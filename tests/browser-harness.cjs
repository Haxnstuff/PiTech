// PiTech by Haxnstuff
'use strict';

const { randomInt } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const appUrl = process.env.PITECH_URL || 'http://127.0.0.1:8787';
const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? path.join(process.env.PROGRAMFILES || String.raw`C:\Program Files`, 'Google', 'Chrome', 'Application', 'chrome.exe')
  : 'google-chrome');
const powershell = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(port, route, method = 'GET', parse = true) {
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

async function openBrowserHarness({ profilePrefix, portStart, portEnd }) {
  await new Promise((resolve, reject) => {
    http.get(appUrl, (res) => {
      res.resume();
      res.statusCode === 200 ? resolve() : reject(new Error(`PiTech returned ${res.statusCode}`));
    }).on('error', reject);
  });

  const port = randomInt(portStart, portEnd);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));
  const child = spawn(chrome, [
    '--headless', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-crash-reporter', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' });
  let tab;
  let socket;

  const close = async () => {
    if (tab) await request(port, `/json/close/${tab.id}`, 'GET', false).catch(() => {});
    socket?.close();
    if (process.platform === 'win32') {
      const escaped = profile.replaceAll("'", "''");
      spawnSync(powershell, ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
    } else if (!child.killed) child.kill('SIGKILL');
    await wait(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        await request(port, '/json/version');
        ready = true;
        break;
      } catch {
        await wait(100);
      }
    }
    if (!ready) throw new Error('Chrome remote debugging did not start');

    tab = await request(port, `/json/new?${encodeURIComponent(appUrl)}`, 'PUT');
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
    await new Promise((resolve) => socket.once('open', resolve));

    const send = (method, params = {}) => new Promise((resolve) => {
      const callId = ++id;
      pending.set(callId, resolve);
      socket.send(JSON.stringify({ id: callId, method, params }));
    });
    const evaluate = async (expression) => (await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    })).result.result.value;
    const clickPoint = async (point, button = 'left') => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 });
    };

    return { appUrl, port, profile, child, tab, socket, sentFrames, jsErrors, send, evaluate, clickPoint, close };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { openBrowserHarness, wait };
