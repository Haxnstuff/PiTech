// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const base = process.env.PITECH_URL || 'http://127.0.0.1:8787';
function request(route, method = 'GET', body) {
  const url = new URL(route, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function post(route, body) {
  const result = await request(route, 'POST', body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body;
}

test('conversation API persists folder, rename, and pin metadata', async () => {
  const initial = (await request('/api/state')).body;
  const session = initial.conversations?.[0];
  assert.ok(session?.path, 'PiTech must expose at least one global conversation');
  const folder = `Browser checks ${Date.now()}`;
  const title = `Renamed browser check ${Date.now()}`;
  const originalTitle = initial.pins?.conversationNames?.[session.path] ?? null;
  await post('/api/conversations/folders', { action: 'create', name: folder });
  try {
    await post('/api/conversations/organize', { path: session.path, title, folder });
    await post('/api/pin', { list: 'conversations', name: session.path, pin: true });
    const changed = (await request('/api/state')).body;
    const row = changed.conversations.find((item) => item.path === session.path);
    assert.equal(row.title, title);
    assert.equal(row.folder, folder);
    assert.equal(row.pinned, true);
    assert.equal(changed.conversations[0].path, session.path, 'pinned conversations must sort to the top');
    assert.ok(changed.conversationFolders.some((item) => item.name === folder));
  } finally {
    await post('/api/pin', { list: 'conversations', name: session.path, pin: false }).catch(() => {});
    await post('/api/conversations/organize', { path: session.path, title: originalTitle, folder: null }).catch(() => {});
    await post('/api/conversations/folders', { action: 'delete', name: folder }).catch(() => {});
  }
});

test('creates file folders inside the selected file root', async () => {
  const name = `.pitech-file-folder-${Date.now()}`;
  const projectRoot = path.join(__dirname, '..');
  const projectFolder = path.join(projectRoot, name);
  const contextFolder = path.join(process.env.USERPROFILE || process.env.HOME, '.pi', 'agent', 'Context', name);
  try {
    await post('/api/fs/new-folder', { root: 'pitech', name });
    assert.equal(fs.existsSync(projectFolder), true);
    assert.equal(fs.statSync(projectFolder).isDirectory(), true);
  } finally {
    fs.rmSync(projectFolder, { recursive: true, force: true });
    fs.rmSync(contextFolder, { recursive: true, force: true });
  }
});

test('renames files inside the selected file root', async () => {
  const root = path.join(__dirname, '..');
  const source = path.join(root, `.pitech-rename-${Date.now()}.txt`);
  const name = `.pitech-renamed-${Date.now()}.txt`;
  const target = path.join(root, name);
  fs.writeFileSync(source, '');
  try {
    await post('/api/fs/rename', { path: source, name });
    assert.equal(fs.existsSync(target), true);
  } finally {
    fs.rmSync(source, { force: true });
    fs.rmSync(target, { force: true });
  }
});

test('records paths sent through the PiTech terminal in Paths/paths.txt', async () => {
  const file = path.join(process.env.USERPROFILE || process.env.HOME, '.pi', 'agent', 'Paths', 'paths.txt');
  const marker = `C:\\Users\\jluka\\pi-webui\\api-path-${Date.now()}.txt`;
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const socket = new WebSocket(new URL('/ws', base));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket path test timed out')), 5000);
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'input', data: marker }));
      setTimeout(() => {
        socket.send(JSON.stringify({ type: 'input', data: '\u0003' }));
        clearTimeout(timer);
        socket.close();
        resolve();
      }, 150);
    });
    socket.once('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  try {
    assert.ok(now.split(/\r?\n/).includes(marker));
  } finally {
    fs.writeFileSync(file, old);
    assert.equal(fs.readFileSync(file, 'utf8'), old, 'the live test must leave path notes unchanged');
  }
});
