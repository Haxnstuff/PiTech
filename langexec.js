// PiTech by Haxnstuff
'use strict';
// PiTech language exec bridge — runs non-Python panel languages through local
// toolchains. Python stays on the Jupyter kernel; HTML/CSS render client-side.
// Each entry: find = binaries that must resolve for the language to be usable,
// ext = source extension, shell builds compile+run in one line.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN_TIMEOUT = 60000;

function findBin(cmd) {
  const c = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(c, [cmd], { windowsHide: true, timeout: 10000 });
    const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.trim());
    return line ? line.trim() : null;
  } catch {
    return null;
  }
}
// ponytail: per-process memo; users who install a toolchain later restart the server
const binCache = new Map();

const LANG_BACKENDS = {
  javascript: { find: ['node'], ext: '.js', run: (f) => ({ cmd: 'node', args: [f] }) },
  nodejs: { find: ['node'], ext: '.js', run: (f) => ({ cmd: 'node', args: [f] }) },
  shell: { find: ['bash'], ext: '.sh', run: (f) => ({ cmd: 'bash', args: [f] }) },
  // R: Rscript.exe prints the machine's console-profile banner (HaxTech prompt)
  // into stdout even with --vanilla, so run Rterm --no-echo with the code on
  // stdin instead — clean stdout, no banner.
  r: { find: ['Rscript'], ext: '.r', stdin: true, run: () => null },
  java: { find: ['javac', 'java'], ext: '.java', run: (f) => ({ cmd: 'java', args: [f] }) },
  c: { find: ['gcc'], ext: '.c', shell: 'gcc "{src}" -o "{out}" && "{out}"' },
  cpp: { find: ['g++'], ext: '.cpp', shell: 'g++ "{src}" -o "{out}" && "{out}"' },
  csharp: { find: ['dotnet'], ext: '.cs', shell: 'dotnet run "{src}"', needsSdk: true },
  lua: { find: ['lua'], ext: '.lua', run: (f) => ({ cmd: 'lua', args: [f] }) },
  luau: { find: ['luau'], ext: '.lua', run: (f) => ({ cmd: 'luau', args: [f] }) },
};

const PREVIEW_LANGS = new Set(['html', 'css']);

function hasNetSdk() {
  try {
    const r = spawnSync(findBin('dotnet') || 'dotnet', ['--list-sdks'], { windowsHide: true, timeout: 15000 });
    return String(r.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

// Availability per language: { available, kind, missing?, error? }
function langCheck(lang) {
  if (PREVIEW_LANGS.has(lang)) return { available: true, kind: 'preview' };
  const spec = LANG_BACKENDS[lang];
  if (!spec) return { available: false, kind: 'exec', missing: lang, error: `Language is not available: ${lang}` };
  for (const bin of spec.find) {
    if (!binCache.has(bin)) binCache.set(bin, findBin(bin));
    if (!binCache.get(bin)) {
      return { available: false, kind: 'exec', missing: bin, error: `Language is not available — install ${bin} to use ${lang}` };
    }
  }
  if (spec.needsSdk && !hasNetSdk()) {
    return { available: false, kind: 'exec', missing: '.NET SDK', error: 'Language is not available — install the .NET SDK to use C#' };
  }
  return { available: true, kind: 'exec' };
}

function collectOutput(p, out, resolve) {
  p.stdout.on('data', (d) => { out.stdout += d; });
  p.stderr.on('data', (d) => { out.stderr += d; });
  const t = setTimeout(() => {
    out.timedOut = true;
    try { p.kill(); } catch {}
  }, RUN_TIMEOUT);
  p.on('exit', (code) => { clearTimeout(t); out.code = code; resolve(); });
  p.on('error', (e) => { clearTimeout(t); out.stderr += String(e); out.code = 1; resolve(); });
}

// Run a code cell as a standalone program: { ok, stdout, stderr, code, timedOut, ms }
async function langRun(lang, code) {
  const spec = LANG_BACKENDS[lang];
  if (!spec) return { ok: false, error: `Language is not available: ${lang}` };
  const check = langCheck(lang);
  if (!check.available) return { ok: false, error: check.error };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitech-run-'));
  const src = path.join(dir, 'main' + spec.ext);
  fs.writeFileSync(src, String(code));
  const out = { stdout: '', stderr: '', code: null, timedOut: false };
  const started = Date.now();
  try {
    await new Promise((resolve) => {
      if (spec.shell) {
        const cmdline = spec.shell.replace(/\{src\}/g, src).replace(/\{out\}/g, path.join(dir, 'main.exe'));
        collectOutput(spawn(cmdline, { shell: true, windowsHide: true, cwd: dir }), out, resolve);
      } else if (spec.stdin) {
        // stdin languages: find the sibling interpreter binary next to the
        // PATH one (R lives in bin/x64/ on Windows) and pipe the source in.
        const binPath = binCache.get(spec.find[0]);
        const base = path.dirname(binPath);
        const interp = [
          path.join(base, 'x64', 'Rterm.exe'),
          path.join(base, 'Rterm.exe'),
          binPath,
        ].find((p) => fs.existsSync(p)) || binPath;
        const p = spawn(interp, ['--no-echo'], { windowsHide: true, cwd: dir });
        p.stdin.write(String(code));
        p.stdin.end();
        collectOutput(p, out, resolve);
      } else {
        const { cmd, args } = spec.run(src);
        collectOutput(spawn(cmd, args, { windowsHide: true, cwd: dir }), out, resolve);
      }
    });
    out.ms = Date.now() - started;
    return { ok: true, ...out };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { LANG_BACKENDS, PREVIEW_LANGS, langCheck, langRun, findBin };