import { EditGraphError } from "./editGraphError";
import { timelineTransitionSchemaV1, type TimelineTransition } from "./timelineTransitionV1";
import type { EditProject, TimelineClip } from "./types";

type Owner = Pick<EditProject, "fps" | "assets" | "tracks"> & { timelineTransitions?: readonly TimelineTransition[] };
function fail(code: string): never { throw new EditGraphError(`TIMELINE_TRANSITION_${code}`); }
const EPSILON = 1e-6;
export interface TimelineTransitionSourceWindowV1 {
  clipId: string; assetId: string; sourceStartSeconds: number; sourceDurationSeconds: number;
  clipLocalStartSeconds: number; originalTimelineStartSeconds: number; originalDurationSeconds: number;
}
export interface TimelineTransitionHandlePlanV1 {
  schema: "editkin.timeline-transition-handle-plan/v1";
  transition: TimelineTransition; cutFrame: number; startFrame: number; endFrame: number; durationFrames: number;
  projectRate: number; from: TimelineTransitionSourceWindowV1; to: TimelineTransitionSourceWindowV1;
}
function frame(time: number, fps: number): number {
  const value = Math.round(time * fps);
  if (!Number.isFinite(time) || !Number.isSafeInteger(value) || value < 0 || Math.abs(time - value / fps) > EPSILON) fail("FRAME_GRID_INVALID");
  return value;
}

/** Only real handles are admitted; lack of source frames never becomes a frozen boundary frame. */
export function compileTimelineTransitionHandleV1(project: Owner, input: TimelineTransition): TimelineTransitionHandlePlanV1 {
  const parsed = timelineTransitionSchemaV1.safeParse(input); if (!parsed.success) fail("FIELDS_INVALID");
  const transition = parsed.data;
  if (!Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) fail("FRAME_GRID_INVALID");
  const track = project.tracks.find(t => t.id === transition.trackId);
  if (!track || track.kind !== "video") fail("TRACK_INVALID");
  const ordered = track.clips.toSorted((a, b) => a.timelineStart - b.timelineStart);
  const index = ordered.findIndex(c => c.id === transition.fromClipId), from = ordered[index], to = ordered[index + 1];
  if (!from || !to || to.id !== transition.toClipId || from.trackId !== track.id || to.trackId !== track.id) fail("NOT_ADJACENT");
  if (Math.abs(from.timelineStart + from.duration - to.timelineStart) > EPSILON) fail("NOT_ADJACENT");
  if ((from.layer?.role ?? "content") !== "content" || (to.layer?.role ?? "content") !== "content") fail("CONTENT_REQUIRED");
  const cutFrame = frame(to.timelineStart, project.fps), fromStart = frame(from.timelineStart, project.fps), toEnd = frame(to.timelineStart + to.duration, project.fps);
  const startFrame = cutFrame - transition.beforeFrames, endFrame = cutFrame + transition.afterFrames;
  if (!Number.isSafeInteger(endFrame) || startFrame < fromStart || endFrame > toEnd) fail("WINDOW_EXCEEDS_CLIPS");
  const durationFrames = transition.beforeFrames + transition.afterFrames, duration = durationFrames / project.fps;
  function source(clip: TimelineClip): TimelineTransitionSourceWindowV1 {
    const asset = project.assets.find(a => a.id === clip.assetId);
    if (!asset || (asset.kind !== "video" && asset.kind !== "image")) fail("SOURCE_INVALID");
    const local = startFrame / project.fps - clip.timelineStart;
    const sourceStart = asset.kind === "image" ? clip.sourceStart : clip.sourceStart + local;
    if (!Number.isFinite(sourceStart) || sourceStart < -EPSILON || (asset.kind === "video"
      && (!Number.isFinite(asset.duration) || sourceStart + duration > asset.duration + EPSILON))) fail("SOURCE_HANDLE_MISSING");
    return { clipId: clip.id, assetId: asset.id, sourceStartSeconds: Math.max(0, sourceStart), sourceDurationSeconds: duration,
      clipLocalStartSeconds: local, originalTimelineStartSeconds: clip.timelineStart, originalDurationSeconds: clip.duration };
  }
  return { schema: "editkin.timeline-transition-handle-plan/v1", transition, cutFrame, startFrame, endFrame, durationFrames,
    projectRate: project.fps, from: source(from), to: source(to) };
}

export function compileTimelineTransitionHandlesV1(project: Owner): TimelineTransitionHandlePlanV1[] {
  const ids = new Set<string>(), pairs = new Set<string>();
  const plans = (project.timelineTransitions ?? []).map(t => {
    if (ids.has(t.id)) fail("DUPLICATE_ID"); ids.add(t.id);
    const pair = JSON.stringify([t.trackId, t.fromClipId, t.toClipId]);
    if (pairs.has(pair)) fail("DUPLICATE_CUT"); pairs.add(pair);
    return compileTimelineTransitionHandleV1(project, t);
  }).toSorted((a, b) => a.transition.trackId.localeCompare(b.transition.trackId) || a.startFrame - b.startFrame);
  for (let i = 1; i < plans.length; i += 1) if (plans[i - 1].transition.trackId === plans[i].transition.trackId && plans[i - 1].endFrame > plans[i].startFrame) fail("WINDOW_OVERLAP");
  return plans;
}

/** Fractional frames are also supported for shutter sampling; the end frame is not part of the window. */
export function timelineTransitionProgressV1(plan: TimelineTransitionHandlePlanV1, projectFrame: number): number {
  if (!Number.isFinite(projectFrame)) fail("FRAME_GRID_INVALID");
  return Math.max(0, Math.min(1, (projectFrame - plan.startFrame) / plan.durationFrames));
}
