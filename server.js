// PiTech by Haxnstuff
'use strict';
// PiTech — local hidden server. Spawns the real `pi` CLI inside a PowerShell PTY
// and streams it to the browser over WebSocket. Serves the UI + a small REST API
// (projects, sessions, skills, MCP) for the sidebars and panels.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');
const pty = require('node-pty');
const { aggregateEditing, isAllowedFile, listTree } = require('./file-tree');
const { migrateSessions } = require('./conversation-store');
const {
  normalizeConversationMeta,
  createFolder,
  renameFolder,
  deleteFolder,
  moveConversation,
  renameConversation,
  decorateConversations,
  serializeConversationMeta,
} = require('./conversation-meta');
const { appendPaths, pathNotesPath } = require('./pi/scripts/path-notes');
const { createJupyterBridge, JUPYTER_INSTALL_URL } = require('./jupyter-bridge');
const { langCheck, langRun } = require('./langexec');

const jupyterBridge = createJupyterBridge({ log: (m) => console.log(m) });

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const AGENT = path.join(os.homedir(), '.pi', 'agent');
const SESSIONS_DIR = path.join(AGENT, 'sessions');
const CONVERSATIONS_DIR = path.join(AGENT, 'conversations');
const CONTEXT_DIR = path.join(AGENT, 'context');
const PATHS_FILE = pathNotesPath(AGENT);
const STATE_FILE = path.join(AGENT, 'webui-state-pitech.json');
const MCP_FILE = path.join(AGENT, 'mcp.json');

let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
const config = Object.assign(
  {
    port: 8787,
    shell: 'pwsh',
    shellArgs: null,
    piCommand: 'pi',
    cwd: os.homedir(),
    bufferKb: 256,
    openBrowser: process.env.PI_NO_OPEN !== '1',
  },
  fileConfig,
  { port: Number(process.env.PI_WEBUI_PORT) || fileConfig.port || 8787 }
);

// ---------------- shared projects lib ----------------
let projLib = null;
async function getProjLib() {
  if (!projLib) projLib = await import(pathToFileURL(path.join(AGENT, 'scripts', 'projects.mjs')).href);
  return projLib;
}

// ---------------- PTY ----------------
const clients = new Set();
let ptyProc = null;
let epoch = 0;
let restarting = false;
let lastSize = { cols: 80, rows: 24 };
const buffer = []; // ring of { epoch, data }
const bufferMax = config.bufferKb * 1024;
let bufferBytes = 0;

// Kill the whole process tree (powershell -> cmd -> node), not just the root,
// so no orphaned pi instances survive a restart. taskkill /T on Windows.
function killTree(proc, sync) {
  if (!proc) return;
  const pid = proc.pid;
  try {
    if (process.platform === 'win32') {
      const args = ['/PID', String(pid), '/T', '/F'];
      if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      else {
        const k = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
        k.on('error', () => {});
      }
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { proc.kill(); } catch {} }
    }
  } catch { try { proc.kill(); } catch {} }
}

function spawnPty() {
  const args = config.shellArgs || ['-NoLogo', '-NoExit', '-Command', `& '${config.piCommand}'`];
  const proc = pty.spawn(config.shell, args, {
    name: 'xterm-256color',
    cols: lastSize.cols, rows: lastSize.rows,
    cwd: config.cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PI_CODING_AGENT_SESSION_DIR: CONVERSATIONS_DIR,
      PITECH_STATE_FILE: STATE_FILE,
    },
  });
  const myEpoch = epoch;
  proc.onData((data) => {
    buffer.push({ epoch: myEpoch, data });
    bufferBytes += data.length;
    while (bufferBytes > bufferMax && buffer.length > 1) bufferBytes -= buffer.shift().data.length;
    const msg = JSON.stringify({ type: 'data', data });
    for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
  proc.onExit(({ exitCode }) => {
    if (!restarting) {
      const msg = JSON.stringify({ type: 'exit', code: exitCode });
      for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
    if (ptyProc === proc) ptyProc = null;
  });
  ptyProc = proc;
  console.log(`[pi-webui] pty up: ${config.shell} -> ${config.piCommand} (${lastSize.cols}x${lastSize.rows})`);
}

function restartPty() {
  if (restarting) return;
  restarting = true;
  const old = ptyProc;
  epoch += 1;
  buffer.length = 0; bufferBytes = 0;
  const msg = JSON.stringify({ type: 'restart' });
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  const spawnNext = () => {
    restarting = false;
    try { spawnPty(); } catch (e) { console.error('[pi-webui] spawn failed:', e.message); }
  };
  if (!old) return spawnNext();
  let done = false;
  const finish = () => { if (!done) { done = true; spawnNext(); } };
  const timer = setTimeout(finish, 4000);
  if (old.onExit) old.onExit(() => { clearTimeout(timer); finish(); });
  killTree(old, false);
}

// ---------------- data endpoints helpers ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function readFrontmatter(file) {
  try {
    const txt = await fs.promises.readFile(file, 'utf8');
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const fm = m[1];
    const name = (fm.match(/^name:\s*(.+)$/m)?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
    let desc = (fm.match(/^description:\s*(.+)$/m)?.[1] || '').trim();
    if (desc) {
      const lines = fm.split(/\r?\n/);
      const di = lines.findIndex((l) => /^description:/.test(l));
      for (let i = di + 1; i < lines.length; i++) {
        const l = lines[i];
        if (/^[a-zA-Z0-9_-]+:/.test(l.trim())) break; // next frontmatter key
        if (/^\s*([#|>]|[-*] )/.test(l) || (/^\s+\S/.test(l) && !/^\s*(license|compatibility|metadata|allowed-tools|disable-model-invocation):/.test(l))) {
          desc += ' ' + l.trim();
        } else break;
      }
    }
    const disabled = /^disable-model-invocation:\s*true\s*$/m.test(fm);
    return { name, desc, disabled };
  } catch { return {}; }
}

async function walkSkills(dir, out, roots, depth = 0) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 4) await walkSkills(p, out, roots, depth + 1);
    } else if (e.name.endsWith('.md')) {
      const fm = await readFrontmatter(p);
      if (fm.name && fm.desc) out.push({ name: fm.name, file: p, desc: fm.desc.slice(0, 160), disabled: !!fm.disabled });
    }
  }
}

