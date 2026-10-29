import type { EditProject } from "./types";
import type { EditorCommand } from "./commandTypes";
import { canonicalJson } from "../shared/canonicalJson";
import { referenceMotionClipOwner } from "./referenceMotionSourceSlots";
import { containsReferenceMotionSourceRebind } from "./referenceMotionSourceRebind";

const proofs = new WeakMap<object, { project: string; batch: string; owners: readonly string[] }>();
export const REFERENCE_MOTION_SOURCE_AUTHORITY_MESSAGE = "模板換片需要目前實體字型重新編譯的提交證明。";

/** Process-local issuer used by the physical recompiler and independent v4 verifier, never a JSON/MCP grant. */
export function issueReferenceMotionSourceOwnerProof(project: EditProject, batch: EditorCommand, instanceIds: readonly string[]): object {
  if (batch.type !== "batch" || batch.commands.some(command => command.type === "batch" && containsReferenceMotionSourceRebind(command))) {
    throw new Error(REFERENCE_MOTION_SOURCE_AUTHORITY_MESSAGE);
  }
  const actual = new Set(batch.commands.flatMap(command => command.type === "rebind_reference_motion_clip_source"
    ? [referenceMotionClipOwner(project, command.clipId)?.instance.id] : []).filter((id): id is string => Boolean(id)));
  const allowed = new Set(instanceIds);
  if (!actual.size || allowed.size !== instanceIds.length || actual.size !== allowed.size || [...actual].some(id => !allowed.has(id))) {
    throw new Error(REFERENCE_MOTION_SOURCE_AUTHORITY_MESSAGE);
  }
  const token = Object.freeze({}); proofs.set(token, { project: canonicalJson(project), batch: canonicalJson(batch), owners: [...allowed] }); return token;
}
export function verifyReferenceMotionSourceOwnerProof(project: EditProject, batch: EditorCommand, proof: unknown, instanceIds: readonly string[]): void {
  const stored = proof && typeof proof === "object" ? proofs.get(proof) : undefined;
  if (!stored || stored.project !== canonicalJson(project) || stored.batch !== canonicalJson(batch)
    || canonicalJson([...stored.owners].sort()) !== canonicalJson([...instanceIds].sort())) throw new Error(REFERENCE_MOTION_SOURCE_AUTHORITY_MESSAGE);
}
