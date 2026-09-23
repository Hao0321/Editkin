import type { ClipKeyframe, TimelineClip } from "./types";

// Only absorbs floating-point clock subtraction noise, not a visible frame.
export const ANIMATION_TIME_EPSILON = 1e-9;
export type ClipAnimationPoint = Pick<ClipKeyframe, "time" | "transform" | "color" | "easing">;

/** The clip base is implicit at zero only when the author has not set zero. */
export function clipAnimationPoints(clip: TimelineClip): readonly ClipAnimationPoint[] {
  if (clip.keyframes[0]?.time === 0) return clip.keyframes;
  return [{ time: 0, transform: clip.transform, color: clip.color, easing: "linear" }, ...clip.keyframes];
}
