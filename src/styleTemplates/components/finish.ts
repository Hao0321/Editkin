import type { EditorCommand } from "../../domain/commandTypes";
import type { ClipKeyframe, ColorGradeV2, TimelineClip, Transform2D } from "../../domain/types";
import { findFilmLookV2 } from "../../creative/filmLooksV2";
import { bakeClipMotionFrames } from "../../motion/motionLanguage";
import { curve } from "../../motionLibrary/svg/easing";
import type { StyleTemplateV1 } from "../types";

/**
 * C7 punch-in (transform keyframes on the footage clip) and C8 looks (a template's
 * look → an existing Hao Film Look v2 through set_clip_grade_v2). Both compile to
 * existing commands only: no new grading engine, no new renderer branch.
 */

// ---------------------------------------------------------------------------
// Punch-in
// ---------------------------------------------------------------------------

export interface PunchInSpec {
  /** Clip-local time (s) where the zoom starts (the beat). */
  readonly at: number;
  /** Clip-local time (s) where it releases back to 1 (a cut-like snap); omitted = held to the clip end. */
  readonly until?: number;
  readonly scale: number;
  readonly attackSeconds: number;
  readonly curve: "expoOut" | "quintOut" | "backOutSoft";
  /** Normalized point that stays fixed while the frame scales. */
  readonly focus: readonly [number, number];
  readonly fps: number;
  readonly width: number;
  readonly height: number;
}

interface Pose { x: number; y: number; scale: number; rotation: number }

/** Scale about a focus point: a point p from the frame centre maps to s·p + t, so t = (1 − s)·(focus − ½)·size. */
function poseAt(spec: PunchInSpec, progress: number): Pose {
  // Exact rest and peak at the ends (a bezier evaluator leaves ~1e-6 there).
  const eased = progress <= 0 ? 0 : progress >= 1 ? 1 : curve(spec.curve, progress);
  const scale = 1 + (spec.scale - 1) * eased;
  return { x: (1 - scale) * (spec.focus[0] - 0.5) * spec.width, y: (1 - scale) * (spec.focus[1] - 0.5) * spec.height, scale, rotation: 0 };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** Clip-local pose keys (time s, pose) of a punch-in, baked to linear keyframes within Motion Language tolerance. */
export function punchInKeys(spec: PunchInSpec, clipDuration: number): Array<{ time: number; pose: Pose }> {
  if (!(spec.scale > 1) || !(spec.attackSeconds > 0) || !(spec.fps > 0)) throw new Error("punch-in needs scale > 1, attack > 0, fps > 0");
  if (!(spec.at >= 0) || spec.at >= clipDuration) throw new Error("punch-in time must fall inside the clip");
  const atFrame = Math.round(spec.at * spec.fps);
  const attack = Math.max(2, Math.round(spec.attackSeconds * spec.fps));
  const rest: Pose = { x: 0, y: 0, scale: 1, rotation: 0 };
  const keys: Array<{ time: number; pose: Pose }> = [];
  if (atFrame > 0) keys.push({ time: 0, pose: rest });
  for (const frame of bakeClipMotionFrames(attack, frame => poseAt(spec, frame / attack))) {
    keys.push({ time: (atFrame + frame) / spec.fps, pose: poseAt(spec, frame / attack) });
  }
  if (spec.until !== undefined) {
    const untilFrame = Math.round(spec.until * spec.fps);
    if (untilFrame > atFrame + attack + 1 && untilFrame / spec.fps < clipDuration) {
      keys.push({ time: (untilFrame - 1) / spec.fps, pose: poseAt(spec, 1) });
      keys.push({ time: untilFrame / spec.fps, pose: rest });
    }
  }
  return keys;
}

/** add_keyframe commands for a punch-in on an ordinary footage clip (refuses a clip that already has keyframes). */
export function punchInCommands(clip: Pick<TimelineClip, "id" | "transform" | "color" | "keyframes" | "duration">, spec: PunchInSpec): EditorCommand[] {
  if (clip.keyframes.length) throw new Error(`Clip ${clip.id} already has keyframes; a punch-in would overwrite authored motion`);
  const base: Transform2D = clip.transform;
  return punchInKeys(spec, clip.duration).map(({ time, pose }, index) => {
    const keyframe: ClipKeyframe = {
      id: `style-punch-${Math.round(spec.at * spec.fps)}-${index}`, time: round6(time), easing: "linear",
      transform: { ...base, x: base.x + round3(pose.x), y: base.y + round3(pose.y), scale: round6(base.scale * pose.scale), rotation: base.rotation, opacity: base.opacity },
      color: { ...clip.color },
    };
    return { type: "add_keyframe" as const, clipId: clip.id, keyframe };
  });
}

/** Linear evaluation of baked keys (what preview and export do with linear keyframes): scale and offsets at clip-local t. */
export function evaluatePunchInKeys(keys: ReadonlyArray<{ time: number; pose: Pose }>, t: number): Pose {
  if (!keys.length || t <= keys[0].time) return keys[0]?.pose ?? { x: 0, y: 0, scale: 1, rotation: 0 };
  for (let index = 1; index < keys.length; index += 1) {
    if (t < keys[index].time) {
      const a = keys[index - 1], b = keys[index], u = (t - a.time) / (b.time - a.time);
      return { x: a.pose.x + (b.pose.x - a.pose.x) * u, y: a.pose.y + (b.pose.y - a.pose.y) * u, scale: a.pose.scale + (b.pose.scale - a.pose.scale) * u, rotation: 0 };
    }
  }
  return keys[keys.length - 1].pose;
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

export interface StyleLookChoice { readonly filmLookId: string; readonly strength: number }

/** Footage genres that are never graded: Hao Film Looks are for camera footage, not screen recordings (filmLooksV2). */
export const UNGRADED_GENRES: readonly string[] = Object.freeze(["screen", "screen_recording"]);

export function styleLookFor(template: StyleTemplateV1, genre?: string): StyleLookChoice | undefined {
  if (genre && UNGRADED_GENRES.includes(genre)) return undefined;
  const look = (genre && template.components.look.byGenre?.[genre]) || template.components.look;
  if (!findFilmLookV2(look.filmLookId)) throw new Error(`Unknown film look ${look.filmLookId}`);
  return { filmLookId: look.filmLookId, strength: look.strength };
}

export function styleLookGrade(choice: StyleLookChoice): ColorGradeV2 {
  return { schema: "editkin.color-grade/v2", look: { id: choice.filmLookId, strength: choice.strength } } as ColorGradeV2;
}

/** set_clip_grade_v2 for each footage clip (the same command the look_color module emits). */
export function styleLookCommands(clipIds: readonly string[], choice: StyleLookChoice): EditorCommand[] {
  return clipIds.map(clipId => ({ type: "set_clip_grade_v2" as const, clipId, grade: styleLookGrade(choice) }));
}
