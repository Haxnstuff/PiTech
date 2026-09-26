// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { langCheck, langRun, LANG_BACKENDS } = require('../langexec');

test('language backends all declare find/ext/run', () => {
  for (const [lang, spec] of Object.entries(LANG_BACKENDS)) {
    assert.ok(Array.isArray(spec.find) && spec.find.length, `${lang} must declare find`);
    assert.ok(spec.ext, `${lang} must declare ext`);
    assert.ok(spec.run || spec.shell, `${lang} must declare run or shell`);
  }
});

test('html/css are previews, python has no exec backend', () => {
  assert.equal(langCheck('html').kind, 'preview');
  assert.equal(langCheck('css').kind, 'preview');
  assert.equal(langCheck('python').available, false);
  assert.match(langCheck('unknownlang').error, /Language is not available/);
});

test('javascript runs via node', async () => {
  const r = await langRun('javascript', 'console.log("hello " + (2 + 3)); let x = 40; console.log(x + 2);');
  assert.equal(r.ok, true);
  assert.match(r.stdout, /hello 5/);
  assert.match(r.stdout, /42/);
  assert.equal(r.code, 0);
});

test('unavailable language reports install hint', async () => {
  const r = await langRun('lua', 'print(1)');
  assert.equal(r.ok, false);
  assert.match(r.error, /Language is not available/);
});