// PiTech by Haxnstuff
// pi-webui bridge extension:
//  - /new-project <name>  — create a project folder (collects past sessions)
//  - /add-project <name>  — copy the current session into a project
//  - /project <name>      — enter a project and load its other sessions as context
//  - writes ~/.pi/agent/webui-state.json so the web UI can show which skills
//    are active in the current prompt.
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { access, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { appendPaths, extractPaths, pathNotesPath } from "../scripts/path-notes.js";
import { refreshOpenRouterCatalog } from "../scripts/openrouter-catalog.mjs";

const AGENT = join(homedir(), ".pi", "agent");
const STATE_FILE = process.env.PITECH_STATE_FILE || join(AGENT, "webui-state.json");
const PATHS_FILE = pathNotesPath(AGENT);
const PROJECT_STATE_FILE = join(AGENT, "pitech-project.json");
const LIB_FILE = join(AGENT, "scripts", "projects.mjs");
const IS_SUBAGENT = Number(process.env.PI_SUBAGENT_DEPTH || "0") > 0;
const ACTIVITY_FILE = join(AGENT, `webui-editing-${process.pid}.json`);

function skillFiles(skills: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(skills)) return out;
  for (const skill of skills as any[]) {
    const name = typeof skill === "object" ? skill?.name : null;
    const file = typeof skill === "object" ? skill?.filePath : null;
    if (typeof name === "string" && name && typeof file === "string" && file) {
      out.set(resolve(file).toLowerCase(), name);
    }
  }
  return out;
}

async function writeState(skills: string[], project: string | null, cwd: string) {
  if (IS_SUBAGENT) return;
  try {
    await writeFile(STATE_FILE, JSON.stringify({ ts: Date.now(), skills, project, cwd }), "utf8");
  } catch {}
}

async function readActiveProject(): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(PROJECT_STATE_FILE, "utf8"));
    return typeof value.project === "string" && value.project.trim() ? value.project.trim() : null;
  } catch {
    return null;
  }
}

async function writeActiveProject(project: string | null) {
  if (project) {
    await writeFile(PROJECT_STATE_FILE, JSON.stringify({ project }), "utf8");
    return;
  }
  try { await unlink(PROJECT_STATE_FILE); } catch {}
}

async function projectLib(): Promise<any> {
  const version = (await stat(LIB_FILE)).mtimeMs;
  return import(`${pathToFileURL(LIB_FILE).href}?v=${version}`);
}

async function loadProjectContext(name: string, currentSessionFile?: string) {
  const lib = await projectLib();
  const projects = await lib.listProjects();
  const project = projects.find((item: any) => item.name.toLowerCase() === name.toLowerCase());
  if (!project) throw new Error(`Project "${name}" not found. Create it with /new-project ${name}`);

  const sessionFiles = lib.otherProjectSessions(project.sessions, currentSessionFile);
  const sessions = [];
  for (const session of sessionFiles) {
    try {
      const manager = SessionManager.open(session.path);
      sessions.push({ ...session, messages: manager.buildSessionContext().messages });
    } catch {}
  }

  return {
    name: project.name,
    sessions,
    context: lib.formatProjectContext(project.name, sessions),
  };
}

