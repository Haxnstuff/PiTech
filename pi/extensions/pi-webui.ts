// PiTech by Haxnstuff
// pi-webui bridge extension:
//  - /new-project <name>  — create a project folder (collects past sessions)
//  - /add-project <name>  — copy the current session into a project
//  - writes ~/.pi/agent/webui-state.json so the web UI can show which skills
//    are active in the current prompt.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { homedir } from "os";
import { access, writeFile } from "fs/promises";
import { pathToFileURL } from "url";

const AGENT = join(homedir(), ".pi", "agent");
const STATE_FILE = join(AGENT, "webui-state.json");
const LIB_FILE = join(AGENT, "scripts", "projects.mjs");

function skillNames(skills: unknown): string[] {
  if (!Array.isArray(skills)) return [];
  return skills
    .map((s: any) => (typeof s === "string" ? s : s?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

async function writeState(skills: string[]) {
  try {
    await writeFile(STATE_FILE, JSON.stringify({ ts: Date.now(), skills }), "utf8");
  } catch {}
}

export default function (pi: ExtensionAPI) {
  // Keep the web UI's "skills active in current prompt" list fresh.
  pi.on("before_agent_start", async (event) => {
    await writeState(skillNames((event as any).systemPromptOptions?.skills));
  });

  pi.registerCommand("new-project", {
    description: "Create a project folder that collects past sessions for context",
    handler: async (args, ctx) => {
      try {
        const { newProject } = await import(pathToFileURL(LIB_FILE).href);
        const p = await newProject(args);
        await ctx.ui.notify(`Project "${p.name}" created at ${p.dir}`, "info");
      } catch (e: any) {
        await ctx.ui.notify(`new-project failed: ${e?.message ?? e}`, "error");
      }
    },
  });

  pi.registerCommand("add-project", {
    description: "Copy the current session into a project folder",
    getArgumentCompletions: async (prefix) => {
      try {
        const { listProjects } = await import(pathToFileURL(LIB_FILE).href);
        const projects = await listProjects();
        return projects
          .filter((p) => p.name.startsWith(prefix))
          .map((p) => ({ value: p.name, description: `${p.sessions.length} sessions` }));
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
        const { addSessionToProject } = await import(pathToFileURL(LIB_FILE).href);
        const r = await addSessionToProject(args, sessionFile);
        await ctx.ui.notify(
          `Session added to project "${r.name}" (${r.dst})`,
          "info"
        );
      } catch (e: any) {
        await ctx.ui.notify(`add-project failed: ${e?.message ?? e}`, "error");
      }
    },
  });
}
