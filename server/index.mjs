import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

const HOST = process.env.NARRATIVE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.NARRATIVE_PORT ?? 8787);

const ROOT = path.resolve(process.cwd());
const PROJECT_DIR = path.resolve(ROOT, 'projects');
const LIBRARY_PATH = path.resolve(PROJECT_DIR, 'library.json');

const ENV_PATH = path.resolve(ROOT, '.env');

async function loadDotEnvIfPresent() {
  try {
    const raw = await fs.readFile(ENV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // ignore
  }
}

await loadDotEnvIfPresent();

const runtimeConfig = {
  openaiKey: '',
  anthropicKey: '',
  geminiKey: '',
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function notFound(res) {
  json(res, 404, { error: 'not_found' });
}

function badRequest(res, message) {
  json(res, 400, { error: 'bad_request', message });
}

function methodNotAllowed(res) {
  json(res, 405, { error: 'method_not_allowed' });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  return JSON.parse(raw);
}

function safeName(input) {
  const v = String(input ?? '').trim();
  if (!v) return null;
  const cleaned = v.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!cleaned) return null;
  return cleaned;
}

async function ensureProjectDir() {
  await fs.mkdir(PROJECT_DIR, { recursive: true });
}

async function loadLibraryIndex() {
  try {
    const raw = await fs.readFile(LIBRARY_PATH, 'utf8');
    return JSON.parse(raw) ?? { folders: {}, items: {} };
  } catch {
    return { folders: {}, items: {} };
  }
}

async function saveLibraryIndex(data) {
  await fs.writeFile(LIBRARY_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

const runs = new Map();

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function openaiChat({ messages, temperature = 0.7, maxTokens = 1600 }) {
  const apiKey = (runtimeConfig.openaiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
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

async function generateEditNotes(manuscript) {
  const text = String(manuscript ?? '');
  if (!text.trim()) return '';

  const excerpt = text.slice(0, 18000);

  const notes = await openaiChat({
    temperature: 0.25,
    maxTokens: 1200,
    messages: [
      {
        role: 'system',
        content:
          'You are a senior developmental editor + line editor. Give practical, specific notes. No fluff. Output in bullet points.',
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

  return notes;
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

async function generateBookRun({ runId, payload, push, isCancelled }) {
  const title = String(payload?.title ?? '').trim();
  const bookType = String(payload?.bookType ?? 'fiction');
  const genre = String(payload?.genre ?? '').trim();
  const subgenre = String(payload?.subgenre ?? '').trim();
  const tone = String(payload?.tone ?? '').trim();
  const blueprint = String(payload?.blueprint ?? '').trim();
  const plan = resolveGenerationPlan(payload);
  const { lengthLabel, targetWords, chapterCount, reviewPasses, wordsPerChapter, segmentCount, wordsPerSegment } = plan;

  push({
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

  const outline = await openaiChat({ messages: outlinePrompt, temperature: 0.6, maxTokens: 1400 });

  if (isCancelled()) return;

  push({
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

  const chapters = extractChaptersFromOutline(outline).slice(0, chapterCount);
  const totalUnits = Math.max(1, chapters.length * (segmentCount * (1 + reviewPasses * 3) + 1) + 3);
  let completedUnits = 0;
  const progressFromUnits = () => Math.max(12, Math.min(99, 12 + Math.round((completedUnits / totalUnits) * 86)));
  let manuscript = `# ${title}\n\n`;
  manuscript += `TYPE: ${bookType.toUpperCase()}\n`;
  manuscript += `GENRE: ${genre}${subgenre ? ` / ${subgenre}` : ''}\n`;
  if (tone) manuscript += `TONE: ${tone}\n`;
  manuscript += `TARGET WORDS: ${targetWords}\n`;
  manuscript += `CHAPTERS: ${chapterCount}\n`;
  manuscript += `\n---\n\nOUTLINE\n\n${outline}\n\n---\n\n`;
  const chapterReports = [];

  for (let i = 0; i < chapters.length; i += 1) {
    if (isCancelled()) return;
    const ch = chapters[i];
    const heading = `Chapter ${ch.index}: ${ch.title}`;
    const chapterSections = [];
    const chapterNotes = [];
    const priorContext = manuscript.slice(-4000);

    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      if (isCancelled()) return;

      const segmentLabel = `Part ${segmentIndex + 1}/${segmentCount}`;
      push({
        type: 'agent_event',
        runId,
        at: nowIso(),
        agentId: 'writer',
        agentName: 'Writer',
        stage: 'draft',
        message: `Drafting ${heading} ${segmentLabel}`,
        progress: progressFromUnits(),
      });

      let segmentText = await openaiChat({
        temperature: 0.78,
        maxTokens: 2200,
        messages: [
          { role: 'system', content: 'You are a professional long-form author. Write vivid, specific, useful prose. Avoid generic filler. Maintain continuity and momentum.' },
          {
            role: 'user',
            content:
              `Write ${segmentLabel} of ${heading} for this book.\n` +
              `Book title: ${title}\n` +
              `Genre: ${genre}${subgenre ? ` / ${subgenre}` : ''}\n` +
              `Tone: ${tone || 'default'}\n` +
              `Chapter beat: ${ch.beat || 'Advance the book meaningfully and specifically.'}\n` +
              `Target length for this part: about ${wordsPerSegment} words.\n` +
              `Previous book context:\n${priorContext || 'Beginning of the manuscript.'}\n\n` +
              `Existing text for this chapter so far:\n${chapterSections.join('\n\n').slice(-5000) || 'No prior chapter text yet.'}\n\n` +
              (blueprint ? `Blueprint constraints:\n${blueprint}\n\n` : '') +
              `${segmentIndex === 0 ? `Start with \"## ${heading}\".` : 'Continue directly from the previous paragraph with no repeated heading.'} ` +
              `Do not summarize prior material. Add new substance, examples, scenes, or arguments.`,
          },
        ],
      });

      completedUnits += 1;
      segmentText = normalizeChapterSegment(segmentText, heading, segmentIndex === 0);

      for (let pass = 0; pass < reviewPasses; pass += 1) {
        if (isCancelled()) return;

        push({
          type: 'agent_event',
          runId,
          at: nowIso(),
          agentId: 'reviewer',
          agentName: 'Reviewer',
          stage: 'review',
          message: `Reviewing ${heading} ${segmentLabel} (pass ${pass + 1}/${reviewPasses})`,
          progress: progressFromUnits(),
        });

        const review = await openaiChat({
          temperature: 0.25,
          maxTokens: 900,
          messages: [
            { role: 'system', content: 'You are a rigorous developmental editor and line editor. Give concrete, specific notes. Prioritize depth, clarity, originality, and continuity.' },
            {
              role: 'user',
              content:
                `Review this chapter segment.\n` +
                `Book: ${title}\n` +
                `Chapter: ${heading}\n` +
                `Chapter beat: ${ch.beat || 'N/A'}\n` +
                `Segment target: about ${wordsPerSegment} words\n\n` +
                `Text:\n${segmentText}\n\n` +
                `Return:\n- 3 structural/content improvements\n- 3 line-level improvements\n- 2 continuity/QC checks`,
            },
          ],
        });

        completedUnits += 1;
        chapterNotes.push(`## ${heading} ${segmentLabel} Review Pass ${pass + 1}\n${review}`);

        push({
          type: 'agent_event',
          runId,
          at: nowIso(),
          agentId: 'reviser',
          agentName: 'Reviser',
          stage: 'revise',
          message: `Applying review notes to ${heading} ${segmentLabel}`,
          progress: progressFromUnits(),
        });

        segmentText = await openaiChat({
          temperature: 0.45,
          maxTokens: 2200,
          messages: [
            { role: 'system', content: 'You are a precise revising author. Apply editorial notes while preserving continuity, specificity, and voice. Return only the revised prose.' },
            {
              role: 'user',
              content:
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

        const qc = await openaiChat({
          temperature: 0.1,
          maxTokens: 500,
          messages: [
            { role: 'system', content: 'You are a strict QC editor. Check coherence, specificity, continuity, and whether the notes were actually addressed.' },
            {
              role: 'user',
              content:
                `QC this revised chapter segment.\n` +
                `Return exactly:\nStatus: PASS or NEEDS_WORK\nIssues:\n- bullet list\n\n` +
                `Segment:\n${segmentText}`,
            },
          ],
        });

        completedUnits += 1;
        chapterNotes.push(`## ${heading} ${segmentLabel} QC Pass ${pass + 1}\n${qc}`);
      }

      chapterSections.push(segmentText);

      push({
        type: 'agent_event',
        runId,
        at: nowIso(),
        agentId: 'writer',
        agentName: 'Writer',
        stage: 'draft',
        message: `${heading} ${segmentLabel} complete`,
        progress: progressFromUnits(),
        chunk: segmentText,
      });
    }

    const chapterText = chapterSections.join('\n\n').trim();

    push({
      type: 'agent_event',
      runId,
      at: nowIso(),
      agentId: 'qc',
      agentName: 'QC',
      stage: 'qc',
      message: `Final chapter QC for ${heading}`,
      progress: progressFromUnits(),
    });

    const chapterQc = await openaiChat({
      temperature: 0.15,
      maxTokens: 700,
      messages: [
        { role: 'system', content: 'You are a senior manuscript reviewer. Evaluate whether the chapter is substantive, coherent, and aligned with its outline beat.' },
        {
          role: 'user',
          content:
            `Review this completed chapter.\n` +
            `Chapter: ${heading}\n` +
            `Beat: ${ch.beat || 'N/A'}\n` +
            `Target words: about ${wordsPerChapter}\n\n` +
            `Return:\n- Verdict\n- 5 strongest improvements made\n- 5 remaining issues, if any\n\n` +
            chapterText.slice(0, 18000),
        },
      ],
    });

    completedUnits += 1;
    chapterReports.push({ chapter: heading, words: countWords(chapterText), notes: chapterNotes.join('\n\n'), qc: chapterQc });
    manuscript += `${chapterText}\n\n`;
  }

  if (isCancelled()) return;

  push({
    type: 'agent_event',
    runId,
    at: nowIso(),
    agentId: 'editor',
    agentName: 'Editor',
    stage: 'edit',
    message: 'Running final book review',
    progress: progressFromUnits(),
  });

  const manuscriptWordCount = countWords(manuscript);

  const polish = await openaiChat({
    temperature: 0.3,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: 'You are a senior book reviewer. Produce practical, high-signal editorial feedback for an almost-finished manuscript.' },
      {
        role: 'user',
        content:
          `This book currently has about ${manuscriptWordCount.toLocaleString()} words.\n` +
          `Provide:\n- 8 macro improvements\n- 8 line/style improvements\n- 8 publish-readiness checks\n\n` +
          `Outline:\n${outline.slice(0, 5000)}\n\n` +
          `Opening excerpt:\n${manuscript.slice(0, 8000)}\n\n` +
          `Closing excerpt:\n${manuscript.slice(-8000)}`,
      },
    ],
  });

  completedUnits += 1;

  const finalQc = await openaiChat({
    temperature: 0.1,
    maxTokens: 700,
    messages: [
      { role: 'system', content: 'You are the final QC gate before publication. Be concise, skeptical, and concrete.' },
      {
        role: 'user',
        content:
          `Evaluate this manuscript for completion and quality.\n` +
          `Return:\nStatus: PASS or NEEDS_WORK\nReason:\n- bullet list\n\n` +
          `Outline:\n${outline.slice(0, 5000)}\n\n` +
          `Manuscript opening:\n${manuscript.slice(0, 7000)}\n\n` +
          `Manuscript ending:\n${manuscript.slice(-7000)}`,
      },
    ],
  });

  completedUnits += 1;

  push({
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

  await ensureProjectDir();
  const projectId = crypto.randomUUID();
  const file = `${projectId}.json`;
  const full = path.resolve(PROJECT_DIR, file);
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
  await fs.writeFile(full, JSON.stringify(project, null, 2), 'utf8');

  push({
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

function startStubRun(runId, payload) {
  const agents = [
    { id: 'planner', name: 'Planner' },
    { id: 'writer', name: 'Writer' },
    { id: 'editor', name: 'Editor' },
    { id: 'qc', name: 'QC' },
  ];

  const steps = [
    { agent: 'planner', stage: 'outline', message: 'Deriving outline and chapter beats' },
    { agent: 'writer', stage: 'draft', message: 'Drafting chapter 1' },
    { agent: 'writer', stage: 'draft', message: 'Drafting chapter 2' },
    { agent: 'editor', stage: 'edit', message: 'Editing for voice + flow' },
    { agent: 'qc', stage: 'qc', message: 'Checking consistency and plot holes' },
    { agent: 'writer', stage: 'draft', message: 'Drafting remaining chapters (chunked)' },
    { agent: 'editor', stage: 'edit', message: 'Final polish pass' },
  ];

  const run = {
    id: runId,
    createdAt: nowIso(),
    payload,
    status: 'running',
    events: [],
    clients: new Set(),
  };

  runs.set(runId, run);

  const push = (evt) => {
    run.events.push(evt);
    for (const res of run.clients) sseWrite(res, evt.type, evt);
  };

  push({
    type: 'run_started',
    runId,
    at: nowIso(),
    title: payload?.title ?? '',
  });

  let i = 0;
  const interval = setInterval(() => {
    if (!runs.has(runId)) {
      clearInterval(interval);
      return;
    }

    if (i >= steps.length) {
      run.status = 'done';
      push({ type: 'run_completed', runId, at: nowIso() });
      clearInterval(interval);
      return;
    }

    const step = steps[i++];
    const agentMeta = agents.find((a) => a.id === step.agent) ?? { id: step.agent, name: step.agent };
    push({
      type: 'agent_event',
      runId,
      at: nowIso(),
      agentId: agentMeta.id,
      agentName: agentMeta.name,
      stage: step.stage,
      message: step.message,
      progress: Math.round((i / steps.length) * 100),
    });
  }, 650);

  run._interval = interval;
  return run;
}

function stopRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run._interval) clearInterval(run._interval);
  run.status = 'cancelled';
  for (const res of run.clients) {
    sseWrite(res, 'run_cancelled', { type: 'run_cancelled', runId, at: nowIso() });
  }
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  res.setHeader('cache-control', 'no-store');

  if (pathname === '/api/health') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/library') {
    if (req.method === 'GET') {
      const index = await loadLibraryIndex();
      return json(res, 200, index);
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, 'Invalid JSON');
      }

      const index = await loadLibraryIndex();
      const { action, payload } = body;

      if (action === 'createFolder') {
        const { folderId, name, color } = payload;
        index.folders[folderId] = { id: folderId, name, color, children: [] };
        await saveLibraryIndex(index);
        return json(res, 200, { ok: true, folderId });
      }

      if (action === 'updateItem') {
        const { projectId, metadata } = payload;
        index.items[projectId] = metadata;
        await saveLibraryIndex(index);
        return json(res, 200, { ok: true });
      }

      if (action === 'deleteItem') {
        const { projectId } = payload;
        delete index.items[projectId];
        await saveLibraryIndex(index);
        return json(res, 200, { ok: true });
      }

      return badRequest(res, 'Unsupported action');
    }

    return methodNotAllowed(res);
  }

  if (pathname === '/api/config') {
    // eslint-disable-next-line no-console
    console.log(`[config] ${req.method} ${pathname}`);
    if (req.method === 'GET') {
      const openai = Boolean((runtimeConfig.openaiKey || process.env.OPENAI_API_KEY || '').trim());
      const anthropic = Boolean((runtimeConfig.anthropicKey || process.env.ANTHROPIC_API_KEY || '').trim());
      const gemini = Boolean((runtimeConfig.geminiKey || process.env.GEMINI_API_KEY || '').trim());
      return json(res, 200, {
        ok: true,
        model: OPENAI_MODEL,
        keys: {
          openai,
          anthropic,
          gemini,
        },
        sourceHint: {
          openai: runtimeConfig.openaiKey ? 'runtime' : process.env.OPENAI_API_KEY ? 'env' : 'missing',
          anthropic: runtimeConfig.anthropicKey ? 'runtime' : process.env.ANTHROPIC_API_KEY ? 'env' : 'missing',
          gemini: runtimeConfig.geminiKey ? 'runtime' : process.env.GEMINI_API_KEY ? 'env' : 'missing',
        },
      });
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, 'Invalid JSON');
      }

      runtimeConfig.openaiKey = String(body?.openai ?? '').trim();
      runtimeConfig.anthropicKey = String(body?.anthropic ?? '').trim();
      runtimeConfig.geminiKey = String(body?.gemini ?? '').trim();

      return json(res, 200, { ok: true });
    }

    return methodNotAllowed(res);
  }

  if (pathname === '/api/runs') {
    if (req.method === 'GET') {
      const list = Array.from(runs.entries()).map(([runId, run]) => ({
        id: runId,
        title: run.payload?.title ?? '',
        status: run.status,
        stage: run.events.findLast((e) => e.stage)?.stage,
        progress: run.events.findLast((e) => typeof e.progress === 'number')?.progress ?? 0,
        createdAt: run.createdAt,
      }));
      return json(res, 200, { items: list });
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, 'Invalid JSON');
      }

      const runId = crypto.randomUUID();
      const payload = body ?? null;

      const run = {
        id: runId,
        createdAt: nowIso(),
        payload,
        status: 'running',
        events: [],
        clients: new Set(),
        manuscript: '',
        cancelled: false,
      };

      runs.set(runId, run);

      const push = (evt) => {
        run.events.push(evt);
        if (typeof evt?.chunk === 'string' && evt.chunk) {
          run.manuscript += `\n\n${evt.chunk}`;
        }
        for (const clientRes of run.clients) sseWrite(clientRes, evt.type, evt);
      };

      push({ type: 'run_started', runId, at: nowIso(), title: payload?.title ?? '' });

      const isCancelled = () => Boolean(run.cancelled);

      run._promise = (async () => {
        try {
          const result = await generateBookRun({
            runId,
            payload,
            push,
            isCancelled,
          });

          if (run.cancelled) {
            run.status = 'cancelled';
            push({ type: 'run_cancelled', runId, at: nowIso() });
            return;
          }

          run.status = 'done';
          push({ type: 'run_completed', runId, at: nowIso(), projectId: result?.projectId ?? null });
        } catch (err) {
          run.status = 'error';
          push({ type: 'run_error', runId, at: nowIso(), message: String(err?.message ?? err) });
        }
      })();

      return json(res, 200, { ok: true, runId });
    }

    return methodNotAllowed(res);
  }

  if (pathname === '/api/projects') {
    if (req.method === 'GET') {
      await ensureProjectDir();
      const files = await fs.readdir(PROJECT_DIR).catch(() => []);
      const items = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const full = path.resolve(PROJECT_DIR, file);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat) continue;
        items.push({
          id: file.replace(/\.json$/i, ''),
          file,
          updatedAt: stat.mtime.toISOString(),
          size: stat.size,
        });
      }
      items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return json(res, 200, { items });
    }

    if (req.method === 'POST') {
      await ensureProjectDir();
      let body;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, 'Invalid JSON');
      }

      const requestedId = safeName(body?.id);
      const id = requestedId ?? crypto.randomUUID();
      const file = `${id}.json`;
      const full = path.resolve(PROJECT_DIR, file);

      const payload = {
        id,
        title: String(body?.title ?? ''),
        data: body?.data ?? null,
        updatedAt: nowIso(),
        createdAt: body?.createdAt ?? nowIso(),
      };

      await fs.writeFile(full, JSON.stringify(payload, null, 2), 'utf8');
      return json(res, 200, { ok: true, id });
    }

    return methodNotAllowed(res);
  }

  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/edit-notes')) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    await ensureProjectDir();

    const id = safeName(pathname.replace('/api/projects/', '').replace('/edit-notes', ''));
    if (!id) return badRequest(res, 'Missing project id');

    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, 'Invalid JSON');
    }

    try {
      const notes = await generateEditNotes(body?.manuscript ?? '');
      return json(res, 200, { ok: true, notes });
    } catch (err) {
      return json(res, 500, { ok: false, error: 'edit_notes_failed', message: String(err?.message ?? err) });
    }
  }

  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/manuscript')) {
    if (req.method !== 'GET') return methodNotAllowed(res);
    await ensureProjectDir();

    const id = safeName(pathname.replace('/api/projects/', '').replace('/manuscript', ''));
    if (!id) return badRequest(res, 'Missing project id');

    const file = `${id}.json`;
    const full = path.resolve(PROJECT_DIR, file);

    try {
      const raw = await fs.readFile(full, 'utf8');
      const parsed = JSON.parse(raw);
      const manuscript = String(parsed?.manuscript ?? '');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(manuscript);
      return;
    } catch {
      return notFound(res);
    }
  }

  if (pathname.startsWith('/api/projects/')) {
    const id = safeName(pathname.replace('/api/projects/', ''));
    if (!id) return badRequest(res, 'Missing project id');
    await ensureProjectDir();

    const file = `${id}.json`;
    const full = path.resolve(PROJECT_DIR, file);

    if (req.method === 'GET') {
      try {
        const raw = await fs.readFile(full, 'utf8');
        const parsed = JSON.parse(raw);
        return json(res, 200, parsed);
      } catch {
        return notFound(res);
      }
    }

    if (req.method === 'PUT') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, 'Invalid JSON');
      }

      try {
        const raw = await fs.readFile(full, 'utf8');
        const parsed = JSON.parse(raw);
        const updated = {
          ...parsed,
          manuscript: typeof body?.manuscript === 'string' ? body.manuscript : parsed?.manuscript,
          polish: typeof body?.polish === 'string' ? body.polish : parsed?.polish,
          updatedAt: nowIso(),
        };
        await fs.writeFile(full, JSON.stringify(updated, null, 2), 'utf8');
        return json(res, 200, { ok: true, id });
      } catch {
        return notFound(res);
      }
    }

    return methodNotAllowed(res);
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/events')) {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/events', ''));
    if (!runId) return badRequest(res, 'Missing runId');
    const run = runs.get(runId);
    if (!run) return notFound(res);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('access-control-allow-origin', '*');
    run.clients.add(res);
    res.on('close', () => run.clients.delete(res));
    // Flush existing events to new client
    for (const evt of run.events) {
      sseWrite(res, evt.type, evt);
    }
    return;
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/cancel')) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/cancel', ''));
    if (!runId) return badRequest(res, 'Missing runId');
    const cancelled = cancelRun(runId);
    return json(res, 200, { ok: true, cancelled });
  }

  if (pathname === '/api/runs') {
    if (req.method !== 'POST') return methodNotAllowed(res);

    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, 'Invalid JSON');
    }

    const runId = crypto.randomUUID();
    const payload = body ?? null;

    const run = {
      id: runId,
      createdAt: nowIso(),
      payload,
      status: 'running',
      events: [],
      clients: new Set(),
      manuscript: '',
      cancelled: false,
    };

    runs.set(runId, run);

    const push = (evt) => {
      run.events.push(evt);
      if (typeof evt?.chunk === 'string' && evt.chunk) {
        run.manuscript += `\n\n${evt.chunk}`;
      }
      for (const clientRes of run.clients) sseWrite(clientRes, evt.type, evt);
    };

    push({ type: 'run_started', runId, at: nowIso(), title: payload?.title ?? '' });

    const isCancelled = () => Boolean(run.cancelled);

    run._promise = (async () => {
      try {
        const result = await generateBookRun({
          runId,
          payload,
          push,
          isCancelled,
        });

        if (run.cancelled) {
          run.status = 'cancelled';
          push({ type: 'run_cancelled', runId, at: nowIso() });
          return;
        }

        run.status = 'done';
        push({ type: 'run_completed', runId, at: nowIso(), projectId: result?.projectId ?? null });
      } catch (err) {
        run.status = 'error';
        push({ type: 'run_error', runId, at: nowIso(), message: String(err?.message ?? err) });
      }
    })();

    return json(res, 200, { ok: true, runId });
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/events')) {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/events', ''));
    if (!runId) return badRequest(res, 'Missing runId');
    const run = runs.get(runId);
    if (!run) return notFound(res);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('access-control-allow-origin', '*');
    run.clients.add(res);
    res.on('close', () => run.clients.delete(res));
    // Flush existing events to new client
    for (const evt of run.events) {
      sseWrite(res, evt.type, evt);
    }
    return;
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/cancel')) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/cancel', ''));
    if (!runId) return badRequest(res, 'Missing runId');
    const cancelled = cancelRun(runId);
    return json(res, 200, { ok: true, cancelled });
  }

  return notFound(res);
}

const server = http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch((err) => {
    json(res, 500, { error: 'internal_error', message: String(err?.message ?? err) });
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Narrative server listening on http://${HOST}:${PORT}`);
});
