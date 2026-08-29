// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { appendPaths, extractPaths, pathNotesPath } = require('../pi/scripts/path-notes');

test('extracts user-supplied Windows, UNC, home, and POSIX paths without URLs', () => {
  const text = 'Open "C:\\Program Files\\PiTech\\server.js", \\\\fileserver\\share\\notes.txt, ~/notes/today.txt, and /tmp/pitech.txt. Ignore https://example.com/a.';
  assert.deepEqual(extractPaths(text), [
    'C:\\Program Files\\PiTech\\server.js',
    '\\\\fileserver\\share\\notes.txt',
    '~/notes/today.txt',
    '/tmp/pitech.txt',
  ]);
});

test('does not mistake Pi slash commands for POSIX paths', () => {
  assert.deepEqual(extractPaths('/help C:\\Users\\jluka\\pi-webui'), ['C:\\Users\\jluka\\pi-webui']);
});

test('strips terminal control characters from captured paths', () => {
  assert.deepEqual(extractPaths('C:\\Users\\jluka\\pi-webui\\server.js\u0003'), ['C:\\Users\\jluka\\pi-webui\\server.js']);
});

test('creates Paths/paths.txt and appends each path only once', async () => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pitech-paths-'));
  const file = pathNotesPath(base);
  try {
    await appendPaths(file, ['C:\\one', 'C:\\two', 'C:\\one']);
    await appendPaths(file, ['C:\\two', 'C:\\three']);
    assert.equal(path.dirname(file), path.join(base, 'Paths'));
    assert.equal(await fs.promises.readFile(file, 'utf8'), 'C:\\one\nC:\\two\nC:\\three\n');
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});
