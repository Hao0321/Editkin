import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import type { EditProject, TimelineClip, TimelineTrack } from "../domain/types";

/**
 * Which clip Ctrl+B (and 切開) cuts at the playhead.
 *  - The selected clip, when the playhead is inside it (selecting a clip never moves the playhead, so the creator parks
 *    the playhead, picks the clip and cuts).
 *  - Otherwise the clip under the playhead: on the selected clip's track first, then on 主畫面, then on the topmost
 *    unlocked track (timeline order). Locked tracks are never picked.
 * "Inside" is on the frame grid and strictly between the clip's first and last edge, where a cut leaves two pieces.
 */

export const SPLIT_NOTHING_HERE = "播放頭下面沒有可以切開的片段；把播放頭移到片段中間再按 Ctrl+B。";
export const SPLIT_AT_EDGE = "播放頭在選取片段的邊緣或外面；把播放頭移到片段中間再切開。";
/** The 剪刀 tool was clicked within one frame of a clip's start or end: there is nothing to cut there. */
export const BLADE_TOO_CLOSE = "太靠近片段邊緣，切不開。";

/** One cut of the 剪刀 tool: a clip and the timeline time it is cut at (on the frame grid). */
export interface TimelineCut {
  clipId: string;
  at: number;
}

export interface SplitTarget {
  clip: TimelineClip;
  track: TimelineTrack;
  /** True when it is the selected clip; false when it was found under the playhead. */
  selected: boolean;
}

export type SplitTargetResult = { target: SplitTarget } | { refusal: string };

export function playheadInsideClip(clip: Pick<TimelineClip, "timelineStart" | "duration">, playhead: number, fps: number): boolean {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(playhead)) return false;
  const at = Math.round(playhead * fps), start = Math.round(clip.timelineStart * fps), end = start + Math.max(1, Math.round(clip.duration * fps));
  return at > start && at < end;
}

export function findSplitTarget(project: EditProject, playhead: number, selectedClipId?: string): SplitTargetResult {
  const fps = project.fps;
  const selectedTrack = selectedClipId ? project.tracks.find(track => track.clips.some(clip => clip.id === selectedClipId)) : undefined;
  const selected = selectedTrack?.clips.find(clip => clip.id === selectedClipId);
  if (selected && selectedTrack && playheadInsideClip(selected, playhead, fps)) return { target: { clip: selected, track: selectedTrack, selected: true } };
  const under = project.tracks.filter(track => track.kind !== "caption")
    .flatMap(track => track.clips.filter(clip => playheadInsideClip(clip, playhead, fps)).map(clip => ({ clip, track })));
  const open = under.filter(candidate => !candidate.track.locked);
  const pick = open.find(candidate => candidate.track === selectedTrack) ?? open.find(candidate => candidate.track.id === "video-main") ?? open[0];
  if (pick) return { target: { ...pick, selected: false } };
  if (under.length) return { refusal: TRACK_LOCKED_MESSAGE };
  return { refusal: selected ? SPLIT_AT_EDGE : SPLIT_NOTHING_HERE };
}

/**
 * The 剪刀 tool's cuts at `at` (timeline seconds on the frame grid). A click cuts the clicked clip; Shift+click cuts every
 * unlocked picture and sound track that has a clip there. A clip whose edge is within a frame of `at` has nothing to cut
 * and is left out. Locked tracks are never cut: a click on one, or a Shift+click that finds nothing else, says why.
 */
export function planBladeCuts(project: EditProject, clipId: string, at: number, allTracks = false): { cuts: TimelineCut[] } | { refusal: string } {
  const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId));
  const clip = track?.clips.find(item => item.id === clipId);
  if (!track || !clip) return { refusal: "找不到這個片段，請重新選取。" };
  const cuts = (allTracks ? project.tracks.filter(item => item.kind !== "caption" && !item.locked).flatMap(item => item.clips) : track.locked ? [] : [clip])
    .filter(candidate => playheadInsideClip(candidate, at, project.fps)).map(candidate => ({ clipId: candidate.id, at }));
  if (cuts.length) return { cuts };
  return { refusal: track.locked ? TRACK_LOCKED_MESSAGE : BLADE_TOO_CLOSE };
}
