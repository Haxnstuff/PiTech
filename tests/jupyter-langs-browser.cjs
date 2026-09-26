// PiTech by Haxnstuff
'use strict';
// All-language matrix check for the Jupyter panel: for every panel language,
// switch the dropdown, run a hello-world cell and a variable-definition cell,
// and assert the expected output renders. Requires real toolchains on PATH.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { openBrowserHarness, wait } = require('./browser-harness.cjs');

// per language: cells + expected substrings + whether the lang must be available
const CASES = {
  python: { cells: ['print("hello")\nx = 7\nprint(x)'], expect: [['hello'], ['7']] },
  javascript: { cells: ['console.log("hello");\nlet x = 7;\nconsole.log(x);'], expect: [['hello', '7']] },
  nodejs: { cells: ['console.log("hello");\nconst x = 7;\nconsole.log(x);'], expect: [['hello', '7']] },
  shell: { cells: ['echo "hello"\nx=7\necho $x'], expect: [['hello', '7']] },
  r: { cells: ['cat("hello\\n")\nx <- 7\ncat(x, "\\n")'], expect: [['hello', '7']], notExpect: ['HaxTech'], required: true },
  groovy: {
    cells: ['def x = 7\nprintln("hello")\nprintln(x)'],
    expect: [['hello', '7']], required: false, // groovy toolchain optional
  },
  c: { cells: ['#include <stdio.h>\nint main() {\n  printf("hello\\n");\n  int x = 7;\n  printf("%d\\n", x);\n  return 0;\n}'], expect: [['hello', '7']], required: true },
  cpp: { cells: ['#include <iostream>\nint main() {\n  std::cout << "hello" << std::endl;\n  int x = 7;\n  std::cout << x << std::endl;\n  return 0;\n}'], expect: [['hello', '7']], required: true },
  csharp: { cells: ['Console.WriteLine("hello");\nint x = 7;\nConsole.WriteLine(x);'], expect: [['hello', '7']], required: true },
  lua: { cells: ['print("hello")\nlocal x = 7\nprint(x)'], expect: [['hello', '7']], required: true },
  luau: { cells: ['print("hello")\nlocal x = 7\nprint(x)'], expect: [['hello', '7']], required: true },
  html: { cells: ['<h2 id="ptitle">hello preview</h2>'], expect: [['preview-ok']] },
  css: { cells: ['body { background: #eef; }'], expect: [['preview-ok']] },
};

function httpPost(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = require('node:http').request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const port = new URL(process.env.PITECH_URL || 'http://127.0.0.1:8787').port || 8787;
  const browser = await openBrowserHarness({ profilePrefix: 'pitech-jlangs-', portStart: 10500, portEnd: 10900, url: `http://127.0.0.1:${port}` });
  const { send, evaluate, jsErrors } = browser;
  try {
    await send('Runtime.enable');
    for (let i = 0; i < 40; i++) { if (await evaluate(`!!document.getElementById('jupyter-btn')`)) break; await wait(250); }
    await wait(800);
    await evaluate(`document.getElementById('jupyter-btn').click()`);
    await wait(400);

    const results = {};
    for (const [lang, spec] of Object.entries(CASES)) {
      // required = toolchain expected on this host; optional = skip politely
      const bins = { javascript: ['node'], nodejs: ['node'], shell: ['bash'], r: ['Rscript'], groovy: ['groovy'], c: ['gcc'], cpp: ['g++'], csharp: ['dotnet'], lua: ['lua'], luau: ['luau'] }[lang] || [];
      // ask the live server (it holds the toolchain PATH)
      const avail = await httpPost(port, '/api/lang/check', { lang });
      if (!avail.available && !spec.required) { results[lang] = 'skipped (no toolchain)'; continue; }
      if (!avail.available) { results[lang] = `SKIPPED-BAD (required, server says: ${avail.error})`; continue; }

      await evaluate(`(() => { const s = document.getElementById('jupyter-lang'); s.value = '${lang}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await wait(150);
      const cur = await evaluate(`document.getElementById('jupyter-lang').value`);
      assert.equal(cur, lang, `language switch to ${lang}`);

      const outTexts = [];
      for (let ci = 0; ci < spec.cells.length; ci++) {
        await evaluate(`(() => {
          const tas = [...document.querySelectorAll('.jupyter-cell .jupyter-input')];
          const ta = tas[0];
          ta.focus(); ta.select();
        })()`);
        await send('Input.insertText', { text: spec.cells[ci] });
        await wait(150);
        await evaluate(`document.querySelector('.jupyter-cell .jupyter-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`);
        await wait(1200);
        if (lang === 'html' || lang === 'css') {
          const txt = await evaluate(`(() => { const f = document.querySelector('.jupyter-out .j-preview iframe'); return f ? (f.srcdoc.includes(${JSON.stringify(spec.cells[ci])}) ? 'preview-ok' : 'SRCDOC-MISMATCH') : 'NO-PREVIEW'; })()`);
          outTexts.push(txt);
        } else {
          const txt = await evaluate(`[...document.querySelectorAll('.jupyter-cell .jupyter-out .j-o')].map((e) => e.textContent).join('\\n')`);
          outTexts.push(txt);
        }
      }
      const flat = outTexts.join('\\n');
      const errs = spec.expect.map((e) => e.every((x) => flat.includes(x)) ? 'ok' : `MISSING [${e.join(',')}] in <<${flat.slice(0, 300)}>>`);
      for (const bad of spec.notExpect || []) {
        if (flat.includes(bad)) errs.push(`output must not contain "${bad}" (console banner leaked)`);
      }
      const bad = errs.filter((e) => e !== 'ok');
      results[lang] = bad.length ? bad.join('; ') : 'ok';
      if (bad.length) results[lang] += ` | flat=<<${flat.slice(0, 200)}>>`;
    }
    for (const [lang, res] of Object.entries(results)) console.log(`  ${lang}: ${res}`);
    const failures = Object.entries(results).filter(([, v]) => v !== 'ok' && !v.startsWith('skipped'));
    assert.deepEqual(failures, [], 'all installed languages must run hello-world + variable tests');
    console.log('PiTech all-language matrix checks passed');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });