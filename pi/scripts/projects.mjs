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

export function isReservedProjectName(name) {
  return /^(off|none)$/i.test(String(name || "").trim());
}

export async function ensureRoots() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await fs.mkdir(CONTEXT_DIR, { recursive: true });
}

export async function newProject(name) {
  const safe = sanitizeName(name);
  if (!safe) throw new Error("Invalid project name");
  if (isReservedProjectName(safe)) throw new Error(`Project name "${safe}" is reserved by /project`);
  await ensureRoots();
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

function messageLine(message) {
  if (!message || typeof message !== "object") return null;
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    const summary = String(message.summary || "").replace(/\s+/g, " ").trim();
    return summary ? `Summary: ${summary}` : null;
  }
  if (message.role !== "user" && message.role !== "assistant") return null;
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join(" ")
      : "";
  const text = String(content).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
}

export function projectCompletionItems(projects, prefix = "", includeOff = false) {
  const rows = Array.isArray(projects) ? projects : [];
  const choices = [
    ...(includeOff ? [{ value: "off", label: "off", description: "Leave the active project" }] : []),
    ...rows.filter((project) => !isReservedProjectName(project.name)).map((project) => ({
      value: project.name,
      label: project.name,
      description: `${project.sessions?.length || 0} sessions`,
    })),
  ];
  const query = String(prefix).toLowerCase();
  return choices.filter((choice) => choice.value.toLowerCase().startsWith(query));
}

export function otherProjectSessions(sessions, currentSessionFile) {
  const current = currentSessionFile ? path.basename(currentSessionFile) : null;
  return (Array.isArray(sessions) ? sessions : []).filter((session) => !current || session.file !== current);
}

function utf8Head(value, maxBytes) {
  const buffer = Buffer.from(String(value), "utf8");
  if (buffer.length <= maxBytes) return String(value);
  let end = Math.max(0, Math.min(maxBytes, buffer.length));
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Tail(value, maxBytes) {
  const buffer = Buffer.from(String(value), "utf8");
  if (buffer.length <= maxBytes) return String(value);
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

export function formatProjectContext(name, sessions, options = {}) {
  const maxBytes = Math.max(512, Number(options.maxBytes ?? options.maxChars) || 48000);
  const perSessionBytes = Math.max(256, Number(options.perSessionBytes ?? options.perSessionChars) || 6000);
  const rows = Array.isArray(sessions) ? sessions : [];
  const index = rows.length
    ? rows.map((session) => `- ${session.title || session.file} (${session.file})`).join("\n")
    : "- No other sessions are currently saved in this project.";
  let output = `## PiTech project context\nActive project: ${name}\n\nThis is background from other sessions in the same project. Treat it as prior history; the current conversation and latest user request take precedence.\n\nSessions:\n${index}\n`;
  const marker = "\n[…project history truncated…]";
  const markerBytes = Buffer.byteLength(marker, "utf8");

  for (const session of rows) {
    const lines = (session.messages || []).map(messageLine).filter(Boolean);
    if (!lines.length) continue;
    let excerpt = lines.join("\n");
    if (Buffer.byteLength(excerpt, "utf8") > perSessionBytes) {
      const notice = "[…earlier session history truncated…]\n";
      excerpt = notice + utf8Tail(excerpt, perSessionBytes - Buffer.byteLength(notice, "utf8"));
    }
    const section = `\n### ${session.title || session.file}\n${excerpt}\n`;
    const outputBytes = Buffer.byteLength(output, "utf8");
    if (outputBytes + Buffer.byteLength(section, "utf8") <= maxBytes) {
      output += section;
      continue;
    }
    const room = maxBytes - outputBytes;
    if (room > markerBytes) output += utf8Head(section, room - markerBytes) + marker;
    else output = utf8Head(output, maxBytes - markerBytes) + marker;
    break;
  }

  return utf8Head(output, maxBytes);
}
