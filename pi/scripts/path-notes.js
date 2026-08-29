// PiTech by Haxnstuff
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PATH_START = /(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/(?!\/))/g;
const TRAILING = /[.,;!?)}\]]+$/;

function pathNotesPath(agentDir) {
  return path.join(agentDir, 'Paths', 'paths.txt');
}

function cleanPath(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(TRAILING, '');
}

function looksLikePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /^~[\\/]/.test(value)
    || /^\.{1,2}[\\/]/.test(value)
    || /^\/(?!\/)/.test(value);
}

function extractPaths(text) {
  const input = String(text || '');
  const found = [];
  const seen = new Set();
  const add = (value) => {
    const item = cleanPath(value);
    if (!item || /^https?:\/\//i.test(item) || !looksLikePath(item)) return;
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(item);
  };
  const masked = input.replace(/(["'`])((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/(?!\/))[\s\S]*?)\1/g, (whole, _quote, value) => {
    add(value);
    return ' '.repeat(whole.length);
  });
  const command = masked.match(/^\s*\/[A-Za-z][A-Za-z0-9_-]*/);
  const commandStart = command ? masked.search(/\S/) : -1;
  const commandEnd = commandStart >= 0 ? commandStart + command[0].trim().length : -1;
  for (const match of masked.matchAll(PATH_START)) {
    const index = match.index || 0;
    if (index >= commandStart && index < commandEnd) continue;
    if (index > 0 && /[A-Za-z0-9_.~:/\\-]/.test(masked[index - 1])) continue;
    const rest = masked.slice(index);
    add(rest.match(/^[^\s"'`<>|]+/)?.[0] || '');
  }
  return found;
}

async function appendPaths(file, values) {
  const incoming = Array.isArray(values) ? values : extractPaths(values);
  if (!incoming.length) return [];
  await fs.mkdir(path.dirname(file), { recursive: true });
  let lines = [];
  try { lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean); } catch {}
  const seen = new Set(lines.map((item) => item.toLowerCase()));
  const added = [];
  for (const value of incoming) {
    const item = cleanPath(value);
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    lines.push(item);
    added.push(item);
  }
  if (added.length) await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return added;
}

module.exports = { appendPaths, extractPaths, pathNotesPath };
