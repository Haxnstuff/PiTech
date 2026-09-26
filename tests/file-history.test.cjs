// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFileHistory } = require('../file-history');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitech-history-'));
  const journalPath = path.join(root, '.pitech-history.json');
  const trashDir = path.join(root, '.pitech-trash');
  const allowedRoot = path.join(root, 'allowed');
  fs.mkdirSync(allowedRoot);
  const isAllowedPath = (value) => {
    const resolved = path.resolve(value);
    return resolved === path.resolve(trashDir)
      || resolved.startsWith(path.resolve(trashDir) + path.sep)
      || resolved === path.resolve(allowedRoot)
      || resolved.startsWith(path.resolve(allowedRoot) + path.sep);
  };
  const history = (overrides = {}) => createFileHistory({ journalPath, trashDir, isAllowedPath, ...overrides });
  return { root, journalPath, trashDir, allowedRoot, history, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('file text edits undo, redo, and survive a history reload', async () => {
  const f = fixture();
  const file = path.join(f.allowedRoot, 'note.txt');
  fs.writeFileSync(file, 'before');
  try {
    const first = f.history();
    await first.writeText(file, 'after', 'edit note.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'after');
    assert.deepEqual(first.status(), { canUndo: true, canRedo: false });

    const reloaded = f.history();
    assert.deepEqual(reloaded.status(), { canUndo: true, canRedo: false });
    assert.equal((await reloaded.undo()).label, 'edit note.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'before');
    assert.deepEqual(reloaded.status(), { canUndo: false, canRedo: true });

    const afterUndoReload = f.history();
    assert.equal((await afterUndoReload.redo()).label, 'edit note.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  } finally {
    f.close();
  }
});

test('grouped deletion restores every path as one undoable action', async () => {
  const f = fixture();
  const file = path.join(f.allowedRoot, 'one.txt');
  const folder = path.join(f.allowedRoot, 'folder');
  fs.writeFileSync(file, 'one');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'two.txt'), 'two');
  try {
    const history = f.history();
    const result = await history.deletePaths([file, folder], 'delete 2 selected items');
    assert.equal(result.label, 'delete 2 selected items');
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(folder), false);

    await history.undo();
    assert.equal(fs.readFileSync(file, 'utf8'), 'one');
    assert.equal(fs.readFileSync(path.join(folder, 'two.txt'), 'utf8'), 'two');

    await history.redo();
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(folder), false);
  } finally {
    f.close();
  }
});

test('deletion chooses trash beside each configured source root', async () => {
  const f = fixture();
  const alternateRoot = path.join(f.allowedRoot, 'alternate');
  const alternateTrash = path.join(alternateRoot, '.pitech-trash');
  const file = path.join(alternateRoot, 'note.txt');
  fs.mkdirSync(alternateRoot);
  fs.writeFileSync(file, 'keep');
  try {
    const history = f.history({ trashForPath: () => alternateTrash });
    await history.deletePaths([file]);
    const journal = JSON.parse(fs.readFileSync(f.journalPath, 'utf8'));
    const destination = journal.undo[0].operations[0].to;
    assert.equal(destination.startsWith(alternateTrash + path.sep), true);
    assert.equal(fs.existsSync(file), false);
    await history.undo();
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  } finally {
    f.close();
  }
});

test('a new action after undo clears redo', async () => {
  const f = fixture();
  const file = path.join(f.allowedRoot, 'note.txt');
  fs.writeFileSync(file, 'one');
  try {
    const history = f.history();
    await history.writeText(file, 'two', 'first edit');
    await history.undo();
    await history.writeText(file, 'three', 'replacement edit');
    assert.deepEqual(history.status(), { canUndo: true, canRedo: false });
    const result = await history.redo();
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'three');
  } finally {
    f.close();
  }
});

