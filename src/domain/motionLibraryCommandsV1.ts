import { MOTION_LIBRARY_ENGINE_VERSION } from "../motionLibrary/types";
import type { EditorCommand } from "./commandTypes";
import { EditGraphError } from "./editGraphError";
import { MotionLibraryRefusalV1, motionLibraryClipV1Schema, type MotionLibraryClipV1 } from "./motionLibraryFieldsV1";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { DEFAULT_CLIP_LAYER, type EditProject, type MediaAsset, type TimelineClip, type TimelineTrack } from "./types";
import { reconcileUnifiedLayerOrderInPlaceV1 } from "./unifiedLayerEditsV1";

/**
 * add_motion_library_clip / update_motion_library_clip (PHASE3_CORE_BRIEF decision 3). Both are pure over the project:
 * rendering happens before dispatch (application/motionLibraryClipsV1.ts), and the command carries the rendered asset.
 * The full field and asset binding (catalog params, cache key, size, frame count, alpha) is enforced by validateProject
 * when the command finishes (domain/motionLibraryV1.ts); here only what the field validation cannot see is checked:
 * the current engine, the asset/field pairing, asset identity conflicts, the track lock and the update guard.
 * Each command is one history entry, like any other command.
 */

function parseField(value: unknown): MotionLibraryClipV1 {
  if (value === undefined) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_CLIP_FIELD_REQUIRED");
  const parsed = motionLibraryClipV1Schema.safeParse(value);
  if (!parsed.success) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_FIELD_INVALID", parsed.error.issues[0]?.path.join(".") || "motionLibrary");
  if (parsed.data.engineVersion !== MOTION_LIBRARY_ENGINE_VERSION) {
    throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ENGINE_VERSION_STALE", `${parsed.data.engineVersion} is not ${MOTION_LIBRARY_ENGINE_VERSION}; re-render first`);
  }
  return parsed.data;
}

/** The fields that make two asset records the same rendered file; derivatives (proxies) may differ. */
function renderedIdentity(asset: MediaAsset) {
  return JSON.stringify([asset.kind, asset.uri, asset.width, asset.height, asset.duration, asset.alphaMode, asset.compositionId, asset.imageSequence]);
}

/** Adds the asset unless the same rendered file is already registered under its id; a different file is a conflict. */
function ensureAsset(project: EditProject, asset: MediaAsset): void {
  if (!asset || typeof asset !== "object" || typeof asset.id !== "string") throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_MISSING", "the command carries no asset");
  const existing = project.assets.find(candidate => candidate.id === asset.id);
  if (existing) {
    if (renderedIdentity(existing) !== renderedIdentity(asset)) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_CONFLICT", asset.id);
    return;
  }
  project.assets.push(structuredClone(asset));
}

/**
 * Motion Library tracks for `autoTrack` placement: text on top of the picture stack, backgrounds beneath it. Track ids
 * are the base id, then `<base>-2`, `<base>-3`, … (the first one not taken by any track).
 */
export const MOTION_LIBRARY_AUTO_TRACKS_V1 = {
  text: { base: "motionlib-text", name: "動態文字" },
  background: { base: "motionlib-bg", name: "動態背景" },
} as const;
/** Same tolerance as the per-track overlap rule in projectValidation. */
const OVERLAP_EPSILON = 1e-6;

/**
 * The track an `autoTrack` clip goes on, resolved when the command runs (so several prepares sealed against one saved
 * project compose in one plan, deterministically, in command order): the first unlocked, visible Motion Library track of
 * the clip's kind (base id first, then -2, -3, …) where the clip fits without overlap; otherwise a new track with the next
 * free id, created inside this same command (one Undo removes clip and track together).
 */
