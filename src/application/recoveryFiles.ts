import { randomUUID } from "node:crypto";
import { access, open, rename, rm } from "node:fs/promises";
import type { EditProject } from "../domain/types";
import { readBoundedFile } from "../shared/boundedFile";
import { acquireProjectLock, assertProjectFileIdentityV1, requireProjectFileIdentityV1, parseProject, writeProjectFileAtomicWithIdentityV1 } from "./projectFiles";
import type { ProjectFileIdentityV1 } from "../domain/projectFileIdentityV1";

export const RECOVERY_MAX_BYTES = 32 * 1024 * 1024;
export const RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export interface RecoverySnapshot {
  schemaVersion: 1;
  savedAt: string;
  cleanUpdatedAt: string;
  projectPath?: string;
  project: EditProject;
  baseFileIdentity?: Readonly<ProjectFileIdentityV1>;
}

export type RecoveryReadResult =
  | { found: false; reason: "missing" | "corrupt" | "stale" }
  | { found: true; source: "primary" | "previous"; snapshot: RecoverySnapshot };

function previousPath(path: string): string { return `${path}.previous`; }

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function parseRecoverySnapshot(
  input: unknown,
  nowMs = Date.now(),
  maxAgeMs = RECOVERY_MAX_AGE_MS,
): RecoverySnapshot {
  if (!input || typeof input !== "object") throw new Error("recovery snapshot 不是物件");
  const value = input as Record<string, unknown>;
  const savedAtMs = typeof value.savedAt === "string" ? Date.parse(value.savedAt) : Number.NaN;
  const cleanUpdatedAtMs = typeof value.cleanUpdatedAt === "string" ? Date.parse(value.cleanUpdatedAt) : Number.NaN;
  if (value.schemaVersion !== 1 || !Number.isFinite(savedAtMs) || !Number.isFinite(cleanUpdatedAtMs)) {
    throw new Error("recovery snapshot metadata 不合法");
  }
  if (savedAtMs > nowMs + 5 * 60_000) throw new Error("recovery snapshot 時間來自未來");
  if (nowMs - savedAtMs > maxAgeMs) throw Object.assign(new Error("recovery snapshot 已過期"), { code: "STALE" });
  if (value.projectPath !== undefined && (typeof value.projectPath !== "string" || !value.projectPath.trim())) {
    throw new Error("recovery snapshot projectPath 不合法");
  }
  return {
    schemaVersion: 1,
    savedAt: new Date(savedAtMs).toISOString(),
    cleanUpdatedAt: new Date(cleanUpdatedAtMs).toISOString(),
    ...(typeof value.projectPath === "string" ? { projectPath: value.projectPath } : {}),
    project: parseProject(value.project),
    ...(value.baseFileIdentity !== undefined ? { baseFileIdentity: requireProjectFileIdentityV1(value.baseFileIdentity) } : {}),
  };
}

async function readCandidate(path: string, nowMs: number, maxBytes: number): Promise<RecoverySnapshot | undefined> {
  if (!await exists(path)) return undefined;
  const bytes = await readBoundedFile(path, maxBytes, { followSymlinks: true, messages: { tooLarge: "recovery snapshot 超過大小上限" } });
  return parseRecoverySnapshot(JSON.parse(bytes.toString("utf8")), nowMs);
}

export async function readRecoveryFile(
  path: string,
  options: { nowMs?: number; maxBytes?: number } = {},
): Promise<RecoveryReadResult> {
  const nowMs = options.nowMs ?? Date.now();
  const maxBytes = options.maxBytes ?? RECOVERY_MAX_BYTES;
  let stale = false;
  try {
    const primary = await readCandidate(path, nowMs, maxBytes);
    if (primary) return { found: true, source: "primary", snapshot: primary };
  } catch (error) {
    stale = (error as NodeJS.ErrnoException).code === "STALE";
  }
  try {
    const previous = await readCandidate(previousPath(path), nowMs, maxBytes);
    if (previous) return { found: true, source: "previous", snapshot: previous };
  } catch (error) {
    stale ||= (error as NodeJS.ErrnoException).code === "STALE";
  }
  return { found: false, reason: stale ? "stale" : await exists(path) || await exists(previousPath(path)) ? "corrupt" : "missing" };
}

