import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_ROOT = path.resolve(process.cwd(), process.env.NARRATIVE_DATA_DIR || 'data');

function sanitizeSegment(input) {
  return String(input ?? '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 180);
}

function keyToFilePath(storeName, key) {
  const namespace = sanitizeSegment(storeName || 'default') || 'default';
  const rawSegments = String(key ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => sanitizeSegment(segment))
    .filter(Boolean);
  const safeSegments = rawSegments.length ? rawSegments : ['value'];
  return path.join(DATA_ROOT, namespace, ...safeSegments);
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function createStore(storeName) {
  return {
    async get(key, options = {}) {
      const filePath = keyToFilePath(storeName, key);
      const raw = await fs.readFile(filePath, 'utf8');
      if (options?.type === 'json') return JSON.parse(raw);
      return raw;
    },
    async set(key, value) {
      const filePath = keyToFilePath(storeName, key);
      await ensureParentDir(filePath);
      await fs.writeFile(filePath, String(value ?? ''), 'utf8');
      return true;
    },
    async setJSON(key, value) {
      const filePath = keyToFilePath(storeName, key);
      await ensureParentDir(filePath);
      await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
      return true;
    },
  };
}

function getStore(storeName) {
  return createStore(storeName);
}

export { DATA_ROOT, getStore };
