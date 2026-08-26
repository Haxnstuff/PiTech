// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const appUrl = process.env.PITECH_URL || 'http://127.0.0.1:8787';
const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
  : 'google-chrome');
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pitech-browser-'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(route, method = 'GET', parse = true) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${route}`, { method }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (!parse) return resolve(body);
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  await new Promise((resolve, reject) => {
    http.get(appUrl, (res) => { res.resume(); res.statusCode === 200 ? resolve() : reject(new Error(`PiTech returned ${res.statusCode}`)); }).on('error', reject);
  });

  const child = spawn(chrome, [
    '--headless', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-crash-reporter', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' });

  let tab;
  try {
    for (let i = 0; i < 40; i++) {
      try { await request('/json/version'); break; } catch { await wait(100); }
    }
    tab = await request(`/json/new?${encodeURIComponent(appUrl)}`, 'PUT');
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const sentFrames = [];
    const jsErrors = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
      if (message.method === 'Network.webSocketFrameSent') sentFrames.push(message.params.response.payloadData);
      if (message.method === 'Runtime.exceptionThrown') jsErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') jsErrors.push(message.params.entry.text);
    });
    await new Promise((resolve) => socket.on('open', resolve));
    const send = (method, params = {}) => new Promise((resolve) => {
      const callId = ++id;
      pending.set(callId, resolve);
      socket.send(JSON.stringify({ id: callId, method, params }));
    });
    const evaluate = async (expression) => (await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    })).result.result.value;
    const click = async (point, button = 'left') => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 });
    };

    await send('Runtime.enable');
    await send('Network.enable');
    await send('Log.enable');
    await send('Browser.setPermission', { origin: appUrl, permission: { name: 'clipboardReadWrite' }, setting: 'granted' });
    await send('Browser.setPermission', { origin: appUrl, permission: { name: 'clipboardSanitizedWrite' }, setting: 'granted' });
    await wait(2500);

    await evaluate(`(() => {
      const input = document.createElement('input');
      input.id = 'clipboard-test-input';
      input.value = 'Before Test After';
      input.style.cssText = 'position:fixed;left:20px;top:20px;width:240px;z-index:99999';
      document.body.appendChild(input);
      input.focus();
      input.setSelectionRange(7, 11);
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
      input.setSelectionRange(0, 17);
      input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 30 }));
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
          writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        },
      });
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: (command) => command === 'copy',
      });
    })()`);
    const copyPoint = await evaluate(`(() => {
      const item = [...document.querySelectorAll('#ctx-menu > .ctx-item')].find((el) => el.textContent.trim() === 'Copy');
      const r = item.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await click(copyPoint);
    await wait(150);
    assert.equal(await evaluate(`document.getElementById('toast').textContent`), 'Copied to clipboard', 'Firefox fallback must report a successful copy');

    await send('Browser.setPermission', { origin: appUrl, permission: { name: 'clipboardReadWrite' }, setting: 'denied' });
    await evaluate(`(() => {
      const input = document.getElementById('clipboard-test-input');
      input.value = 'AB';
      input.focus();
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 30 }));
      input.setSelectionRange(2, 2);
    })()`);
    const pastePoint = await evaluate(`(() => {
      const item = [...document.querySelectorAll('#ctx-menu > .ctx-item')].find((el) => el.textContent.trim() === 'Paste');
      const r = item.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await click(pastePoint);
    await wait(150);
    assert.equal(await evaluate(`document.getElementById('clipboard-test-input').value`), 'ATestB', 'input paste must use the right-click caret captured before the menu took focus');

    await evaluate(`(() => {
      window.__term.selectAll();
      const r = document.getElementById('term-wrap').getBoundingClientRect();
      document.getElementById('term-wrap').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
      window.__term.clearSelection();
      document.getElementById('term-wrap').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    })()`);
    const terminalMenuAfterSelectionClear = await evaluate(`document.getElementById('ctx-menu').classList.contains('hidden')`);
    assert.equal(terminalMenuAfterSelectionClear, false, 'Firefox right-click must preserve terminal selection for the custom menu');
    await evaluate(`document.getElementById('ctx-menu').classList.add('hidden')`);
    const before = sentFrames.length;
    const terminalPoint = await evaluate(`(() => {
      window.__term.clearSelection();
      const r = document.getElementById('term-wrap').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await click(terminalPoint, 'right');
    await wait(300);
    const pasted = sentFrames.slice(before).map((frame) => {
      try {
        const message = JSON.parse(frame);
        return message.type === 'input' ? message.data : '';
      } catch { return ''; }
    }).join('');
    assert.match(pasted, /Test/, 'ordinary terminal right-click must paste cached clipboard text');
    assert.doesNotMatch(pasted, /Before Test After/, 'terminal paste must use only the original highlighted span');
    assert.equal(await evaluate(`document.getElementById('ctx-menu').classList.contains('hidden')`), true, 'ordinary terminal right-click must not open the menu');

    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...terminalPoint, button: 'right', modifiers: 8, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...terminalPoint, button: 'right', modifiers: 8, clickCount: 1 });
    await wait(150);
    assert.equal(await evaluate(`document.getElementById('ctx-menu').classList.contains('hidden')`), false, 'Shift+right-click must open terminal actions');
    assert.equal(await evaluate(`[...document.querySelectorAll('#ctx-menu > .ctx-item')].some((el) => el.textContent.trim() === 'Paste')`), true, 'terminal actions must include Paste');

    await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
    await wait(100);
    assert.deepEqual(jsErrors, [], `browser JavaScript errors:\n${jsErrors.join('\n')}`);
    socket.close();
    console.log('PiTech clipboard browser checks passed');
  } finally {
    if (tab) await request(`/json/close/${tab.id}`, 'GET', false).catch(() => {});
    if (process.platform === 'win32') {
      const escaped = profile.replace(/'/g, "''");
      spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
    } else child.kill('SIGKILL');
    await wait(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
