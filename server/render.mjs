import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { handler as apiHandler } from '../netlify/functions/api.mjs';
import { handler as backgroundHandler } from '../netlify/functions/run-generator-background.mjs';

const ROOT = path.resolve(process.cwd());
const DIST_DIR = path.resolve(ROOT, 'dist');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || process.env.NARRATIVE_PORT || 8787);
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
  }
}

await loadDotEnvIfPresent();

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
}

function writeHandlerResponse(res, result) {
  const statusCode = Number(result?.statusCode ?? 200);
  const headers = result?.headers ?? {};
  res.statusCode = statusCode;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'undefined') res.setHeader(key, value);
  }
  res.end(typeof result?.body === 'string' ? result.body : JSON.stringify(result?.body ?? ''));
}

async function serveFile(res, filePath) {
  const content = await fs.readFile(filePath);
  res.statusCode = 200;
  res.setHeader('content-type', getMimeType(filePath));
  res.end(content);
}

async function serveSpa(res, pathname) {
  const cleaned = decodeURIComponent(pathname || '/');
  const relativePath = cleaned === '/' ? 'index.html' : cleaned.replace(/^\/+/, '');
  const filePath = path.resolve(DIST_DIR, relativePath);
  if (filePath.startsWith(DIST_DIR)) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        await serveFile(res, filePath);
        return;
      }
    } catch {
    }
  }
  await serveFile(res, INDEX_HTML);
}

function buildEvent(req, pathname, body) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const proto = String(req.headers['x-forwarded-proto'] || 'http');
  return {
    httpMethod: String(req.method || 'GET').toUpperCase(),
    path: pathname,
    rawUrl: `${proto}://${host}${req.url || pathname}`,
    headers: req.headers,
    body,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    const pathname = url.pathname;

    if (pathname === '/internal/run-generator-background') {
      if (String(req.method || 'GET').toUpperCase() !== 'POST') {
        res.statusCode = 405;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      const body = await readRequestBody(req);
      const event = buildEvent(req, pathname, body);
      setTimeout(() => {
        backgroundHandler(event).catch((err) => {
          console.error('Background generator failed', err);
        });
      }, 0);
      res.statusCode = 202;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, queued: true }));
      return;
    }

    if (pathname.startsWith('/api')) {
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || 'GET').toUpperCase())
        ? await readRequestBody(req)
        : '';
      const result = await apiHandler(buildEvent(req, pathname, body));
      writeHandlerResponse(res, result);
      return;
    }

    await serveSpa(res, pathname);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Render server listening on http://${HOST}:${PORT}`);
});
