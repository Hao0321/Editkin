import type { EditorCommand } from "../domain/commandTypes";
import { MOTION_LIBRARY_CLIP_SCHEMA_V1, type MotionLibraryClipV1, type TimelineTransitionMotionLibraryV1 } from "../domain/motionLibraryFieldsV1";
import type { TimelineTransition } from "../domain/timelineTransitionV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip, type TimelineTrack } from "../domain/types";
import type { MotionLibraryCutRefV1, MotionLibraryTransitionWindowV1 } from "./motionLibraryCutsV1";
import type { MotionLibraryRenderedV1 } from "./motionLibraryRenderHostV1";

/**
 * Pure planning for the Motion Library GUI: where a text or background clip lands, and the one command (one Undo)
 * each GUI action dispatches. The command shapes mirror application/motionLibraryClipsV1.ts (the Node service layer);
 * this file is the browser-safe twin for the editor.
 */

const EPSILON = 1e-6;
export type MotionLibraryIdFactoryV1 = (prefix: string) => string;

export interface MotionLibraryPlacementV1 {
  readonly trackId: string;
  readonly startFrame: number;
  /** A new video layer created for the clip (dispatched in the same command). */
  readonly newTrack?: TimelineTrack;
}

function collides(track: TimelineTrack, start: number, end: number): boolean {
  return track.clips.some(clip => start < clip.timelineStart + clip.duration - EPSILON && end > clip.timelineStart + EPSILON);
}

/**
 * Text and backgrounds go where they were dropped (or onto the selected track at the playhead). When that span is taken
 * they go to the next free unlocked video layer above it, or onto a new layer, as an asset drop does; never over a clip.
 */
export function planMotionLibraryClipPlacementV1(project: EditProject, request: { trackId?: string; startFrame: number; durationFrames: number;
  kind: "text" | "background"; strictTrack?: boolean }, makeId: MotionLibraryIdFactoryV1): MotionLibraryPlacementV1 {
  const fps = project.fps, startFrame = Math.max(0, Math.round(request.startFrame));
  const start = startFrame / fps, end = (startFrame + Math.max(1, request.durationFrames)) / fps;
  const videoTracks = project.tracks.filter(track => track.kind === "video");
  const requested = request.trackId ? project.tracks.find(track => track.id === request.trackId) : undefined;
  if (request.strictTrack && requested && requested.kind !== "video") throw new Error("動態文字與背景要放在畫面軌道上。");
  if (request.strictTrack && requested?.locked) throw new Error("這條軌道已鎖定，先解鎖才能加入。");
  const target = requested && requested.kind === "video" && !requested.locked ? requested : videoTracks.find(track => !track.locked);
  if (target && !collides(target, start, end)) return { trackId: target.id, startFrame };
  const from = target ? project.tracks.indexOf(target) : -1;
  const above = project.tracks.slice(from + 1).find(track => track.kind === "video" && !track.locked && !collides(track, start, end));
  if (above) return { trackId: above.id, startFrame };
  const id = makeId("motion-track");
  if (!id.trim() || project.tracks.some(track => track.id === id)) throw new Error("新增圖層的軌道 id 重複。");
  const number = videoTracks.filter(track => track.name.startsWith(request.kind === "text" ? "動態文字" : "動態背景")).length + 1;
  return { trackId: id, startFrame, newTrack: { id, name: `${request.kind === "text" ? "動態文字" : "動態背景"} ${number}`, kind: "video", locked: false, muted: false, clips: [] } };
}

export function motionLibraryClipFieldV1(rendered: MotionLibraryRenderedV1): MotionLibraryClipV1 {
  if (rendered.kind === "transition") throw new Error(`${rendered.itemId} 是轉場，請拖到剪接點。`);
  return { schema: MOTION_LIBRARY_CLIP_SCHEMA_V1, itemId: rendered.itemId, kind: rendered.kind, itemRevision: rendered.itemRevision,
    params: structuredClone(rendered.params) as Record<string, unknown>, engineVersion: rendered.engineVersion, cacheKey: rendered.cacheKey };
}

