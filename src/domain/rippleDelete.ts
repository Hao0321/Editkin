import { EditGraphError } from "./editGraphError";
import { assertMotionGraphicV2Contract } from "./motionCompositionV2Contract";
import { assertMotionGraphicV3Contract } from "./motionCompositionV3Contract";
import { assertContinuityVectorFrameRange } from "./motionContinuityContract";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "./trackLock";
import type { CaptionCue, EditProject, MotionGraphic, TimelineClip, TimelineTrack } from "./types";

/**
 * Ripple delete (`ripple_delete_clip`): remove one clip and close the gap it leaves. It never fails because the cut
 * would put clips on top of each other, and it never deletes the user's own picture or sound on another track.
 *
 * On 主畫面 (video-main), CapCut-like:
 *  - 主畫面 closes the gap;
 *  - captions, free titles and markers that lie entirely inside the deleted clip go with it; one that only partly
 *    overlaps it is trimmed to what remains (a title too short for its animation then goes with it);
 *  - captions, titles and markers after the cut move up with 主畫面;
 *  - every other picture or sound track moves up by the gap only when that puts no clip on another; otherwise it stays
 *    where it is, and the outcome says so (heldTracks). Locked tracks, and the 字幕 track when it is locked, stay too;
 *  - a saved title template on the deleted clip goes with it (all its own layers and its record); a template further on
 *    moves with its main clip, so the editor and apply_edit_commands re-record it in the same write;
 *  - an original Motion scene keeps its own clock and stays where it is.
 * On any other track only that track closes the gap; the deleted clip's own captions, tracked labels and template go
 * with it, and nothing else moves.
 */

const EPSILON = 1e-6;
export const TEMPLATE_LAYER_LOCKED_MESSAGE = "這段片段的標題模板有圖層在鎖定的軌道上，先解鎖才能刪除。";

export interface RippleHeldTrack {
  trackId: string;
  name: string;
  kind: "video" | "audio";
  /** "overlap": moving it up would put clips on top of each other; "locked": the track is locked. */
  reason: "overlap" | "locked";
}

export interface RippleDeleteOutcome {
  clipId: string;
  trackId: string;
  /** True when the deleted clip was on 主畫面. */
  mainTrack: boolean;
  startFrame: number;
  endFrame: number;
  gapFrames: number;
  /** Other picture and sound tracks that moved up by the gap. */
  shiftedTrackIds: string[];
  /** Other tracks that had content after the cut but stayed where they are. */
  heldTracks: RippleHeldTrack[];
  /** The 字幕 track is locked: captions that would have changed were left as they are. */
  captionsLocked: boolean;
  removedCaptionIds: string[];
  trimmedCaptionIds: string[];
  removedGraphicIds: string[];
  trimmedGraphicIds: string[];
  removedMarkerIds: string[];
  /** Saved title templates that sat on the deleted clip and went with it. */
  removedTemplateIds: string[];
  /** Original Motion scenes at or after the cut that keep their own place. */
  heldSceneIds: string[];
}

function fpsOf(project: EditProject): number {
  if (!Number.isFinite(project.fps) || project.fps <= 0) throw new EditGraphError("專案影格率無效，無法刪除片段。");
  return project.fps;
}

const frameOf = (seconds: number, fps: number) => Math.round(seconds * fps);
const lengthOf = (seconds: number, fps: number) => Math.max(1, Math.round(seconds * fps));

/** Can this graphic play for `duration` seconds (its animation, per-glyph budget and vector range)? */
function graphicLengthValid(graphic: MotionGraphic, duration: number, fps: number): boolean {
  if (graphic.paintV1) return false;
  const candidate = { ...graphic, duration };
  try {
    assertMotionGraphicV2Contract(candidate, fps);
    assertMotionGraphicV3Contract(candidate);
    assertContinuityVectorFrameRange(candidate, fps);
    return true;
  } catch { return false; }
}

/**
 * The clip a caption belongs to: the picture or sound clip that holds its whole time; 主畫面 wins when several do.
 * The same rule as the editor's captionOwnerClip (application/timelineMotionEdits), which also moves captions with a clip.
 */
export function captionHolder(project: EditProject, caption: CaptionCue, fps: number): TimelineClip | undefined {
  const start = frameOf(caption.start, fps), end = start + lengthOf(caption.duration, fps);
  const generated = new Set((project.referenceMotionInstances ?? []).flatMap(instance => instance.roles
    .filter(role => role.kind === "clip" && role.id !== instance.input.clipId).map(role => role.id)));
  const holders = project.tracks.filter(track => track.kind !== "caption").flatMap(track => track.clips.filter(clip => {
    const clipStart = frameOf(clip.timelineStart, fps);
    return !generated.has(clip.id) && (clip.layer?.role ?? "content") === "content"
      && start >= clipStart && end <= clipStart + lengthOf(clip.duration, fps);
  }));
  return holders.find(clip => clip.trackId === "video-main") ?? (holders.length === 1 ? holders[0] : undefined);
}

