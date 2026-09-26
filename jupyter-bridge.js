// PiTech by Haxnstuff
'use strict';
// PiTech Jupyter bridge — manages a real local `jupyter server` process and
// proxies a minimal slice of its REST API + kernel WebSocket channels so the
// browser panel can run code against a genuine IPython kernel.
//
// The browser never sees the jupyter token; everything goes through this
// localhost-only proxy. If jupyter is not installed, status() reports it and
// the client sends the user to https://jupyter.org/install.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

function findJupyter() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, ['jupyter'], { windowsHide: true, timeout: 10000 });
    const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.trim());
    return line ? line.trim() : null;
  } catch {
    return null;
  }
}

function createJupyterBridge({ log = () => {} } = {}) {
  const state = {
    installed: false,
    bin: null,
    proc: null,
    port: 0,
    token: null,
    starting: null, // in-flight start promise
    ready: false,
    upstreams: new Set(), // proxied kernel websockets
  };

  state.bin = findJupyter();
  state.installed = !!state.bin;

  function upstreamRequest(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = body == null ? null : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: state.port,
          path: urlPath,
          method,
          headers: {
            Authorization: `token ${state.token}`,
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          },
          timeout: 10000,
        },
        (res) => {
          let out = '';
          res.on('data', (c) => { out += c; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(out); } catch {}
            resolve({ status: res.statusCode, json });
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('upstream timeout')));
      if (data) req.write(data);
      req.end();
    });
  }

  function pollReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (!state.proc) return reject(new Error('jupyter server exited'));
        try {
          const res = await upstreamRequest('GET', '/api/status');
          if (res.status === 200) return resolve(true);
        } catch {}
        if (Date.now() > deadline) return reject(new Error('jupyter server did not become ready in time'));
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  async function start() {
    if (!state.installed) throw new Error('jupyter is not installed');
    if (state.ready) return { port: state.port };
    if (state.starting) return state.starting;
    state.starting = (async () => {
      state.token = crypto.randomBytes(24).toString('hex');
      state.port = 9000 + crypto.randomInt(1000);
      const args = [
        'server',
        '--no-browser',
        `--port=${state.port}`,
        '--port-retries=0',
        '--ip=127.0.0.1',
        `--ServerApp.token=${state.token}`,
        '--ServerApp.password=',
        '--ServerApp.disable_check_xsrf=True',
        '--ServerApp.allow_remote_access=False',
      ];
      const proc = spawn(state.bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      state.proc = proc;
      let died = null;
      proc.on('exit', (code) => {
        died = new Error(`jupyter server exited (code ${code})`);
        state.proc = null;
        state.ready = false;
        for (const ws of state.upstreams) { try { ws.close(); } catch {} }
        state.upstreams.clear();
      });
      proc.stderr.on('data', (d) => log(`[jupyter] ${String(d).trim()}`));
      try {
        await pollReady(60000);
        state.ready = true;
        log(`[pi-webui] jupyter server up on 127.0.0.1:${state.port}`);
        return { port: state.port };
      } catch (e) {
        try { proc.kill(); } catch {}
        state.proc = null;
        throw died ? new Error(died) : e;
      }
    })();
    try {
      return await state.starting;
    } finally {
      state.starting = null;
    }
  }

  function stop() {
    if (state.proc) {
      const p = state.proc;
      state.proc = null;
      state.ready = false;
      for (const ws of state.upstreams) { try { ws.close(); } catch {} }
      state.upstreams.clear();
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else p.kill('SIGKILL');
      } catch {}
      log('[pi-webui] jupyter server stopped');
    }
  }

  function status() {
    return { installed: state.installed, running: state.ready, bin: state.bin };
  }

  // REST proxy calls used by the panel. Each requires the jupyter server up.
  async function api(method, action, body) {
    if (!state.installed) return { status: 501, json: { error: 'jupyter is not installed' } };
    if (!state.ready) {
      try { await start(); } catch (e) { return { status: 502, json: { error: String(e.message || e) } }; }
    }
    try {
      if (action === 'kernelspecs') return await upstreamRequest('GET', '/api/kernelspecs');
      if (action === 'kernels' && method === 'GET') return await upstreamRequest('GET', '/api/kernels');
      if (action === 'kernels' && method === 'POST') {
        const name = body?.name || 'python3';
        return await upstreamRequest('POST', '/api/kernels', { name });
      }
      if (action.startsWith('kernel/') && method === 'DELETE') {
        const id = action.slice('kernel/'.length);
        return await upstreamRequest('DELETE', `/api/kernels/${encodeURIComponent(id)}`);
      }
      if (action.startsWith('kernel/') && method === 'GET') {
        const id = action.slice('kernel/'.length);
        return await upstreamRequest('GET', `/api/kernels/${encodeURIComponent(id)}`);
      }
      return { status: 404, json: { error: 'unknown action' } };
    } catch (e) {
      return { status: 502, json: { error: String(e.message || e) } };
    }
  }

  // Proxy a browser kernel websocket to the jupyter server's /channels ws.
  function proxyChannel(kernelId, clientSocket) {
    if (!state.ready) {
      try { clientSocket.close(1013, 'jupyter server not running'); } catch {}
      return;
    }
    const url = `ws://127.0.0.1:${state.port}/api/kernels/${encodeURIComponent(kernelId)}/channels?token=${state.token}`;
    const upstream = new WebSocket(url, { headers: { Origin: `http://127.0.0.1:${state.port}` } });
    state.upstreams.add(upstream);
    let closed = false;
    let pending = []; // client frames that arrived before the upstream handshake finished
    const finish = () => {
      if (closed) return;
      closed = true;
      state.upstreams.delete(upstream);
      try { upstream.close(); } catch {}
      try { clientSocket.close(); } catch {}
    };
    upstream.on('open', () => {
      const flush = pending;
      pending = null;
      for (const [data, isBinary] of flush) upstream.send(data, { binary: isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      if (!closed && clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data, { binary: isBinary });
    });
    upstream.on('close', finish);
    upstream.on('error', finish);
    clientSocket.on('message', (data, isBinary) => {
      if (pending) pending.push([data, isBinary]);
      else if (!closed && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });
    clientSocket.on('close', finish);
    clientSocket.on('error', finish);
  }

  process.on('exit', stop);

  return { status, start, stop, api, proxyChannel };
}

module.exports = { createJupyterBridge, findJupyter, JUPYTER_INSTALL_URL: 'https://jupyter.org/install' };