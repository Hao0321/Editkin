import type { EditorCommand } from "../domain/commands";
import { alignTime, EditGraphError, findAsset, findClip, findTrack, validateProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip, type TimelineTrack } from "../domain/types";
import { timelineAssetDuration } from "../ui/timelineAssetDrop";

// Preview, drop, ordinary insert and import share one source-frame duration rule.
export { timelineAssetDuration } from "../ui/timelineAssetDrop";

export interface TimelinePlacementPlan {
  command: EditorCommand;
  trackId: string;
  newLayer: boolean;
}

/** Explicit source seconds on the unchanged project frame clock. */
export interface TimelineSourceWindow {
  sourceStart: number;
  duration: number;
}

export type TimelinePlacementIdFactory = (prefix: string) => string;
const EPSILON = 1e-6; // The existing EditGraph overlap/source-range precision.

function assertTimeRange(start: number, duration: number, fps: number, label: string): void {
  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0
    || !Number.isSafeInteger(Math.ceil(start * fps))
    || !Number.isSafeInteger(Math.ceil(duration * fps))
    || !Number.isSafeInteger(Math.ceil((start + duration) * fps))) {
    throw new EditGraphError(`${label} 的時間範圍超出有效影格`);
  }
}

/** Validate the live graph, including numeric clocks not covered by old guards. */
function assertCurrentProject(project: EditProject): void {
  if (!Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240
    || !Number.isFinite(project.width) || !Number.isFinite(project.height)) {
    throw new EditGraphError("專案解析度或 fps 不合法");
  }
  for (const asset of project.assets) assertTimeRange(0, asset.duration, project.fps, `素材 ${asset.id}`);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      assertTimeRange(clip.timelineStart, clip.duration, project.fps, `片段 ${clip.id}`);
      assertTimeRange(clip.sourceStart, clip.duration, project.fps, `片段 ${clip.id} 的來源`);
    }
  }
  validateProject(project);
}

function placementStart(start: number, duration: number, fps: number): number {
  // Reject an outside/invalid request before alignment; never clamp it to zero.
  assertTimeRange(start, duration, fps, "指定落點");
  const aligned = alignTime(start, fps);
  assertTimeRange(aligned, duration, fps, "指定落點");
  return aligned;
}

function assertUnlockedMediaTrack(track: TimelineTrack): asserts track is TimelineTrack & { kind: "video" | "audio" } {
  if (track.locked) throw new EditGraphError("指定軌道已鎖定，片段未移動或加入");
  if (track.kind !== "video" && track.kind !== "audio") throw new EditGraphError("片段需要畫面或聲音軌道");
}

function hasCollision(track: TimelineTrack, start: number, duration: number, excludedClipId?: string): boolean {
  const end = start + duration;
  return track.clips.some(clip => clip.id !== excludedClipId
    && start < clip.timelineStart + clip.duration - EPSILON
    && end > clip.timelineStart + EPSILON);
}

function placementTrack(
  project: EditProject,
  target: TimelineTrack & { kind: "video" | "audio" },
  collision: boolean,
  makeId: TimelinePlacementIdFactory,
): { trackId: string; track?: TimelineTrack } {
  if (!collision) return { trackId: target.id };
  const id = makeId(`${target.kind}-track`);
  if (typeof id !== "string" || !id.trim() || project.tracks.some(track => track.id === id)) {
    throw new EditGraphError("新增圖層的軌道 id 空白或已存在");
  }
  const number = project.tracks.filter(track => track.kind === target.kind).length + 1;
  return {
    trackId: id,
    // add_track appends: later video tracks are the existing preview's top layers.
    track: { id, name: `${target.kind === "audio" ? "聲音" : "畫面"}圖層 ${number}`, kind: target.kind, locked: false, muted: target.muted, clips: [] },
  };
}

function plannedCommand(track: TimelineTrack | undefined, command: EditorCommand): EditorCommand {
  return track ? { type: "batch", commands: [{ type: "add_track", track }, command] } : command;
}

/** Preserve source trims and neighbours; collision adds one compatible empty layer. */
export function planTimelineClipMove(
  project: EditProject,
  clipId: string,
  targetTrackId: string,
  start: number,
  makeId: TimelinePlacementIdFactory,
): TimelinePlacementPlan {
  assertCurrentProject(project);
  const clip = findClip(project, clipId);
  const source = findTrack(project, clip.trackId);
  const target = findTrack(project, targetTrackId);
  assertUnlockedMediaTrack(source);
  assertUnlockedMediaTrack(target);
  if (source.kind !== target.kind) throw new EditGraphError("片段只能移動到相同類型的軌道");
  const asset = findAsset(project, clip.assetId);
  if (clip.sourceStart + clip.duration > asset.duration + EPSILON) throw new EditGraphError("片段超過實際來源時長");
  const timelineStart = placementStart(start, clip.duration, project.fps);
  const placement = placementTrack(project, target, hasCollision(target, timelineStart, clip.duration, clip.id), makeId);
  const move: EditorCommand = { type: "move_clip_to_track", clipId: clip.id, trackId: placement.trackId, timelineStart };
  return { command: plannedCommand(placement.track, move), trackId: placement.trackId, newLayer: Boolean(placement.track) };
}

/** The asset must already be in the current graph (an import can stage it first). */
export function planTimelineAssetInsert(
  project: EditProject,
  assetId: string,
  targetTrackId: string,
  start: number,
  clipId: string,
  makeId: TimelinePlacementIdFactory,
  sourceWindow?: TimelineSourceWindow,
): TimelinePlacementPlan {
  assertCurrentProject(project);
  const asset = findAsset(project, assetId);
  const target = findTrack(project, targetTrackId);
  assertUnlockedMediaTrack(target);
  const kind = asset.kind === "audio" ? "audio" : "video";
  if (target.kind !== kind) throw new EditGraphError("素材與指定軌道種類不同，請放到相容軌道");
  if (typeof clipId !== "string" || !clipId.trim() || project.tracks.some(track => track.clips.some(clip => clip.id === clipId))) {
    throw new EditGraphError("新增片段的 id 空白或已存在");
  }
  const sourceStart = sourceWindow?.sourceStart ?? 0;
  const duration = sourceWindow?.duration ?? timelineAssetDuration(asset, project.fps);
  if (sourceWindow) {
    assertTimeRange(sourceStart, duration, project.fps, "指定來源窗口");
    for (const seconds of [sourceStart, duration]) {
      const frame = seconds * project.fps;
      if (!Number.isSafeInteger(Math.round(frame)) || Math.abs(frame - Math.round(frame)) > EPSILON) {
        throw new EditGraphError("指定來源窗口必須使用整數專案影格");
      }
    }
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new EditGraphError("素材不足一個專案影格，無法加入時間軸");
  if (sourceStart + duration > asset.duration + EPSILON) throw new EditGraphError("新增片段超過實際來源時長");
  const timelineStart = placementStart(start, duration, project.fps);
  const placement = placementTrack(project, target, hasCollision(target, timelineStart, duration), makeId);
  const clip: TimelineClip = {
    id: clipId, assetId: asset.id, trackId: placement.trackId, timelineStart, sourceStart, duration, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
  };
  return {
    command: plannedCommand(placement.track, { type: "add_clip", clip }),
    trackId: placement.trackId,
    newLayer: Boolean(placement.track),
  };
}
