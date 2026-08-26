// PiTech by Haxnstuff
// pi-webui bridge extension:
//  - /new-project <name>  — create a project folder (collects past sessions)
//  - /add-project <name>  — copy the current session into a project
//  - /project <name>      — enter a project and load its other sessions as context
//  - writes ~/.pi/agent/webui-state.json so the web UI can show which skills
//    are active in the current prompt.
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { homedir } from "os";
import { access, readFile, stat, unlink, writeFile } from "fs/promises";
import { pathToFileURL } from "url";

const AGENT = join(homedir(), ".pi", "agent");
const STATE_FILE = join(AGENT, "webui-state.json");
const PROJECT_STATE_FILE = join(AGENT, "pitech-project.json");
const LIB_FILE = join(AGENT, "scripts", "projects.mjs");

function skillNames(skills: unknown): string[] {
  if (!Array.isArray(skills)) return [];
  return skills
    .map((s: any) => (typeof s === "string" ? s : s?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

async function writeState(skills: string[], project: string | null) {
  try {
    await writeFile(STATE_FILE, JSON.stringify({ ts: Date.now(), skills, project }), "utf8");
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

export default async function (pi: ExtensionAPI) {
  let activeProject = await readActiveProject();
  let projectContext = "";
  let projectSessionCount = 0;

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

  // Keep the web UI's "skills active in current prompt" list fresh and add
  // compaction-aware history from the active project's other sessions.
  pi.on("before_agent_start", async (event) => {
    await writeState(skillNames((event as any).systemPromptOptions?.skills), activeProject);
    if (!projectContext) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${projectContext}` };
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
          await ctx.ui.notify(
            `${activeProject ? `Active project: ${activeProject} (${projectSessionCount} other sessions). ` : "No active project. "}Available: ${available}`,
            "info"
          );
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
