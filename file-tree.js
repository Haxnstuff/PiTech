// PiTech by Haxnstuff
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// Text extensions viewable/editable in the in-browser file explorer.
const TEXT_EXTS = ['.md', '.txt', '.cfg', '.json', '.jsonl', '.log', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.sh', '.ps1', '.bat', '.sql'];

// Shared guard for /api/file (view) and /api/file/save (edit).
function isAllowedFile(roots, p) {
  if (!p || typeof p !== 'string') return false;
  const resolved = path.resolve(p);
  if (!TEXT_EXTS.includes(path.extname(resolved).toLowerCase())) return false;
  return roots.some((r) => isWithin(r, resolved) && path.resolve(r) !== resolved);
}

async function listTree(root, target = root) {
  const resolved = path.resolve(target);
  if (!isWithin(root, resolved)) throw new Error('path is outside the active workspace');
  const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolved, entry.name),
      type: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
}

async function aggregateEditing(agentDir, now = Date.now()) {
  let names;
  try { names = await fs.promises.readdir(agentDir); } catch { return []; }
  const found = [];
  for (const name of names.filter((value) => /^webui-editing-\d+\.json$/.test(value))) {
    try {
      const activity = JSON.parse(await fs.promises.readFile(path.join(agentDir, name), 'utf8'));
      if (!['pi', 'sub'].includes(activity.who) || now - Number(activity.ts) > 60_000 || Number(activity.expiresAt || Infinity) < now) continue;
      for (const file of Array.isArray(activity.files) ? activity.files : []) {
        if (typeof file === 'string' && file) found.push({ path: path.normalize(file), who: activity.who });
      }
    } catch {}
  }
  return [...new Map(found.map((item) => [`${item.who}\0${item.path.toLowerCase()}`, item])).values()]
    .sort((a, b) => a.path.localeCompare(b.path) || a.who.localeCompare(b.who));
}

module.exports = { TEXT_EXTS, aggregateEditing, isAllowedFile, isWithin, listTree };