async function scanAllSkills() {
  const out = [];
  const seen = new Set();
  const push = (s) => { if (!seen.has(s.name)) { seen.add(s.name); out.push(s); } };
  const roots = [
    { dir: path.join(AGENT, 'skills'), label: '~/.pi/agent/skills' },
    { dir: path.join(os.homedir(), '.agents', 'skills'), label: '~/.agents/skills' },
  ];
  for (const r of roots) {
    const found = [];
    await walkSkills(r.dir, found, roots);
    for (const s of found) push({ ...s, label: r.label });
  }
  // npm packages: node_modules/<pkg>/skills (scoped: node_modules/@scope/<pkg>/skills)
  const npmRoot = path.join(AGENT, 'npm', 'node_modules');
  let pkgs = [];
  try { pkgs = await fs.promises.readdir(npmRoot, { withFileTypes: true }); } catch {}
  for (const p of pkgs) {
    if (!p.isDirectory() || p.name.startsWith('.')) continue;
    if (p.name.startsWith('@')) {
      let scoped = [];
      try { scoped = await fs.promises.readdir(path.join(npmRoot, p.name), { withFileTypes: true }); } catch {}
      for (const sp of scoped) {
        if (!sp.isDirectory()) continue;
        const found = [];
        await walkSkills(path.join(npmRoot, p.name, sp.name, 'skills'), found, roots);
        for (const s of found) push({ ...s, label: 'npm' });
      }
      continue;
    }
    const found = [];
    await walkSkills(path.join(npmRoot, p.name, 'skills'), found, roots);
    for (const s of found) push({ ...s, label: 'npm' });
  }
  // git packages: git/<host>/<owner>/<repo>/skills
  const gitRoot = path.join(AGENT, 'git');
  try {
    const hosts = await fs.promises.readdir(gitRoot, { withFileTypes: true });
    for (const h of hosts) {
      if (!h.isDirectory() || h.name.startsWith('.')) continue;
      let owners = [];
      try { owners = await fs.promises.readdir(path.join(gitRoot, h.name), { withFileTypes: true }); } catch {}
      for (const o of owners) {
        if (!o.isDirectory() || o.name.startsWith('.')) continue;
        let repos = [];
        try { repos = await fs.promises.readdir(path.join(gitRoot, h.name, o.name), { withFileTypes: true }); } catch {}
        for (const r of repos) {
          if (!r.isDirectory() || r.name.startsWith('.')) continue;
          const found = [];
          await walkSkills(path.join(gitRoot, h.name, o.name, r.name, 'skills'), found, roots);
          for (const s of found) push({ ...s, label: 'git' });
        }
      }
    }
  } catch {}
  // settings.json packages not covered by npm/git dirs (e.g. local paths)
  try {
    const settings = JSON.parse(await fs.promises.readFile(path.join(AGENT, 'settings.json'), 'utf8'));
    for (const pkg of settings.packages || []) {
      if (typeof pkg !== 'string' || pkg.startsWith('npm:') || pkg.startsWith('git:')) continue;
      const found = [];
      await walkSkills(path.join(AGENT, pkg, 'skills'), found, roots);
      for (const s of found) push({ ...s, label: 'packages' });
    }
  } catch {}
  return out;
}

let convCache = { ts: 0, data: null };
let conversationMigration;

function ensureConversationMigration() {
  if (!conversationMigration) {
    conversationMigration = migrateSessions(SESSIONS_DIR, CONVERSATIONS_DIR).catch((error) => {
      console.error('[pi-webui] session migration failed:', error.message);
      return null;
    });
  }
  return conversationMigration;
}

async function listConversations() {
  if (Date.now() - convCache.ts < 10000) return convCache.data;
  await ensureConversationMigration();
  const lib = await getProjLib();
  const sessions = [];
  let files = [];
  try { files = (await fs.promises.readdir(CONVERSATIONS_DIR)).filter((f) => f.toLowerCase().endsWith('.jsonl')); } catch {}
  for (const file of files) {
    const p = path.join(CONVERSATIONS_DIR, file);
    try {
      const st = await fs.promises.stat(p);
      sessions.push({ file, path: p, mtime: st.mtimeMs, size: st.size, title: await lib.sessionTitle(p) });
    } catch {}
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  convCache = { ts: Date.now(), data: sessions };
  return sessions;
}

async function listContext() {
  const out = [];
  let files;
  try { files = (await fs.promises.readdir(CONTEXT_DIR)).filter((f) => f.endsWith('.md')); } catch { return out; }
  for (const f of files) {
    try {
      const st = await fs.promises.stat(path.join(CONTEXT_DIR, f));
      out.push({ file: f, path: path.join(CONTEXT_DIR, f), mtime: st.mtimeMs, size: st.size });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function readMcp() {
  const out = new Map();
  try {
    const cfg = JSON.parse(await fs.promises.readFile(MCP_FILE, 'utf8'));
    for (const [name, c] of Object.entries(cfg.mcpServers || {})) {
      out.set(name, {
        name,
        type: c.type || 'stdio',
        endpoint: c.url || c.command || c.transport || '',
        enabled: c.enabled !== false,
        tools: null,
      });
    }
  } catch {}
  try {
    const cache = JSON.parse(await fs.promises.readFile(path.join(AGENT, 'mcp-cache.json'), 'utf8'));
    for (const [name, c] of Object.entries(cache.servers || {})) {
      const tools = Array.isArray(c.tools) ? c.tools.length : null;
      if (out.has(name)) out.get(name).tools = tools;
      else out.set(name, { name, type: 'mcp', endpoint: '', enabled: true, tools, cached: true });
    }
  } catch {}
  return [...out.values()];
}

let skillsCache = { ts: 0, data: null };

// ---------------- update checks & actions ----------------
let updateCache = { ts: 0, data: null }; // { pi, extensions } — refreshed in background
let updateRunning = false;

function run(cmd, args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, out, err: err || e.message }); });
    p.on('close', (code) => { clearTimeout(to); resolve({ code, out, err }); });
  });
}

