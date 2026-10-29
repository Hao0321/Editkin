import type { EditorCommand } from "../domain/commandTypes";
import { alignTime } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip, type TimelineTrack } from "../domain/types";
import type { TimelineMarkRange } from "./timelineNavigation";

export const ADJUSTMENT_LAYER_RANGE_REQUIRED = "先在時間軸選一段片段，或按 I／O 標出範圍，再加入調整圖層。";
export const ADJUSTMENT_LAYER_HOST_REQUIRED = "調整圖層需要專案裡有一段至少一樣長的影片或照片素材。";

export interface AdjustmentLayerPlanV1 { command: Extract<EditorCommand, { type: "batch" }>; clipId: string; trackId: string; start: number; duration: number }

/** The range ＋調整圖層 covers: the marked I/O range when there is one, otherwise the selected clip. Frame aligned. */
export function adjustmentLayerRangeV1(project: EditProject, selectedClipId?: string, markRange?: TimelineMarkRange): { start: number; end: number } | undefined {
  const fps = project.fps;
  if (markRange?.in !== undefined && markRange.out !== undefined && markRange.out - markRange.in >= 1 / fps) {
    const start = alignTime(Math.max(0, markRange.in), fps), end = alignTime(markRange.out, fps);
    if (end - start >= 1 / fps - 1e-9) return { start, end };
  }
  const clip = selectedClipId ? project.tracks.flatMap(track => track.clips).find(item => item.id === selectedClipId) : undefined;
  return clip ? { start: clip.timelineStart, end: clip.timelineStart + clip.duration } : undefined;
}

/**
 * ＋調整圖層 as existing commands (one batch, one Undo): an `adjustment` clip over the range on the top picture track,
 * which grades every layer below it in the export and the native preview.
 *
 * The edit graph has no generated "adjustment" source yet, so the clip borrows the window [0, duration) of a picture
 * asset that is long enough (the selected clip's own when it is); adjustment clips never decode or play their source
 * (export: ffmpegComposite skips their input; preview: activeMediaLayers drops them) and the clip is silent. When the
 * domain gains a dedicated command (AUDIT_AND_PLAN P7 add_adjustment_layer), only this planner changes.
 */
export function planAdjustmentLayerV1(project: EditProject, input: { selectedClipId?: string; markRange?: TimelineMarkRange; trackName: string },
  makeId: (prefix: string) => string): AdjustmentLayerPlanV1 {
  const range = adjustmentLayerRangeV1(project, input.selectedClipId, input.markRange);
  if (!range) throw new Error(ADJUSTMENT_LAYER_RANGE_REQUIRED);
  const duration = alignTime(range.end - range.start, project.fps);
  const usable = (asset: MediaAsset | undefined): asset is MediaAsset => Boolean(asset && (asset.kind === "video" || asset.kind === "image")
    && !asset.compositionId && !asset.imageSequence && asset.duration + 1e-6 >= duration);
  const selected = project.tracks.flatMap(track => track.clips).find(clip => clip.id === input.selectedClipId);
  const own = project.assets.find(asset => asset.id === selected?.assetId);
  const host = usable(own) ? own : [...project.assets].filter(usable).sort((a, b) => b.duration - a.duration)[0];
  if (!host) throw new Error(ADJUSTMENT_LAYER_HOST_REQUIRED);
  const pictureTracks = project.tracks.filter(track => track.kind === "video");
  const top = pictureTracks.at(-1);
  // Reuse only an adjustment track already on top (never 主畫面, an empty track someone added, or a locked one).
  const free = (track: TimelineTrack) => !track.locked && track.clips.length > 0 && track.clips.every(clip => (clip.layer?.role ?? "content") === "adjustment")
    && track.clips.every(clip => clip.timelineStart + clip.duration <= range.start + 1e-9 || clip.timelineStart >= range.start + duration - 1e-9);
  const commands: EditorCommand[] = [];
  let trackId: string;
  if (top && top !== pictureTracks[0] && free(top)) trackId = top.id;
  else {
    trackId = makeId("adjustment-track");
    const count = project.tracks.filter(track => track.kind === "video" && track.clips.length > 0
      && track.clips.every(clip => (clip.layer?.role ?? "content") === "adjustment")).length;
    commands.push({ type: "add_track", track: { id: trackId, name: count ? `${input.trackName} ${count + 1}` : input.trackName, kind: "video", locked: false, muted: false, clips: [] } });
  }
  const clipId = makeId("adjustment");
  const clip: TimelineClip = { id: clipId, assetId: host.id, trackId, timelineStart: range.start, sourceStart: 0, duration, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { enabled: true, blendMode: "normal", role: "adjustment" } };
  commands.push({ type: "add_clip", clip });
  return { command: { type: "batch", commands }, clipId, trackId, start: range.start, duration };
}
