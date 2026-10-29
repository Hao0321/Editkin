import { AsyncLocalStorage } from "node:async_hooks";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { RECOVERY_MAX_AGE_MS } from "../application/recoveryFiles";

/**
 * What an agent can observe about the Editkin desktop (GUI) session without touching it.
 *
 * The desktop editor writes a crash-recovery snapshot (<app data>/recovery/session.json, 500 ms after the first unsaved
 * change) and deletes it when the project is saved or the change is undone. A present, fresh snapshot therefore means
 * the GUI holds unsaved changes for `projectPath` (or for an untitled project), or a crashed session is waiting for the
 * creator's recovery choice. A GUI that has a project open with no unsaved changes leaves no trace an agent can read, so
 * that state is reported as not observable rather than guessed.
 *
 * The app data root is EDITKIN_APP_DATA_ROOT, else the parent of EDITKIN_AGENT_STATE_ROOT (the desktop launches agents
 * with <app data>/agent-runtime-v3). Without either, the GUI is not observable and nothing is blocked.
 */
export interface GuiUnsavedSession {
  source: "primary" | "previous";
  /** Absolute path as the GUI recorded it; never returned to the agent when it lies outside the workspace. */
  projectPath?: string;
  savedAt: string;
  cleanUpdatedAt: string;
  ageSeconds: number;
}

export type GuiSessionObservation =
  | { observable: false; reason: "app_data_root_unknown" }
  | { observable: true; unsaved: GuiUnsavedSession | null; unreadable?: "corrupt" | "stale" };

const SNAPSHOT_PREFIX_BYTES = 64 * 1024;

export function editkinAppDataRoot(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = environment.EDITKIN_APP_DATA_ROOT;
  if (explicit && isAbsolute(explicit)) return resolve(explicit);
  const state = environment.EDITKIN_AGENT_STATE_ROOT;
  if (state && isAbsolute(state)) return dirname(resolve(state));
  return undefined;
}

/**
 * Reads only the snapshot metadata. The recovery writer serializes {schemaVersion, savedAt, cleanUpdatedAt,
 * projectPath?, project, …} in that key order, and a JSON string can never contain an unescaped `,"project":`, so the
 * metadata is the prefix before the first `,"project":`. The (up to 32 MiB) project body is never read.
 */
async function readSnapshotMetadata(path: string): Promise<{ savedAt: string; cleanUpdatedAt: string; projectPath?: string } | "missing" | "corrupt"> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; !handle; attempt += 1) {
    try { handle = await open(path, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      // The desktop publishes snapshots by rename; retry one transient Windows sharing error, then fail closed.
      if (attempt >= 1) throw error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
  }
  try {
    const buffer = Buffer.alloc(SNAPSHOT_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const end = text.indexOf(",\"project\":");
    if (end < 0) return "corrupt";
    let value: unknown;
    try { value = JSON.parse(`${text.slice(0, end)}}`); } catch { return "corrupt"; }
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || typeof record.savedAt !== "string" || typeof record.cleanUpdatedAt !== "string") return "corrupt";
    if (record.projectPath !== undefined && (typeof record.projectPath !== "string" || !record.projectPath.trim())) return "corrupt";
    return { savedAt: record.savedAt, cleanUpdatedAt: record.cleanUpdatedAt, ...(typeof record.projectPath === "string" ? { projectPath: record.projectPath } : {}) };
  } finally { await handle.close(); }
}

export async function observeGuiSession(environment: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): Promise<GuiSessionObservation> {
  const root = editkinAppDataRoot(environment);
  if (!root) return { observable: false, reason: "app_data_root_unknown" };
  const primary = resolve(root, "recovery", "session.json");
  let unreadable: "corrupt" | "stale" | undefined;
  for (const [source, path] of [["primary", primary], ["previous", `${primary}.previous`]] as const) {
    const metadata = await readSnapshotMetadata(path);
    if (metadata === "missing") continue;
    if (metadata === "corrupt") { unreadable ??= "corrupt"; continue; }
    const savedAtMs = Date.parse(metadata.savedAt);
    if (!Number.isFinite(savedAtMs) || savedAtMs > nowMs + 5 * 60_000) { unreadable ??= "corrupt"; continue; }
    // Same window as the desktop reader: an older snapshot is moved aside at the next GUI start, never restored.
    if (nowMs - savedAtMs > RECOVERY_MAX_AGE_MS) { unreadable ??= "stale"; continue; }
    return { observable: true, unsaved: { source, ...metadata, ageSeconds: Math.max(0, Math.round((nowMs - savedAtMs) / 1000)) } };
  }
  return { observable: true, unsaved: null, ...(unreadable ? { unreadable } : {}) };
}

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function sameProjectPath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

/** A compact, privacy-safe view of a GUI project path: workspace-relative inside the workspace, otherwise the file name only. */
export function describeGuiProjectPath(projectPath: string | undefined, workspace: string): { projectPath: string | null; inWorkspace: boolean | null } {
  if (!projectPath) return { projectPath: null, inWorkspace: null };
  const relation = relative(resolve(workspace), resolve(projectPath));
  if (relation && !relation.startsWith("..") && !isAbsolute(relation)) return { projectPath: relation.replaceAll("\\", "/"), inWorkspace: true };
  return { projectPath: basename(projectPath), inWorkspace: false };
}

export class GuiSessionDirtyError extends Error {
  constructor(savedAt: string) {
    super(`GUI_SESSION_DIRTY: Editkin 桌面版正開著這個專案且有未儲存的修改（復原快照 ${savedAt}）。請先在 Editkin 儲存或關閉它；確定要覆寫桌面版尚未儲存的修改時，apply_edit_commands 可明確傳 allowDirtyGuiSession:true。`);
    this.name = "GuiSessionDirtyError";
  }
}

const dirtyGuiOverride = new AsyncLocalStorage<boolean>();

/** Runs `operation` with the caller's explicit permission to write a project the GUI holds unsaved changes for. */
export function withDirtyGuiSessionOverride<T>(allowed: boolean, operation: () => Promise<T>): Promise<T> {
  return allowed ? dirtyGuiOverride.run(true, operation) : operation();
}

/** Refuses an agent write to a project the desktop editor holds unsaved changes for, unless the call explicitly allowed it. */
export async function assertNoDirtyGuiSession(absoluteProjectPath: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (dirtyGuiOverride.getStore() === true) return;
  const observed = await observeGuiSession(environment);
  if (!observed.observable || !observed.unsaved?.projectPath) return;
  if (sameProjectPath(observed.unsaved.projectPath, absoluteProjectPath)) throw new GuiSessionDirtyError(observed.unsaved.savedAt);
}

/** The project the GUI holds unsaved changes for, when it is this one (create_project overwrite never allows it). */
export async function guiUnsavedSessionFor(absoluteProjectPath: string, environment: NodeJS.ProcessEnv = process.env): Promise<GuiUnsavedSession | undefined> {
  const observed = await observeGuiSession(environment);
  if (!observed.observable || !observed.unsaved?.projectPath) return undefined;
  return sameProjectPath(observed.unsaved.projectPath, absoluteProjectPath) ? observed.unsaved : undefined;
}