/** add_motion_library_clip (with its new layer, as one batch when one is needed). */
export function motionLibraryAddCommandV1(project: Pick<EditProject, "fps">, rendered: MotionLibraryRenderedV1, placement: MotionLibraryPlacementV1,
  clipId: string): EditorCommand {
  const asset = rendered.assets.clip;
  if (!asset) throw new Error(`${rendered.itemId} 沒有可加入的片段。`);
  const clip: TimelineClip = { id: clipId, assetId: asset.id, trackId: placement.trackId, timelineStart: placement.startFrame / project.fps, sourceStart: 0,
    duration: rendered.frameCount / project.fps, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    motionLibrary: motionLibraryClipFieldV1(rendered) };
  const add: EditorCommand = { type: "add_motion_library_clip", asset, clip };
  return placement.newTrack ? { type: "batch", commands: [{ type: "add_track", track: placement.newTrack }, add] } : add;
}

/** update_motion_library_clip; a new duration refits the clip, an unchanged one keeps the person's trim. */
export function motionLibraryUpdateCommandV1(project: Pick<EditProject, "fps">, clip: TimelineClip, rendered: MotionLibraryRenderedV1): EditorCommand {
  if (!clip.motionLibrary) throw new Error("這個片段不是動態素材。");
  const asset = rendered.assets.clip;
  if (!asset) throw new Error(`${rendered.itemId} 沒有可替換的片段。`);
  const field = motionLibraryClipFieldV1(rendered);
  const oldSeconds = Number((clip.motionLibrary.params as { durationSeconds?: unknown }).durationSeconds);
  const keepTiming = Math.abs(oldSeconds - Number((rendered.params as { durationSeconds?: unknown }).durationSeconds)) < EPSILON
    && clip.sourceStart + clip.duration <= asset.duration + EPSILON;
  return { type: "update_motion_library_clip", clipId: clip.id, expected: { assetId: clip.assetId, cacheKey: clip.motionLibrary.cacheKey }, asset,
    motionLibrary: field, ...(keepTiming ? {} : { sourceStart: 0, duration: rendered.frameCount / project.fps }) };
}

function transitionRecord(cut: MotionLibraryCutRefV1, transitionId: string, window: MotionLibraryTransitionWindowV1,
  kernel: TimelineTransition["kernel"], motionLibrary?: TimelineTransitionMotionLibraryV1): TimelineTransition {
  return { schema: "editkin.timeline-transition/v1", id: transitionId, trackId: cut.trackId, fromClipId: cut.fromClipId, toClipId: cut.toClipId,
    beforeFrames: window.before, afterFrames: window.after, kernel, ...(motionLibrary ? { motionLibrary } : {}) };
}

/** 溶接 / 黑場: one set_timeline_transition. */
export function basicTransitionCommandV1(cut: MotionLibraryCutRefV1, transitionId: string, window: MotionLibraryTransitionWindowV1,
  kernel: "dissolve" | "dip"): EditorCommand {
  return { type: "set_timeline_transition", transition: transitionRecord(cut, transitionId, window, kernel) };
}

/** A rendered matte transition: import its matte (and overlay) unless already registered, then set the transition. One batch. */
export function matteTransitionCommandV1(project: Pick<EditProject, "assets">, rendered: MotionLibraryRenderedV1, cut: MotionLibraryCutRefV1,
  transitionId: string, window: MotionLibraryTransitionWindowV1): EditorCommand {
  const matte = rendered.assets.matte, overlay = rendered.assets.overlay;
  if (rendered.kind !== "transition" || !matte) throw new Error(`${rendered.itemId} 不是轉場。`);
  if (rendered.frameCount !== window.before + window.after) throw new Error(`轉場遮罩有 ${rendered.frameCount} 幀，剪接點窗口是 ${window.before + window.after} 幀。`);
  const imports = [matte, ...(overlay ? [overlay] : [])].filter(asset => !project.assets.some(existing => existing.id === asset.id))
    .map(asset => ({ type: "import_asset" as const, asset }));
  const motionLibrary: TimelineTransitionMotionLibraryV1 = { itemId: rendered.itemId, itemRevision: rendered.itemRevision,
    params: structuredClone(rendered.params) as Record<string, unknown>, engineVersion: rendered.engineVersion, cacheKey: rendered.cacheKey,
    matteAssetId: matte.id, ...(overlay ? { overlayAssetId: overlay.id } : {}) };
  return { type: "batch", commands: [...imports, { type: "set_timeline_transition", transition: transitionRecord(cut, transitionId, window, "matte", motionLibrary) }] };
}
