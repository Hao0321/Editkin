import { canonicalJson } from "../shared/canonicalJson";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { findAsset, findClip } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import { clipTimeRemapExpectedV1, type ClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import { resolveRetimeWindow } from "./clipRetime";
import { validateSpeedCurveEditorV1 } from "./speedCurveEditorModelV1";

function identity(project: EditProject, clipId: string) {
  const clip = findClip(project, clipId), asset = findAsset(project, clip.assetId);
  return canonicalJson({ projectId: project.id, fps: project.fps, clip, asset });
}
export function speedCurveForClipV1(project: EditProject, clipId: string): ClipTimeRemapV1 {
  const clip = findClip(project, clipId), asset = findAsset(project, clip.assetId);
  if (asset.clipRetime) throw Error("SPEED_CURVE_RESET_B4_REQUIRED");
  const base = clip.speed ?? 1, curve = clip.timeRemap ? structuredClone(clip.timeRemap) : {
    schema: "editkin.clip-time-remap/v1" as const, direction: "forward" as const, interpolation: "frame_blending" as const, audioMode: clip.speed === 0 ? "mute" as const : "follow_speed" as const,
    segments: [{ from: { time: 0, speed: 1 }, control1: { time: 1 / 3, speed: 1 }, control2: { time: 2 / 3, speed: 1 }, to: { time: 1, speed: 1 } }],
  };
  curve.segments = curve.segments.map(s => ({ from: { ...s.from, speed: s.from.speed * base },
    control1: { ...s.control1, speed: s.control1.speed * base }, control2: { ...s.control2, speed: s.control2.speed * base }, to: { ...s.to, speed: s.to.speed * base } }));
  return validateSpeedCurveEditorV1(curve);
}
export interface SpeedCurveGestureV1 {
  schema: "editkin.speed-curve-gesture/v1"; clipId: string; expectedIdentity: string; initialCurve: ClipTimeRemapV1;
}
export function beginSpeedCurveGestureV1(project: EditProject, clipId: string): SpeedCurveGestureV1 {
  return { schema: "editkin.speed-curve-gesture/v1", clipId, expectedIdentity: identity(project, clipId), initialCurve: speedCurveForClipV1(project, clipId) };
}
/** Pointer moves edit only a scratch curve. Escape/blur discard it; call this ONCE at pointer-up.
 * H13 must supply pending/failed cache presentation before mounting an actionable editor. */
export function planSpeedCurveGestureV1(project: EditProject, gesture: SpeedCurveGestureV1, candidate: ClipTimeRemapV1) {
  if (gesture.schema !== "editkin.speed-curve-gesture/v1" || identity(project, gesture.clipId) !== gesture.expectedIdentity
    || canonicalJson(speedCurveForClipV1(project, gesture.clipId)) !== canonicalJson(gesture.initialCurve)) throw Error("SPEED_CURVE_GESTURE_STALE");
  const curve = validateSpeedCurveEditorV1(candidate), commands: EditorCommand[] = [];
  if (canonicalJson(curve) !== canonicalJson(gesture.initialCurve)) {
    let stage = project;
    const append = (command: EditorCommand) => { stage = applyCommand(stage, command); commands.push(command); };
    const target = () => findClip(stage, gesture.clipId);
    if (target().speed !== undefined) {
      // Clear through a valid zero-consumption hold, never an invalid temporary1x clock.
      const hold: ClipTimeRemapV1 = { ...structuredClone(curve), audioMode: "mute", segments: [{ from: { time: 0, speed: 0 }, control1: { time: 1 / 3, speed: 0 }, control2: { time: 2 / 3, speed: 0 }, to: { time: 1, speed: 0 } }] };
      append({ type: "set_clip_time_remap", clipId: gesture.clipId, expected: clipTimeRemapExpectedV1(target()), timeRemap: hold });
      append({ type: "set_clip_speed", clipId: gesture.clipId, expected: clipTimeRemapExpectedV1(target()), speed: null });
    }
    append({ type: "set_clip_time_remap", clipId: gesture.clipId, expected: clipTimeRemapExpectedV1(target()), timeRemap: curve });
  }
  const command = commands.length ? { type: "batch" as const, commands } : undefined;
  if (command) applyCommand(project, command);
  return { schema: "editkin.speed-curve-edit-plan/v1" as const, command, certification: "pending" as const,
    vaDefaultEligible: false as const, ordinaryPreviewIntegrated: false as const, exportHookIntegrated: false as const };
}

/** Reconnect the retained original through the existing retime reducer (captions/ripple/Undo included).
 * No derivative is deleted or re-encoded. This resets to forward1x before a separate curve gesture. */
export function planResetB4ForSpeedCurveV1(project: EditProject, clipId: string) {
  const clip = findClip(project, clipId), current = findAsset(project, clip.assetId);
  if (!current.clipRetime) throw Error("SPEED_CURVE_B4_DERIVATIVE_REQUIRED");
  const window = resolveRetimeWindow(project, clipId, 1, false);
  if (window.asset.clipRetime) throw Error("SPEED_CURVE_B4_CHAIN_UNSUPPORTED");
  const command = { type: "batch" as const, commands: [{ type: "retime_clip" as const, clipId, expectedAssetId: current.id,
    assetId: window.asset.id, sourceStart: window.sourceStart, duration: window.duration }] };
  applyCommand(project, command);
  return { command, sourceAssetId: window.asset.id, sourceStart: window.sourceStart, duration: window.duration,
    certification: "pending" as const, vaDefaultEligible: false as const };
}
