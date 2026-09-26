// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { findJupyter, JUPYTER_INSTALL_URL } = require('../jupyter-bridge');
const jtk = require('../public/jupyter.js');

test('highlight wraps python keywords in spans', () => {
  const html = jtk.highlight('def hello():\n    return True', 'python');
  assert.match(html, /<span class="jtk-keyword">def<\/span>/);
  assert.match(html, /<span class="jtk-keyword">return<\/span>/);
  assert.doesNotMatch(html, /<span class="jtk-keyword">hello<\/span>/);
});

test('highlight escapes html and colors comments/strings', () => {
  const html = jtk.highlight('# hi <b>x</b>\ns = "a&b"', 'python');
  assert.ok(html.includes('&lt;b&gt;'), 'must escape markup');
  assert.match(html, /<span class="jtk-comment">/);
  assert.match(html, /<span class="jtk-string">/);
});

test('highlight handles empty and unknown languages safely', () => {
  assert.equal(jtk.highlight('', 'python'), '');
  assert.equal(jtk.highlight('<&>', 'cobol'), '&lt;&amp;&gt;');
  assert.ok(jtk.highlight('if (TRUE) x <- 1', 'r').includes('jtk-keyword'));
});

test('default language is python and language list exposes it', () => {
  assert.equal(jtk.defaultLanguage(), 'python');
  assert.ok(jtk.languages().some((l) => l.id === 'python'));
  assert.ok(jtk.isValidLanguage('python'));
  assert.ok(!jtk.isValidLanguage('nope'));
});

const LANG_SAMPLES = {
  html: '<!-- note --><div class="box">hi</div>',
  css: 'body { color: #fff; margin: 0 auto; }',
  groovy: 'def x = 1\nprintln(x)',
  c: '#include <stdio.h>\nint main() { return 0; }',
  cpp: 'class A { public: void f() { return; } };',
  csharp: 'using System;\npublic class A { static void M() { var x = 1; } }',
  lua: 'local x = 10\nprint(x)',
  luau: 'local p = game.Players\nprint(p)',
  nodejs: 'const fs = require("fs");',
};

test('every panel language is valid and highlights keywords', () => {
  for (const [lang, code] of Object.entries(LANG_SAMPLES)) {
    assert.ok(jtk.isValidLanguage(lang), `${lang} must be valid`);
    const html = jtk.highlight(code, lang);
    assert.match(html, /jtk-keyword/, `${lang} must highlight keywords`);
  }
  assert.ok(jtk.languages().map((l) => l.id).includes('nodejs'));
});

test('new languages still escape html and color comments/strings', () => {
  assert.ok(jtk.highlight('s = "a&b"', 'groovy').includes('&amp;'));
  assert.ok(jtk.highlight('/* note */', 'cpp').includes('jtk-comment'));
  assert.ok(jtk.highlight('s = "hi"', 'lua').includes('jtk-string'));
  assert.ok(jtk.highlight('<!-- x -->', 'html').includes('jtk-comment'));
  assert.ok(jtk.highlight('/* c */', 'css').includes('jtk-comment'));
});

test('csharp types as keywords, css props/at-rules/numbers', () => {
  assert.match(jtk.highlight('public class A', 'csharp'), /<span class="jtk-keyword">class<\/span>/);
  const css = jtk.highlight('color: red; @media screen {}', 'css');
  assert.match(css, /jtk-keyword/, 'css properties must highlight');
  assert.match(css, /@media/);
  assert.match(jtk.highlight('margin: 10px', 'css'), /jtk-number/);
});

test('jupyter bridge detects a local jupyter install when present', () => {
  const bin = findJupyter();
  // On machines without jupyter this returns null; the panel must treat that
  // as "not installed" rather than crashing.
  if (bin) assert.ok(bin.length > 0, 'findJupyter returns a path');
  else assert.equal(bin, null);
  assert.equal(JUPYTER_INSTALL_URL, 'https://jupyter.org/install');
});