import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { EditProject } from "../domain/types";
import { parseProject } from "./projectFiles";

export const RECOVERY_MAX_BYTES = 32 * 1024 * 1024;
export const RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export interface RecoverySnapshot {
  schemaVersion: 1;
  savedAt: string;
  cleanUpdatedAt: string;
  projectPath?: string;
  project: EditProject;
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
  };
}

async function readCandidate(path: string, nowMs: number, maxBytes: number): Promise<RecoverySnapshot | undefined> {
  if (!await exists(path)) return undefined;
  if ((await stat(path)).size > maxBytes) throw new Error("recovery snapshot 超過大小上限");
  return parseRecoverySnapshot(JSON.parse(await readFile(path, "utf8")), nowMs);
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
  input: { project: EditProject; projectPath?: string; cleanUpdatedAt: string },
  options: { nowMs?: number; maxBytes?: number } = {},
): Promise<RecoverySnapshot> {
  const snapshot = parseRecoverySnapshot({
    schemaVersion: 1,
    savedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    cleanUpdatedAt: input.cleanUpdatedAt,
    projectPath: input.projectPath,
    project: input.project,
  }, options.nowMs ?? Date.now());
  const serialized = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(serialized) > (options.maxBytes ?? RECOVERY_MAX_BYTES)) {
    throw new Error("專案 recovery snapshot 超過 32 MiB 上限；請立即手動儲存專案");
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const previous = previousPath(path);
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(serialized, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rm(previous, { force: true });
    if (await exists(path)) await rename(path, previous);
    await rename(temporary, path);
    return snapshot;
  } catch (error) {
    if (!await exists(path) && await exists(previous)) await rename(previous, path);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function clearRecoveryFile(path: string): Promise<void> {
  await Promise.all([rm(path, { force: true }), rm(previousPath(path), { force: true })]);
}
