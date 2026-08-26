// PiTech by Haxnstuff
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let api = {};
try {
  api = require('../public/clipboard.js');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('falls back to the last explicit PiTech copy when browser clipboard reads are blocked', async () => {
  const clipboard = api.createClipboard?.({
    readText: async () => { throw new Error('denied'); },
    writeText: async () => { throw new Error('denied'); },
  });

  assert.ok(clipboard, 'createClipboard must return a clipboard controller');
  assert.equal(await clipboard.copy('Test'), false);
  assert.equal(await clipboard.read(), 'Test');
});

test('successful browser reads do not replace the last explicit PiTech fallback', async () => {
  let systemText = 'System text';
  let readError = null;
  const clipboard = api.createClipboard?.({
    readText: async () => {
      if (readError) throw readError;
      return systemText;
    },
    writeText: async (text) => { systemText = text; },
  });

  assert.ok(clipboard, 'createClipboard must return a clipboard controller');
  await clipboard.copy('Local text');
  systemText = 'New system text';
  assert.equal(await clipboard.read(), 'New system text');
  systemText = '';
  assert.equal(await clipboard.read(), '');
  readError = new Error('denied');
  assert.equal(await clipboard.read(), 'Local text');
});

test('uses synchronous legacy copy before Firefox async clipboard permission', async () => {
  const calls = [];
  const clipboard = api.createClipboard?.({
    preferLegacy: true,
    readText: async () => '',
    writeText: async () => { calls.push('async'); },
    fallbackCopy: () => { calls.push('legacy'); return true; },
  });

  assert.equal(await clipboard.copy('Firefox text'), true);
  assert.deepEqual(calls, ['legacy']);
});

test('uses the legacy document copy path when Firefox rejects Clipboard API writes', async () => {
  let copied = '';
  let removed = false;
  const textarea = {
    value: '',
    style: {},
    focus() {},
    select() { copied = this.value; },
    remove() { removed = true; },
  };
  const doc = {
    body: { appendChild() {} },
    createElement(tag) { assert.equal(tag, 'textarea'); return textarea; },
    execCommand(command) { assert.equal(command, 'copy'); return true; },
  };

  assert.equal(await api.createClipboard?.({
    readText: async () => { throw new Error('denied'); },
    writeText: async () => { throw new Error('denied'); },
    fallbackCopy: (text) => api.copyWithExecCommand?.(text, doc),
  }).copy('Firefox text'), true);
  assert.equal(copied, 'Firefox text');
  assert.equal(removed, true);
});

test('captures only the highlighted input span', () => {
  assert.deepEqual(
    api.captureSelection?.('Before Test After', 7, 11),
    { start: 7, end: 11, text: 'Test' }
  );
});
