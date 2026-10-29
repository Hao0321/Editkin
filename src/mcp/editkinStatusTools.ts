import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import packageManifest from "../../package.json";
import { describeGuiProjectPath, observeGuiSession, sameProjectPath } from "./guiSessionState";
import type { McpProfileState } from "./mcpProfiles";
import { projectFileExists, projectLockState, projectMediaState, readStoredProject, resolveProjectPath, workspaceRoot } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

const STATUS_MISSING_MEDIA_ITEMS = 3;

/** The running engine build: the bundled entrypoint's own bytes identify it; source runs (tsx) say so. */
let entrypointIdentity: Promise<{ build: "bundle" | "source"; entrypointSha256: string | null }> | undefined;
function readEntrypointIdentity() {
  entrypointIdentity ??= (async () => {
    const file = fileURLToPath(import.meta.url);
    if (!file.endsWith(".mjs") && !file.endsWith(".js")) return { build: "source" as const, entrypointSha256: null };
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return { build: "bundle" as const, entrypointSha256: hash.digest("hex") };
  })().catch(() => ({ build: "bundle" as const, entrypointSha256: null }));
  return entrypointIdentity;
}

export async function editkinStatus(context: { profile: McpProfileState; environment: NodeJS.ProcessEnv }, projectPath?: string) {
  const [identity, gui] = await Promise.all([readEntrypointIdentity(), observeGuiSession(context.environment)]);
  const workspace = workspaceRoot();
  const unsaved = gui.observable ? gui.unsaved : null;
  const status = {
    status: "GREEN" as const,
    engine: {
      name: "editkin", version: packageManifest.version, ...identity, node: process.versions.node,
      mcpProfile: context.profile.profile, advertisedTools: context.profile.advertised().length, registeredTools: context.profile.registered.length,
    },
    gui: gui.observable ? {
      observable: true, source: "crash_recovery_autosave", openCleanProject: "not_observable",
      unsavedSession: unsaved ? { ...describeGuiProjectPath(unsaved.projectPath, workspace), savedAt: unsaved.savedAt, ageSeconds: unsaved.ageSeconds,
        snapshot: unsaved.source, meaning: "unsaved_changes_or_pending_crash_recovery" } : null,
      ...(gui.unreadable ? { unreadableSnapshot: gui.unreadable } : {}),
    } : { observable: false, reason: gui.reason },
    agentWritePolicy: "A project with unsaved desktop changes is refused unless apply_edit_commands passes allowDirtyGuiSession:true; create_project overwrite always refuses it and locked projects.",
  };
  if (projectPath === undefined) return status;
  const absolute = await resolveProjectPath(projectPath);
  const guiUnsavedChanges = gui.observable ? Boolean(unsaved?.projectPath && sameProjectPath(unsaved.projectPath, absolute)) : null;
  const locks = await projectLockState(absolute);
  if (!await projectFileExists(absolute)) {
    return { ...status, project: { projectPath, exists: false, guiUnsavedChanges, ...locks } };
  }
  const stored = await readStoredProject(projectPath);
  const media = await projectMediaState(stored.project, STATUS_MISSING_MEDIA_ITEMS);
  return { ...status, project: {
    projectPath, exists: true, revision: stored.project.revision, projectSha256: stored.projectSha256,
    ...(stored.readFrom === "previous" ? { readFrom: "previous" } : {}),
    guiUnsavedChanges, ...locks, ...media,
    agentWrites: guiUnsavedChanges ? "refused_gui_unsaved_changes" : locks.saveLocked || locks.autopilotLocked ? "busy_locked" : "allowed",
  } };
}

export function registerEditkinStatusTools(server: McpServer, context: { profile: McpProfileState; environment: NodeJS.ProcessEnv }): void {
  server.registerTool("get_editkin_status", {
    description: "精簡狀態（≤2 KB、唯讀）：引擎版本與 build 身分、MCP profile、桌面版是否有未儲存修改（讀當機復原自動備份，只讀 metadata；開著但已儲存的專案無法觀察，誠實回報）；給 projectPath 時再回 revision、檔案 SHA-256、儲存／自動剪輯鎖、缺失素材與工作區外唯讀素材數。Agent 寫入前先查：桌面版有未儲存修改的專案預設拒絕寫入。",
    inputSchema: z.object({ projectPath: z.string().min(1).max(1024).optional() }),
  }, async ({ projectPath }) => {
    try { return textResult(await editkinStatus(context, projectPath)); }
    catch (error) { return errorResult(error); }
  });
}