function dropReferences(project: EditProject, removed: ReadonlySet<string>): void {
  for (const candidate of project.tracks.flatMap(track => track.clips)) {
    if (candidate.layer?.parentClipId && removed.has(candidate.layer.parentClipId)) candidate.layer.parentClipId = undefined;
    if (candidate.layer?.trackMatte?.sourceClipId && removed.has(candidate.layer.trackMatte.sourceClipId)) candidate.layer.trackMatte = undefined;
  }
}

/** Remove the saved title templates on `clipId`, with every layer they own; returns their ids. */
function removeTemplatesOn(project: EditProject, clipId: string): string[] {
  const instances = (project.referenceMotionInstances ?? []).filter(instance => instance.input.clipId === clipId);
  if (!instances.length) return [];
  const sceneOwned = new Set((project.motionScenes ?? []).flatMap(scene => scene.graphicIds));
  const graphicIds = new Set<string>(), clipIds = new Set<string>(), trackIds = new Set<string>();
  for (const instance of instances) {
    for (const role of instance.roles) {
      if (role.kind === "graphic" && !sceneOwned.has(role.id)) graphicIds.add(role.id);
      else if (role.kind === "clip" && role.id !== clipId) clipIds.add(role.id);
      else if (role.kind === "track") trackIds.add(role.id);
    }
  }
  for (const track of project.tracks) {
    if (track.locked && track.clips.some(clip => clipIds.has(clip.id))) throw new EditGraphError(TEMPLATE_LAYER_LOCKED_MESSAGE);
  }
  for (const track of project.tracks) track.clips = track.clips.filter(clip => !clipIds.has(clip.id));
  dropReferences(project, clipIds);
  project.motionGraphics = project.motionGraphics.filter(graphic => !graphicIds.has(graphic.id));
  const kept = new Set(["video-main", "audio-main"]);
  project.tracks = project.tracks.filter(track => !(trackIds.has(track.id) && track.clips.length === 0 && track.kind !== "caption" && !kept.has(track.id)));
  const removed = new Set(instances.map(instance => instance.id));
  project.referenceMotionInstances = project.referenceMotionInstances!.filter(instance => !removed.has(instance.id));
  return [...removed];
}

/** Clips that would move up on `track` (those starting at or after the cut) and whether moving them collides. */
function trackShift(track: TimelineTrack, endFrame: number, gapFrames: number, fps: number): { movers: TimelineClip[]; collides: boolean } {
  const movers = track.clips.filter(clip => frameOf(clip.timelineStart, fps) >= endFrame);
  if (!movers.length) return { movers, collides: false };
  const moving = new Set(movers);
  const earliest = Math.min(...movers.map(clip => (frameOf(clip.timelineStart, fps) - gapFrames) / fps));
  // The same overlap rule as validation: a clip that stays may end exactly where a moved one starts.
  const collides = track.clips.some(clip => !moving.has(clip) && clip.timelineStart + clip.duration > earliest + EPSILON);
  return { movers, collides };
}

/**
 * Apply a ripple delete of `clipId` to `project` (mutated in place) and say what happened. Throws a plain refusal,
 * changing nothing it has not already checked, when the clip is on a locked track or a template layer on it is.
 */
