import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, type EditProject, type MediaAsset, type TimelineClip, type TimelineTrack } from "../domain/types";
import type { SubjectMatteMediaV1 } from "./subjectMatteDerivative";

/**
 * "Text behind the subject" with existing Editkin features only (style templates C10 / S3):
 *
 *   top    ── foreground: duplicate of the footage clip, Track Matte → matte clip (subject only)
 *          ── text track(s): the big words (e.g. Motion Library title clips)
 *          ── footage clip (unchanged; keeps its sound)
 *   bottom ── matte clip: the subject matte video, same geometry as the footage, fully hidden
 *             under the opaque footage (every renderer still reads it as the matte source)
 *
 * One batch command = one Undo. The input project is never mutated. The plan is pure: the caller
 * dispatches `command` through the normal history owner.
 *
 * Renderer support today (read from the code, 2026-10-22): the formal FFmpeg export composites a
 * video Track Matte; the compatible browser preview refuses a moving-video matte source
 * (AlphaPreviewUnavailable) and the native GPU compositor admits only a two-clip matte stack. See
 * SUBJECT_MATTE_RESULT.md for the engine changes that would make preview == export here.
 */
export const BEHIND_SUBJECT_PLAN_SCHEMA_V1 = "editkin.behind-subject-plan/v1";

export interface BehindSubjectIdsV1 {
  matteAssetId: string;
  matteClipId: string;
  matteTrackId: string;
  foregroundClipId: string;
  foregroundTrackId: string;
  /** Used only when no `textTrackIds` are given: an empty text track is created for the words. */
  textTrackId?: string;
  linkGroupId: string;
  matteAssetName?: string;
  matteTrackName?: string;
  foregroundTrackName?: string;
  textTrackName?: string;
}

export interface BehindSubjectRequestV1 {
  footageClipId: string;
  matte: SubjectMatteMediaV1;
  ids: BehindSubjectIdsV1;
  /** Existing video tracks that hold the words. They must sit above the footage track. */
  textTrackIds?: string[];
}

export interface BehindSubjectPlanV1 {
  schema: typeof BEHIND_SUBJECT_PLAN_SCHEMA_V1;
  command: Extract<EditorCommand, { type: "batch" }>;
  matteAsset: MediaAsset;
  footageClipId: string;
  matteClipId: string;
  foregroundClipId: string;
  /** Where the words go (created when the request named none). */
  textTrackIds: string[];
  createdTextTrack: boolean;
  /** Resulting video-track order, bottom to top, from the matte track upward. */
  videoTrackOrder: string[];
  trackMatteMode: "luma" | "alpha";
  qualityState: "diagnostic";
}

const SHA = /^[a-f0-9]{64}$/;
const refuse = (code: string): never => { throw Error(code); };

function framesEqual(a: number, b: number, fps: number) {
  return Math.abs(a - b) <= 1.5 / fps;
}