function resolveAutoTrack(project: EditProject, clip: TimelineClip, kind: MotionLibraryClipV1["kind"]): string {
  const { base, name } = MOTION_LIBRARY_AUTO_TRACKS_V1[kind];
  if (clip.trackId !== base) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_TRACK_INVALID", `an autoTrack ${kind} clip names ${base}, not ${clip.trackId}`);
  const ordinal = (trackId: string) => {
    if (trackId === base) return 1;
    const match = /^-([1-9][0-9]{0,5})$/.exec(trackId.startsWith(base) ? trackId.slice(base.length) : "");
    return match && Number(match[1]) >= 2 ? Number(match[1]) : undefined;
  };
  const start = clip.timelineStart, end = clip.timelineStart + clip.duration;
  const fits = (track: TimelineTrack) => track.clips.every(other => other.timelineStart + other.duration <= start + OVERLAP_EPSILON || end <= other.timelineStart + OVERLAP_EPSILON);
  const reusable = project.tracks
    .filter(track => track.kind === "video" && !track.locked && track.hidden !== true && ordinal(track.id) !== undefined)
    .sort((a, b) => ordinal(a.id)! - ordinal(b.id)!)
    .find(fits);
  if (reusable) return reusable.id;
  const taken = new Set(project.tracks.map(track => track.id));
  let index = 1;
  while (taken.has(index === 1 ? base : `${base}-${index}`)) index += 1;
  const track: TimelineTrack = { id: index === 1 ? base : `${base}-${index}`, name: index === 1 ? name : `${name} ${index}`, kind: "video", locked: false, muted: false, clips: [] };
  const lowestVideo = project.tracks.findIndex(candidate => candidate.kind === "video");
  if (kind === "background" && lowestVideo >= 0) project.tracks.splice(lowestVideo, 0, track);
  else project.tracks.push(track);
  return track.id;
}

export function applyMotionLibraryCommandV1(project: EditProject, command: EditorCommand): boolean {
  if (command.type === "add_motion_library_clip") {
    const field = parseField(command.clip?.motionLibrary);
    if (command.autoTrack !== undefined && command.autoTrack !== true) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_TRACK_INVALID", "autoTrack is true or absent");
    if (command.clip.assetId !== command.asset?.id) {
      throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_BINDING_MISMATCH", `clip ${command.clip.id} must use asset ${String(command.asset?.id)}`);
    }
    if (project.tracks.some(candidate => candidate.clips.some(existing => existing.id === command.clip.id))) throw new EditGraphError(`重複片段 id：${command.clip.id}`);
    // Checked before a track may be created, so a refused command leaves no track behind.
    ensureAsset(project, command.asset);
    const clip = command.autoTrack ? { ...command.clip, trackId: resolveAutoTrack(project, command.clip, field.kind) } : command.clip;
    const track = project.tracks.find(candidate => candidate.id === clip.trackId);
    if (!track) throw new EditGraphError(`找不到軌道：${clip.trackId}`);
    if (track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
    if (track.kind !== "video") throw new MotionLibraryRefusalV1("MOTION_LIBRARY_TRACK_INVALID", `${clip.id} is on a ${track.kind} track`);
    // Same normalization as add_clip: later commands of a batch may edit nested arrays.
    track.clips.push({ ...structuredClone(clip), layer: { ...DEFAULT_CLIP_LAYER, ...clip.layer }, expressions: { ...clip.expressions } });
    track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
    // A new clip is a layer identity edit, exactly like add_clip.
    reconcileUnifiedLayerOrderInPlaceV1(project, { type: "add_clip", clip });
    return true;
  }
  if (command.type === "update_motion_library_clip") {
    const track = project.tracks.find(candidate => candidate.clips.some(clip => clip.id === command.clipId));
    const clip: TimelineClip | undefined = track?.clips.find(candidate => candidate.id === command.clipId);
    if (!track || !clip) throw new EditGraphError(`找不到片段：${command.clipId}`);
    if (track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
    if (!clip.motionLibrary) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_CLIP_FIELD_REQUIRED", clip.id);
    if (!command.expected || command.expected.assetId !== clip.assetId || command.expected.cacheKey !== clip.motionLibrary.cacheKey) {
      throw new MotionLibraryRefusalV1("MOTION_LIBRARY_UPDATE_STALE", clip.id);
    }
    const field = parseField(command.motionLibrary);
    if (field.kind !== clip.motionLibrary.kind) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_KIND_MISMATCH", `${clip.id} is a ${clip.motionLibrary.kind} clip`);
    ensureAsset(project, command.asset);
    clip.assetId = command.asset.id;
    clip.motionLibrary = structuredClone(field);
    if (command.sourceStart !== undefined) clip.sourceStart = command.sourceStart;
    if (command.duration !== undefined) clip.duration = command.duration;
    return true;
  }
  return false;
}
