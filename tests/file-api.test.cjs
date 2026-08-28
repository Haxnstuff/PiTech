// PiTech by Haxnstuff
'use strict';

// End-to-end check of the in-browser file explorer API against a running server:
//   node tests/file-api.test.cjs  (expects PiTech on http://127.0.0.1:8787)

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const BASE = process.env.PITECH_URL || 'http://127.0.0.1:8787';
const AGENT = path.join(os.homedir(), '.pi', 'agent');

(async () => {
  let r;
  let j;
  // 1. the explorer must use Pi-owned roots, not the last process cwd.
  r = await fetch(`${BASE}/api/state`);
  j = await r.json();
  assert.equal(path.normalize(j.fileRoot), path.normalize(AGENT));
  assert.deepEqual(j.fileRoots.map((root) => root.id), ['agent', 'shared', 'pitech']);

  r = await fetch(`${BASE}/api/tree?root=agent`);
  j = await r.json();
  assert.equal(r.status, 200, `list Pi root: ${JSON.stringify(j)}`);
  assert.equal(path.normalize(j.root), path.normalize(AGENT));

  // 2. a pi-internal file is viewable.
  const ext = path.join(AGENT, 'extensions', 'spotify.ts');
  r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(ext)}`);
  j = await r.json();
  assert.equal(r.status, 200, `view pi file: ${JSON.stringify(j)}`);
  assert.equal(j.path, path.normalize(ext));

  // 3. save round-trip
  const scratch = path.join(AGENT, 'scripts', 'webui-save-test.tmp.md');
  r = await fetch(`${BASE}/api/file/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: scratch, text: 'hello v1\n' }),
  });
  assert.deepEqual(await r.json(), { ok: true });
  j = await (await fetch(`${BASE}/api/file?path=${encodeURIComponent(scratch)}`)).json();
  assert.equal(j.text, 'hello v1\n');

  r = await fetch(`${BASE}/api/file/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: scratch, text: 'hello v2\n' }),
  });
  assert.deepEqual(await r.json(), { ok: true });
  j = await (await fetch(`${BASE}/api/file?path=${encodeURIComponent(scratch)}`)).json();
  assert.equal(j.text, 'hello v2\n');

  // 4. guards still hold: outside roots rejected for both read and write
  r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(path.join(os.homedir(), 'not-a-root.md'))}`);
  assert.equal(r.status, 400);
  r = await fetch(`${BASE}/api/file/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path.join(os.tmpdir(), 'webui-evil.js'), text: 'x' }),
  });
  assert.equal(r.status, 400);

  console.log('file-api: ALL PASS');
  require('node:fs').rmSync(scratch, { force: true });
})().catch((e) => {
  console.error('file-api FAIL:', e.message);
  process.exit(1);
});
