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
const port = 9800 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pitech-notepad-'));
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
  let socket;
  try {
    for (let i = 0; i < 40; i++) {
      try { await request('/json/version'); break; } catch { await wait(100); }
    }
    tab = await request(`/json/new?${encodeURIComponent(appUrl)}`, 'PUT');
    socket = new WebSocket(tab.webSocketDebuggerUrl);
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
    const click = async (selector) => {
      const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      assert.ok(point, `missing clickable element ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const rightClick = async (selector) => {
      const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      assert.ok(point, `missing context-menu target ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', clickCount: 1 });
    };
    const clickMenuItem = async (label) => {
      const point = await evaluate(`(() => { const e = [...document.querySelectorAll('#ctx-menu > .ctx-item')].find((item) => item.textContent.trim() === ${JSON.stringify(label)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      assert.ok(point, `missing context-menu item ${label}`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const drag = async (selector, dx, dy) => {
      const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width - 8, y: r.top + r.height - 8 }; })()`);
      assert.ok(point, `missing draggable element ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + dx, y: point.y + dy, button: 'left', buttons: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + dx, y: point.y + dy, button: 'left', clickCount: 1 });
    };

    await send('Runtime.enable');
    await send('Network.enable');
    await send('Log.enable');
    await wait(2200);

    const initial = await evaluate(`(() => {
      const button = document.getElementById('notepad-btn');
      return {
        button: !!button,
        immediatelyAfterNewProject: button?.previousElementSibling?.id === 'new-project-btn',
        panel: !!document.getElementById('notepad-panel'),
      };
    })()`);
    assert.deepEqual(initial, { button: true, immediatelyAfterNewProject: true, panel: true }, 'Notepad must be wired into the existing header/panel surface');

    await click('#notepad-btn');
    await wait(250);
    assert.equal(await evaluate(`!document.getElementById('notepad-panel').classList.contains('hidden')`), true, 'Notepad button must open the panel');
    assert.equal(await evaluate(`document.activeElement?.id`), 'notepad-textarea', 'opening Notepad must focus the editor');

    const note = 'Hello world, this is a test';
    const framesBeforeNote = sentFrames.length;
    await send('Input.insertText', { text: note });
    await wait(150);
    assert.equal(await evaluate(`document.getElementById('notepad-textarea').value`), note, 'Notepad must accept text');
    const noteFrames = sentFrames.slice(framesBeforeNote).filter((frame) => {
      try { const message = JSON.parse(frame); return message.type === 'input' && message.data?.includes(note); } catch { return false; }
    });
    assert.deepEqual(noteFrames, [], 'Notepad text must not be sent to pi');

    await click('#notepad-new-tab');
    await wait(100);
    assert.equal(await evaluate(`document.querySelectorAll('.notepad-tab').length`), 2, 'New tab must create a second notepad');
    assert.equal(await evaluate(`document.querySelector('.notepad-tab.active')?.textContent.trim()`), 'Note 2', 'New tab must select the new notepad');

    await click('#notepad-rename');
    await wait(50);
    await evaluate(`(() => { const e = document.getElementById('prompt-input'); e.value = 'Research'; document.getElementById('prompt-ok').click(); })()`);
    await wait(100);
    assert.equal(await evaluate(`document.querySelector('.notepad-tab.active')?.textContent.trim()`), 'Research', 'Notepad tabs must be renameable');

    await rightClick('.notepad-tab:last-child');
    await wait(60);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#ctx-menu > .ctx-item')].map((item) => item.textContent.trim())`), ['Rename Tab', 'Delete Tab'], 'Notepad tabs must expose only rename and delete actions');
    await rightClick('#notepad-textarea');
    await wait(60);
    const editorMenuItems = await evaluate(`[...document.querySelectorAll('#ctx-menu > .ctx-item')].map((item) => item.textContent.trim())`);
    assert.equal(editorMenuItems.includes('Rename Tab'), false, 'Rename Tab must be limited to Notepad tabs');
    assert.equal(editorMenuItems.includes('Delete Tab'), false, 'Delete Tab must be limited to Notepad tabs');
    await evaluate(`document.getElementById('ctx-menu').classList.add('hidden')`);

    await rightClick('.notepad-tab:last-child');
    await clickMenuItem('Rename Tab');
    await wait(50);
    await evaluate(`(() => { const e = document.getElementById('prompt-input'); e.value = 'Scratch'; document.getElementById('prompt-ok').click(); })()`);
    await wait(100);
    assert.equal(await evaluate(`document.querySelector('.notepad-tab.active')?.textContent.trim()`), 'Scratch', 'context-menu rename must update the selected tab');

    await rightClick('.notepad-tab:last-child');
    await clickMenuItem('Delete Tab');
    await wait(60);
    assert.equal(await evaluate(`!document.getElementById('confirm-modal').classList.contains('hidden')`), true, 'Delete Tab must require confirmation');
    assert.equal(await evaluate(`document.getElementById('confirm-title').textContent`), 'Delete Tab?', 'delete confirmation must identify the tab action');
    await click('#confirm-ok');
    await wait(100);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.notepad-tab')].map((e) => e.textContent.trim())`), ['Note 1'], 'confirming Delete Tab must remove that tab');
    assert.equal(await evaluate(`document.getElementById('notepad-textarea').value`), note, 'deleting another tab must preserve the remaining note');

    const beforeMove = await evaluate(`(() => { const r = document.getElementById('notepad-panel').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    await evaluate(`(() => { const e = document.getElementById('notepad-head'); const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + 80, clientY: r.top + 12, button: 0 })); })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeMove.left + 40, y: beforeMove.top + 32, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: beforeMove.left + 40, y: beforeMove.top + 32, button: 'left', clickCount: 1 });
    await wait(80);
    const afterMove = await evaluate(`(() => { const r = document.getElementById('notepad-panel').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, saved: localStorage.getItem('pi-notepad-panel') }; })()`);
    assert.ok(afterMove.left !== beforeMove.left || afterMove.top !== beforeMove.top, 'Notepad must be movable');
    assert.ok(afterMove.saved, 'Notepad position must be persisted');

    await drag('#notepad-resize', 40, 30);
    await wait(80);
    const afterResize = await evaluate(`(() => { const r = document.getElementById('notepad-panel').getBoundingClientRect(); return { width: r.width, height: r.height, saved: localStorage.getItem('pi-notepad-panel') }; })()`);
    assert.ok(afterResize.width > beforeMove.width || afterResize.height > beforeMove.height, 'Notepad must be resizable');
    assert.ok(afterResize.saved, 'Notepad size must be persisted');

    await send('Page.reload', { ignoreCache: true });
    await wait(2200);
    await click('#notepad-btn');
    await wait(150);
    const restored = await evaluate(`(() => ({
      tabs: [...document.querySelectorAll('.notepad-tab')].map((e) => e.textContent.trim()),
      active: document.querySelector('.notepad-tab.active')?.textContent.trim(),
      value: document.getElementById('notepad-textarea').value,
      panelBg: getComputedStyle(document.getElementById('notepad-panel')).backgroundColor,
      headerBg: getComputedStyle(document.querySelector('header')).backgroundColor,
      panelText: getComputedStyle(document.getElementById('notepad-textarea')).color,
      bodyText: getComputedStyle(document.body).color,
    }))()`);
    assert.deepEqual(restored.tabs, ['Note 1'], 'notepad tabs must survive reload');
    assert.equal(restored.active, 'Note 1', 'active notepad must survive reload');
    assert.equal(restored.value, note, 'notepad text must survive reload');
    assert.equal(restored.panelBg, restored.headerBg, 'notepad panel must use the active panel theme');
    assert.equal(restored.panelText, restored.bodyText, 'notepad text must use the active text theme');

    await rightClick('.notepad-tab:first-child');
    await clickMenuItem('Delete Tab');
    await click('#confirm-ok');
    await wait(100);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.notepad-tab')].map((e) => e.textContent.trim())`), ['Note 1'], 'deleting the last tab must leave a fresh replacement tab');
    assert.equal(await evaluate(`document.getElementById('notepad-textarea').value`), '', 'the replacement tab must start empty');
    assert.deepEqual(jsErrors, [], `browser JavaScript errors:\n${jsErrors.join('\n')}`);
    socket.close();
    console.log('PiTech notepad browser checks passed');
  } finally {
    if (tab) await request(`/json/close/${tab.id}`, 'GET', false).catch(() => {});
    if (process.platform === 'win32') {
      const escaped = profile.replace(/'/g, "''");
      spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
    await wait(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