export default async function registerPiWebui(pi: ExtensionAPI) {
  pi.registerProvider("openrouter", {
    refreshModels: (context) => refreshOpenRouterCatalog(context),
  });

  let activeProject = await readActiveProject();
  let projectContext = "";
  let projectSessionCount = 0;
  let activeSkills: string[] = [];
  let currentSkillFiles = new Map<string, string>();
  let pendingSkillNames = new Set<string>();
  let currentCwd = process.cwd();
  const editedFiles = new Set<string>();
  const activeEditCalls = new Set<string>();

  async function writeActivity(expiresAt?: number) {
    if (!editedFiles.size) {
      try { await unlink(ACTIVITY_FILE); } catch {}
      return;
    }
    try {
      await writeFile(ACTIVITY_FILE, JSON.stringify({
        ts: Date.now(),
        who: IS_SUBAGENT ? "sub" : "pi",
        files: [...editedFiles],
        ...(expiresAt ? { expiresAt } : {}),
      }), "utf8");
    } catch {}
  }

  async function activateProject(name: string, ctx: any) {
    const loaded = await loadProjectContext(name, ctx.sessionManager?.getSessionFile?.());
    activeProject = loaded.name;
    projectContext = loaded.context;
    projectSessionCount = loaded.sessions.length;
    await writeActiveProject(activeProject);
    ctx.ui.setStatus("pitech-project", `project: ${activeProject}`);
    return loaded;
  }

  async function leaveProject(ctx: any) {
    activeProject = null;
    projectContext = "";
    projectSessionCount = 0;
    await writeActiveProject(null);
    ctx.ui.setStatus("pitech-project", undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = (ctx as any).cwd || process.cwd();
    await writeState(activeSkills, activeProject, currentCwd);
    if (!activeProject) {
      ctx.ui.setStatus("pitech-project", undefined);
      return;
    }
    try {
      await activateProject(activeProject, ctx);
    } catch (error: any) {
      const failed = activeProject;
      await leaveProject(ctx);
      await ctx.ui.notify(`Could not restore project "${failed}": ${error?.message ?? error}`, "error");
    }
  });

  async function recordPaths(text: string) {
    const paths = extractPaths(text);
    if (paths.length) await appendPaths(PATHS_FILE, paths);
  }

  // Keep the web UI's "skills used in current prompt" list fresh and add
  // compaction-aware history from the active project's other sessions.
  pi.on("input", async (event) => {
    await recordPaths(event.text);
    const match = /^\/skill:([^\s]+)/.exec(event.text);
    if (match) pendingSkillNames.add(match[1]);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await recordPaths(event.prompt);
    activeSkills = [];
    currentSkillFiles = skillFiles((event as any).systemPromptOptions?.skills);
    for (const name of pendingSkillNames) {
      if ([...currentSkillFiles.values()].includes(name)) activeSkills.push(name);
    }
    pendingSkillNames.clear();
    currentCwd = (ctx as any).cwd || process.cwd();
    await writeState(activeSkills, activeProject, currentCwd);
    if (!projectContext) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${projectContext}` };
  });

  pi.on("agent_start", async () => {
    editedFiles.clear();
    activeEditCalls.clear();
    await writeActivity();
  });

  pi.on("tool_execution_start", async (event) => {
    const file = (event.args as any)?.path;
    if (typeof file === "string" && file.trim() && /^read$/i.test(event.toolName)) {
      const skill = currentSkillFiles.get(resolve(currentCwd, file).toLowerCase());
      if (skill && !activeSkills.includes(skill)) {
        activeSkills.push(skill);
        await writeState(activeSkills, activeProject, currentCwd);
      }
      return;
    }
    if (!/^(edit|write)$/i.test(event.toolName)) return;
    if (typeof file !== "string" || !file.trim()) return;
    editedFiles.add(resolve(currentCwd, file));
    activeEditCalls.add(event.toolCallId);
    await writeActivity();
  });

  pi.on("tool_execution_end", async (event) => {
    if (!activeEditCalls.delete(event.toolCallId)) return;
    await writeActivity();
  });

  pi.on("agent_end", async () => {
    activeEditCalls.clear();
    await writeActivity(Date.now() + 15_000);
  });

  pi.on("session_shutdown", async () => {
    try { await unlink(ACTIVITY_FILE); } catch {}
  });

  pi.registerCommand("project", {
    description: "Enter a project and load its other sessions as context",
    getArgumentCompletions: async (prefix) => {
      try {
        const { listProjects, projectCompletionItems } = await projectLib();
        const projects = await listProjects();
        return projectCompletionItems(projects, prefix, true) || null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        try {
          const { listProjects } = await projectLib();
          const projects = await listProjects();
          const available = projects.map((project: any) => project.name).join(", ") || "none";
          const projectStatus = activeProject
            ? `Active project: ${activeProject} (${projectSessionCount} other sessions). `
            : "No active project. ";
          await ctx.ui.notify(`${projectStatus}Available: ${available}`, "info");
        } catch (error: any) {
          await ctx.ui.notify(`project failed: ${error?.message ?? error}`, "error");
        }
        return;
      }
      if (/^(off|none)$/i.test(name)) {
        await leaveProject(ctx);
        await ctx.ui.notify("Left the active project", "info");
        return;
      }
      try {
        const loaded = await activateProject(name, ctx);
        await ctx.ui.notify(
          `Entered project "${loaded.name}" with ${loaded.sessions.length} other session${loaded.sessions.length === 1 ? "" : "s"} in context`,
          "info"
        );
      } catch (error: any) {
        await ctx.ui.notify(`project failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("new-project", {
    description: "Create a project folder that collects past sessions for context",
    handler: async (args, ctx) => {
      try {
        const { newProject } = await projectLib();
        const project = await newProject(args);
        await ctx.ui.notify(`Project "${project.name}" created at ${project.dir}`, "info");
      } catch (error: any) {
        await ctx.ui.notify(`new-project failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("add-project", {
    description: "Copy the current session into a project folder",
    getArgumentCompletions: async (prefix) => {
      try {
        const { listProjects, projectCompletionItems } = await projectLib();
        const projects = await listProjects();
        return projectCompletionItems(projects, prefix) || null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      try {
        const sessionFile = ctx.sessionManager?.getSessionFile?.();
        if (!sessionFile) {
          await ctx.ui.notify("No session file to add (ephemeral session?)", "error");
          return;
        }
        try {
          await access(sessionFile);
        } catch {
          await ctx.ui.notify(
            "Session file isn't on disk yet — send a message first, then run /add-project again",
            "error"
          );
          return;
        }
        const { addSessionToProject } = await projectLib();
        const result = await addSessionToProject(args, sessionFile);
        await ctx.ui.notify(`Session added to project "${result.name}" (${result.dst})`, "info");
      } catch (error: any) {
        await ctx.ui.notify(`add-project failed: ${error?.message ?? error}`, "error");
      }
    },
  });
}