export function applyRippleDelete(project: EditProject, clipId: string): RippleDeleteOutcome {
  const fps = fpsOf(project);
  const sourceTrack = project.tracks.find(track => track.clips.some(clip => clip.id === clipId));
  if (!sourceTrack) throw new EditGraphError(`找不到片段：${clipId}`);
  if (sourceTrack.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  const clip = sourceTrack.clips.find(item => item.id === clipId)!;
  const startFrame = frameOf(clip.timelineStart, fps), gapFrames = lengthOf(clip.duration, fps), endFrame = startFrame + gapFrames;
  const S = startFrame / fps, E = endFrame / fps;
  const mainTrack = sourceTrack.id === "video-main";
  const outcome: RippleDeleteOutcome = { clipId, trackId: sourceTrack.id, mainTrack, startFrame, endFrame, gapFrames, shiftedTrackIds: [], heldTracks: [],
    captionsLocked: false, removedCaptionIds: [], trimmedCaptionIds: [], removedGraphicIds: [], trimmedGraphicIds: [], removedMarkerIds: [],
    removedTemplateIds: [], heldSceneIds: [] };

  // What belongs to the deleted clip is read before anything changes.
  const ownedCaptionIds = new Set(mainTrack ? [] : project.captions.filter(caption => captionHolder(project, caption, fps)?.id === clipId).map(caption => caption.id));
  const motionTrackClip = new Map(project.motionTracks.map(track => [track.id, track.clipId]));
  const templateOwned = new Map<string, string>();
  for (const instance of project.referenceMotionInstances ?? []) {
    for (const role of instance.roles) if (role.kind === "graphic") templateOwned.set(role.id, instance.input.clipId);
  }
  const sceneOwned = new Set((project.motionScenes ?? []).flatMap(scene => scene.graphicIds));

  sourceTrack.clips = sourceTrack.clips.filter(item => item.id !== clipId);
  dropReferences(project, new Set([clipId]));
  outcome.removedTemplateIds = removeTemplatesOn(project, clipId);

  // Clips that moved up, so what follows them (tracked labels, template titles) moves the same way.
  const moved = new Set<string>();
  const shiftClips = (clips: TimelineClip[]) => {
    for (const item of clips) { item.timelineStart = Math.max(0, frameOf(item.timelineStart, fps) - gapFrames) / fps; moved.add(item.id); }
  };
  shiftClips(trackShift(sourceTrack, endFrame, gapFrames, fps).movers);
  sourceTrack.clips.sort((left, right) => left.timelineStart - right.timelineStart);
  if (mainTrack) {
    for (const track of project.tracks) {
      if (track === sourceTrack || track.kind === "caption") continue;
      const { movers, collides } = trackShift(track, endFrame, gapFrames, fps);
      if (!movers.length) continue;
      const kind = track.kind as "video" | "audio";
      if (track.locked) { outcome.heldTracks.push({ trackId: track.id, name: track.name, kind, reason: "locked" }); continue; }
      if (collides) { outcome.heldTracks.push({ trackId: track.id, name: track.name, kind, reason: "overlap" }); continue; }
      shiftClips(movers);
      track.clips.sort((left, right) => left.timelineStart - right.timelineStart);
      outcome.shiftedTrackIds.push(track.id);
    }
  }

  // Captions.
  const captionChanges: Array<() => void> = [];
  for (const caption of project.captions) {
    const s = caption.start, e = caption.start + caption.duration;
    if (!mainTrack) {
      if (ownedCaptionIds.has(caption.id)) captionChanges.push(() => outcome.removedCaptionIds.push(caption.id));
      continue;
    }
    if (e <= S + EPSILON) continue;
    if (s >= E - EPSILON) {
      captionChanges.push(() => { caption.start = Math.max(0, frameOf(s, fps) - gapFrames) / fps; });
      continue;
    }
    const remaining = s < S ? (e > E ? caption.duration - gapFrames / fps : S - s) : e - E;
    if (s >= S - EPSILON && e <= E + EPSILON || remaining < 1 / fps - EPSILON) {
      captionChanges.push(() => outcome.removedCaptionIds.push(caption.id));
      continue;
    }
    captionChanges.push(() => {
      if (s >= S) caption.start = S;
      caption.duration = remaining;
      outcome.trimmedCaptionIds.push(caption.id);
    });
  }
  if (captionChanges.length && captionTrackLocked(project)) outcome.captionsLocked = true;
  else for (const change of captionChanges) change();
  if (outcome.removedCaptionIds.length) {
    const removed = new Set(outcome.removedCaptionIds);
    project.captions = project.captions.filter(caption => !removed.has(caption.id));
  }
  project.captions.sort((left, right) => left.start - right.start);

  // Titles and graphics.
  const removedGraphics = new Set<string>();
  for (const graphic of project.motionGraphics) {
    if (sceneOwned.has(graphic.id)) continue;
    const templateClip = templateOwned.get(graphic.id);
    if (templateClip !== undefined) {
      if (moved.has(templateClip)) graphic.timelineStart = Math.max(0, frameOf(graphic.timelineStart, fps) - gapFrames) / fps;
      continue;
    }
    if (graphic.trackId !== undefined) {
      const tracked = motionTrackClip.get(graphic.trackId);
      if (tracked === clipId) removedGraphics.add(graphic.id);
      else if (tracked !== undefined && moved.has(tracked)) graphic.timelineStart = Math.max(0, frameOf(graphic.timelineStart, fps) - gapFrames) / fps;
      continue;
    }
    if (!mainTrack) continue;
    const s = graphic.timelineStart, e = graphic.timelineStart + graphic.duration;
    if (e <= S + EPSILON) continue;
    if (s >= E - EPSILON) { graphic.timelineStart = Math.max(0, frameOf(s, fps) - gapFrames) / fps; continue; }
    if (s >= S - EPSILON && e <= E + EPSILON) { removedGraphics.add(graphic.id); continue; }
    const remainingFrames = s < S ? (e > E ? lengthOf(graphic.duration, fps) - gapFrames : startFrame - frameOf(s, fps)) : frameOf(e, fps) - endFrame;
    if (remainingFrames < 1 || !graphicLengthValid(graphic, remainingFrames / fps, fps)) { removedGraphics.add(graphic.id); continue; }
    if (s >= S) graphic.timelineStart = S;
    graphic.duration = remainingFrames / fps;
    outcome.trimmedGraphicIds.push(graphic.id);
  }
  if (removedGraphics.size) {
    project.motionGraphics = project.motionGraphics.filter(graphic => !removedGraphics.has(graphic.id));
    outcome.removedGraphicIds = [...removedGraphics];
  }

  if (mainTrack) {
    // Markers: inside the deleted clip they go with it; after the cut they move up.
    const removedMarkers = new Set<string>();
    for (const marker of project.director.markers) {
      if (marker.time < S - EPSILON) continue;
      if (marker.time < E - EPSILON) { removedMarkers.add(marker.id); continue; }
      marker.time = Math.max(0, frameOf(marker.time, fps) - gapFrames) / fps;
    }
    if (removedMarkers.size) {
      project.director.markers = project.director.markers.filter(marker => !removedMarkers.has(marker.id));
      outcome.removedMarkerIds = [...removedMarkers];
    }
    project.director.markers.sort((left, right) => left.time - right.time);
    outcome.heldSceneIds = (project.motionScenes ?? []).filter(scene => scene.startFrame >= startFrame).map(scene => scene.id);
  }
  return outcome;
}

/** What a ripple delete of `clipId` would do, without changing `project`. */
export function previewRippleDelete(project: EditProject, clipId: string): RippleDeleteOutcome {
  return applyRippleDelete(structuredClone(project), clipId);
}

/** What goes with a clip that is deleted without closing its gap (a lift): nothing else moves. */
export interface LiftAttachments {
  /** Captions that belong to the clip (it holds their whole time; 主畫面 wins). */
  captionIds: string[];
  /** Free titles bound to the clip that lie entirely inside it, and labels that track it. */
  graphicIds: string[];
  /** Saved title templates on the clip, with every layer they own. */
  templates: Array<{ id: string; title: string; instanceRevision: number; graphicIds: string[]; clipIds: string[]; trackIds: string[] }>;
}

export function liftAttachments(project: EditProject, clipId: string): LiftAttachments {
  const fps = fpsOf(project);
  const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId));
  const clip = track?.clips.find(item => item.id === clipId);
  if (!track || !clip) throw new EditGraphError(`找不到片段：${clipId}`);
  const startFrame = frameOf(clip.timelineStart, fps), endFrame = startFrame + lengthOf(clip.duration, fps);
  const sceneOwned = new Set((project.motionScenes ?? []).flatMap(scene => scene.graphicIds));
  const templateOwned = new Set((project.referenceMotionInstances ?? []).flatMap(instance => instance.roles.filter(role => role.kind === "graphic").map(role => role.id)));
  const trackedClip = new Map(project.motionTracks.map(motion => [motion.id, motion.clipId]));
  const graphicIds = project.motionGraphics.filter(graphic => {
    if (sceneOwned.has(graphic.id) || templateOwned.has(graphic.id)) return false;
    if (graphic.trackId !== undefined) return trackedClip.get(graphic.trackId) === clipId;
    // A free title follows the 主畫面 clip under its first frame.
    const start = frameOf(graphic.timelineStart, fps), end = start + lengthOf(graphic.duration, fps);
    return track.id === "video-main" && start >= startFrame && end <= endFrame;
  }).map(graphic => graphic.id);
  const templates = (project.referenceMotionInstances ?? []).filter(instance => instance.input.clipId === clipId).map(instance => ({
    id: instance.id, title: instance.input.title, instanceRevision: instance.instanceRevision,
    graphicIds: instance.roles.filter(role => role.kind === "graphic" && !sceneOwned.has(role.id) && project.motionGraphics.some(graphic => graphic.id === role.id)).map(role => role.id),
    clipIds: instance.roles.filter(role => role.kind === "clip" && role.id !== clipId && project.tracks.some(item => item.clips.some(candidate => candidate.id === role.id))).map(role => role.id),
    trackIds: instance.roles.filter(role => role.kind === "track" && project.tracks.some(item => item.id === role.id)).map(role => role.id),
  }));
  return { captionIds: project.captions.filter(caption => captionHolder(project, caption, fps)?.id === clipId).map(caption => caption.id), graphicIds, templates };
}
