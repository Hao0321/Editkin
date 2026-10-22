import type { EditorCommand } from "../domain/commandTypes";
import { findAsset, findClip } from "../domain/editGraph";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import type { EditProject } from "../domain/types";
import type { ClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import { beginSpeedCurveGestureV1, planSpeedCurveGestureV1, planResetB4ForSpeedCurveV1, type SpeedCurveGestureV1 } from "./speedCurveEditCommandsV1";
import { moveSpeedCurvePointV1, moveSpeedCurveHandleV1, speedCurveAnchorsV1 } from "./speedCurveEditorModelV1";
export function speedCurveInteractionErrorKindV1(error: unknown): "stale" | "sourceShort" | "locked" | "endpoint" | "followUnavailable" | "temporal" | "unsupported" | "outside" | "unavailable" | "invalid" {
  const text = String(error);
  if (text.includes("STALE") || text.includes("SOURCE_OR_SETTINGS_CHANGED")) return "stale";
  if (text.includes("HANDLES_INSUFFICIENT") || /超過素材/.test(text)) return "sourceShort";
  if (text.includes(TRACK_LOCKED_MESSAGE)) return "locked";
  if (text.includes("ENDPOINT")) return "endpoint";
  if (text.includes("FOLLOW_AUDIO")) return "followUnavailable";
  if (text.includes("TEMPORAL_BINDING") || /標題模板/.test(text)) return "temporal";
  if (text.includes("UNSUPPORTED")) return "unsupported";
  if (text.includes("OUTSIDE")) return "outside";
  if (text.includes("UNAVAILABLE")) return "unavailable";
  return "invalid";
}

export type SpeedCurveDragTargetV1 = { kind: "anchor"; index: number } | { kind: "handle"; index: number; handle: "control1" | "control2" };
export interface SpeedCurveInteractionContextV1 {
  project: EditProject; clipId: string; hostReady?: boolean; disabled?: boolean; busy?: boolean;
  sourceHasAudio?: boolean; followAudioSupported?: boolean;
}
export function createSpeedCurveInteractionV1(options: {
  read(): SpeedCurveInteractionContextV1;
  dispatch(command: EditorCommand, expectedRevision: number): void | Promise<void>;
  onDraft?(curve: ClipTimeRemapV1 | undefined): void; onBusy?(busy: boolean): void; onError?(error: unknown): void;
}) {
  let drag: { gesture: SpeedCurveGestureV1; revision: number; curve: ClipTimeRemapV1; target: SpeedCurveDragTargetV1 } | undefined;
  let inFlight = false;
  const guard = (context: SpeedCurveInteractionContextV1, requireHost = true) => {
    if (context.disabled || context.busy || requireHost && !context.hostReady) throw Error("SPEED_CURVE_UI_UNAVAILABLE");
    const clip = findClip(context.project, context.clipId), asset = findAsset(context.project, clip.assetId);
    if (context.project.tracks.find(t => t.id === clip.trackId)?.locked) throw Error(TRACK_LOCKED_MESSAGE);
    if (asset.kind !== "video" || asset.compositionId || asset.imageSequence || context.project.colorManagement?.mode === "aces2") throw Error("SPEED_CURVE_UI_UNSUPPORTED");
    return clip;
  };
  const cancel = () => { drag = undefined; options.onDraft?.(undefined); };
  const report = (e: unknown) => { options.onError?.(e); return false; };
  const submit = async (context: SpeedCurveInteractionContextV1, gesture: SpeedCurveGestureV1, curve: ClipTimeRemapV1, revision: number) => {
    guard(context);
    if (context.project.revision !== revision || context.clipId !== gesture.clipId) throw Error("SPEED_CURVE_GESTURE_STALE");
    const plan = planSpeedCurveGestureV1(context.project, gesture, curve);
    if (plan.command) {
      if (curve.audioMode === "follow_speed" && context.sourceHasAudio !== false && !context.followAudioSupported) throw Error("SPEED_CURVE_UI_FOLLOW_AUDIO_UNAVAILABLE");
      await options.dispatch(plan.command, revision);
    }
  };
  const run = async (work: () => Promise<void>) => {
    if (inFlight) return report(Error("SPEED_CURVE_UI_BUSY"));
    inFlight = true; options.onBusy?.(true);
    try { await work(); return true; }
    catch (e) { return report(e); }
    finally { inFlight = false; drag = undefined; options.onDraft?.(undefined); options.onBusy?.(false); }
  };
  return {
    isDragging: () => !!drag, isBusy: () => inFlight, cancel,
    begin(target: SpeedCurveDragTargetV1) {
      try {
        if (inFlight || drag) throw Error("SPEED_CURVE_UI_BUSY");
        const context = options.read(); guard(context); const gesture = beginSpeedCurveGestureV1(context.project, context.clipId);
        const points = speedCurveAnchorsV1(gesture.initialCurve);
        if (!Number.isSafeInteger(target.index) || target.index < 0 || target.index >= (target.kind === "anchor" ? points.length : gesture.initialCurve.segments.length)
          || target.kind !== "anchor" && (target.kind !== "handle" || !["control1", "control2"].includes(target.handle))) throw Error("SPEED_CURVE_UI_TARGET_INVALID");
        drag = { gesture, revision: context.project.revision, curve: gesture.initialCurve, target: { ...target } };
        options.onDraft?.(drag.curve); return true;
      } catch (e) { return report(e); }
    },
    move(point: { time: number; speed: number }) {
      if (!drag || inFlight) return false;
      try {
        const context = options.read(); guard(context);
        if (context.project.revision !== drag.revision || context.clipId !== drag.gesture.clipId) throw Error("SPEED_CURVE_GESTURE_STALE");
        const base = drag.gesture.initialCurve, target = drag.target;
        drag.curve = target.kind === "anchor" ? moveSpeedCurvePointV1(base, target.index, point) : moveSpeedCurveHandleV1(base, target.index, target.handle, point);
        options.onDraft?.(drag.curve); return true;
      } catch (e) { cancel(); return report(e); }
    },
    async commit() {
      if (!drag) return false; const current = drag; drag = undefined;
      return run(() => submit(options.read(), current.gesture, current.curve, current.revision));
    },
    async change(edit: (curve: ClipTimeRemapV1) => ClipTimeRemapV1) {
      if (drag) return report(Error("SPEED_CURVE_UI_BUSY"));
      return run(async () => { const context = options.read(); guard(context); const gesture = beginSpeedCurveGestureV1(context.project, context.clipId);
        await submit(context, gesture, edit(gesture.initialCurve), context.project.revision); });
    },
    async resetB4() {
      if (drag) return report(Error("SPEED_CURVE_UI_BUSY"));
      return run(async () => { const context = options.read(); guard(context, false);
        const plan = planResetB4ForSpeedCurveV1(context.project, context.clipId); await options.dispatch(plan.command, context.project.revision); });
    },
  };
}