export async function writeRecoveryFileAtomic(
  path: string,
  input: { project: EditProject; projectPath?: string; cleanUpdatedAt: string; baseFileIdentity?: ProjectFileIdentityV1 },
  options: { nowMs?: number; maxBytes?: number } = {},
): Promise<RecoverySnapshot> {
  const snapshot = parseRecoverySnapshot({
    schemaVersion: 1,
    savedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    cleanUpdatedAt: input.cleanUpdatedAt,
    projectPath: input.projectPath,
    project: input.project,
    baseFileIdentity: input.baseFileIdentity,
  }, options.nowMs ?? Date.now());
  const serialized = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(serialized) > (options.maxBytes ?? RECOVERY_MAX_BYTES)) {
    throw new Error("專案 recovery snapshot 超過 32 MiB 上限；請立即手動儲存專案");
  }
  const release = await acquireProjectLock(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const previous = previousPath(path);
  const parkedPrevious = `${previous}.${process.pid}.${randomUUID()}.rollback`;
  const corrupt = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
  let parked = false;
  let movedCurrent = false;
  let movedCorrupt = false;
  let committed = false;
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(serialized, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    if (await exists(path)) {
      let primaryValid = false;
      try { primaryValid = Boolean(await readCandidate(path, options.nowMs ?? Date.now(), options.maxBytes ?? RECOVERY_MAX_BYTES)); }
      catch { /* A corrupt/stale primary must never replace the valid previous generation. */ }
      if (primaryValid) {
        // Keep the old backup's exact bytes until the new primary has committed.
        // Renaming avoids a full backup copy on every autosave.
        if (await exists(previous)) { await rename(previous, parkedPrevious); parked = true; }
        await rename(path, previous);
        movedCurrent = true;
      } else {
        await rename(path, corrupt);
        movedCorrupt = true;
      }
    }
    await rename(temporary, path);
    committed = true;
    if (parked) {
      // A cleanup error after the commit point must not report a successful
      // durable save as rejected. The exact older backup remains on disk.
      try { await rm(parkedPrevious, { force: true }); } catch { /* retained rollback artifact */ }
    }
    return snapshot;
  } catch (error) {
    if (!committed) {
      try {
        if (!await exists(path)) {
          if (movedCurrent && await exists(previous)) await rename(previous, path);
          else if (movedCorrupt && await exists(corrupt)) await rename(corrupt, path);
        }
        if (parked && !await exists(previous)) await rename(parkedPrevious, previous);
      } catch (rollbackError) {
        // Do not delete either retained generation when the filesystem also
        // rejects rollback. Both errors remain visible to the caller.
        throw new AggregateError([error, rollbackError], "復原資料儲存及回復失敗；保留原檔與暫存備份，請立即手動另存專案");
      }
    }
    throw error;
  } finally {
    try { await rm(temporary, { force: true }); }
    finally { await release(); }
  }
}

export async function clearRecoveryFile(path: string): Promise<void> {
  const release = await acquireProjectLock(path);
  try { await Promise.all([rm(path, { force: true }), rm(previousPath(path), { force: true })]); }
  finally { await release(); }
}

function requireRecoveryBaseV1(target: string, input: unknown) {
  const snapshot = parseRecoverySnapshot(input);
  if (!snapshot.projectPath || snapshot.projectPath !== target || !snapshot.baseFileIdentity) throw new Error("RECOVERY_BASE_IDENTITY_REQUIRED_USE_SAVE_AS");
  const base = requireProjectFileIdentityV1(snapshot.baseFileIdentity);
  if (base.projectId !== snapshot.project.id || base.revision !== snapshot.project.revision || base.updatedAt !== snapshot.cleanUpdatedAt) throw new Error("RECOVERY_BASE_IDENTITY_MISMATCH");
  return { snapshot, base };
}
export async function verifyRecoveryProjectBaseV1(target: string, input: unknown) {
  const { base } = requireRecoveryBaseV1(target, input);
  return assertProjectFileIdentityV1(target, base);
}
export async function commitRecoveryProjectFileV1(target: string, input: unknown) {
  const { snapshot, base } = requireRecoveryBaseV1(target, input);
  return writeProjectFileAtomicWithIdentityV1(target, snapshot.project, snapshot.project.revision, { expectedFileIdentity: base });
}
