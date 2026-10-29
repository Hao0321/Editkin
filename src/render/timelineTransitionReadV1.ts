import { compileTimelineTransitionHandlesV1, type TimelineTransitionHandlePlanV1 } from "../domain/timelineTransitionHandlesV1";
import type { EditProject, TimelineClip } from "../domain/types";
import type { MediaProbe } from "./ffmpegTypes";
import { animationTimeValue, escapeExpression } from "./ffmpegExpressions";

/** A private transport view. Authored timing, masks and animation stay on clip. */
export interface TimelineTransitionReadViewV1 {
  clip: TimelineClip;
  readClip: TimelineClip;
  prefixFrames: number;
  suffixFrames: number;
  readFrames: number;
  localTimeOffset: number;
}

export function timelineTransitionReadViewsV1(project: EditProject, plans: readonly TimelineTransitionHandlePlanV1[]): ReadonlyMap<string, TimelineTransitionReadViewV1> {
  if (JSON.stringify(plans) !== JSON.stringify(compileTimelineTransitionHandlesV1(project))) throw Error("TIMELINE_TRANSITION_STALE_RENDER_PLAN");
  const clips = new Map(project.tracks.flatMap(t => t.clips).map(c => [c.id, c]));
  const bounds = new Map<string, { start: number; end: number }>();
  for (const plan of plans) for (const id of [plan.from.clipId, plan.to.clipId]) {
    const clip = clips.get(id); if (!clip) throw Error("TIMELINE_TRANSITION_SOURCE_INVALID");
    const previous = bounds.get(id) ?? { start: Math.round(clip.timelineStart * project.fps), end: Math.round((clip.timelineStart + clip.duration) * project.fps) };
    bounds.set(id, { start: Math.min(previous.start, plan.startFrame), end: Math.max(previous.end, plan.endFrame) });
  }
  return new Map([...bounds].map(([id, range]) => {
    const clip = clips.get(id)!, asset = project.assets.find(a => a.id === clip.assetId)!;
    const nominalStart = Math.round(clip.timelineStart * project.fps), nominalEnd = Math.round((clip.timelineStart + clip.duration) * project.fps);
    const offset = (range.start - nominalStart) / project.fps;
    const readClip = { ...clip, timelineStart: range.start / project.fps, duration: (range.end - range.start) / project.fps,
      sourceStart: asset.kind === "image" ? clip.sourceStart : clip.sourceStart + offset };
    return [id, { clip, readClip, prefixFrames: nominalStart - range.start, suffixFrames: range.end - nominalEnd,
      readFrames: range.end - range.start, localTimeOffset: offset }];
  }));
}

/** Declared asset duration cannot authorize handles missing from the current file. */
export function assertTimelineTransitionProbeV1(view: TimelineTransitionReadViewV1, kind: "video" | "image", probe: MediaProbe): void {
  if (!probe.hasVideo) throw Error("TIMELINE_TRANSITION_VIDEO_STREAM_MISSING");
  if (kind === "video" && (!Number.isFinite(probe.duration) || probe.duration <= 0 || view.readClip.sourceStart < -1e-6
    || view.readClip.sourceStart + view.readClip.duration > probe.duration + 1e-6)) throw Error("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING");
}

export function timelineTransitionLocalTimeV1(view: TimelineTransitionReadViewV1 | undefined, variable: string): string {
  return view ? `min(${animationTimeValue(view.clip.duration)},max(0,${variable}+(${animationTimeValue(view.localTimeOffset)})))` : variable;
}

/** Extend authored matte coverage at its boundaries; source pixels are never cloned. */
export function timelineTransitionMattePaddingV1(view: TimelineTransitionReadViewV1 | undefined): string[] {
  if (!view || (!view.prefixFrames && !view.suffixFrames)) return [];
  return [`tpad=start=${view.prefixFrames}:stop=${view.suffixFrames}:start_mode=clone:stop_mode=clone`,
    `trim=end_frame=${view.readFrames}`, "setpts=PTS-STARTPTS"];
}

/** Preserve the frozen floating-frame generator and adapt only its private clock. */
export function timelineTransitionFloatingClockV1(filters: string[], view: TimelineTransitionReadViewV1 | undefined, fps: number): string[] {
  if (!view || (!view.prefixFrames && !view.suffixFrames)) return filters;
  const last = Math.round(view.clip.duration * fps) - 1;
  if (last < 0) throw Error("TIMELINE_TRANSITION_FLOATING_CLOCK_INVALID");
  return filters.map(filter => filter.replace(/\b(?:N|on)\b/g, variable => escapeExpression(`min(${last},max(0,${variable}-${view.prefixFrames}))`)));
}