function npmView(pkg) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return run(process.execPath, [npmCli, 'view', pkg, 'version', '--no-fund', '--no-audit'], 45000)
    .then((r) => (r.code === 0 ? (r.out.trim().split(/\s+/).pop() || null) : null));
}

async function getInstalledPiVersion() {
  try {
    const p = path.join(path.dirname(config.piCommand), 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
    return JSON.parse(await fs.promises.readFile(p, 'utf8')).version || null;
  } catch { return null; }
}

async function fetchPiLatest() {
  try {
    const res = await fetch('https://pi.dev/api/latest-version', { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const text = (await res.text()).trim();
      try {
        const j = JSON.parse(text);
        if (j && j.version) return String(j.version);
      } catch {}
      if (/^\d+\.\d+\.\d+/.test(text)) return text;
    }
  } catch {}
  return npmView('@earendil-works/pi-coding-agent');
}

async function gitHead(dir) {
  const r = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], 15000);
  return r.code === 0 ? r.out.trim() : null;
}
async function gitRemoteHead(url) {
  const r = await run('git', ['ls-remote', url, 'HEAD'], 30000);
  return r.code === 0 ? (r.out.trim().split(/\s+/)[0] || null) : null;
}

async function checkUpdates() {
  const out = { pi: null, extensions: [] };
  const [installed, latest] = await Promise.all([getInstalledPiVersion(), fetchPiLatest()]);
  out.pi = { current: installed, latest, update: !!(installed && latest && latest !== installed) };
  let packages = [];
  try {
    packages = JSON.parse(await fs.promises.readFile(path.join(AGENT, 'settings.json'), 'utf8')).packages || [];
  } catch {}
  for (const spec of packages) {
    if (typeof spec !== 'string') continue;
    if (spec.startsWith('npm:')) {
      const name = spec.slice(4);
      let current = null;
      try {
        current = JSON.parse(await fs.promises.readFile(path.join(AGENT, 'npm', 'node_modules', name, 'package.json'), 'utf8')).version;
      } catch {}
      const latest = await npmView(name);
      if (current && latest && latest !== current) out.extensions.push({ name, current, latest });
    } else if (spec.startsWith('git:')) {
      const bare = spec.slice(4).split('@')[0];
      const parts = bare.split('/');
      if (parts.length >= 3) {
        const dir = path.join(AGENT, 'git', ...parts);
        const [head, remote] = await Promise.all([gitHead(dir), gitRemoteHead('https://' + bare)]);
        if (head && remote && head !== remote) out.extensions.push({ name: 'git:' + bare, current: head.slice(0, 7), latest: remote.slice(0, 7) });
      }
    }
  }
  return out;
}

function refreshUpdates() {
  if (Date.now() - updateCache.ts > 30 * 60 * 1000) {
    updateCache = { ts: Date.now(), data: null };
    checkUpdates()
      .then((d) => { updateCache.data = d; })
      .catch(() => { updateCache.data = { pi: null, extensions: [] }; });
  }
}

// ---------------- pins (right-click menu) ----------------
const PINS_FILE = path.join(AGENT, 'webui-pins.json');
const EMPTY_PINS = {
  projects: [],
  skills: [],
  mcp: [],
  conversations: [],
  conversationFolders: [],
  conversationNames: {},
};

async function readPins() {
  let saved = {};
  try { saved = JSON.parse(await fs.promises.readFile(PINS_FILE, 'utf8')); } catch {}
  return {
    ...EMPTY_PINS,
    ...(saved && typeof saved === 'object' ? saved : {}),
    projects: Array.isArray(saved?.projects) ? saved.projects : [],
    skills: Array.isArray(saved?.skills) ? saved.skills : [],
    mcp: Array.isArray(saved?.mcp) ? saved.mcp : [],
    conversations: Array.isArray(saved?.conversations) ? saved.conversations.filter((item) => item !== 'conversations') : [],
    conversationFolders: Array.isArray(saved?.conversationFolders) ? saved.conversationFolders : [],
    conversationNames: saved?.conversationNames && typeof saved.conversationNames === 'object' ? saved.conversationNames : {},
  };
}
async function writePins(pins) {
  await fs.promises.writeFile(PINS_FILE, JSON.stringify(pins, null, 2), 'utf8');
}
const sortPinned = (arr, key, pinned) => [
  ...arr.filter((x) => pinned.includes(x[key])),
  ...arr.filter((x) => !pinned.includes(x[key])),
];