test('dependent move and write operations execute atomically', async () => {
  const f = fixture();
  const source = path.join(f.allowedRoot, 'Old Project');
  const destination = path.join(f.allowedRoot, 'New Project');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'project.md'), '# Project: Old Project\n');
  try {
    const history = f.history();
    await history.perform('rename project', [
      { kind: 'move', from: source, to: destination },
      { kind: 'write', path: path.join(destination, 'project.md'), before: '# Project: Old Project\n', after: '# Project: New Project\n' },
    ]);
    assert.equal(fs.readFileSync(path.join(destination, 'project.md'), 'utf8'), '# Project: New Project\n');
    await history.undo();
    assert.equal(fs.readFileSync(path.join(source, 'project.md'), 'utf8'), '# Project: Old Project\n');
  } finally {
    f.close();
  }
});

test('copy plus manifest write undo and redo as one action', async () => {
  const f = fixture();
  const source = path.join(f.allowedRoot, 'source.jsonl');
  const destination = path.join(f.allowedRoot, 'project', 'session.jsonl');
  const manifest = path.join(f.allowedRoot, 'project', 'project.md');
  fs.mkdirSync(path.dirname(destination));
  fs.writeFileSync(source, '{"session":true}\n');
  fs.writeFileSync(manifest, 'before\n');
  fs.copyFileSync(source, destination);
  fs.writeFileSync(manifest, 'after\n');
  try {
    const history = f.history();
    await history.recordApplied('copy session into project', [
      { kind: 'copy', from: source, to: destination },
      { kind: 'write', path: manifest, before: 'before\n', after: 'after\n' },
    ]);
    await history.undo();
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readFileSync(manifest, 'utf8'), 'before\n');
    await history.redo();
    assert.equal(fs.readFileSync(destination, 'utf8'), '{"session":true}\n');
    assert.equal(fs.readFileSync(manifest, 'utf8'), 'after\n');
  } finally {
    f.close();
  }
});

test('undo refuses to delete a copied file changed after the action', async () => {
  const f = fixture();
  const source = path.join(f.allowedRoot, 'source.jsonl');
  const destination = path.join(f.allowedRoot, 'copy.jsonl');
  fs.writeFileSync(source, 'original');
  fs.copyFileSync(source, destination);
  try {
    const history = f.history();
    await history.recordApplied('copy session', [{ kind: 'copy', from: source, to: destination }]);
    fs.writeFileSync(destination, 'edited later');
    await assert.rejects(() => history.undo(), /changed since/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'edited later');
    assert.deepEqual(history.status(), { canUndo: true, canRedo: false });
  } finally {
    f.close();
  }
});

test('history restores a metadata file that did not exist before an action', async () => {
  const f = fixture();
  const file = path.join(f.allowedRoot, 'metadata.json');
  fs.writeFileSync(file, '{"folder":"Research"}');
  try {
    const history = f.history();
    await history.recordApplied('organize session', [
      { kind: 'write', path: file, before: null, after: '{"folder":"Research"}' },
    ]);
    await history.undo();
    assert.equal(fs.existsSync(file), false);
    await history.redo();
    assert.equal(fs.readFileSync(file, 'utf8'), '{"folder":"Research"}');
  } finally {
    f.close();
  }
});

test('stale file contents block undo without changing history', async () => {
  const f = fixture();
  const file = path.join(f.allowedRoot, 'note.txt');
  fs.writeFileSync(file, 'before');
  try {
    const history = f.history();
    await history.writeText(file, 'after', 'edit note');
    fs.writeFileSync(file, 'external change');
    await assert.rejects(() => history.undo(), /changed since/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'external change');
    assert.deepEqual(history.status(), { canUndo: true, canRedo: false });
  } finally {
    f.close();
  }
});

test('paths outside configured roots are rejected', async () => {
  const f = fixture();
  const outside = path.join(f.root, 'outside.txt');
  fs.writeFileSync(outside, 'safe');
  try {
    const history = f.history();
    await assert.rejects(() => history.writeText(outside, 'unsafe'), /not allowed/);
    await assert.rejects(() => history.deletePaths([outside]), /not allowed/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'safe');
    assert.deepEqual(history.status(), { canUndo: false, canRedo: false });
  } finally {
    f.close();
  }
});

