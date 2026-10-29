import type { EditProject, TimelineClip } from "../domain/types";
import { isTransformMotionBlurInstance } from "../domain/transformMotionBlur";

/** Supplied by H4/H13 at the time of the action, and checked again before rendering.
 * Windows are not persisted in today's clip schema; their future adapter must say explicitly. */
export interface MotionBlurCapabilitiesV1 {
  gpuCompositorAvailable: boolean;
  colorWindowAttached: boolean;
}
export type MotionBlurRefusalV1 = "aces" | "clip-mask" | "color-window" | "capabilities-unverified"
  | "gpu-unavailable" | "authored-clock" | "animated-opacity" | "cpu-effect-stack" | "effect-stack-full" | "unsupported-content";
export type MotionBlurAdmissionV1 = { allowed: true } | { allowed: false; reason: MotionBlurRefusalV1 };

/** Pure admission, not an installed export hook or a GPU-quality receipt. It does not drop a mask.
 * The integrator maps reasons to UI text; this module contains no new untranslated UI copy. */
export function inspectMotionBlurAdmissionV1(project: EditProject, clip: TimelineClip,
  capabilities?: MotionBlurCapabilitiesV1): MotionBlurAdmissionV1 {
  if (project.colorManagement?.mode === "aces2") return { allowed: false, reason: "aces" };
  if (clip.masks?.some(m => m.enabled)) return { allowed: false, reason: "clip-mask" };
  if (capabilities?.colorWindowAttached === true) return { allowed: false, reason: "color-window" };
  if (typeof capabilities?.colorWindowAttached !== "boolean" || typeof capabilities?.gpuCompositorAvailable !== "boolean") {
    return { allowed: false, reason: "capabilities-unverified" };
  }
  if (!capabilities.gpuCompositorAvailable) return { allowed: false, reason: "gpu-unavailable" };
  if (clip.timeRemap || (clip.speed ?? 1) !== 1) return { allowed: false, reason: "authored-clock" };
  if (clip.keyframes.some(k => Math.abs(k.transform.opacity - clip.transform.opacity) > 1e-6)) return { allowed: false, reason: "animated-opacity" };
  const source = project.assets.find(a => a.id === clip.assetId);
  if (!source || !["video", "image"].includes(source.kind) || source.compositionId || source.imageSequence
    || clip.transform3d || clip.floatingFrame || clip.proofStill || Object.keys(clip.expressions ?? {}).length > 0) {
    return { allowed: false, reason: "unsupported-content" };
  }
  const stack = clip.creative?.nativeEffectInstances ?? [];
  // The existing add command counts disabled entries and refuses mixed CPU/GPU stacks.
  if (stack.some(i => i.runtimeType !== "gpu_effect_graph")) return { allowed: false, reason: "cpu-effect-stack" };
  if (!stack.some(isTransformMotionBlurInstance) && stack.length >= 4) return { allowed: false, reason: "effect-stack-full" };
  return { allowed: true };
}
