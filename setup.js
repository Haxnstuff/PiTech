// PiTech by Haxnstuff
'use strict';
// One-shot installer: npm install → vendor xterm → install pi bridge → detect
// shell/pi → write config.json → create shell:startup shortcut → launch hidden.
// Idempotent — safe to re-run.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const win = process.platform === 'win32';

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

// npm.cmd can't be spawned directly on Windows (EINVAL) — call npm-cli.js with node.
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
function npm(args, opts = {}) {
  return sh(process.execPath, [npmCli, ...args], opts);
}

// 1) dependencies
console.log('== Installing dependencies ==');
const install = npm(['install', '--no-fund', '--no-audit'], { stdio: 'inherit', cwd: ROOT });
if (install.status !== 0) process.exit(install.status || 1);

// 2) vendor xterm.js assets
console.log('== Vendoring xterm.js ==');
const vendor = path.join(ROOT, 'public', 'vendor');
fs.mkdirSync(vendor, { recursive: true });
const copies = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];
for (const [src, dst] of copies) fs.copyFileSync(path.join(ROOT, src), path.join(vendor, dst));
console.log('  vendored', copies.map(([, d]) => d).join(', '));

// 3) install the pi extension and shared project library
console.log('== Installing PiTech bridge for pi ==');
const agentDir = path.join(os.homedir(), '.pi', 'agent');
const piCopies = [
  ['pi/extensions/pi-webui.ts', path.join(agentDir, 'extensions', 'pi-webui.ts')],
  ['pi/scripts/path-notes.js', path.join(agentDir, 'scripts', 'path-notes.js')],
  ['pi/scripts/projects.mjs', path.join(agentDir, 'scripts', 'projects.mjs')],
];
for (const [src, dst] of piCopies) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, src), dst);
}
console.log('  installed extension/pi-webui.ts, scripts/path-notes.js and scripts/projects.mjs');

// 4) detect shell + pi command
console.log('== Detecting shell and pi ==');
function where(cmd) {
  const r = sh(win ? 'where' : 'which', [cmd]);
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
const pwsh = where('pwsh')[0] || null;
const shell = pwsh
  || (win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'bash');

let piCmd = 'pi';
if (win) {
  const lines = where('pi');
  piCmd = lines.find((l) => /\.(cmd|bat|exe)$/i.test(l)) || lines[0] || 'pi';
} else {
  piCmd = where('pi')[0] || 'pi';
}
const isPs = /pwsh|powershell/i.test(shell);
const shellArgs = isPs
  ? ['-NoLogo', '-NoExit', '-Command', `& '${piCmd.replace(/'/g, "''")}'`]
  : ['-lc', piCmd];

const config = {
  port: 8787,
  shell,
  shellArgs,
  piCommand: piCmd,
  cwd: os.homedir(),
  bufferKb: 256,
  openBrowser: true,
};
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(config, null, 2));
console.log(`  shell: ${shell}`);
console.log(`  pi:    ${piCmd}`);
console.log('  config.json written');

// 5) startup shortcut (logon autostart, hidden via wscript)
if (win) {
  console.log('== Creating startup shortcut ==');
  const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  fs.mkdirSync(startup, { recursive: true });
  const vbs = path.join(ROOT, 'start-hidden.vbs');
  const ps = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$lnk = $ws.CreateShortcut('${startup.replace(/'/g, "''")}\\pi WebUI.lnk')`,
    `$lnk.TargetPath = 'wscript.exe'`,
    `$lnk.Arguments = '"${vbs.replace(/"/g, '\\"')}"'`,
    `$lnk.WorkingDirectory = '${ROOT.replace(/'/g, "''")}'`,
    `$lnk.Description = 'pi coding agent — local web UI'`,
    `$lnk.Save()`,
  ].join('; ');
  const r = sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
  console.log(`  shortcut: ${startup}\\pi WebUI.lnk`);
}

// 6) launch now (hidden; server opens the browser itself)
if (win && process.env.PI_NO_LAUNCH !== '1') {
  console.log('== Launching pi WebUI (hidden) ==');
  sh('wscript.exe', [path.join(ROOT, 'start-hidden.vbs')], { detached: true, stdio: 'ignore' });
  console.log('  launched. Browser should open at http://127.0.0.1:8787');
}
console.log('Done — PiTech by Haxnstuff.');
