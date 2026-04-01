import crypto from 'node:crypto';
import { getStore } from './store.mjs';

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const MAX_RUN_EVENTS = 500;

function getRunsStore() {
  return getStore('runs');
}

function getProjectsStore() {
  return getStore('projects');
}

function getMetaStore() {
  return getStore('meta');
}

async function saveRunManuscriptSnapshot(runId, text, meta = null) {
  const safeRunId = safeName(runId);
  if (!safeRunId) return false;
  const manuscript = String(text ?? '');
  const wordCount = countWords(manuscript);
  await getRunsStore().set(`${safeRunId}.manuscript.txt`, manuscript, { contentType: 'text/plain; charset=utf-8' });
  await writeJsonValue(getRunsStore(), `${safeRunId}.manuscript.meta.json`, {
    updatedAt: nowIso(),
    wordCount,
    lastAgentId: typeof meta?.agentId === 'string' ? meta.agentId : '',
    lastAgentName: typeof meta?.agentName === 'string' ? meta.agentName : '',
    lastStage: typeof meta?.stage === 'string' ? meta.stage : '',
    chapterIndex: Number.isFinite(Number(meta?.chapterIndex)) ? Number(meta.chapterIndex) : null,
    segmentIndex: Number.isFinite(Number(meta?.segmentIndex)) ? Number(meta.segmentIndex) : null,
    segmentStart: Number.isFinite(Number(meta?.segmentStart)) ? Number(meta.segmentStart) : null,
    segmentEnd: Number.isFinite(Number(meta?.segmentEnd)) ? Number(meta.segmentEnd) : null,
    segmentCount: Number.isFinite(Number(meta?.segmentCount)) ? Number(meta.segmentCount) : null,
    chapterCount: Number.isFinite(Number(meta?.chapterCount)) ? Number(meta.chapterCount) : null,
  });
  return true;
}

async function getRunManuscriptSnapshot(runId) {
  const safeRunId = safeName(runId);
  if (!safeRunId) return null;
  const meta = await readJsonValue(getRunsStore(), `${safeRunId}.manuscript.meta.json`, null);
  const text = await getRunsStore().get(`${safeRunId}.manuscript.txt`, { type: 'text' }).catch(() => null);
  if (!text) return null;
  return {
    text,
    updatedAt: String(meta?.updatedAt ?? ''),
    wordCount: meta?.wordCount ?? 0,
    lastAgentId: String(meta?.lastAgentId ?? ''),
    lastAgentName: String(meta?.lastAgentName ?? ''),
    lastStage: String(meta?.lastStage ?? ''),
    chapterIndex: meta?.chapterIndex ?? null,
    segmentIndex: meta?.segmentIndex ?? null,
    segmentStart: meta?.segmentStart ?? null,
    segmentEnd: meta?.segmentEnd ?? null,
    segmentCount: meta?.segmentCount ?? null,
    chapterCount: meta?.chapterCount ?? null,
  };
}

async function loadRunDirectives(runId) {
  const safeRunId = safeName(runId);
  if (!safeRunId) return { items: [] };
  return readJsonValue(getRunsStore(), `${safeRunId}.directives.json`, { items: [] });
}

async function appendRunDirective(runId, item) {
  const safeRunId = safeName(runId);
  if (!safeRunId) return null;
  const existing = await loadRunDirectives(runId);
  const items = Array.isArray(existing?.items) ? existing.items : [];
  const next = {
    ...existing,
    items: [...items, item].slice(-200),
  };
  await writeJsonValue(getRunsStore(), `${safeRunId}.directives.json`, next);
  return item;
}

async function setActiveRunDirective(runId, active) {
  const safeRunId = safeName(runId);
  if (!safeRunId) return false;
  await writeJsonValue(getRunsStore(), `${safeRunId}.directive.active.json`, active ?? null);
  return true;
}

async function getActiveRunDirective(runId) {
  const safeRunId = safeName(runId);
  if (!safeRunId) return null;
  return readJsonValue(getRunsStore(), `${safeRunId}.directive.active.json`, null);
}

function nowIso() {
  return new Date().toISOString();
}

function safeName(input) {
  const v = String(input ?? '').trim();
  if (!v) return null;
  const cleaned = v.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!cleaned) return null;
  return cleaned;
}