/** Same admission discipline as the subject sticker / roto cutout owners: only an ordinary clip. */
export function admitBehindSubjectFootageV1(project: EditProject, clipId: string) {
  const matches = project.tracks.flatMap(track => track.clips.filter(clip => clip.id === clipId).map(clip => ({ track, clip })));
  if (matches.length !== 1) refuse("BEHIND_SUBJECT_FOOTAGE_MISSING_OR_AMBIGUOUS");
  const { track, clip } = matches[0];
  const assets = project.assets.filter(asset => asset.id === clip.assetId), asset = assets[0];
  if (track.kind !== "video" || track.hidden || assets.length !== 1 || asset.kind !== "video" || clip.layer?.enabled === false) refuse("BEHIND_SUBJECT_FOOTAGE_NOT_VISIBLE_VIDEO");
  if (track.locked) refuse("BEHIND_SUBJECT_FOOTAGE_TRACK_LOCKED");
  if ((project.colorManagement?.mode ?? "rec709") !== "rec709") refuse("BEHIND_SUBJECT_REC709_PROJECT_REQUIRED");
  if (asset.compositionId || asset.imageSequence || asset.clipRetime || asset.alphaMode === "straight" || asset.alphaMode === "premultiplied") refuse("BEHIND_SUBJECT_OPAQUE_ORIGINAL_REQUIRED");
  if (clip.timeRemap || (clip.speed ?? 1) !== 1 || clip.expressions && Object.keys(clip.expressions).length || clip.transform3d || clip.floatingFrame || clip.proofStill
    || clip.motionLibrary || project.scene25d?.enabled || clip.layer?.parentClipId || clip.layer?.trackMatte || (clip.layer?.role ?? "content") !== "content"
    || (clip.layer?.blendMode ?? "normal") !== "normal") refuse("BEHIND_SUBJECT_FOOTAGE_DEPENDENCY_REQUIRES_OWNER");
  if (clip.creative?.transitionIn || clip.creative?.transitionOut || project.timelineTransitions?.some(t => t.fromClipId === clipId || t.toClipId === clipId)) refuse("BEHIND_SUBJECT_TRANSITION_REQUIRES_OWNER");
  // The matte clip sits under the footage; any footage transparency would reveal it.
  if (clip.transform.opacity !== 1 || clip.keyframes.some(key => key.transform.opacity !== 1) || clip.masks?.some(mask => mask.enabled) || clip.chromaKey?.enabled) refuse("BEHIND_SUBJECT_FOOTAGE_MUST_BE_OPAQUE");
  if (project.scene3d?.segments.some(segment => segment.objects.some(object => object.material.clipId === clipId))) refuse("BEHIND_SUBJECT_FOOTAGE_DEPENDENCY_REQUIRES_OWNER");
  if (project.referenceMotionInstances?.some(i => i.input.clipId === clipId || i.roles.some(r => r.id === clipId || r.parentId === clipId))
    || project.templateApplication?.generatedClips?.some(c => c.clipId === clipId) || project.templateApplication?.applied.clips.some(c => c.clipId === clipId)) refuse("BEHIND_SUBJECT_TEMPLATE_RECOMPILE_REQUIRED");
  return { track, clip, asset };
}

/** The matte must be this exact source's matte and cover the clip's source window. */
export function admitSubjectMatteForAssetV1(asset: MediaAsset, clip: TimelineClip, matte: SubjectMatteMediaV1) {
  if (matte.schema !== "editkin.subject-matte-derivative/v1" || matte.licence !== "Apache-2.0" || matte.qualityState !== "diagnostic"
    || !SHA.test(matte.sourceSha256) || !SHA.test(matte.matteSha256) || typeof matte.matteUri !== "string" || !matte.matteUri) refuse("BEHIND_SUBJECT_MATTE_RECEIPT_INVALID");
  if (!asset.derivatives?.sourceSha256 || asset.derivatives.sourceSha256 !== matte.sourceSha256) refuse("BEHIND_SUBJECT_MATTE_SOURCE_MISMATCH");
  if (!["luma", "alpha"].includes(matte.trackMatteMode) || (matte.trackMatteMode === "alpha") !== matte.matteFormat.startsWith("alpha")) refuse("BEHIND_SUBJECT_MATTE_FORMAT");
  const fps = matte.frameRateNumerator / matte.frameRateDenominator;
  if (![matte.width, matte.height, matte.frames, matte.frameRateNumerator, matte.frameRateDenominator].every(n => Number.isSafeInteger(n) && n > 0) || !(fps > 0 && fps <= 240)) refuse("BEHIND_SUBJECT_MATTE_RECEIPT_INVALID");
  // Matte frames are upright display pixels; asset width/height may be the coded (pre-rotation) size.
  if (asset.width && asset.height && !((asset.width === matte.width && asset.height === matte.height) || (asset.width === matte.height && asset.height === matte.width))) refuse("BEHIND_SUBJECT_MATTE_SIZE_MISMATCH");
  if (asset.displayAspectRatio && Math.abs(asset.displayAspectRatio - matte.width / matte.height) > 0.01) refuse("BEHIND_SUBJECT_MATTE_ORIENTATION_MISMATCH");
  const matteDuration = matte.frames / fps;
  if (!framesEqual(matteDuration, asset.duration, fps)) refuse("BEHIND_SUBJECT_MATTE_DURATION_MISMATCH");
  if (clip.sourceStart < 0 || clip.sourceStart + clip.duration > matteDuration + 1.5 / fps) refuse("BEHIND_SUBJECT_MATTE_DOES_NOT_COVER_CLIP");
  return { fps, matteDuration };
}

