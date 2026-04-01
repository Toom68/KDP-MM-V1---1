import { appendRunEvent, generateBookRun, getRunRecord } from './lib/runtime.mjs';

export async function handler(event) {
  let body = null;
  try {
    body = event?.body ? JSON.parse(event.body) : null;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid_json' }) };
  }

  const runId = String(body?.runId ?? '').trim();
  const payload = body?.payload ?? null;
  const resume = body?.resume ?? null;
  const openaiApiKey = String(body?.openaiApiKey ?? '').trim() || String(process.env.OPENAI_API_KEY ?? '').trim();

  if (!runId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'missing_run_id' }) };
  }

  if (!openaiApiKey) {
    await appendRunEvent(runId, {
      type: 'run_error',
      runId,
      message: 'Missing OPENAI_API_KEY',
      stage: 'config',
      progress: 0,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const push = async (evt) => {
    await appendRunEvent(runId, evt);
  };

  const isCancelled = async () => {
    const run = await getRunRecord(runId);
    return Boolean(run?.cancelled);
  };

  try {
    const result = await generateBookRun({
      runId,
      payload,
      apiKey: openaiApiKey,
      push,
      isCancelled,
      resume,
    });

    if (await isCancelled()) {
      await appendRunEvent(runId, {
        type: 'run_cancelled',
        runId,
        message: 'Run cancelled',
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    await appendRunEvent(runId, {
      type: 'run_completed',
      runId,
      projectId: result?.projectId ?? null,
      progress: 100,
      stage: 'save',
    });
  } catch (err) {
    await appendRunEvent(runId, {
      type: 'run_error',
      runId,
      message: String(err?.message ?? err),
    });
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}