function conversationPathAllowed(value) {
  const target = path.normalize(String(value || ''));
  const relative = path.relative(CONVERSATIONS_DIR, target);
  return target.toLowerCase().endsWith('.jsonl')
    && relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function conversationMetaFromPins(pins) {
  return normalizeConversationMeta({ folders: pins.conversationFolders, names: pins.conversationNames });
}

function saveConversationMeta(pins, meta) {
  Object.assign(pins, serializeConversationMeta(meta));
}

function sanitizeFsName(name) {
  const s = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim();
  return s.slice(0, 80) || null;
}

// Fixed, user-owned roots keep the compact explorer useful and out of system folders.
const FILE_ROOTS = [
  { id: 'agent', label: 'Pi workspace', hint: '~/.pi/agent', path: AGENT },
  { id: 'shared', label: 'Shared agent files', hint: '~/.agents', path: path.join(os.homedir(), '.agents') },
  { id: 'pitech', label: 'PiTech project', hint: ROOT, path: ROOT },
];
const FILE_ROOT_PATHS = FILE_ROOTS.map((root) => root.path);

async function readWebuiState() {
  try { return JSON.parse(await fs.promises.readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}

async function ensurePathNotes() {
  await fs.promises.mkdir(path.dirname(PATHS_FILE), { recursive: true });
  try { await fs.promises.access(PATHS_FILE); }
  catch { await fs.promises.writeFile(PATHS_FILE, '', 'utf8'); }
}

function fileRoot(id) {
  return FILE_ROOTS.find((root) => root.id === id) || FILE_ROOTS[0];
}

async function getState() {
  const [projects, conversations, context, mcp] = await Promise.all([
    getProjLib().then((l) => l.listProjects()),
    listConversations(),
    listContext(),
    readMcp(),
  ]);
  if (Date.now() - skillsCache.ts > 60000) {
    skillsCache = { ts: Date.now(), data: await scanAllSkills() };
  }
  refreshUpdates();
  const webuiState = await readWebuiState();
  const activeSet = new Set(Array.isArray(webuiState.skills) ? webuiState.skills : []);
  const fileRoot = FILE_ROOTS[0];
  const editing = await aggregateEditing(AGENT);
  const pins = await readPins();
  const conversationMeta = conversationMetaFromPins(pins);
  const conversationRows = decorateConversations(conversations, conversationMeta, pins.conversations);
  const conversationFolders = conversationMeta.folders.map((folder) => ({
    name: folder.name,
    total: conversationRows.filter((session) => folder.paths.includes(session.path)).length,
  }));
  const pinnedSkills = skillsCache.data.filter((s) => pins.skills.includes(s.name)).map((s) => ({ ...s, label: 'Pinned' }));
  const restSkills = skillsCache.data.filter((s) => !pins.skills.includes(s.name));
  return {
    projects: sortPinned(projects, 'name', pins.projects),
    conversations: conversationRows,
    conversationFolders,
    context,
    mcp: sortPinned(mcp, 'name', pins.mcp),
    skills: [...pinnedSkills, ...restSkills].map((s) => ({ ...s, active: !s.disabled && activeSet.has(s.name) })),
    pins,
    skillRoots: [path.join(AGENT, 'skills'), path.join(os.homedir(), '.agents', 'skills')],
    fileRoots: FILE_ROOTS,
    fileRoot: fileRoot.path,
    fileRootId: fileRoot.id,
    editing,
    updates: updateCache.data,
    updateRunning,
    appVersion: 13,
    stateTs: Date.now(),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Parse a session JSONL into a compact, renderable conversation.
async function readSession(file) {
  const st = await fs.promises.stat(file);
  const fh = await fs.promises.open(file, 'r');
  const MAX = 8 * 1024 * 1024;
  let buf;
  if (st.size > MAX) {
    buf = Buffer.alloc(MAX);
    const { bytesRead } = await fh.read(buf, 0, MAX, 0);
    buf = buf.subarray(0, bytesRead);
  } else {
    buf = await fh.readFile();
  }
  await fh.close();
  const out = { file, cwd: null, name: null, model: null, started: null, messages: [] };
  const cap = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  for (const line of buf.toString('utf8').split('\n')) {
    if (out.messages.length >= 500) break;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'session') { out.cwd = e.cwd || null; out.started = e.timestamp || null; continue; }
    if (e.type === 'session_info' && e.name) { out.name = String(e.name).slice(0, 120); continue; }
    if (e.type === 'model_change') { out.model = e.modelId || null; continue; }
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    const parts = Array.isArray(m.content) ? m.content : [];
    const textOf = (types) => parts.filter((p) => types.includes(p.type) && (p.text || p.thinking)).map((p) => p.text || p.thinking).join('\n');
    if (m.role === 'user') {
      const t = textOf(['text']).trim();
      if (t) out.messages.push({ role: 'user', text: cap(t, 4000), ts: e.timestamp || null });
    } else if (m.role === 'assistant') {
      const t = textOf(['text']).trim();
      const th = textOf(['thinking']).trim();
      out.messages.push({ role: 'assistant', text: cap(t, 4000), thinking: th ? cap(th, 800) : null, ts: e.timestamp || null });
    } else if (m.role === 'toolCall' || m.role === 'tool') {
      const name = m.toolName || m.name || 'tool';
      const input = JSON.stringify(m.input ?? m.arguments ?? {});
      out.messages.push({ role: 'tool', name, input: cap(input, 250), ts: e.timestamp || null });
    } else if (m.role === 'toolResult') {
      const t = textOf(['text']).trim().replace(/\s+/g, ' ');
      out.messages.push({ role: 'toolResult', name: m.toolName || '', text: cap(t, 300), ts: e.timestamp || null });
    }
  }
  return out;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

// ---------------- HTTP ----------------
const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch { urlPath = '/'; }

  // REST API
  if (urlPath.startsWith('/api/')) {
    try {
      if (req.method === 'GET' && urlPath === '/api/state') {
        return sendJson(res, 200, await getState());
      }
      if (req.method === 'GET' && urlPath === '/api/session') {
        const u = new URL(req.url, 'http://localhost');
        const file = path.normalize(u.searchParams.get('file') || '');
        const lib = await getProjLib();
        const inSessions = file.startsWith(SESSIONS_DIR + path.sep) || file.startsWith(CONVERSATIONS_DIR + path.sep);
        const inProjects = file.startsWith(lib.PROJECTS_DIR + path.sep);
        if (!inSessions && !inProjects) {
          return sendJson(res, 400, { ok: false, error: 'file must live under ~/.pi/agent/conversations or projects' });
        }
        try {
          return sendJson(res, 200, await readSession(file));
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e.message });
        }
      }
      if (req.method === 'POST' && urlPath === '/api/pin') {
        const body = await readBody(req);
        if (!['projects', 'skills', 'mcp', 'conversations'].includes(body.list)) {
          return sendJson(res, 400, { ok: false, error: 'invalid list' });
        }
        const name = body.list === 'conversations' ? path.normalize(String(body.name || '')) : String(body.name || '');
        if (!name) return sendJson(res, 400, { ok: false, error: 'missing name' });
        if (body.list === 'conversations' && !conversationPathAllowed(name)) {
          return sendJson(res, 400, { ok: false, error: 'conversation path is not allowed' });
        }
        const pins = await readPins();
        if (body.pin) { if (!pins[body.list].includes(name)) pins[body.list].push(name); }
        else pins[body.list] = pins[body.list].filter((n) => n !== name);
        await writePins(pins);
        return sendJson(res, 200, { ok: true, pins });
      }
      if (req.method === 'POST' && urlPath === '/api/conversations/organize') {
        const body = await readBody(req);
        const conversationPath = path.normalize(String(body.path || ''));
        if (!conversationPathAllowed(conversationPath)) {
          return sendJson(res, 400, { ok: false, error: 'conversation path is not allowed' });
        }
        try {
          await fs.promises.stat(conversationPath);
          const pins = await readPins();
          let meta = conversationMetaFromPins(pins);
          if (Object.prototype.hasOwnProperty.call(body, 'title')) meta = renameConversation(meta, conversationPath, body.title);
          if (Object.prototype.hasOwnProperty.call(body, 'folder')) meta = moveConversation(meta, conversationPath, body.folder);
          saveConversationMeta(pins, meta);
          await writePins(pins);
          convCache.ts = 0;
          return sendJson(res, 200, { ok: true });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
      }
      if (req.method === 'POST' && urlPath === '/api/conversations/folders') {
        const body = await readBody(req);
        const action = String(body.action || '');
        try {
          const pins = await readPins();
          let meta = conversationMetaFromPins(pins);
          if (action === 'create') meta = createFolder(meta, body.name);
          else if (action === 'rename') meta = renameFolder(meta, body.oldName, body.newName);
          else if (action === 'delete') meta = deleteFolder(meta, body.name);
          else return sendJson(res, 400, { ok: false, error: 'action must be create, rename or delete' });
          saveConversationMeta(pins, meta);
          await writePins(pins);
          convCache.ts = 0;
          return sendJson(res, 200, { ok: true, conversationFolders: meta.folders.map((folder) => ({ name: folder.name, total: folder.paths.length })) });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
      }
      if (req.method === 'POST' && urlPath === '/api/projects') {
        const body = await readBody(req);
        const lib = await getProjLib();
        const project = await lib.newProject(body.name);
        return sendJson(res, 200, { ok: true, project });
      }
      if (req.method === 'POST' && urlPath === '/api/sessions/copy') {
        const body = await readBody(req);
        const src = path.normalize(body.src || '');
        const lib = await getProjLib();
        const projDir = lib.PROJECTS_DIR;
        const inSessions = src.startsWith(SESSIONS_DIR + path.sep) || src.startsWith(CONVERSATIONS_DIR + path.sep);
        const inProjects = src.startsWith(projDir + path.sep);
        if (!inSessions && !inProjects) {
          return sendJson(res, 400, { ok: false, error: 'src must live under ~/.pi/agent/conversations or projects' });
        }
        if (inProjects && src.startsWith(path.join(projDir, String(body.project || '')) + path.sep)) {
          return sendJson(res, 400, { ok: false, error: 'session is already in that project' });
        }
        let copied = 0;
        try {
          const st = await fs.promises.stat(src);
          if (st.isDirectory()) {
            const files = (await fs.promises.readdir(src)).filter((f) => f.endsWith('.jsonl'));
            for (const f of files) {
              await lib.addSessionToProject(body.project, path.join(src, f));
              copied++;
            }
          } else {
            if (!src.endsWith('.jsonl')) return sendJson(res, 400, { ok: false, error: 'only .jsonl session files can be copied' });
            await lib.addSessionToProject(body.project, src);
            copied = 1;
          }
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
        return sendJson(res, 200, { ok: true, copied });
      }
      if (req.method === 'POST' && urlPath === '/api/update') {
        const body = await readBody(req);
        const target = body.target === 'pi' ? 'pi' : body.target === 'extensions' ? 'extensions' : null;
        if (!target) return sendJson(res, 400, { ok: false, error: 'target must be pi or extensions' });
        if (updateRunning) return sendJson(res, 409, { ok: false, error: 'an update is already running' });
        updateRunning = true;
        updateCache = { ts: 0, data: null };
        const p = spawn('cmd.exe', ['/d', '/s', '/c', `${config.piCommand} ${target === 'pi' ? 'update' : 'update --extensions'}`], {
          windowsHide: true,
          cwd: os.homedir(),
        });
        p.stdout.on('data', (d) => console.log('[pi-webui] update:', String(d).trim()));
        p.stderr.on('data', (d) => console.log('[pi-webui] update err:', String(d).trim()));
        p.on('error', (e) => {
          updateRunning = false;
          console.error('[pi-webui] update failed to start:', e.message);
        });
        p.on('close', (code) => {
          updateRunning = false;
          console.log(`[pi-webui] update ${target} finished (exit ${code})`);
          if (target === 'pi') restartPty();
          else { try { if (ptyProc) ptyProc.write('/reload\r'); } catch {} }
        });
        return sendJson(res, 200, { ok: true, started: true, target });
      }
      if (req.method === 'POST' && urlPath === '/api/fs/new-file') {
        const body = await readBody(req);
        const name = sanitizeFsName(body.name);
        if (!name || !/\.(txt|md|cfg)$/i.test(name)) return sendJson(res, 400, { ok: false, error: 'name must end in .txt, .md or .cfg' });
        try {
          await fs.promises.writeFile(path.join(CONTEXT_DIR, name), '', 'utf8');
          return sendJson(res, 200, { ok: true });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/fs/new-folder') {
        const body = await readBody(req);
        const name = sanitizeFsName(body.name);
        if (!name) return sendJson(res, 400, { ok: false, error: 'invalid name' });
        const rootId = String(body.root || '');
        const root = rootId ? FILE_ROOTS.find((item) => item.id === rootId) : null;
        if (rootId && !root) return sendJson(res, 400, { ok: false, error: 'invalid file root' });
        const parent = root?.path || CONTEXT_DIR;
        try {
          await fs.promises.mkdir(path.join(parent, name));
          return sendJson(res, 200, { ok: true });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/fs/delete') {
        const body = await readBody(req);
        const p = path.normalize(body.path || '');
        const lib = await getProjLib();
        const allowed = [SESSIONS_DIR, CONVERSATIONS_DIR, CONTEXT_DIR, path.join(AGENT, 'skills'), lib.PROJECTS_DIR];
        if (!allowed.some((r) => p.startsWith(r + path.sep))) {
          return sendJson(res, 400, { ok: false, error: 'path not deletable' });
        }
        try {
          await fs.promises.rm(p, { recursive: true, force: true });
          return sendJson(res, 200, { ok: true });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/fs/rename') {
        const body = await readBody(req);
        const p = path.normalize(body.path || '');
        const name = sanitizeFsName(body.name);
        if (!name || name.includes('/') || name.includes('\\')) return sendJson(res, 400, { ok: false, error: 'invalid name' });
        const lib = await getProjLib();
        const inCtx = p.startsWith(CONTEXT_DIR + path.sep);
        const inProj = p.startsWith(lib.PROJECTS_DIR + path.sep);
        const inFileRoot = FILE_ROOT_PATHS.some((root) => p.startsWith(root + path.sep));
        if (!inCtx && !inProj && !inFileRoot) return sendJson(res, 400, { ok: false, error: 'path not renameable' });
        const dest = path.join(path.dirname(p), name);
        try {
          await fs.promises.rename(p, dest);
          if (inProj) {
            const mf = path.join(dest, 'project.md');
            try {
              const txt = await fs.promises.readFile(mf, 'utf8');
              await fs.promises.writeFile(mf, txt.replace(/^# Project: .*$/m, `# Project: ${name}`), 'utf8');
            } catch {}
          }
          return sendJson(res, 200, { ok: true, dest });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/open') {
        const body = await readBody(req);
        const p = path.normalize(body.path || '');
        const lib = await getProjLib();
        const roots = [...FILE_ROOT_PATHS, lib.PROJECTS_DIR, CONVERSATIONS_DIR];
        if (!roots.some((r) => p.startsWith(r + path.sep))) return sendJson(res, 400, { ok: false, error: 'path not allowed' });
        try {
          const st = await fs.promises.stat(p);
          if (body.mode === 'explorer') {
            spawn('explorer.exe', [st.isDirectory() ? p : '/select,' + p], { detached: true, stdio: 'ignore' }).unref();
          } else {
            spawn('cmd.exe', ['/d', '/s', '/c', 'start "" "' + p + '"'], { detached: true, stdio: 'ignore' }).unref();
          }
          return sendJson(res, 200, { ok: true });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'GET' && urlPath === '/api/tree') {
        const u = new URL(req.url, 'http://localhost');
        const selected = fileRoot(u.searchParams.get('root'));
        const requested = path.resolve(u.searchParams.get('path') || selected.path);
        try {
          const entries = await listTree(selected.path, requested);
          return sendJson(res, 200, { ok: true, rootId: selected.id, root: selected.path, path: requested, entries });
        } catch (e) {
          return sendJson(res, /outside the active workspace/.test(e.message) ? 400 : 500, { ok: false, error: e.message });
        }
      }
      if (req.method === 'GET' && urlPath === '/api/file') {
        const u = new URL(req.url, 'http://localhost');
        const p = path.normalize(u.searchParams.get('path') || '');
        const lib = await getProjLib();
        const roots = [...FILE_ROOT_PATHS, lib.PROJECTS_DIR, CONVERSATIONS_DIR];
        if (!isAllowedFile(roots, p)) {
          return sendJson(res, 400, { ok: false, error: 'file not allowed' });
        }
        try {
          const st = await fs.promises.stat(p);
          const fh = await fs.promises.open(p, 'r');
          const buf = Buffer.alloc(Math.min(st.size, 200 * 1024));
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          await fh.close();
          return sendJson(res, 200, { path: p, text: buf.toString('utf8', 0, bytesRead) });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/file/save') {
        const body = await readBody(req);
        const p = path.normalize(String(body.path || ''));
        const text = typeof body.text === 'string' ? body.text : null;
        const lib = await getProjLib();
        const roots = [...FILE_ROOT_PATHS, lib.PROJECTS_DIR, CONVERSATIONS_DIR];
        if (!isAllowedFile(roots, p)) return sendJson(res, 400, { ok: false, error: 'file not allowed' });
        if (text === null || Buffer.byteLength(text, 'utf8') > 200 * 1024) return sendJson(res, 400, { ok: false, error: 'text too large or missing' });
        try {
          await fs.promises.writeFile(p, text, 'utf8');
          return sendJson(res, 200, { ok: true });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/mcp') {
        const body = await readBody(req);
        const name = String(body.name || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 60);
        const type = body.type === 'stdio' ? 'stdio' : 'http';
        if (!name) return sendJson(res, 400, { ok: false, error: 'invalid server name' });
        if (type === 'http') {
          if (!/^https?:\/\/\S+$/i.test(String(body.url || ''))) return sendJson(res, 400, { ok: false, error: 'url must start with http(s)://' });
        } else if (!String(body.command || '').trim()) {
          return sendJson(res, 400, { ok: false, error: 'command required for stdio servers' });
        }
        try {
          const cfg = JSON.parse(await fs.promises.readFile(MCP_FILE, 'utf8'));
          cfg.mcpServers = cfg.mcpServers || {};
          cfg.mcpServers[name] = type === 'http'
            ? { type, url: String(body.url).trim(), enabled: body.enabled !== false }
            : { type, command: String(body.command).trim(), enabled: body.enabled !== false };
          await fs.promises.writeFile(MCP_FILE, JSON.stringify(cfg, null, 2), 'utf8');
          return sendJson(res, 200, { ok: true, name });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/mcp/remove') {
        const body = await readBody(req);
        const name = String(body.name || '');
        if (!name) return sendJson(res, 400, { ok: false, error: 'missing name' });
        try {
          const cfg = JSON.parse(await fs.promises.readFile(MCP_FILE, 'utf8'));
          if (cfg.mcpServers && cfg.mcpServers[name]) {
            delete cfg.mcpServers[name];
            await fs.promises.writeFile(MCP_FILE, JSON.stringify(cfg, null, 2), 'utf8');
          }
          return sendJson(res, 200, { ok: true });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/skills') {
        const body = await readBody(req);
        const name = String(body.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
        const desc = String(body.description || '').trim().slice(0, 1024);
        if (!name || !desc) return sendJson(res, 400, { ok: false, error: 'name and description required' });
        const dir = path.join(AGENT, 'skills', name);
        try {
          await fs.promises.access(dir);
          return sendJson(res, 409, { ok: false, error: 'a skill with that name already exists' });
        } catch {}
        try {
          await fs.promises.mkdir(dir);
          const md = `---\nname: ${name}\ndescription: ${desc}\n---\n\n${String(body.content || '')}\n`;
          await fs.promises.writeFile(path.join(dir, 'SKILL.md'), md, 'utf8');
          return sendJson(res, 200, { ok: true, name });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/skills/import') {
        const body = await readBody(req);
        const src = path.normalize(String(body.path || ''));
        let st;
        try { st = await fs.promises.stat(src); } catch { return sendJson(res, 400, { ok: false, error: 'path not found' }); }
        try {
          let dest;
          if (st.isDirectory()) {
            await fs.promises.access(path.join(src, 'SKILL.md'));
            dest = path.join(AGENT, 'skills', path.basename(src));
          } else {
            if (path.basename(src).toLowerCase() !== 'skill.md') return sendJson(res, 400, { ok: false, error: 'file must be SKILL.md' });
            dest = path.join(AGENT, 'skills', path.basename(path.dirname(src)));
          }
          try { await fs.promises.access(dest); return sendJson(res, 409, { ok: false, error: 'already exists in ~/.pi/agent/skills' }); } catch {}
          await fs.promises.cp(src, dest, { recursive: true });
          return sendJson(res, 200, { ok: true, name: path.basename(dest) });
        } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      }
      if (req.method === 'GET' && urlPath === '/api/auth') {
        let providers = [];
        try { providers = Object.keys(JSON.parse(await fs.promises.readFile(path.join(AGENT, 'auth.json'), 'utf8'))); } catch {}
        return sendJson(res, 200, { ok: true, providers });
      }
      if (req.method === 'POST' && urlPath === '/api/auth/key') {
        const body = await readBody(req);
        const provider = String(body.provider || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
        const key = String(body.key || '').trim();
        if (!provider || !key) return sendJson(res, 400, { ok: false, error: 'provider and API key required' });
        try {
          const file = path.join(AGENT, 'auth.json');
          let auth = {};
          try { auth = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch {}
          auth[provider] = { type: 'api_key', key };
          await fs.promises.writeFile(file, JSON.stringify(auth, null, 2), 'utf8');
          return sendJson(res, 200, { ok: true, provider });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/mcp/toggle') {
        const body = await readBody(req);
        const name = String(body.name || '');
        if (!name) return sendJson(res, 400, { ok: false, error: 'missing name' });
        try {
          const cfg = JSON.parse(await fs.promises.readFile(MCP_FILE, 'utf8'));
          if (!cfg.mcpServers || !cfg.mcpServers[name]) return sendJson(res, 404, { ok: false, error: 'server not found' });
          cfg.mcpServers[name].enabled = body.enabled !== false;
          await fs.promises.writeFile(MCP_FILE, JSON.stringify(cfg, null, 2), 'utf8');
          return sendJson(res, 200, { ok: true, enabled: body.enabled !== false });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && urlPath === '/api/skill/toggle') {
        const body = await readBody(req);
        const name = String(body.name || '');
        const enabled = body.enabled !== false;
        const found = [];
        await walkSkills(path.join(AGENT, 'skills'), found, []);
        await walkSkills(path.join(os.homedir(), '.agents', 'skills'), found, []);
        const skill = found.find((s) => s.name === name);
        if (!skill) return sendJson(res, 404, { ok: false, error: 'skill not found (only user skills can be toggled)' });
        try {
          const txt = await fs.promises.readFile(skill.file, 'utf8');
          const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (!m) return sendJson(res, 400, { ok: false, error: 'no frontmatter to edit' });
          let fm = m[1];
          if (enabled) fm = fm.replace(/^disable-model-invocation:[^\r\n]*[\r\n]?/m, '');
          else if (/^disable-model-invocation:/m.test(fm)) fm = fm.replace(/^disable-model-invocation:[^\r\n]*/m, 'disable-model-invocation: true');
          else fm += '\ndisable-model-invocation: true';
          await fs.promises.writeFile(skill.file, txt.replace(m[1], fm), 'utf8');
          skillsCache = { ts: 0, data: null };
          return sendJson(res, 200, { ok: true, enabled });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      }
      // ---------------- Jupyter panel ----------------
      if (urlPath === '/api/jupyter/status') {
        return sendJson(res, 200, { ok: true, installUrl: JUPYTER_INSTALL_URL, ...jupyterBridge.status() });
      }
      if (req.method === 'POST' && urlPath === '/api/jupyter/start') {
        try {
          await jupyterBridge.start();
          return sendJson(res, 200, { ok: true, ...jupyterBridge.status() });
        } catch (e) {
          return sendJson(res, 502, { ok: false, error: e.message });
        }
      }
      if (req.method === 'POST' && urlPath === '/api/jupyter/stop') {
        jupyterBridge.stop();
        return sendJson(res, 200, { ok: true, ...jupyterBridge.status() });
      }
      if (urlPath.startsWith('/api/jupyter/')) {
        const parts = urlPath.split('/').filter(Boolean); // ['api','jupyter', ...]
        const method = req.method;
        let body = null;
        if (method === 'POST') body = await readBody(req);
        let action;
        if (parts[2] === 'kernelspecs' && method === 'GET') action = 'kernelspecs';
        else if (parts[2] === 'kernels' && parts.length === 3) action = 'kernels';
        else if (parts[2] === 'kernels' && parts.length === 4) action = 'kernel/' + parts[3];
        if (!action) return sendJson(res, 404, { ok: false, error: 'not found' });
        const result = await jupyterBridge.api(method, action, body);
        return sendJson(res, result.status, { ok: result.status < 400, ...(result.json || { error: 'upstream error' }) });
      }
      // ---------------- language exec (non-Python panel languages) --------
      if (urlPath === '/api/lang/check' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, { ok: true, ...langCheck(String(body.lang || '')) });
      }
      if (urlPath === '/api/lang/run' && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.code !== 'string' || body.code.length > 200000) return sendJson(res, 400, { ok: false, error: 'bad code payload' });
        const result = await langRun(String(body.lang || ''), body.code);
        return sendJson(res, 200, result);
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // static
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// Route terminal WS (/ws) and Jupyter kernel channel WS (/jupyter-ws/:id).
const wss = new WebSocket.Server({ noServer: true });
const jupyterWss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/ws') return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  const m = /^\/jupyter-ws\/([^/]+)$/.exec(urlPath);
  if (m) return jupyterWss.handleUpgrade(req, socket, head, (ws) => jupyterBridge.proxyChannel(decodeURIComponent(m[1]), ws));
  socket.destroy();
});
wss.on('connection', (ws) => {
  let terminalInput = '';
  const flushPathNotes = () => {
    if (!terminalInput) return;
    const text = terminalInput;
    terminalInput = '';
    appendPaths(PATHS_FILE, text).catch(() => {});
  };
  clients.add(ws);
  for (const c of buffer) ws.send(JSON.stringify({ type: 'data', data: c.data }));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'input') {
      const data = typeof msg.data === 'string' ? msg.data : '';
      terminalInput = (terminalInput + data).slice(-10000);
      if (/[\r\n\u0003]/.test(data)) flushPathNotes();
      if (ptyProc && data) ptyProc.write(data);
    }
    else if (msg.type === 'resize') {
      lastSize = { cols: Math.max(2, msg.cols | 0), rows: Math.max(1, msg.rows | 0) };
      if (ptyProc) ptyProc.resize(lastSize.cols, lastSize.rows);
    }
    else if (msg.type === 'restart') restartPty();
  });
  ws.on('close', () => clients.delete(ws));
});

function openBrowser() {
  const url = `http://127.0.0.1:${config.port}`;
  if (process.platform === 'win32') {
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('[pi-webui] already running — opening browser');
    if (config.openBrowser) openBrowser();
    process.exit(0);
  }
  throw e;
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[pi-webui] listening on http://127.0.0.1:${config.port}`);
  Promise.all([
    ensurePathNotes().catch((error) => console.error('[pi-webui] path notes setup failed:', error.message)),
    ensureConversationMigration(),
  ]).finally(() => {
    spawnPty();
    if (config.openBrowser) openBrowser();
  });
});

process.on('exit', () => { if (ptyProc) killTree(ptyProc, true); });
