// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TEXT_EXTS, aggregateEditing, isAllowedFile, isWithin, listTree } = require('../file-tree');

test('lists one directory level with folders first and blocks paths outside the root', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pitech-tree-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Project');
  fs.writeFileSync(path.join(root, '.pitech-history.json'), '{}');
  fs.mkdirSync(path.join(root, '.pitech-trash'));
  fs.writeFileSync(path.join(base, 'secret.txt'), 'nope');

  assert.equal(isWithin(root, root), true);
  assert.equal(isWithin(root, path.join(root, 'src')), true);
  assert.equal(isWithin(root, path.join(base, 'secret.txt')), false);
  assert.deepEqual((await listTree(root, root)).map(({ name, type }) => ({ name, type })), [
    { name: 'src', type: 'directory' },
    { name: 'README.md', type: 'file' },
  ]);
  await assert.rejects(() => listTree(root, path.join(base, 'secret.txt')), /outside the active workspace/);

  fs.rmSync(base, { recursive: true, force: true });
});

test('file guard allows text files under a root and rejects everything else', () => {
  const roots = ['C:/work', 'C:/Users/x/.pi/agent'];
  assert.equal(isAllowedFile(roots, 'C:/work/src/app.js'), true);
  assert.equal(isAllowedFile(roots, 'C:/Users/x/.pi/agent/extensions/pi-webui.ts'), true);
  assert.equal(isAllowedFile(roots, 'C:/work/pic.png'), false); // binary extension
  assert.equal(isAllowedFile(roots, 'C:/elsewhere/notes.md'), false); // outside roots
  assert.equal(isAllowedFile(roots, 'C:/work'), false); // the root itself
  assert.equal(isAllowedFile(roots, ''), false);
  assert.ok(TEXT_EXTS.includes('.md'));
});

test('aggregates main and subagent edit activity while dropping expired entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitech-editing-'));
  const now = 1_000_000;
  fs.writeFileSync(path.join(dir, 'webui-editing-10.json'), JSON.stringify({
    ts: now,
    who: 'pi',
    files: ['C:/work/a.js'],
  }));
  fs.writeFileSync(path.join(dir, 'webui-editing-11.json'), JSON.stringify({
    ts: now,
    who: 'sub',
    files: ['C:/work/a.js', 'C:/work/b.js'],
  }));
  fs.writeFileSync(path.join(dir, 'webui-editing-12.json'), JSON.stringify({
    ts: now - 61_000,
    who: 'pi',
    files: ['C:/work/stale.js'],
  }));

  assert.deepEqual(await aggregateEditing(dir, now), [
    { path: path.normalize('C:/work/a.js'), who: 'pi' },
    { path: path.normalize('C:/work/a.js'), who: 'sub' },
    { path: path.normalize('C:/work/b.js'), who: 'sub' },
  ]);

  fs.rmSync(dir, { recursive: true, force: true });
});
