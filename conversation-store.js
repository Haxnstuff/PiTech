// PiTech by Haxnstuff
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const key = (value) => path.resolve(value).toLowerCase();

async function collectSessionFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) files.push(file);
    }
  }
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function readHeader(file) {
  try {
    const first = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/, 1)[0];
    const value = JSON.parse(first);
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

async function destinationFor(root, source, header, reserved) {
  const original = path.basename(source);
  const stem = original.replace(/\.jsonl$/i, '');
  const suffix = safeId(header.id);
  let name = original;
  let n = 2;
  while (reserved.has(name.toLowerCase()) || await exists(path.join(root, name))) {
    name = `${stem}-${suffix || 'moved'}${n > 2 ? `-${n}` : ''}.jsonl`;
    n++;
  }
  reserved.add(name.toLowerCase());
  return path.join(root, name);
}

async function exists(file) {
  try { await fs.promises.access(file); return true; } catch { return false; }
}

function mappedParent(value, source, parents) {
  if (typeof value !== 'string' || !value) return null;
  return parents.get(key(value)) || parents.get(key(path.resolve(path.dirname(source), value))) || null;
}

function rewriteParentSessions(content, source, parents) {
  let changed = false;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      const entry = JSON.parse(lines[i]);
      const destination = mappedParent(entry?.parentSession, source, parents);
      if (!destination || destination === entry.parentSession) continue;
      entry.parentSession = destination;
      lines[i] = JSON.stringify(entry);
      changed = true;
    } catch {}
  }
  return changed ? lines.join('\n') : content;
}

async function removeEmptyChildren(root) {
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    await removeEmptyChildren(child);
    try {
      if ((await fs.promises.readdir(child)).length === 0) await fs.promises.rmdir(child);
    } catch {}
  }
}

async function migrateSessions(sessionsDir, conversationsDir) {
  await fs.promises.mkdir(conversationsDir, { recursive: true });
  const sources = await collectSessionFiles(sessionsDir);
  const reserved = new Set();
  try {
    for (const entry of await fs.promises.readdir(conversationsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) reserved.add(entry.name.toLowerCase());
    }
  } catch {}

  const plan = [];
  const parents = new Map();
  for (const source of sources) {
    const destination = await destinationFor(conversationsDir, source, await readHeader(source), reserved);
    plan.push({ source, destination });
    parents.set(key(source), destination);
  }

  const moved = [];
  for (const item of plan) {
    const stat = await fs.promises.stat(item.source);
    const content = await fs.promises.readFile(item.source, 'utf8');
    const output = rewriteParentSessions(content, item.source, parents);
    const temp = path.join(conversationsDir, `.${path.basename(item.destination)}.${process.pid}.tmp`);
    try {
      await fs.promises.writeFile(temp, output, 'utf8');
      await fs.promises.utimes(temp, stat.atime, stat.mtime);
      await fs.promises.rename(temp, item.destination);
      await fs.promises.unlink(item.source);
      moved.push({ source: path.normalize(item.source), destination: path.normalize(item.destination) });
    } catch (error) {
      try { await fs.promises.unlink(temp); } catch {}
      throw error;
    }
  }
  await removeEmptyChildren(sessionsDir);
  return { moved };
}

module.exports = { migrateSessions };
