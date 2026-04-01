import crypto from 'node:crypto';
import {
  OPENAI_MODEL,
  appendRunEvent,
  appendRunDirective,
  createRunRecord,
  finalizeDirective,
  generateEditNotes,
  generateDirectiveQuestions,
  getActiveRunDirective,
  getProjectRecord,
  getRunManuscriptSnapshot,
  getRunRecord,
  loadRunDirectives,
  listProjectRecords,
  listRunRecords,
  loadLibraryIndex,
  markRunCancelled,
  nowIso,
  safeName,
  sanitizePayload,
  saveLibraryIndex,
  saveProjectRecord,
  setActiveRunDirective,
  summarizeRun,
  updateProjectRecord,
} from './lib/runtime.mjs';

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function json(statusCode, body) {
  return response(statusCode, body, { 'content-type': 'application/json; charset=utf-8' });
}

function badRequest(message) {
  return json(400, { error: 'bad_request', message });
}

function notFound() {
  return json(404, { error: 'not_found' });
}

function methodNotAllowed() {
  return json(405, { error: 'method_not_allowed' });
}

function parseBody(event) {
  if (!event?.body) return null;
  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error('Invalid JSON');
  }
}

function getPath(event) {
  const rawPath = String(event?.path ?? '/');
  if (rawPath.startsWith('/.netlify/functions/api')) {
    const suffix = rawPath.slice('/.netlify/functions/api'.length) || '/';
    const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
    return normalizedSuffix.startsWith('/api/') || normalizedSuffix === '/api'
      ? normalizedSuffix
      : `/api${normalizedSuffix === '/' ? '' : normalizedSuffix}`;
  }
  return rawPath;
}

function getBaseUrl(event) {
  if (event?.rawUrl) {
    const url = new URL(event.rawUrl);
    return `${url.protocol}//${url.host}`;
  }
  const proto = event?.headers?.['x-forwarded-proto'] ?? 'https';
  const host = event?.headers?.host ?? '';
  return `${proto}://${host}`;
}

function normalizeRetryStage(stage) {
  const s = String(stage ?? '').trim().toLowerCase();
  if (s === 'draft' || s === 'review' || s === 'revise' || s === 'qc' || s === 'edit') return s;
  return 'draft';
}

function getOpenAiKeyFromBody(body) {
  return String(body?.openaiApiKey ?? '').trim();
}

export async function handler(event) {
  const method = String(event?.httpMethod ?? 'GET').toUpperCase();
  const pathname = getPath(event);

  if (pathname === '/api/health') {
    if (method !== 'GET') return methodNotAllowed();
    return json(200, { ok: true });
  }

  if (pathname === '/api/config') {
    if (method === 'GET') {
      const openai = Boolean(String(process.env.OPENAI_API_KEY ?? '').trim());
      const anthropic = Boolean(String(process.env.ANTHROPIC_API_KEY ?? '').trim());
      const gemini = Boolean(String(process.env.GEMINI_API_KEY ?? '').trim());
      return json(200, {
        ok: true,
        model: OPENAI_MODEL,
        keys: { openai, anthropic, gemini },
        sourceHint: {
          openai: openai ? 'env' : 'missing',
          anthropic: anthropic ? 'env' : 'missing',
          gemini: gemini ? 'env' : 'missing',
        },
        runtimeKeyInjectionSupported: false,
      });
    }

    if (method === 'POST') {
      let body;
      try {
        body = parseBody(event) ?? {};
      } catch (err) {
        return badRequest(String(err?.message ?? err));
      }

      const openai = Boolean(String(body?.openai ?? '').trim() || String(process.env.OPENAI_API_KEY ?? '').trim());
      const anthropic = Boolean(String(body?.anthropic ?? '').trim() || String(process.env.ANTHROPIC_API_KEY ?? '').trim());
      const gemini = Boolean(String(body?.gemini ?? '').trim() || String(process.env.GEMINI_API_KEY ?? '').trim());
      return json(200, {
        ok: true,
        model: OPENAI_MODEL,
        keys: { openai, anthropic, gemini },
        sourceHint: {
          openai: String(body?.openai ?? '').trim() ? 'request' : (process.env.OPENAI_API_KEY ? 'env' : 'missing'),
          anthropic: String(body?.anthropic ?? '').trim() ? 'request' : (process.env.ANTHROPIC_API_KEY ? 'env' : 'missing'),
          gemini: String(body?.gemini ?? '').trim() ? 'request' : (process.env.GEMINI_API_KEY ? 'env' : 'missing'),
        },
        runtimeKeyInjectionSupported: false,
      });
    }

    return methodNotAllowed();
  }

  if (pathname === '/api/library') {
    if (method === 'GET') {
      const index = await loadLibraryIndex();
      return json(200, index);
    }

    if (method === 'POST') {
      let body;
      try {
        body = parseBody(event) ?? {};
      } catch (err) {
        return badRequest(String(err?.message ?? err));
      }

      const index = await loadLibraryIndex();
      const { action, payload } = body;

      if (action === 'createFolder') {
        const folderId = safeName(payload?.folderId) ?? crypto.randomUUID();
        index.folders[folderId] = {
          id: folderId,
          name: String(payload?.name ?? ''),
          color: String(payload?.color ?? ''),
          children: Array.isArray(payload?.children) ? payload.children : [],
        };
        await saveLibraryIndex(index);
        return json(200, { ok: true, folderId });
      }

      if (action === 'updateItem') {
        const projectId = safeName(payload?.projectId);
        if (!projectId) return badRequest('Missing projectId');
        index.items[projectId] = payload?.metadata ?? null;
        await saveLibraryIndex(index);
        return json(200, { ok: true });
      }

      if (action === 'deleteItem') {
        const projectId = safeName(payload?.projectId);
        if (!projectId) return badRequest('Missing projectId');
        delete index.items[projectId];
        await saveLibraryIndex(index);
        return json(200, { ok: true });
      }

      return badRequest('Unsupported action');
    }

    return methodNotAllowed();
  }

  if (pathname === '/api/runs') {
    if (method === 'GET') {
      const items = await listRunRecords();
      return json(200, { items });
    }

    if (method === 'POST') {
      let body;
      try {
        body = parseBody(event) ?? {};
      } catch (err) {
        return badRequest(String(err?.message ?? err));
      }

      const openaiApiKey = getOpenAiKeyFromBody(body) || String(process.env.OPENAI_API_KEY ?? '').trim();
      if (!openaiApiKey) {
        return json(400, { ok: false, error: 'missing_openai_key', message: 'Missing OPENAI_API_KEY' });
      }

      const runId = crypto.randomUUID();
      const payload = sanitizePayload(body ?? null);
      await createRunRecord(runId, payload);
      await appendRunEvent(runId, { type: 'run_started', runId, at: nowIso(), title: payload?.title ?? '', stage: 'queued', progress: 0 });

      const backgroundUrl = `${getBaseUrl(event)}/internal/run-generator-background`;
      await fetch(backgroundUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, payload, openaiApiKey }),
      });

      return json(200, { ok: true, runId });
    }

    return methodNotAllowed();
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/cancel')) {
    if (method !== 'POST') return methodNotAllowed();
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/cancel', ''));
    if (!runId) return badRequest('Missing runId');
    const cancelled = await markRunCancelled(runId);
    return json(200, { ok: true, cancelled });
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/reinit')) {
    if (method !== 'POST') return methodNotAllowed();
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/reinit', ''));
    if (!runId) return badRequest('Missing runId');
    const run = await getRunRecord(runId);
    if (!run) return notFound();

    let body;
    try {
      body = parseBody(event) ?? {};
    } catch (err) {
      return badRequest(String(err?.message ?? err));
    }

    const cancelOld = body?.cancelOld !== false;
    const openaiApiKey = getOpenAiKeyFromBody(body) || String(process.env.OPENAI_API_KEY ?? '').trim();
    if (!openaiApiKey) {
      return json(400, { ok: false, error: 'missing_openai_key', message: 'Missing OPENAI_API_KEY' });
    }

    const payload = sanitizePayload(run?.payload ?? null);
    const newRunId = crypto.randomUUID();
    await createRunRecord(newRunId, payload);
    await appendRunEvent(newRunId, { type: 'run_started', runId: newRunId, at: nowIso(), title: payload?.title ?? '', stage: 'queued', progress: 0 });

    if (cancelOld) {
      await markRunCancelled(runId);
      await appendRunEvent(runId, { type: 'agent_event', runId, at: nowIso(), agentId: 'system', agentName: 'System', stage: 'reinit', progress: run?.progress ?? 0, message: `Reinitialised (spawned new run ${newRunId})` });
    }

    const backgroundUrl = `${getBaseUrl(event)}/internal/run-generator-background`;
    await fetch(backgroundUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: newRunId, payload, openaiApiKey }),
    });

    return json(200, { ok: true, runId: newRunId, cancelledOld: cancelOld, oldRunId: runId });
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/retry-segment')) {
    if (method !== 'POST') return methodNotAllowed();
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/retry-segment', ''));
    if (!runId) return badRequest('Missing runId');

    const run = await getRunRecord(runId);
    if (!run) return notFound();

    let body;
    try {
      body = parseBody(event) ?? {};
    } catch (err) {
      return badRequest(String(err?.message ?? err));
    }

    const openaiApiKey = getOpenAiKeyFromBody(body) || String(process.env.OPENAI_API_KEY ?? '').trim();
    if (!openaiApiKey) {
      return json(400, { ok: false, error: 'missing_openai_key', message: 'Missing OPENAI_API_KEY' });
    }

    const snapshot = await getRunManuscriptSnapshot(runId);
    if (!snapshot?.text) {
      return json(400, { ok: false, error: 'missing_snapshot', message: 'No manuscript snapshot exists yet for this run' });
    }

    const resume = {
      stage: normalizeRetryStage(body?.stageOverride || snapshot?.lastStage || 'draft'),
      chapterIndex: snapshot?.chapterIndex ?? 0,
      segmentIndex: snapshot?.segmentIndex ?? 0,
      segmentStart: snapshot?.segmentStart ?? null,
      segmentEnd: snapshot?.segmentEnd ?? null,
      manuscriptText: snapshot.text,
      progress: typeof run?.progress === 'number' ? run.progress : undefined,
    };

    await appendRunEvent(runId, {
      type: 'agent_event',
      runId,
      at: nowIso(),
      agentId: 'system',
      agentName: 'System',
      stage: 'retry',
      progress: run?.progress ?? 0,
      message: `Retry requested: ${String(resume.stage).toUpperCase()} (Chapter ${Number(resume.chapterIndex) || 0}, Segment ${Number(resume.segmentIndex) + 1 || 0})`,
    });

    const payload = sanitizePayload(run?.payload ?? null);
    const backgroundUrl = `${getBaseUrl(event)}/internal/run-generator-background`;
    await fetch(backgroundUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, payload, openaiApiKey, resume }),
    });

    return json(200, { ok: true, runId, resume });
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/manuscript')) {
    if (method !== 'GET') return methodNotAllowed();
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/manuscript', ''));
    if (!runId) return badRequest('Missing runId');
    const snapshot = await getRunManuscriptSnapshot(runId);
    if (snapshot) return json(200, snapshot);
    const run = await getRunRecord(runId);
    if (!run) return notFound();
    return json(200, { text: '', updatedAt: '', wordCount: 0 });
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/directives')) {
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/directives', ''));
    if (!runId) return badRequest('Missing runId');

    if (method === 'GET') {
      const run = await getRunRecord(runId);
      if (!run) return notFound();
      const items = await loadRunDirectives(runId);
      const active = await getActiveRunDirective(runId);
      return json(200, { ok: true, items: items?.items ?? [], active: active ?? null });
    }

    return methodNotAllowed();
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/directives/questions')) {
    if (method !== 'POST') return methodNotAllowed();
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/directives/questions', ''));
    if (!runId) return badRequest('Missing runId');
    const run = await getRunRecord(runId);
    if (!run) return notFound();

    let body;
    try {
      body = parseBody(event) ?? {};
    } catch (err) {
      return badRequest(String(err?.message ?? err));
    }

    const apiKey = getOpenAiKeyFromBody(body) || String(process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) return json(400, { ok: false, error: 'missing_openai_key', message: 'Missing OPENAI_API_KEY' });

    const ideaText = String(body?.text ?? '').trim();
    if (!ideaText) return badRequest('Missing text');

    try {
      const questions = await generateDirectiveQuestions({ apiKey, title: String(run?.title ?? ''), userText: ideaText });
      return json(200, { ok: true, questions });
    } catch (err) {
      return json(500, { ok: false, error: 'directive_questions_failed', message: String(err?.message ?? err) });
    }
  }

  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/directives/apply')) {
    if (method !== 'POST') return methodNotAllowed();
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/directives/apply', ''));
    if (!runId) return badRequest('Missing runId');
    const run = await getRunRecord(runId);
    if (!run) return notFound();

    let body;
    try {
      body = parseBody(event) ?? {};
    } catch (err) {
      return badRequest(String(err?.message ?? err));
    }

    const apiKey = getOpenAiKeyFromBody(body) || String(process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) return json(400, { ok: false, error: 'missing_openai_key', message: 'Missing OPENAI_API_KEY' });

    const ideaText = String(body?.ideaText ?? '').trim();
    const answersText = String(body?.answersText ?? '').trim();
    if (!ideaText) return badRequest('Missing ideaText');
    if (!answersText) return badRequest('Missing answersText');

    try {
      const directive = await finalizeDirective({ apiKey, title: String(run?.title ?? ''), ideaText, answersText });
      const item = {
        id: crypto.randomUUID(),
        at: nowIso(),
        ideaText,
        answersText,
        directive,
      };
      await appendRunDirective(runId, item);
      await setActiveRunDirective(runId, { id: item.id, at: item.at, text: directive });
      await appendRunEvent(runId, {
        type: 'agent_event',
        runId,
        at: nowIso(),
        agentId: 'user',
        agentName: 'User',
        stage: 'directive',
        message: 'Directive applied',
        chunk: directive,
      });
      return json(200, { ok: true, directive, active: { id: item.id, at: item.at, text: directive } });
    } catch (err) {
      return json(500, { ok: false, error: 'directive_apply_failed', message: String(err?.message ?? err) });
    }
  }

  if (pathname.startsWith('/api/runs/')) {
    if (method !== 'GET') return methodNotAllowed();
    const runId = safeName(pathname.replace('/api/runs/', '').replace('/events', ''));
    if (!runId) return badRequest('Missing runId');
    const run = await getRunRecord(runId);
    if (!run) return notFound();
    return json(200, run);
  }

  if (pathname === '/api/projects') {
    if (method === 'GET') {
      const items = await listProjectRecords();
      return json(200, { items });
    }

    if (method === 'POST') {
      let body;
      try {
        body = parseBody(event) ?? {};
      } catch (err) {
        return badRequest(String(err?.message ?? err));
      }

      const requestedId = safeName(body?.id);
      const id = requestedId ?? crypto.randomUUID();
      await saveProjectRecord({
        id,
        title: String(body?.title ?? ''),
        data: body?.data ?? null,
        updatedAt: nowIso(),
        createdAt: body?.createdAt ?? nowIso(),
      });
      return json(200, { ok: true, id });
    }

    return methodNotAllowed();
  }

  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/edit-notes')) {
    if (method !== 'POST') return methodNotAllowed();
    const id = safeName(pathname.replace('/api/projects/', '').replace('/edit-notes', ''));
    if (!id) return badRequest('Missing project id');

    let body;
    try {
      body = parseBody(event) ?? {};
    } catch (err) {
      return badRequest(String(err?.message ?? err));
    }

    const apiKey = getOpenAiKeyFromBody(body) || String(process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) return json(400, { ok: false, error: 'missing_openai_key', message: 'Missing OPENAI_API_KEY' });

    try {
      const notes = await generateEditNotes({ apiKey, manuscript: body?.manuscript ?? '' });
      return json(200, { ok: true, notes });
    } catch (err) {
      return json(500, { ok: false, error: 'edit_notes_failed', message: String(err?.message ?? err) });
    }
  }

  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/manuscript')) {
    if (method !== 'GET') return methodNotAllowed();
    const id = safeName(pathname.replace('/api/projects/', '').replace('/manuscript', ''));
    if (!id) return badRequest('Missing project id');
    const project = await getProjectRecord(id);
    if (!project) return notFound();
    return response(200, String(project?.manuscript ?? ''), { 'content-type': 'text/plain; charset=utf-8' });
  }

  if (pathname.startsWith('/api/projects/')) {
    const id = safeName(pathname.replace('/api/projects/', ''));
    if (!id) return badRequest('Missing project id');

    if (method === 'GET') {
      const project = await getProjectRecord(id);
      if (!project) return notFound();
      return json(200, project);
    }

    if (method === 'PUT') {
      let body;
      try {
        body = parseBody(event) ?? {};
      } catch (err) {
        return badRequest(String(err?.message ?? err));
      }
      const updated = await updateProjectRecord(id, body);
      if (!updated) return notFound();
      return json(200, { ok: true, id });
    }

    return methodNotAllowed();
  }

  return notFound();
}
