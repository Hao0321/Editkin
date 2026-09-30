import type { EditProject } from "../domain/types";
import { parseProject } from "./parseProject";

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