test('external transactions are serialized before their filesystem work starts', async () => {
  const f = fixture();
  let active = 0;
  let peak = 0;
  try {
    const history = f.history();
    const run = (id) => history.recordTransaction(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { label: `transaction ${id}`, operations: [], value: { id } };
    });
    const results = await Promise.all([run(1), run(2)]);
    assert.equal(peak, 1);
    assert.deepEqual(results.map((result) => result.id), [1, 2]);
  } finally {
    f.close();
  }
});

test('concurrent undo requests serialize across distinct history entries', async () => {
  const f = fixture();
  const file = path.join(f.allowedRoot, 'note.txt');
  fs.writeFileSync(file, 'one');
  try {
    const history = f.history();
    await history.writeText(file, 'two', 'first edit');
    await history.writeText(file, 'three', 'second edit');
    await Promise.all([history.undo(), history.undo()]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'one');
    assert.deepEqual(history.status(), { canUndo: false, canRedo: true });
  } finally {
    f.close();
  }
});

test('tampered persisted operations cannot escape allowed roots', async () => {
  const f = fixture();
  const outside = path.join(f.root, 'outside.txt');
  fs.writeFileSync(outside, 'after');
  fs.writeFileSync(f.journalPath, JSON.stringify({
    undo: [{
      id: 'tampered',
      label: 'tampered action',
      timestamp: new Date().toISOString(),
      operations: [{ kind: 'write', path: outside, before: 'before', after: 'after' }],
    }],
    redo: [],
  }));
  try {
    const history = f.history();
    await assert.rejects(() => history.undo(), /not allowed/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'after');
    assert.deepEqual(history.status(), { canUndo: true, canRedo: false });
  } finally {
    f.close();
  }
});

test('transaction callback rollback is not repeated after journal failure already reverses the action', async () => {
  const f = fixture();
  const source = path.join(f.allowedRoot, 'source.txt');
  const destination = path.join(f.allowedRoot, 'destination.txt');
  fs.writeFileSync(source, 'source');
  const blockedParent = path.join(f.root, 'blocked-transaction-parent');
  const history = createFileHistory({
    journalPath: path.join(blockedParent, 'history.json'),
    trashDir: f.trashDir,
    isAllowedPath: (value) => path.resolve(value).startsWith(path.resolve(f.allowedRoot) + path.sep)
      || path.resolve(value).startsWith(path.resolve(f.trashDir) + path.sep),
  });
  fs.writeFileSync(blockedParent, 'blocks journal directory');
  let rollbackCalls = 0;
  try {
    await assert.rejects(() => history.recordTransaction(async () => {
      fs.copyFileSync(source, destination);
      return {
        label: 'copy file transaction',
        operations: [{ kind: 'copy', from: source, to: destination }],
        rollback: async () => { rollbackCalls += 1; fs.rmSync(destination, { force: true }); },
      };
    }), /journal|directory|ENOTDIR/i);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(rollbackCalls, 0, 'history already reversed the applied copy');
  } finally {
    f.close();
  }
});

test('journal failure reverses an already applied action', async () => {
  const f = fixture();
  const source = path.join(f.allowedRoot, 'source.txt');
  const destination = path.join(f.allowedRoot, 'destination.txt');
  fs.writeFileSync(source, 'source');
  fs.copyFileSync(source, destination);
  const blockedParent = path.join(f.root, 'blocked-parent');
  const history = createFileHistory({
    journalPath: path.join(blockedParent, 'history.json'),
    trashDir: f.trashDir,
    isAllowedPath: (value) => path.resolve(value).startsWith(path.resolve(f.allowedRoot) + path.sep)
      || path.resolve(value).startsWith(path.resolve(f.trashDir) + path.sep),
  });
  fs.writeFileSync(blockedParent, 'blocks journal directory');
  try {
    await assert.rejects(() => history.recordApplied('copy file', [{ kind: 'copy', from: source, to: destination }]), /journal|directory|ENOTDIR/i);
    assert.equal(fs.existsSync(destination), false, 'failed journal recording must reverse the copy');
  } finally {
    f.close();
  }
});
