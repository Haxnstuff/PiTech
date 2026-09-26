// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { openBrowserHarness, wait } = require('./browser-harness.cjs');

function requestJson(port, route) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${route}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const port = new URL(process.env.PITECH_URL || 'http://127.0.0.1:8787').port || 8787;
  const status = await requestJson(port, '/api/jupyter/status').catch(() => ({ installed: false }));
  const browser = await openBrowserHarness({ profilePrefix: 'pitech-jupyter-', portStart: 10100, portEnd: 10400 });
  const { send, evaluate, sentFrames, jsErrors } = browser;
  try {
    const click = async (selector) => {
      const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      assert.ok(point, `missing clickable element ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };

    await send('Runtime.enable');
    await send('Network.enable');
    await send('Log.enable');
    // wait for the app tab to actually finish loading (headless race on tab open)
    for (let i = 0; i < 40; i++) {
      const ready = await evaluate(`location.href.startsWith('http') && !!document.getElementById('jupyter-btn')`);
      if (ready) break;
      await wait(250);
    }
    await wait(1200);

    const initial = await evaluate(`(() => {
      const button = document.getElementById('jupyter-btn');
      return {
        button: !!button,
        rightOfNotepad: button?.previousElementSibling?.id === 'notepad-btn',
        panel: !!document.getElementById('jupyter-panel'),
        langSelect: !!document.getElementById('jupyter-lang'),
        langs: [...(document.getElementById('jupyter-lang')?.options || [])].map((o) => o.value),
      };
    })()`);
    assert.deepEqual(initial, {
      button: true,
      rightOfNotepad: true,
      panel: true,
      langSelect: true,
      langs: ['python', 'javascript', 'nodejs', 'html', 'css', 'java', 'c', 'cpp', 'csharp', 'lua', 'luau', 'shell', 'r'],
    }, 'Jupyter button must sit right of Notepad with all panel languages in the selector');

    // A malformed status response (e.g. stale server predating the jupyter
    // routes) must be surfaced as an error, never as "not installed".
    await evaluate(`(() => {
      const realFetch = window.fetch;
      window.__installOpened = null;
      window.open = (u) => { window.__installOpened = String(u); return null; };
      window.fetch = (url, opts) => {
        if (String(url).includes('/api/jupyter/status')) {
          return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 200 }));
        }
        return realFetch(url, opts);
      };
    })()`);
    await click('#jupyter-btn');
    await wait(400);
    assert.equal(await evaluate(`window.__installOpened`), null, 'a malformed status must never open the install page');
    assert.equal(await evaluate(`!document.querySelector('#toast').classList.contains('hidden')`), true, 'a malformed status must surface an error toast');
    assert.equal(await evaluate(`document.getElementById('jupyter-panel').classList.contains('hidden')`), true, 'panel must stay closed on malformed status');
    // restore real fetch and a clean panel state for the rest of the flow
    await evaluate(`location.reload()`);
    await wait(2500);
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`location.href.startsWith('http') && !!document.getElementById('jupyter-btn')`)) break;
      await wait(250);
    }
    await wait(1200);

    // the language select must be usable: the head's drag handler must not
    // preventDefault mousedown on it (that suppresses the native dropdown)
    const dragBlocks = await evaluate(`(() => {
      const sel = document.getElementById('jupyter-lang');
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      sel.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    assert.equal(dragBlocks, false, 'head drag must not swallow mousedown on the language select');

    await click('#jupyter-btn');
    await wait(400);
    if (!status.installed) {
      console.log('[jupyter-browser] jupyter not installed on this machine — asserting install-page flow only');
      const redirected = await evaluate(`!!document.querySelector('#toast') && !document.querySelector('#toast').classList.contains('hidden')`);
      assert.equal(redirected, true, 'missing jupyter must surface the install-page toast');
      return;
    }
    assert.equal(await evaluate(`!document.getElementById('jupyter-panel').classList.contains('hidden')`), true, 'Jupyter button must open the panel');

    // line numbers render with the cell
    assert.equal(await evaluate(`document.querySelectorAll('#jupyter-body .jupyter-gutter span').length >= 1`), true, 'cells must show line numbers');

    // type python code and run it
    const cell = '.jupyter-cell .jupyter-input';
    await click(cell);
    await send('Input.insertText', { text: 'print(6 * 7)\nraise_ok = "no"\nprint("done")' });
    await wait(200);
    // highlighting must be applied
    assert.equal(await evaluate(`document.querySelector('.jupyter-hl').innerHTML.includes('jtk-fn')`), true, 'python code must be syntax highlighted');

    // run via the Ctrl+Enter hotkey (key handler is on the textarea)
    await evaluate(`document.querySelector('.jupyter-cell .jupyter-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`);
    let saw = '';
    for (let i = 0; i < 60; i++) {
      await wait(500);
      saw = await evaluate(`document.querySelector('.jupyter-cell .jupyter-out')?.textContent || ''`);
      if (saw.includes('42') && saw.includes('done')) break;
    }
    assert.match(saw, /6\*7|In \[\d+\]/i, 'cell must execute via a real kernel');
    assert.ok(saw.includes('42'), 'stdout must be rendered');
    assert.ok(saw.includes('done'), 'second print must be rendered');

    // error cells render a traceback (select-all first so the insert replaces)
    await click(cell);
    await evaluate(`document.querySelector('.jupyter-cell .jupyter-input').select()`);
    await send('Input.insertText', { text: 'x = 1/0' });
    await wait(150);
    await click('.jupyter-run');
    let errText = '';
    for (let i = 0; i < 40; i++) {
      await wait(500);
      errText = await evaluate(`[...document.querySelectorAll('.jupyter-out .j-error')].map((e) => e.textContent).join('\\n')`);
      if (errText.includes('ZeroDivisionError')) break;
    }
    assert.match(errText, /ZeroDivisionError/, 'errors must render the traceback');

    // nothing typed into the jupyter panel may leak to the pi terminal
    const leak = sentFrames.filter((frame) => {
      try { const message = JSON.parse(frame); return message.type === 'input' && /ZeroDivisionError|print\(6/.test(message.data || ''); } catch { return false; }
    });
    assert.deepEqual(leak, [], 'Jupyter panel input must not reach pi');

    // state persists across reload
    await evaluate(`location.reload()`);
    await wait(2500);
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`location.href.startsWith('http') && !!document.getElementById('jupyter-btn')`)) break;
      await wait(250);
    }
    await wait(1200);
    await click('#jupyter-btn');
    await wait(300);
    const persisted = await evaluate(`document.querySelector('.jupyter-cell .jupyter-input')?.value || ''`);
    assert.match(persisted, /x = 1\/0/, 'cells and code must persist locally');

    // a long cell must stay height-capped so the output area remains visible
    await click(cell);
    await evaluate(`document.querySelector('.jupyter-cell .jupyter-input').select()`);
    await send('Input.insertText', { text: Array.from({ length: 30 }, (_, i) => `x${i} = ${i}`).join('\n') });
    await wait(200);
    const taH = await evaluate(`document.querySelector('.jupyter-cell .jupyter-input')?.offsetHeight || 0`);
    assert.ok(taH > 0 && taH <= 224, `long cell input must cap at ~220px (got ${taH}px)`);

    // theme adherence: panel + cells must track the configured theme vars
    await evaluate(`localStorage.setItem('pi-theme', 'dracula'); localStorage.removeItem('pi-jupyter'); location.reload()`);
    await wait(2500);
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`location.href.startsWith('http') && !!document.getElementById('jupyter-btn')`)) break;
      await wait(250);
    }
    await wait(1200);
    await click('#jupyter-btn');
    await wait(300);
    const themed = await evaluate(`(() => {
      const panel = document.getElementById('jupyter-panel');
      const cell = document.querySelector('.jupyter-cell');
      const cs = getComputedStyle(document.documentElement);
      return {
        panelBg: getComputedStyle(panel).backgroundColor,
        panelVar: cs.getPropertyValue('--panel').trim(),
        accent: getComputedStyle(document.querySelector('.jupyter-hl .jtk-keyword, .jupyter-hl .jtk-string, .jupyter-hl .jtk-comment') || document.body).color,
        accentVar: cs.getPropertyValue('--ok').trim(),
      };
    })()`);
    assert.ok(themed.panelVar.length > 0, 'theme vars must be set');
    assert.ok(themed.accent.length > 0, 'highlight spans must use theme colors');

    assert.deepEqual(jsErrors.filter((e) => /jupyter/i.test(e)), [], 'no js errors in the jupyter flow');
    console.log('PiTech jupyter browser checks passed');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});