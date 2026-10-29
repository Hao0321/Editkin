import { createEmptyProject, validateProject } from "../domain/editGraph";
import { linkedClipIds } from "../domain/clipLinks";
import type { EditProject } from "../domain/types";
import { resolveAestheticSystem } from "./editkinAesthetic";

export interface ReframeNewProjectIdentityV1 { id: string; name: string; createdAt: string; }
export function assertPortraitReframeSizeV1(width: number, height: number) {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 16384) || width * 16 !== height * 9)
    throw Error("AUTO_REFRAME_PORTRAIT_SIZE_REQUIRED");
}
/** Browser-safe source guard; preserves the compiler's camera/clock refusals instead of
 * deleting keys, layout, transitions or original source bindings to make a clip eligible. */
export function assertAutoReframeVideoV1(project: EditProject, clipId: string) {
  validateProject(project);
  const parents = project.tracks.filter(t => t.clips.some(c => c.id === clipId));
  const clips = parents.flatMap(t => t.clips.filter(c => c.id === clipId));
  const clip = clips[0], assets = project.assets.filter(a => a.id === clip?.assetId), asset = assets[0];
  if (parents.length !== 1 || clips.length !== 1 || parents[0].kind !== "video" || assets.length !== 1 || asset.kind !== "video") throw Error("AUTO_REFRAME_VIDEO_REQUIRED");
  if (parents[0].locked) throw Error("AUTO_REFRAME_SOURCE_LOCKED");
  if (parents[0].hidden || asset.compositionId || asset.imageSequence || clip.proofStill || asset.clipRetime
    || clip.timeRemap || (clip.speed ?? 1) !== 1) throw Error("AUTO_REFRAME_ORIGINAL_SOURCE_REQUIRED");
  const t = clip.transform;
  if (clip.keyframes.length || t.x !== 0 || t.y !== 0 || t.scale !== 1 || t.rotation !== 0 || t.flipX || t.flipY
    || clip.layout || clip.transform3d || clip.floatingFrame || Object.keys(clip.expressions ?? {}).length || project.scene25d?.enabled)
    throw Error("AUTO_REFRAME_CAMERA_REQUIRES_MERGE");
  if (!Number.isFinite(clip.duration) || clip.duration <= 0 || !Number.isFinite(clip.sourceStart) || clip.sourceStart < 0
    || !Number.isFinite(asset.duration) || clip.sourceStart + clip.duration > asset.duration + 1e-7
    || !Number.isSafeInteger(Math.round(clip.duration * project.fps)) || Math.abs(Math.round(clip.duration * project.fps) / project.fps - clip.duration) > 1e-8)
    throw Error("AUTO_REFRAME_SOURCE_CLOCK_INVALID");
  if (!/^[a-f0-9]{64}$/.test(asset.derivatives?.sourceSha256 ?? "")) throw Error("AUTO_REFRAME_SOURCE_INSPECTION_REQUIRED");
  if (clip.masks?.some(m => m.enabled && (m.matteSequence?.stale || m.matteSequence?.staleReason))) throw Error("AUTO_REFRAME_MATTE_STALE");
  return { clip, asset, track: parents[0] };
}

/** Independent selected-clip document; never writes/replaces the original editor session.
 * IDs inside the new project retain their source namespace, so clip-local references stay exact. */
