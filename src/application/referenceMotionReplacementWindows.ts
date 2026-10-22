import type { EditProject } from "../domain/types";
import { referenceMotionSourceSlots } from "../domain/referenceMotionSourceSlots";
import type { ReferenceMotionCompatiblePlan } from "./referenceMotionSourcePlanV2";

export interface ReferenceMotionMaterialWindow { assetId: string; sourceStart: number; duration: number }
export function hasReferenceMotionSourceReplacement(declaration: ReferenceMotionCompatiblePlan | undefined): boolean {
  return Boolean(declaration?.instances.some(step => step.mode === "replace_source"));
}
/** Derive coverage from current source slots and declared intent, never from caller-provided command metadata. */
export function referenceMotionReplacementWindows(project: EditProject, declaration: ReferenceMotionCompatiblePlan | undefined): ReferenceMotionMaterialWindow[] {
  const windows = new Map<string, ReferenceMotionMaterialWindow>();
  for (const step of declaration?.instances ?? []) {
    if (step.mode !== "replace_source") continue;
    const instance = project.referenceMotionInstances?.find(candidate => candidate.id === step.instanceId);
    if (!instance || instance.instanceRevision !== step.expectedInstanceRevision) throw new Error("Source replacement requires its current saved instance");
    const duration = (step.replacement.durationFrames ?? instance.input.durationFrames) / project.fps;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid source replacement duration");
    for (const slot of referenceMotionSourceSlots(project, instance)) {
      const target = slot.slot === 0 ? step.replacement.primary : step.replacement.sources?.[slot.slot - 1];
      const next = { assetId: target?.assetId ?? slot.assetId, sourceStart: target?.sourceStart ?? slot.sourceStart, duration };
      if (next.assetId === slot.assetId && next.sourceStart === slot.sourceStart && duration === slot.durationFrames / project.fps) continue;
      windows.set(JSON.stringify(next), next);
    }
  }
  return [...windows.values()];
}
/** Only windows emitted after full source/cache/semantic verification may enter this containment check. */
export function assertReferenceMotionReplacementCoverage(required: readonly ReferenceMotionMaterialWindow[], verified: readonly ReferenceMotionMaterialWindow[]): void {
  for (const window of required) {
    if (!verified.some(receipt => receipt.assetId === window.assetId && Number.isFinite(receipt.sourceStart)
      && Number.isFinite(receipt.duration) && receipt.sourceStart >= 0 && receipt.duration > 0
      && receipt.sourceStart <= window.sourceStart + 1e-7 && receipt.sourceStart + receipt.duration >= window.sourceStart + window.duration - 1e-7)) {
      throw new Error(`Template source replacement lacks fresh verified material coverage: ${window.assetId} [${window.sourceStart}, ${window.sourceStart + window.duration}]`);
    }
  }
}