/** Drops keys instead of writing `undefined`, so save/reopen keeps the same shape. */
function omit<T extends object>(value: T, keys: readonly string[]): T {
  const copy = structuredClone(value) as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}

function nameOk(value: unknown) {
  return typeof value === "string" && !!value.trim() && value.length <= 160 && value === value.trim();
}

export function planBehindSubjectV1(project: EditProject, request: BehindSubjectRequestV1): BehindSubjectPlanV1 {
  const { ids, matte } = request;
  const required = [ids.matteAssetId, ids.matteClipId, ids.matteTrackId, ids.foregroundClipId, ids.foregroundTrackId, ids.linkGroupId];
  const createText = !request.textTrackIds?.length;
  if (createText) required.push(ids.textTrackId as string);
  if (!required.every(nameOk) || new Set(required).size !== required.length) refuse("BEHIND_SUBJECT_IDS_REQUIRED");
  const taken = new Set([...project.assets.map(a => a.id), ...project.tracks.map(t => t.id), ...project.tracks.flatMap(t => t.clips.map(c => c.id))]);
  if (required.some(id => id !== ids.linkGroupId && taken.has(id))) refuse("BEHIND_SUBJECT_ID_ALREADY_USED");
  const { track: footageTrack, clip: footage, asset } = admitBehindSubjectFootageV1(project, request.footageClipId);
  admitSubjectMatteForAssetV1(asset, footage, matte);

  const videoTracks = project.tracks.filter(t => t.kind === "video");
  const footageIndex = videoTracks.indexOf(footageTrack);
  const textTracks = createText ? [] : request.textTrackIds!.map(id => videoTracks.find(t => t.id === id) ?? refuse("BEHIND_SUBJECT_TEXT_TRACK_MISSING"));
  if (new Set(textTracks).size !== textTracks.length) refuse("BEHIND_SUBJECT_TEXT_TRACK_DUPLICATED");
  if (textTracks.some(t => videoTracks.indexOf(t) <= footageIndex)) refuse("BEHIND_SUBJECT_TEXT_TRACK_BELOW_FOOTAGE");
  if (textTracks.some(t => t.hidden)) refuse("BEHIND_SUBJECT_TEXT_TRACK_HIDDEN");
  // Every video track from the footage upward moves up one or more slots.
  if (videoTracks.slice(footageIndex).some(t => t.locked)) refuse("BEHIND_SUBJECT_UPPER_TRACK_LOCKED");

  const alpha = matte.trackMatteMode === "alpha";
  const matteAsset: MediaAsset = {
    id: ids.matteAssetId, name: ids.matteAssetName ?? `${asset.name}（主體遮罩）`, kind: "video", uri: matte.matteUri,
    // Width/height are already upright display pixels. No displayAspectRatio: the FFV1 matte carries no SAR, and
    // export refuses a stored aspect it cannot re-verify against the probe (mediaDisplayGeometry).
    duration: matte.frames * matte.frameRateDenominator / matte.frameRateNumerator, width: matte.width, height: matte.height,
    alphaMode: alpha ? "straight" : "opaque",
    color: alpha ? { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "gbr", range: "pc" } : { interpretation: "rec709", primaries: "bt709", transfer: "bt709", range: "pc" },
    ...(asset.license === undefined ? {} : { license: asset.license }), ...(asset.rightsBasis === undefined ? {} : { rightsBasis: asset.rightsBasis }),
    ...(asset.redistributable === undefined ? {} : { redistributable: asset.redistributable }),
    provenance: `editkin.subject-matte/v1:${matte.sourceSha256}:${matte.matteSha256}:${matte.models.map(m => m.id).join("+")}`,
  };
  // Matte: identical geometry/timing, neutral colour, no look/effects/sound (they would alter the matte).
  const matteBase = omit(footage, ["creative", "gradeV2", "rec709Input", "masks", "chromaKey", "audioEnvelope", "linkGroupId"]);
  const matteClip: TimelineClip = {
    ...matteBase, id: ids.matteClipId, assetId: ids.matteAssetId, trackId: ids.matteTrackId, volume: 0, color: { ...DEFAULT_COLOR },
    keyframes: matteBase.keyframes.map((key, index) => ({ ...key, id: `${ids.matteClipId}:key:${index}`, color: { ...DEFAULT_COLOR } })),
    layer: { ...DEFAULT_CLIP_LAYER },
  };
  // Foreground: the same picture with the same grade and look, keyed to the matte, silent.
  const foregroundBase = omit(footage, ["audioEnvelope", "linkGroupId"]);
  const foreground: TimelineClip = {
    ...foregroundBase, id: ids.foregroundClipId, trackId: ids.foregroundTrackId, volume: 0,
    keyframes: foregroundBase.keyframes.map((key, index) => ({ ...key, id: `${ids.foregroundClipId}:key:${index}` })),
    layer: { ...DEFAULT_CLIP_LAYER, ...footage.layer, trackMatte: { sourceClipId: ids.matteClipId, mode: alpha ? "alpha" : "luma" } },
  };
  const newTrack = (id: string, name: string): TimelineTrack => ({ id, name, kind: "video", locked: false, muted: true, hidden: false, clips: [] });
  const commands: EditorCommand[] = [
    { type: "import_asset", asset: matteAsset },
    { type: "add_track", track: newTrack(ids.matteTrackId, ids.matteTrackName ?? "主體遮罩（來源）") },
    ...(createText ? [{ type: "add_track" as const, track: newTrack(ids.textTrackId!, ids.textTrackName ?? "主體後文字") }] : []),
    { type: "add_track", track: newTrack(ids.foregroundTrackId, ids.foregroundTrackName ?? "主體前景") },
    { type: "add_clip", clip: matteClip },
    { type: "add_clip", clip: foreground },
  ];
  // Bottom-to-top order for the footage track and everything above it.
  const highestText = textTracks.reduce<TimelineTrack | undefined>((top, t) => !top || videoTracks.indexOf(t) > videoTracks.indexOf(top) ? t : top, undefined);
  const order: string[] = [];
  for (const track of videoTracks.slice(footageIndex)) {
    if (track === footageTrack) {
      order.push(ids.matteTrackId, track.id);
      if (createText) order.push(ids.textTrackId!, ids.foregroundTrackId);
    } else {
      order.push(track.id);
      if (track === highestText) order.push(ids.foregroundTrackId);
    }
  }
  commands.push({ type: "reorder_tracks", trackIds: order });
  commands.push({ type: "set_clip_links", clipIds: [footage.id, ids.matteClipId, ids.foregroundClipId], groupId: footage.linkGroupId ?? ids.linkGroupId });
  const command: Extract<EditorCommand, { type: "batch" }> = { type: "batch", commands };
  // Full validation on a clone; applyCommand never mutates its input.
  const after = applyCommand(project, command);
  const placed = after.tracks.filter(t => t.kind === "video").map(t => t.id);
  const at = (id: string) => placed.indexOf(id);
  if (!(at(ids.matteTrackId) < at(footageTrack.id) && at(footageTrack.id) < at(ids.foregroundTrackId)
    && (createText ? [ids.textTrackId!] : request.textTrackIds!).every(id => at(footageTrack.id) < at(id) && at(id) < at(ids.foregroundTrackId)))) refuse("BEHIND_SUBJECT_LAYER_ORDER");
  return {
    schema: BEHIND_SUBJECT_PLAN_SCHEMA_V1, command, matteAsset, footageClipId: footage.id, matteClipId: ids.matteClipId, foregroundClipId: ids.foregroundClipId,
    textTrackIds: createText ? [ids.textTrackId!] : [...request.textTrackIds!], createdTextTrack: createText, videoTrackOrder: order,
    trackMatteMode: alpha ? "alpha" : "luma", qualityState: "diagnostic",
  };
}
