import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { createTransformMotionBlurInstance, isTransformMotionBlurInstance, transformMotionBlurParameters } from "../domain/transformMotionBlur";
import type { EditProject } from "../domain/types";
import { motionClipPresetCommands, type MotionClipPresetId, type MotionClipPresetContext } from "../motion/motionClipPresets";
import { inspectMotionBlurAdmissionV1, type MotionBlurCapabilitiesV1 } from "../plugins/motionBlurAdmissionV1";

export const CLIP_MOTION_BLUR_RECIPES_V1 = Object.freeze(["punch_in", "snap_zoom", "whip_in", "impact_shake"] as const);
export const CLIP_MOTION_BLUR_POLICY_V1 = Object.freeze({
  schema: "editkin.clip-motion-blur-policy/v1", enabledByDefault: false, certification: "pending", vaDefaultEligible: false,
  shutterAngle: 180, samples: 8, sourceSampling: "decoded_temporal", recipes: CLIP_MOTION_BLUR_RECIPES_V1,
} as const);
export interface ClipMotionBlurOptionsV1 extends Pick<MotionClipPresetContext, "energy" | "focus" | "direction"> {
  addMotionBlur?: boolean;
  capabilities?: MotionBlurCapabilitiesV1;
}
export function clipMotionBlurEligibleV1(preset: MotionClipPresetId) {
  return (CLIP_MOTION_BLUR_RECIPES_V1 as readonly string[]).includes(preset);
}

/** One command for one Undo. Does not edit the frozen motion compiler or any existing instance's
 * parameters. H13 owns the default-off checkbox and H4 owns renderer admission/messaging. */
export function planClipMotionWithBlurV1(project: EditProject, clipId: string, preset: MotionClipPresetId,
  options: ClipMotionBlurOptionsV1 = {}) {
  if (options.addMotionBlur !== undefined && typeof options.addMotionBlur !== "boolean") throw Error("MOTION_BLUR_OPTION_INVALID");
  const track = project.tracks.find(t => t.clips.some(c => c.id === clipId)), clip = track?.clips.find(c => c.id === clipId);
  if (!track || !clip || track.kind !== "video") throw Error("MOTION_BLUR_VIDEO_CLIP_REQUIRED");
  if (track.locked) throw Error(TRACK_LOCKED_MESSAGE);
  if (project.referenceMotionInstances?.some(i => i.input.clipId === clipId || i.roles.some(r => r.id === clipId || r.parentId === clipId))
    || project.templateApplication?.generatedClips?.some(c => c.clipId === clipId)
    || project.templateApplication?.applied.clips.some(c => c.clipId === clipId)) throw Error("MOTION_BLUR_TEMPLATE_RECOMPILE_REQUIRED");
  if (options.addMotionBlur && !clipMotionBlurEligibleV1(preset)) throw Error("MOTION_BLUR_RECIPE_NOT_APPROVED");
  const instances = clip.creative?.nativeEffectInstances ?? [], existing = instances.filter(isTransformMotionBlurInstance);
  if (existing.length > 1) throw Error("MOTION_BLUR_DUPLICATE_INSTANCE");
  const requested = options.addMotionBlur === true, prior = existing[0];
  if (requested || prior?.enabled) {
    const admission = inspectMotionBlurAdmissionV1(project, clip, options.capabilities);
    if (!admission.allowed) throw Error(`MOTION_BLUR_REFUSED:${admission.reason}`);
    if (prior) transformMotionBlurParameters(prior);
  }
  const commands: EditorCommand[] = motionClipPresetCommands(clip, project.fps, preset, {
    projectWidth: project.width, projectHeight: project.height, energy: options.energy, focus: options.focus, direction: options.direction,
  });
  let blurAction: "unchanged" | "added" | "already-enabled" | "reenabled" = "unchanged";
  if (requested && !prior) {
    const instance = createTransformMotionBlurInstance(), base = instance.id;
    for (let suffix = 1; instances.some(i => i.id === instance.id); suffix++) instance.id = `${base}-${suffix}`;
    commands.push({ type: "add_native_effect", clipId, instance }); blurAction = "added";
  } else if (requested && prior) {
    if (!prior.enabled) {
      if (instances.indexOf(prior) !== instances.length - 1) commands.push({ type: "reorder_native_effect", clipId, instanceId: prior.id, toIndex: instances.length - 1 });
      commands.push({ type: "update_native_effect", clipId, instanceId: prior.id, patch: { enabled: true } }); blurAction = "reenabled";
    } else blurAction = "already-enabled";
  }
  const command = { type: "batch" as const, commands };
  // Run the real reducer/validator against a clone before exposing an actionable plan.
  applyCommand(project, command);
  return { schema: "editkin.clip-motion-blur-plan/v1" as const, certification: "pending" as const,
    vaDefaultEligible: false as const, enabledByDefault: false as const, preset, blurAction, command };
}
