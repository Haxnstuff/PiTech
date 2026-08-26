// PiTech by Haxnstuff
// Shared "Projects" logic for pi-webui (used by both the webUI server and the
// pi extension at ~/.pi/agent/extensions/pi-webui.ts). Projects are folders
// under ~/.pi/agent/projects/ that collect past sessions for context.
import { promises as fs } from "fs";
import path from "path";
import os from "os";

export const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const PROJECTS_DIR = path.join(AGENT_DIR, "projects");
export const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");
export const CONTEXT_DIR = path.join(AGENT_DIR, "context");

export function sanitizeName(name) {
  const s = String(name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .trim();
  return s.slice(0, 60) || null;
}

export async function ensureRoots() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await fs.mkdir(CONTEXT_DIR, { recursive: true });
}

export async function newProject(name) {
  await ensureRoots();
  const safe = sanitizeName(name);
  if (!safe) throw new Error("Invalid project name");
  const dir = path.join(PROJECTS_DIR, safe);
  const sessionsDir = path.join(dir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const manifest = path.join(dir, "project.md");
  try {
    await fs.access(manifest);
  } catch {
    await fs.writeFile(
      manifest,
      `# Project: ${safe}\n\nCreated: ${new Date().toISOString()}\n\n## Sessions\n\n`,
      "utf8"
    );
  }
  return { name: safe, dir, manifest };
}

export async function addSessionToProject(project, srcFile) {
  const proj = await newProject(project);
  const dst = path.join(proj.dir, "sessions", path.basename(srcFile));
  await fs.copyFile(srcFile, dst);
  await fs.appendFile(
    proj.manifest,
    `- ${path.basename(srcFile)} (added ${new Date().toISOString()})\n`,
    "utf8"
  );
  return { name: proj.name, dst };
}

// Session display title: /name if set, else the first user message.
export async function sessionTitle(file) {
  try {
    const fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    const head = buf.toString('utf8', 0, bytesRead);
    for (const line of head.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t);
        if (e.type === 'session_info' && e.name) return String(e.name).slice(0, 90);
        if (e.type === 'message' && e.message?.role === 'user') {
          for (const c of e.message.content || []) {
            if (c.type === 'text' && c.text) return String(c.text).replace(/\s+/g, ' ').trim().slice(0, 90);
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

export async function listProjects() {
  await ensureRoots();
  const out = [];
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, e.name);
    const sessions = [];
    try {
      const files = (await fs.readdir(path.join(dir, "sessions"))).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        try {
          const p = path.join(dir, 'sessions', f);
          const st = await fs.stat(p);
          sessions.push({ file: f, path: p, mtime: st.mtimeMs, size: st.size, title: await sessionTitle(p) });
        } catch {}
      }
      sessions.sort((a, b) => b.mtime - a.mtime);
    } catch {}
    let created = null;
    try {
      const m = await fs.readFile(path.join(dir, "project.md"), "utf8");
      created = m.match(/Created: ([^\n]+)/)?.[1] ?? null;
    } catch {}
    out.push({ name: e.name, dir, sessions, created });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