export function createAutoReframePortraitProjectV1(source: EditProject, clipId: string, width: number, height: number,
  identity: ReframeNewProjectIdentityV1) {
  assertPortraitReframeSizeV1(width, height); const selected = assertAutoReframeVideoV1(source, clipId);
  if (![identity.id, identity.name].every(s => typeof s === "string" && s.trim().length > 0 && s.length <= 160)
    || identity.id !== identity.id.trim() || identity.id === source.id || !Number.isFinite(Date.parse(identity.createdAt))
    || new Date(identity.createdAt).toISOString() !== identity.createdAt) throw Error("AUTO_REFRAME_NEW_IDENTITY_INVALID");
  const included = new Set(linkedClipIds(source, clipId)), from = selected.clip.timelineStart, to = from + selected.clip.duration;
  const owned = source.tracks.flatMap(track => track.clips.filter(c => included.has(c.id)).map(clip => ({ track, clip })));
  for (const { clip, track } of owned) {
    if (clip.id !== clipId && track.kind !== "audio") throw Error("AUTO_REFRAME_LINKED_COMPOSITION_REQUIRED");
    if (clip.timelineStart < from - 1e-8 || clip.timelineStart + clip.duration > to + 1e-8) throw Error("AUTO_REFRAME_LINKED_AUDIO_WINDOW_REQUIRED");
    if (clip.layer?.parentClipId || clip.layer?.trackMatte || clip.creative?.transitionIn || clip.creative?.transitionOut
      || clip.masks?.some(m => m.fixedWindowV3)) throw Error("AUTO_REFRAME_DEPENDENCY_RECOMPOSITION_REQUIRED");
    if (source.referenceMotionInstances?.some(i => included.has(i.input.clipId) || i.roles.some(r => included.has(r.id) || !!r.parentId && included.has(r.parentId)))
      || source.templateApplication?.applied.clips.some(c => included.has(c.clipId))
      || source.templateApplication?.generatedClips?.some(c => included.has(c.clipId))) throw Error("AUTO_REFRAME_TEMPLATE_RECOMPILE_REQUIRED");
  }
  const overlaps = (start: number, duration: number) => start < to - 1e-10 && start + duration > from + 1e-10;
  if (source.motionGraphics.some(g => overlaps(g.timelineStart, g.duration)) || source.motionScenes?.length
    || source.scene3d?.segments.length || source.particleSimulation?.enabled
    || source.timelineTransitions?.some(t => included.has(t.fromClipId) || included.has(t.toClipId))) throw Error("AUTO_REFRAME_DEPENDENCY_RECOMPOSITION_REQUIRED");
  const captions = source.captions.filter(c => overlaps(c.start, c.duration));
  const markers = source.director.markers.filter(m => m.time >= from && m.time < to);
  if (captions.some(c => c.templateOwner) || markers.some(m => m.templateOwner)) throw Error("AUTO_REFRAME_TEMPLATE_RECOMPILE_REQUIRED");
  const next = createEmptyProject(identity.name.trim(), { id: identity.id, width, height, fps: source.fps });
  next.updatedAt = identity.createdAt; next.editorialProfile = source.editorialProfile;
  if (source.colorManagement) next.colorManagement = structuredClone(source.colorManagement);
  if (source.particleSimulation && !source.particleSimulation.enabled) next.particleSimulation = structuredClone(source.particleSimulation);
  next.aestheticSystem = resolveAestheticSystem(source.editorialProfile, "shorts");
  next.captionStyle = structuredClone(source.captionStyle);
  next.tracks = source.tracks.map(t => ({ ...structuredClone(t), clips: t.clips.filter(c => included.has(c.id))
    .map(c => ({ ...structuredClone(c), timelineStart: c.timelineStart - from })) }));
  const assetIds = new Set(owned.map(v => v.clip.assetId));
  next.assets = source.assets.filter(a => assetIds.has(a.id)).map(a => structuredClone(a));
  if (next.assets.length !== assetIds.size) throw Error("AUTO_REFRAME_REFERENCED_ASSET_MISSING");
  next.motionTracks = source.motionTracks.filter(t => included.has(t.clipId)).map(t => structuredClone(t));
  const tracks = new Set(next.motionTracks.map(t => t.id));
  if (owned.some(v => v.clip.masks?.some(m => m.trackId && !tracks.has(m.trackId)))) throw Error("AUTO_REFRAME_MASK_TRACK_DEPENDENCY_REQUIRED");
  next.captions = captions.map(c => { const start = Math.max(from, c.start), end = Math.min(to, c.start + c.duration);
    return { ...structuredClone(c), start: start - from, duration: end - start }; });
  next.director = { ...structuredClone(source.director), reviewState: "draft", updatedAt: identity.createdAt,
    markers: markers.map(m => ({ ...structuredClone(m), time: m.time - from })) };
  validateProject(next);
  return { project: next, clipId, sourceRange: { from, to }, summary: { videoClips: 1, linkedAudioClips: owned.length - 1,
    captions: next.captions.length, masks: owned.reduce((n, v) => n + (v.clip.masks?.length ?? 0), 0), motionTracks: next.motionTracks.length,
    sourceAssets: next.assets.length, originalProjectModified: false as const, inheritedApproval: false as const } };
}