function countWords(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function parseWordCountHint(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;

  const kMatch = raw.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (kMatch) return Math.round(Number(kMatch[1]) * 1000);

  const numberMatch = raw.match(/\b(\d{2,3}(?:,\d{3})+)\b|\b(\d{5,6})\b/);
  const candidate = numberMatch?.[1] ?? numberMatch?.[2] ?? '';
  if (!candidate) return null;

  const parsed = Number(candidate.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveGenerationPlan(payload) {
  const presets = {
    novella: { targetWords: 60000, chapterCount: 12, reviewPasses: 1 },
    standard: { targetWords: 85000, chapterCount: 18, reviewPasses: 2 },
    epic: { targetWords: 120000, chapterCount: 24, reviewPasses: 3 },
  };

  const rawLength = String(payload?.length ?? '').trim();
  const preset = presets[rawLength.toLowerCase()] ?? presets.standard;
  const hintedWords = parseWordCountHint(rawLength);
  const requestedWords = Number(payload?.targetWords ?? hintedWords ?? preset.targetWords);
  const requestedChapters = Number(payload?.chapterCount ?? preset.chapterCount);
  const requestedPasses = Number(payload?.reviewPasses ?? preset.reviewPasses);

  const targetWords = Math.max(40000, Math.min(140000, Math.round(Number.isFinite(requestedWords) ? requestedWords : preset.targetWords)));
  const chapterCount = Math.max(8, Math.min(40, Math.round(Number.isFinite(requestedChapters) ? requestedChapters : preset.chapterCount)));
  const reviewPasses = Math.max(1, Math.min(3, Math.round(Number.isFinite(requestedPasses) ? requestedPasses : preset.reviewPasses)));
  const wordsPerChapter = Math.max(2500, Math.round(targetWords / chapterCount));
  const segmentCount = Math.max(2, Math.min(5, Math.ceil(wordsPerChapter / 1400)));
  const wordsPerSegment = Math.max(900, Math.round(wordsPerChapter / segmentCount));

  return {
    lengthLabel: rawLength,
    targetWords,
    chapterCount,
    reviewPasses,
    wordsPerChapter,
    segmentCount,
    wordsPerSegment,
  };
}

function escapeRegex(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeChapterSegment(text, heading, includeHeading) {
  let cleaned = String(text ?? '').trim();
  if (!cleaned) return includeHeading ? `## ${heading}` : '';

  const headingPattern = new RegExp(`^#{1,6}\\s*${escapeRegex(heading)}\\s*`, 'i');
  cleaned = cleaned.replace(headingPattern, '').trim();

  if (includeHeading) {
    return `## ${heading}\n\n${cleaned}`.trim();
  }

  return cleaned;
}

function extractChaptersFromOutline(outlineText) {
  const lines = String(outlineText ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const chapters = [];
  for (const line of lines) {
    const m = line.match(/^(?:chapter\s*)?(\d{1,2})[\.:\-)]\s*(.+)$/i);
    if (m) {
      const raw = m[2].trim();
      const [titlePart, ...beatParts] = raw.split(/\s+[—-]\s+/);
      chapters.push({
        index: Number(m[1]),
        title: titlePart.trim() || `Chapter ${m[1]}`,
        beat: beatParts.join(' — ').trim(),
      });
    }
  }
  if (chapters.length) return chapters.sort((a, b) => a.index - b.index);

  const fallback = [];
  for (let i = 1; i <= 18; i += 1) fallback.push({ index: i, title: `Chapter ${i}`, beat: '' });
  return fallback;
}

async function readJsonValue(store, key, fallback) {
  const value = await store.get(key, { type: 'json' }).catch(() => null);
  return value ?? fallback;
}

async function writeJsonValue(store, key, value) {
  await store.setJSON(key, value);
}

async function loadLibraryIndex() {
  return readJsonValue(getMetaStore(), 'library-index', { folders: {}, items: {} });
}

async function saveLibraryIndex(data) {
  await writeJsonValue(getMetaStore(), 'library-index', data ?? { folders: {}, items: {} });
}

async function loadProjectIndex() {
  return readJsonValue(getMetaStore(), 'projects-index', { items: [] });
}

async function saveProjectIndex(data) {
  await writeJsonValue(getMetaStore(), 'projects-index', data ?? { items: [] });
}

async function loadRunIndex() {
  return readJsonValue(getMetaStore(), 'runs-index', { items: [] });
}

async function saveRunIndex(data) {
  await writeJsonValue(getMetaStore(), 'runs-index', data ?? { items: [] });
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload ?? null;
  const clone = { ...payload };
  delete clone.openaiApiKey;
  delete clone.anthropicApiKey;
  delete clone.geminiApiKey;
  return clone;
}

async function saveProjectRecord(project) {
  const payload = {
    ...project,
    updatedAt: project?.updatedAt ?? nowIso(),
  };
  const serialized = JSON.stringify(payload, null, 2);
  await getProjectsStore().set(`${payload.id}.json`, serialized, { contentType: 'application/json; charset=utf-8' });

  const index = await loadProjectIndex();
  const items = Array.isArray(index?.items) ? index.items : [];
  const nextItem = {
    id: payload.id,
    file: `${payload.id}.json`,
    updatedAt: payload.updatedAt,
    size: Buffer.byteLength(serialized, 'utf8'),
    title: payload.title ?? '',
  };
  const filtered = items.filter((item) => item?.id !== payload.id);
  filtered.unshift(nextItem);
  filtered.sort((a, b) => (String(a?.updatedAt ?? '') < String(b?.updatedAt ?? '') ? 1 : -1));
  await saveProjectIndex({ items: filtered.slice(0, 1000) });
  return payload;
}

async function getProjectRecord(id) {
  const safeId = safeName(id);
  if (!safeId) return null;
  const text = await getProjectsStore().get(`${safeId}.json`, { type: 'text' }).catch(() => null);
  if (!text) return null;
  return JSON.parse(text);
}

async function listProjectRecords() {
  const index = await loadProjectIndex();
  const items = Array.isArray(index?.items) ? index.items : [];
  return items.sort((a, b) => (String(a?.updatedAt ?? '') < String(b?.updatedAt ?? '') ? 1 : -1));
}

async function updateProjectRecord(id, fields) {
  const existing = await getProjectRecord(id);
  if (!existing) return null;
  const updated = {
    ...existing,
    manuscript: typeof fields?.manuscript === 'string' ? fields.manuscript : existing?.manuscript,
    polish: typeof fields?.polish === 'string' ? fields.polish : existing?.polish,
    updatedAt: nowIso(),
  };
  return saveProjectRecord(updated);
}

function summarizeRun(run) {
  return {
    id: run.id,
    title: run.title ?? run.payload?.title ?? '',
    status: run.status,
    stage: run.stage,
    progress: run.progress ?? 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    projectId: run.projectId ?? null,
  };
}

async function getRunRecord(runId) {
  const safeRunId = safeName(runId);
  if (!safeRunId) return null;
  return readJsonValue(getRunsStore(), `${safeRunId}.json`, null);
}

async function saveRunRecord(run) {
  const payload = {
    ...run,
    updatedAt: nowIso(),
  };
  await writeJsonValue(getRunsStore(), `${payload.id}.json`, payload);

  const index = await loadRunIndex();
  const items = Array.isArray(index?.items) ? index.items : [];
  const filtered = items.filter((item) => item?.id !== payload.id);
  filtered.unshift(summarizeRun(payload));
  filtered.sort((a, b) => (String(a?.updatedAt ?? '') < String(b?.updatedAt ?? '') ? 1 : -1));
  await saveRunIndex({ items: filtered.slice(0, 500) });
  return payload;
}

async function createRunRecord(runId, payload) {
  const sanitized = sanitizePayload(payload);
  return saveRunRecord({
    id: runId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    payload: sanitized,
    title: sanitized?.title ?? '',
    status: 'running',
    stage: 'queued',
    progress: 0,
    projectId: null,
    cancelled: false,
    events: [],
  });
}

async function listRunRecords() {
  const index = await loadRunIndex();
  const items = Array.isArray(index?.items) ? index.items : [];
  return items.sort((a, b) => (String(a?.updatedAt ?? '') < String(b?.updatedAt ?? '') ? 1 : -1));
}

async function appendRunEvent(runId, evt) {
  const run = await getRunRecord(runId);
  if (!run) return null;
  const event = {
    id: crypto.randomUUID(),
    at: evt?.at ?? nowIso(),
    ...evt,
  };
  const events = Array.isArray(run.events) ? run.events.slice(-(MAX_RUN_EVENTS - 1)) : [];
  events.push(event);
  const next = {
    ...run,
    events,
    stage: typeof event?.stage === 'string' ? event.stage : run.stage,
    progress: typeof event?.progress === 'number' ? event.progress : run.progress,
  };
  if (event?.type === 'run_completed') {
    next.status = 'done';
    next.progress = 100;
    next.projectId = event?.projectId ?? run.projectId ?? null;
  }
  if (event?.type === 'run_cancelled') next.status = 'cancelled';
  if (event?.type === 'run_error') next.status = 'error';
  return saveRunRecord(next);
}

async function markRunCancelled(runId) {
  const run = await getRunRecord(runId);
  if (!run) return false;
  if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') return true;
  await saveRunRecord({ ...run, cancelled: true });
  await appendRunEvent(runId, { type: 'run_cancelled', runId, at: nowIso(), message: 'Run cancelled', stage: run.stage, progress: run.progress ?? 0 });
  return true;
}

async function openaiChat({ apiKey, messages, temperature = 0.7, maxTokens = 1600 }) {
  const key = String(apiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
  if (!key) throw new Error('Missing OPENAI_API_KEY');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = data?.error?.message ?? `OpenAI error (${resp.status})`;
    throw new Error(msg);
  }

  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

async function buildStoryBible({ apiKey, title, bookType, genre, subgenre, tone, blueprint, outline }) {
  const response = await openaiChat({
    apiKey,
    temperature: 0.15,
    maxTokens: 900,
    messages: [
      {
        role: 'system',
        content:
          'You are a meticulous story continuity editor. Build a compact story bible that can be reused in prompts. Be concrete, avoid speculation, avoid prose. Output only the bible.',
      },
      {
        role: 'user',
        content:
          'Create a STORY BIBLE for this book.\n' +
          `Title: ${title}\n` +
          `Type: ${bookType}\n` +
          `Genre: ${genre}${subgenre ? ` / ${subgenre}` : ''}\n` +
          `Tone: ${tone || 'default'}\n\n` +
          (blueprint ? `Blueprint:\n${blueprint}\n\n` : '') +
          `Outline:\n${outline}\n\n` +
          'Format EXACTLY as:\n' +
          'CHARACTERS:\n- Name: role, age?, voice, desires, fears, secrets, relationships\n' +
          'SETTINGS:\n- Place: sensory anchors, rules\n' +
          'TIMELINE / FACTS:\n- bullet facts that must remain consistent\n' +
          'STYLE RULES:\n- bullet rules for voice and prose\n' +
          'OPEN THREADS:\n- bullet mysteries/promises to pay off\n\n' +
          'Keep it under 2200 characters.',
      },
    ],
  });
  return String(response ?? '').trim();
}

async function finalizeDirective({ apiKey, title, ideaText, answersText }) {
  const response = await openaiChat({
    apiKey,
    temperature: 0.2,
    maxTokens: 450,
    messages: [
      {
        role: 'system',
        content:
          'You convert a user idea + their answers into a clean, actionable directive for a fiction-writing agent. Output only the directive.',
      },
      {
        role: 'user',
        content:
          `Book: ${title}\n\n` +
          `Idea:\n${String(ideaText ?? '').slice(0, 2000)}\n\n` +
          `Answers:\n${String(answersText ?? '').slice(0, 2000)}\n\n` +
          'Write a directive that:\n' +
          '- is concise\n' +
          '- lists constraints as bullet points if needed\n' +
          '- states what to change and where (which chapter/scene if known)\n' +
          '- avoids ambiguity\n',
      },
    ],
  });

  return String(response ?? '').trim();
}

async function updateStoryMemory({ apiKey, title, storyBible, recap, newText, chapterLabel }) {
  const response = await openaiChat({
    apiKey,
    temperature: 0.2,
    maxTokens: 900,
    messages: [
      {
        role: 'system',
        content:
          'You update story memory for continuity. Maintain stable facts. Do NOT invent new facts not supported by text. Keep output compact.',
      },
      {
        role: 'user',
        content:
          `Book: ${title}\n` +
          `Chapter: ${chapterLabel}\n\n` +
          'CURRENT STORY BIBLE:\n' +
          `${storyBible || '(none)'}\n\n` +
          'CURRENT ROLLING RECAP:\n' +
          `${recap || '(none)'}\n\n` +
          'NEW CANON TEXT (authoritative):\n' +
          `${String(newText ?? '').slice(0, 12000)}\n\n` +
          'Return EXACTLY two sections:\n' +
          'STORY_BIBLE:\n(updated bible, under 2400 chars)\n' +
          'RECAP:\n(rolling recap of key events so far, under 900 chars)',
      },
    ],
  });

  const raw = String(response ?? '');
  const match = raw.match(/STORY_BIBLE:\s*([\s\S]*?)\nRECAP:\s*([\s\S]*)$/i);
  if (!match) {
    return {
      storyBible: String(storyBible ?? ''),
      recap: String(recap ?? ''),
    };
  }

  return {
    storyBible: String(match[1] ?? '').trim(),
    recap: String(match[2] ?? '').trim(),
  };
}

function buildContinuityBlock({ storyBible, recap, chapterBeat, chapterLabel }) {
  const bible = String(storyBible ?? '').trim();
  const rolling = String(recap ?? '').trim();
  const beat = String(chapterBeat ?? '').trim();

  return (
    'CONTINUITY MEMORY (authoritative):\n' +
    (bible ? `${bible}\n\n` : '') +
    (rolling ? `ROLLING RECAP:\n${rolling}\n\n` : '') +
    (beat ? `CURRENT CHAPTER GOAL (${chapterLabel}):\n${beat}\n\n` : '') +
    'Rules:\n' +
    '- Do not contradict the story bible or recap.\n' +
    '- Preserve names, relationships, motives, injuries, locations, and timeline facts.\n' +
    '- If uncertain, choose the safest interpretation consistent with prior canon.'
  ).trim();
}

async function generateDirectiveQuestions({ apiKey, title, userText }) {
  const response = await openaiChat({
    apiKey,
    temperature: 0.2,
    maxTokens: 500,
    messages: [
      {
        role: 'system',
        content:
          'You help a user inject a story directive mid-generation. Ask short, pointed questions to clarify intent and constraints. Output only questions.',
      },
      {
        role: 'user',
        content:
          `Book: ${title}\n\n` +
          `User directive:\n${String(userText ?? '').slice(0, 2000)}\n\n` +
          'Ask up to 3 questions. Format as:\n1. ...\n2. ...\n3. ...',
      },
    ],
  });
  return String(response ?? '').trim();
}

async function generateEditNotes({ apiKey, manuscript }) {
  const text = String(manuscript ?? '');
  if (!text.trim()) return '';

  const excerpt = text.slice(0, 18000);

  return openaiChat({
    apiKey,
    temperature: 0.25,
    maxTokens: 1200,
    messages: [
      {
        role: 'system',
        content: 'You are a senior developmental editor + line editor. Give practical, specific notes. No fluff. Output in bullet points.',
      },
      {
        role: 'user',
        content:
          'Read this manuscript excerpt and provide:\n' +
          '- 5 developmental notes (structure/pacing/character/logic)\n' +
          '- 5 line notes (style/clarity/voice)\n' +
          '- 5 consistency/QC checks\n\n' +
          excerpt,
      },
    ],
  });
}

async function generateBookRun({ runId, payload, apiKey, push, isCancelled, resume = null }) {
  const title = String(payload?.title ?? '').trim();
  const bookType = String(payload?.bookType ?? 'fiction');
  const genre = String(payload?.genre ?? '').trim();
  const subgenre = String(payload?.subgenre ?? '').trim();
  const tone = String(payload?.tone ?? '').trim();
  const blueprint = String(payload?.blueprint ?? '').trim();
  const plan = resolveGenerationPlan(payload);
  const { lengthLabel, targetWords, chapterCount, reviewPasses, wordsPerChapter, segmentCount, wordsPerSegment } = plan;

  const resumeEnabled = Boolean(resume && typeof resume === 'object');
  let manuscript = resumeEnabled && typeof resume?.manuscriptText === 'string' ? String(resume.manuscriptText) : '';
  let outline = '';

  if (!resumeEnabled) {
    await push({
      type: 'agent_event',
      runId,
      at: nowIso(),
      agentId: 'planner',
      agentName: 'Planner',
      stage: 'outline',
      message: `Generating outline (${chapterCount} chapters ~${targetWords.toLocaleString()} words)`,
      progress: 5,
    });

    const outlinePrompt = [
      { role: 'system', content: 'You are a senior book outliner. Output concise, high-quality structure with progression and escalating value.' },
      {
        role: 'user',
        content:
          `Create a chapter outline for a ${bookType} book.\n` +
          `Title: ${title}\n` +
          `Genre: ${genre}${subgenre ? ` / ${subgenre}` : ''}\n` +
          `Tone: ${tone || 'default'}\n` +
          `Length label: ${lengthLabel || 'custom'}\n` +
          `Target words: ${targetWords}\n` +
          `Target words per chapter: about ${wordsPerChapter}\n` +
          (blueprint ? `Blueprint:\n${blueprint}\n` : '') +
          `\nReturn an outline with exactly ${chapterCount} lines formatted like: "1. Chapter title — 1-2 sentence beat". Make every beat specific and cumulative.`,
      },
    ];

    outline = await openaiChat({ apiKey, messages: outlinePrompt, temperature: 0.6, maxTokens: 1400 });

    if (await isCancelled()) return null;

    await push({
      type: 'agent_event',
      runId,
      at: nowIso(),
      agentId: 'planner',
      agentName: 'Planner',
      stage: 'outline',
      message: 'Outline ready',
      progress: 12,
      chunk: outline,
    });
  } else {
    outline = extractOutlineFromManuscript(manuscript);
    if (!outline) {
      throw new Error('Cannot resume run: missing outline in manuscript snapshot');
    }
    await push({
      type: 'agent_event',
      runId,
      at: nowIso(),
      agentId: 'system',
      agentName: 'System',
      stage: 'retry',
      message: `Retrying ${String(resume?.stage ?? '').toUpperCase() || 'stage'} at Chapter ${Number(resume?.chapterIndex ?? 0) || 0}, Segment ${Number(resume?.segmentIndex ?? 0) + 1 || 0}`,
      progress: typeof resume?.progress === 'number' ? resume.progress : undefined,
      chapterIndex: resume?.chapterIndex ?? undefined,
      segmentIndex: resume?.segmentIndex ?? undefined,
      segmentCount,
      chapterCount,
    });
  }

  let storyBible = await buildStoryBible({ apiKey, title, bookType, genre, subgenre, tone, blueprint, outline });
  let rollingRecap = '';

  const chapters = extractChaptersFromOutline(outline).slice(0, chapterCount);
  const totalUnits = Math.max(1, chapters.length * (segmentCount * (1 + reviewPasses * 3) + 1) + 3);
  let completedUnits = 0;
  const progressFromUnits = () => Math.max(12, Math.min(99, 12 + Math.round((completedUnits / totalUnits) * 86)));
  let lastSnapshotAt = 0;
  const snapshot = async (meta = null, force = false) => {
    const now = Date.now();
    if (!force && now - lastSnapshotAt < 5000) return;
    lastSnapshotAt = now;
    await saveRunManuscriptSnapshot(runId, manuscript, meta);
  };

  if (!resumeEnabled) {
    manuscript = `# ${title}\n\n`;
    manuscript += `TYPE: ${bookType.toUpperCase()}\n`;
    manuscript += `GENRE: ${genre}${subgenre ? ` / ${subgenre}` : ''}\n`;
    if (tone) manuscript += `TONE: ${tone}\n`;
    manuscript += `TARGET WORDS: ${targetWords}\n`;
    manuscript += `CHAPTERS: ${chapterCount}\n`;
    manuscript += `\n---\n\nOUTLINE\n\n${outline}\n\n---\n\n`;
    await snapshot({ agentId: 'system', agentName: 'System', stage: 'outline', chapterCount, segmentCount, chapterIndex: 0, segmentIndex: 0 }, true);
  }
  const chapterReports = [];

  const resumeChapterIndex = resumeEnabled && Number.isFinite(Number(resume?.chapterIndex)) ? Number(resume.chapterIndex) : null;
  const resumeSegmentIndex = resumeEnabled && Number.isFinite(Number(resume?.segmentIndex)) ? Number(resume.segmentIndex) : null;
  const resumeStage = resumeEnabled && typeof resume?.stage === 'string' ? String(resume.stage) : '';
  const resumeSegmentStart = resumeEnabled && Number.isFinite(Number(resume?.segmentStart)) ? Number(resume.segmentStart) : null;
  const resumeSegmentEnd = resumeEnabled && Number.isFinite(Number(resume?.segmentEnd)) ? Number(resume.segmentEnd) : null;

  for (let i = 0; i < chapters.length; i += 1) {
    if (await isCancelled()) return null;
    const ch = chapters[i];
    if (resumeChapterIndex != null && ch.index < resumeChapterIndex) continue;
    const heading = `Chapter ${ch.index}: ${ch.title}`;
    const chapterSections = [];
    const chapterNotes = [];

    const activeDirective = await getActiveRunDirective(runId);
    const directiveText = String(activeDirective?.text ?? '').trim();
    const directiveBlock = directiveText ? `USER DIRECTIVE (apply going forward):\n${directiveText}\n\n` : '';
    const continuityBlock = (
      directiveBlock +
      buildContinuityBlock({
      storyBible,
      recap: rollingRecap,
      chapterBeat: ch.beat || '',
      chapterLabel: heading,
      })
    ).trim();

    const segmentStartIndex = resumeChapterIndex === ch.index && resumeSegmentIndex != null ? resumeSegmentIndex : 0;
    for (let segmentIndex = segmentStartIndex; segmentIndex < segmentCount; segmentIndex += 1) {
      if (await isCancelled()) return null;

      const segmentLabel = `Part ${segmentIndex + 1}/${segmentCount}`;

      const isResumeSegment = resumeChapterIndex === ch.index && resumeSegmentIndex === segmentIndex && resumeEnabled;
      const segmentSuffix = `\n\n`;
      let segmentStart = isResumeSegment && resumeSegmentStart != null ? resumeSegmentStart : null;
      let segmentEnd = isResumeSegment && resumeSegmentEnd != null ? resumeSegmentEnd : null;

      const chapterStart = manuscript.lastIndexOf(`## ${heading}`);
      const chapterStartSafe = chapterStart >= 0 ? chapterStart : Math.max(0, manuscript.length - 12000);
      const priorContext = segmentStart != null ? manuscript.slice(Math.max(0, segmentStart - 4000), segmentStart) : manuscript.slice(-4000);
      const chapterSoFarText = segmentStart != null ? manuscript.slice(chapterStartSafe, segmentStart) : '';

      let segmentText = '';

      if (isResumeSegment && segmentStart != null && segmentEnd != null && segmentEnd > segmentStart) {
        segmentText = manuscript.slice(segmentStart, segmentEnd).replace(/\s+$/g, '').trim();
      }

      const shouldRedoDraft = !isResumeSegment || !segmentText || resumeStage === 'draft';

      await push({
        type: 'agent_event',
        runId,
        at: nowIso(),
        agentId: 'writer',
        agentName: 'Writer',
        stage: 'draft',
        message: `Drafting ${heading} ${segmentLabel}`,
        progress: progressFromUnits(),
        chapterIndex: ch.index,
        segmentIndex,
        segmentCount,
        chapterCount,
      });

      if (shouldRedoDraft) {
        segmentText = await openaiChat({
          apiKey,
          temperature: 0.78,
          maxTokens: 2200,
          messages: [
            {
              role: 'system',
              content:
                'You are a professional novelist with a human voice.\n' +
                'Write scene-forward prose (action + dialogue + sensory detail) with subtext and distinct character voices.\n' +
                'PACING IS KING: keep paragraphs tight, keep the scene moving, and maintain micro-tension.\n' +
                'Structure: hook in the first 2 lines, rising tension, a clear turn, then end on a forward-moving hook.\n' +
                'Avoid: generic AI phrasing, moralizing, over-explaining, meta commentary, and summary tone.\n' +
                'Avoid: "suddenly", "as if", "in a world", "little did they know", "couldn\'t help but".\n' +
                'Prefer concrete verbs and specific images over abstractions. Vary sentence rhythm.\n' +
                'Do not reset character knowledge or relationships between segments.\n' +
                'Obey the provided CONTINUITY MEMORY block as canon.\n' +
                'Blueprint is CANON: only write events that belong inside the blueprint plan; do not invent new plot beats outside it.',
            },
            {
              role: 'user',
              content:
                `${continuityBlock}\n\n` +
                `Write ${segmentLabel} of ${heading} for this book.\n` +
                `Book title: ${title}\n` +
                `Genre: ${genre}${subgenre ? ` / ${subgenre}` : ''}\n` +
                `Tone: ${tone || 'default'}\n` +
                `Chapter beat: ${ch.beat || 'Advance the book meaningfully and specifically.'}\n` +
                `Target length for this part: about ${wordsPerSegment} words.\n` +
                `Previous book context:\n${priorContext || 'Beginning of the manuscript.'}\n\n` +
                `Existing text for this chapter so far:\n${chapterSoFarText.slice(-5000) || 'No prior chapter text yet.'}\n\n` +
                (blueprint ? `Blueprint (canonical plan - do NOT continue past it, do NOT add new beats):\n${blueprint}\n\n` : '') +
                'Pacing checklist (obey):\n' +
                '- every page must contain change (new info, reversal, decision, or escalating pressure)\n' +
                '- minimize exposition; embed context inside action/dialogue\n' +
                '- keep stakes present; use concrete sensory anchors\n\n' +
                `${segmentIndex === 0 ? `Start with \"## ${heading}\".` : 'Continue directly from the previous paragraph with no repeated heading.'} ` +
                'Do not summarize prior material. Add new substance through actions, dialogue, and sensory beats. End on a forward-moving hook.',
            },
          ],
        });
      }

      completedUnits += 1;
      segmentText = normalizeChapterSegment(segmentText, heading, segmentIndex === 0);

      // Insert or replace draft segment in-place.
      if (segmentStart != null && segmentEnd != null && segmentEnd >= segmentStart) {
        manuscript = manuscript.slice(0, segmentStart) + `${segmentText}${segmentSuffix}` + manuscript.slice(segmentEnd);
        segmentEnd = segmentStart + `${segmentText}${segmentSuffix}`.length;
      } else {
        segmentStart = manuscript.length;
        manuscript += `${segmentText}${segmentSuffix}`;
        segmentEnd = manuscript.length;
      }

      chapterSections.push(segmentText);
      await snapshot(
        { agentId: 'writer', agentName: 'Writer', stage: 'draft', chapterIndex: ch.index, segmentIndex, segmentCount, chapterCount, segmentStart, segmentEnd },
        true
      );

      const resumeSkipToReview = isResumeSegment && resumeStage && resumeStage !== 'draft';
      for (let pass = 0; pass < reviewPasses; pass += 1) {
        if (await isCancelled()) return null;

        await push({
          type: 'agent_event',
          runId,
          at: nowIso(),
          agentId: 'reviewer',
          agentName: 'Reviewer',
          stage: 'review',
          message: `Reviewing ${heading} ${segmentLabel} (pass ${pass + 1}/${reviewPasses})`,
          progress: progressFromUnits(),
          chapterIndex: ch.index,
          segmentIndex,
          segmentCount,
          chapterCount,
        });

        if (!resumeSkipToReview || resumeStage === 'review' || resumeStage === 'revise' || resumeStage === 'qc') {
          await snapshot({ agentId: 'reviewer', agentName: 'Reviewer', stage: 'review', chapterIndex: ch.index, segmentIndex, segmentCount, chapterCount, segmentStart, segmentEnd });
        }

        const review = await openaiChat({
          apiKey,
          temperature: 0.25,
          maxTokens: 900,
          messages: [
            { role: 'system', content: 'You are a rigorous developmental editor and line editor. Give concrete, specific notes. Prioritize depth, clarity, originality, and continuity.' },
            {
              role: 'user',
              content:
                `${continuityBlock}\n\n` +
                'Review this chapter segment.\n' +
                `Book: ${title}\n` +
                `Chapter: ${heading}\n` +
                `Chapter beat: ${ch.beat || 'N/A'}\n` +
                `Segment target: about ${wordsPerSegment} words\n\n` +
                `Text:\n${segmentText}\n\n` +
                'Return:\n- 3 structural/content improvements\n- 3 line-level improvements\n- 2 continuity/QC checks',
            },
          ],
        });

        await push({
          type: 'agent_event',
          runId,
          at: nowIso(),
          agentId: 'reviewer',
          agentName: 'Reviewer',
          stage: 'review',
          message: `Review notes for ${heading} ${segmentLabel} (pass ${pass + 1}/${reviewPasses})`,
          progress: progressFromUnits(),
          chunk: review,
          chapterIndex: ch.index,
          segmentIndex,
          segmentCount,
          chapterCount,
        });

        completedUnits += 1;
        chapterNotes.push(`## ${heading} ${segmentLabel} Review Pass ${pass + 1}\n${review}`);

        await push({
          type: 'agent_event',
          runId,
          at: nowIso(),
          agentId: 'reviser',
          agentName: 'Reviser',
          stage: 'revise',
          message: `Applying review notes to ${heading} ${segmentLabel}`,
          progress: progressFromUnits(),
          chapterIndex: ch.index,
          segmentIndex,
          segmentCount,
          chapterCount,
        });

        if (!resumeSkipToReview || resumeStage === 'revise' || resumeStage === 'qc') {
          await snapshot({ agentId: 'reviser', agentName: 'Reviser', stage: 'revise', chapterIndex: ch.index, segmentIndex, segmentCount, chapterCount, segmentStart, segmentEnd });
        }

        const wordsBefore = countWords(segmentText);
        segmentText = await openaiChat({
          apiKey,
          temperature: 0.45,
          maxTokens: 2200,
          messages: [
            {
              role: 'system',
              content:
                'You are a precise revising author and line editor.\n' +
                'Goal: improve pacing, clarity, specificity, and voice while preserving continuity and intent.\n' +
                'Tighten sentences, remove filler, sharpen images, and make dialogue do work.\n' +
                'Obey the CONTINUITY MEMORY block as canon and obey the Blueprint (canonical plan).\n' +
                'Return only the revised prose.',
            },
            {
              role: 'user',
              content:
                `${continuityBlock}\n\n` +
                `Revise this chapter segment using the review notes.\n` +
                `Keep the segment at roughly ${wordsPerSegment} words.\n` +
                `${segmentIndex === 0 ? `Keep the heading as \"## ${heading}\".` : 'Do not add or repeat a heading.'}\n\n` +
                `Review notes:\n${review}\n\n` +
                `Current segment:\n${segmentText}`,
            },
          ],
        });

        completedUnits += 1;
        segmentText = normalizeChapterSegment(segmentText, heading, segmentIndex === 0);
        const wordsAfter = countWords(segmentText);
        const wordDelta = wordsAfter - wordsBefore;

        // Replace the inserted draft segment in-place so Live shows true edit diffs.
        manuscript = manuscript.slice(0, segmentStart) + `${segmentText}${segmentSuffix}` + manuscript.slice(segmentEnd);
        segmentEnd = segmentStart + `${segmentText}${segmentSuffix}`.length;
        chapterSections[segmentIndex] = segmentText;
        await snapshot({ agentId: 'reviser', agentName: 'Reviser', stage: 'revise', chapterIndex: ch.index, segmentIndex, segmentCount, chapterCount, segmentStart, segmentEnd }, true);

        await push({
          type: 'agent_event',
          runId,
          at: nowIso(),
          agentId: 'reviser',
          agentName: 'Reviser',
          stage: 'revise',
          message: `Revision applied to ${heading} ${segmentLabel} (${wordDelta >= 0 ? '+' : ''}${wordDelta} words)`,
          progress: progressFromUnits(),
          wordDelta,
          chapterIndex: ch.index,
          segmentIndex,
          segmentCount,
          chapterCount,
        });

        await snapshot({ agentId: 'reviser', agentName: 'Reviser', stage: 'revise', chapterIndex: ch.index, segmentIndex, segmentCount, chapterCount, segmentStart, segmentEnd });

        const qc = await openaiChat({
          apiKey,
          temperature: 0.1,
          maxTokens: 500,
          messages: [
            { role: 'system', content: 'You are a strict QC editor. Check coherence, specificity, continuity, and whether the notes were actually addressed.' },
            {
              role: 'user',
              content:
                `${continuityBlock}\n\n` +
                'QC this revised chapter segment.\n' +
                'Return exactly:\nStatus: PASS or NEEDS_WORK\nIssues:\n- bullet list\n\n' +
                `Segment:\n${segmentText}`,
            },
          ],
        });

        await push({
          type: 'agent_event',
          runId,
          at: nowIso(),
          agentId: 'qc',
          agentName: 'QC',
          stage: 'qc',
          message: `QC notes for ${heading} ${segmentLabel} (pass ${pass + 1}/${reviewPasses})`,
          progress: progressFromUnits(),
          chunk: qc,
          chapterIndex: ch.index,
          segmentIndex,
          segmentCount,
          chapterCount,
        });

        completedUnits += 1;
        chapterNotes.push(`## ${heading} ${segmentLabel} QC Pass ${pass + 1}\n${qc}`);
      }

      await push({
        type: 'agent_event',
        runId,
        at: nowIso(),
        agentId: 'writer',
        agentName: 'Writer',
        stage: 'draft',
        message: `${heading} ${segmentLabel} complete`,
        progress: progressFromUnits(),
        chunk: segmentText,
        chapterIndex: ch.index,
        segmentIndex,
        segmentCount,
        chapterCount,
      });
    }

    const chapterText = chapterSections.join('\n\n').trim();

    await push({
      type: 'agent_event',
      runId,
      at: nowIso(),
      agentId: 'qc',
      agentName: 'QC',
      stage: 'qc',
      message: `Final chapter QC for ${heading}`,
      progress: progressFromUnits(),
      chapterIndex: ch.index,
      segmentIndex: segmentCount,
      segmentCount,
      chapterCount,
    });

    const chapterQc = await openaiChat({
      apiKey,
      temperature: 0.15,
      maxTokens: 700,
      messages: [
        { role: 'system', content: 'You are a senior manuscript reviewer. Evaluate whether the chapter is substantive, coherent, and aligned with its outline beat.' },
        {
          role: 'user',
          content:
            `${continuityBlock}\n\n` +
            'Review this completed chapter.\n' +
            `Chapter: ${heading}\n` +
            `Beat: ${ch.beat || 'N/A'}\n` +
            `Target words: about ${wordsPerChapter}\n\n` +
            'Return:\n- Verdict\n- 5 strongest improvements made\n- 5 remaining issues, if any\n\n' +
            chapterText.slice(0, 18000),
        },
      ],
    });

    await push({
      type: 'agent_event',
      runId,
      at: nowIso(),
      agentId: 'qc',
      agentName: 'QC',
      stage: 'qc',
      message: `Chapter QC notes for ${heading}`,
      progress: progressFromUnits(),
      chunk: chapterQc,
      chapterIndex: ch.index,
      segmentIndex: segmentCount,
      segmentCount,
      chapterCount,
    });

    completedUnits += 1;
    chapterReports.push({ chapter: heading, words: countWords(chapterText), notes: chapterNotes.join('\n\n'), qc: chapterQc });

    const memoryUpdate = await updateStoryMemory({
      apiKey,
      title,
      storyBible,
      recap: rollingRecap,
      newText: chapterText,
      chapterLabel: heading,
    });
    storyBible = memoryUpdate.storyBible;
    rollingRecap = memoryUpdate.recap;

    await snapshot({ agentId: 'qc', agentName: 'QC', stage: 'qc', chapterIndex: ch.index, segmentIndex: segmentCount, segmentCount, chapterCount }, true);
  }

  if (await isCancelled()) return null;

  await push({
    type: 'agent_event',
    runId,
    at: nowIso(),
    agentId: 'editor',
    agentName: 'Editor',
    stage: 'edit',
    message: 'Running final book review',
    progress: progressFromUnits(),
  });

  await snapshot({ agentId: 'editor', agentName: 'Editor', stage: 'edit', chapterIndex: chapterCount, segmentIndex: segmentCount, segmentCount, chapterCount });

  const manuscriptWordCount = countWords(manuscript);

  const polish = await openaiChat({
    apiKey,
    temperature: 0.3,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: 'You are a senior book reviewer. Produce practical, high-signal editorial feedback for an almost-finished manuscript.' },
      {
        role: 'user',
        content:
          `This book currently has about ${manuscriptWordCount.toLocaleString()} words.\n` +
          'Provide:\n- 8 macro improvements\n- 8 line/style improvements\n- 8 publish-readiness checks\n\n' +
          `Outline:\n${outline.slice(0, 5000)}\n\n` +
          `Opening excerpt:\n${manuscript.slice(0, 8000)}\n\n` +
          `Closing excerpt:\n${manuscript.slice(-8000)}`,
      },
    ],
  });

  completedUnits += 1;

  const finalQc = await openaiChat({
    apiKey,
    temperature: 0.1,
    maxTokens: 700,
    messages: [
      { role: 'system', content: 'You are the final QC gate before publication. Be concise, skeptical, and concrete.' },
      {
        role: 'user',
        content:
          'Evaluate this manuscript for completion and quality.\n' +
          'Return:\nStatus: PASS or NEEDS_WORK\nReason:\n- bullet list\n\n' +
          `Outline:\n${outline.slice(0, 5000)}\n\n` +
          `Manuscript opening:\n${manuscript.slice(0, 7000)}\n\n` +
          `Manuscript ending:\n${manuscript.slice(-7000)}`,
      },
    ],
  });

  completedUnits += 1;

  await push({
    type: 'agent_event',
    runId,
    at: nowIso(),
    agentId: 'editor',
    agentName: 'Editor',
    stage: 'edit',
    message: 'Final review complete',
    progress: progressFromUnits(),
    chunk: `${polish}\n\n${finalQc}`,
  });

  const projectId = crypto.randomUUID();
  const project = {
    id: projectId,
    title,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    meta: {
      bookType,
      genre,
      subgenre,
      tone,
      lengthLabel,
      targetWords,
      chapterCount,
      wordsPerChapter,
      segmentCount,
      reviewPasses,
      actualWords: manuscriptWordCount,
      model: OPENAI_MODEL,
    },
    outline,
    manuscript,
    polish,
    finalQc,
    chapterReports,
  };

  await saveProjectRecord(project);

  await snapshot({ agentId: 'system', agentName: 'System', stage: 'save', chapterIndex: chapterCount, segmentIndex: segmentCount, segmentCount, chapterCount }, true);

  await push({
    type: 'agent_event',
    runId,
    at: nowIso(),
    agentId: 'system',
    agentName: 'System',
    stage: 'save',
    message: `Saved project ${projectId}`,
    progress: 100,
  });

  return { projectId };
}

export {
  OPENAI_MODEL,
  appendRunEvent,
  appendRunDirective,
  createRunRecord,
  finalizeDirective,
  generateBookRun,
  generateDirectiveQuestions,
  generateEditNotes,
  getActiveRunDirective,
  getRunManuscriptSnapshot,
  getProjectRecord,
  getRunRecord,
  loadRunDirectives,
  listProjectRecords,
  listRunRecords,
  loadLibraryIndex,
  markRunCancelled,
  nowIso,
  resolveGenerationPlan,
  safeName,
  sanitizePayload,
  saveLibraryIndex,
  saveProjectRecord,
  saveRunRecord,
  setActiveRunDirective,
  summarizeRun,
  updateProjectRecord,
};
