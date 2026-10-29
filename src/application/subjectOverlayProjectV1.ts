import { applyCommand, type EditorCommand } from "../domain/commands";
import { validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "../domain/types";
import type { RenderPlan } from "../render/planner";
import type { SubjectOverlayEffectV1, SubjectOverlaySourceStageV1 } from "../render/subjectOverlayGraphV1";

export interface SubjectOverlayIdsV1 { assetId: string; clipId: string; trackId: string; linkGroupId: string; assetName: string; trackName: string; }
export function admitSubjectOverlaySourceV1(project: EditProject, clipId: string, kind: SubjectOverlayEffectV1["kind"]) {
  validateProject(project);
  const matches = project.tracks.flatMap(track => track.clips.filter(c => c.id === clipId).map(clip => ({ track, clip })));
  if (matches.length !== 1) throw Error("SUBJECT_OVERLAY_SOURCE_MISSING_OR_AMBIGUOUS");
  const { track, clip } = matches[0], assets = project.assets.filter(a => a.id === clip.assetId), asset = assets[0];
  if (![project.width, project.height].every(n => Number.isSafeInteger(n) && n >= 16 && n <= 8192) || project.width * project.height > 2073600) throw Error("SUBJECT_OVERLAY_RASTER_BUDGET");
  if (track.locked || track.hidden || track.kind !== "video" || clip.layer?.enabled === false || assets.length !== 1 || asset.kind !== "video") throw Error("SUBJECT_OVERLAY_SOURCE_LOCKED_HIDDEN_OR_NOT_VIDEO");
  if ((project.colorManagement?.mode ?? "rec709") !== "rec709" || project.colorManagement?.outputTransform && project.colorManagement.outputTransform !== "rec709_sdr"
    || asset.color?.interpretation && !["auto", "rec709"].includes(asset.color.interpretation) || asset.alphaMode === "straight" || asset.alphaMode === "premultiplied") throw Error("SUBJECT_OVERLAY_REC709_OPAQUE_ORIGINAL_REQUIRED");
  if (asset.compositionId || asset.imageSequence || asset.clipRetime || clip.timeRemap || (clip.speed ?? 1) !== 1 || clip.expressions || clip.transform3d || clip.floatingFrame || clip.proofStill
    || project.scene25d?.enabled || clip.layer?.parentClipId || clip.layer?.trackMatte || (clip.layer?.role ?? "content") !== "content" || (clip.layer?.blendMode ?? "normal") !== "normal"
    || clip.creative?.transitionIn || clip.creative?.transitionOut || project.timelineTransitions?.some(t => t.fromClipId === clipId || t.toClipId === clipId)
    || project.scene3d?.segments.some(s => s.objects.some(o => o.material.clipId === clipId))) throw Error("SUBJECT_OVERLAY_SOURCE_DEPENDENCY_REQUIRES_OWNER");
  if (project.referenceMotionInstances?.some(i => i.input.clipId === clipId || i.roles.some(r => r.id === clipId || r.parentId === clipId))
    || project.templateApplication?.generatedClips?.some(c => c.clipId === clipId) || project.templateApplication?.applied.clips.some(c => c.clipId === clipId)) throw Error("SUBJECT_OVERLAY_TEMPLATE_RECOMPILE_REQUIRED");
  const tracks = new Set(project.motionTracks.filter(t => t.clipId === clipId).map(t => t.id));
  if (kind === "sticker" && (project.motionGraphics.some(g => g.trackId && tracks.has(g.trackId))
    || project.tracks.some(t => t.clips.some(c => c.layer?.parentClipId === clipId || c.layer?.trackMatte?.sourceClipId === clipId)))) throw Error("SUBJECT_OVERLAY_DEPENDENTS_REQUIRE_REBIND");
  const start = Math.round(clip.timelineStart * project.fps), frames = Math.round(clip.duration * project.fps);
  if (!Number.isFinite(project.fps) || project.fps < 1 || project.fps > 240 || !Number.isSafeInteger(start) || !Number.isSafeInteger(frames) || start < 0 || frames < 1 || frames > 28800
    || Math.abs(start / project.fps - clip.timelineStart) > 1e-8 || Math.abs(frames / project.fps - clip.duration) > 1e-8
    || clip.timelineStart + clip.duration > 86400 || clip.duration > 120) throw Error("SUBJECT_OVERLAY_CLIP_FRAME_GRID_OR_DURATION");
  return { track, clip, asset, start, frames };
}
/** Full current mask/keyer stage only. All original appearance/geometry survives on
 * the new ordinary clip and is executed once by its existing renderer. */
export function subjectOverlaySourceStageV1(project: EditProject, clipId: string, kind: SubjectOverlayEffectV1["kind"]): SubjectOverlaySourceStageV1 {
  const admitted = admitSubjectOverlaySourceV1(project, clipId, kind), copy = structuredClone(project);
  const track = copy.tracks.find(t => t.id === admitted.track.id)!, clip = track.clips.find(c => c.id === clipId)!;
  clip.transform = { ...DEFAULT_TRANSFORM }; clip.color = { ...DEFAULT_COLOR };
  clip.keyframes = [];
  clip.creative = undefined; clip.gradeV2 = undefined; clip.layout = undefined;
  const asset = copy.assets.find(a => a.id === clip.assetId)!;
  const plan: RenderPlan = { fps: copy.fps, width: copy.width, height: copy.height, duration: clip.timelineStart + clip.duration,
    videoLayers: [{ trackId: track.id, trackIndex: copy.tracks.indexOf(track), segments: [{ kind: "clip", start: clip.timelineStart, duration: clip.duration, clip, assetPath: asset.uri }] }], audioClips: [], captions: [] };
  return { project: copy, clip, asset, plan, frames: admitted.frames, clipStartFrame: admitted.start };
}
export interface SubjectOverlayMediaV1 {
  kind: SubjectOverlayEffectV1["kind"]; path: string; sha256: string; width: number; height: number; frames: number; fps: number; duration: number;
  sourceSha256: string; confirmationSha256: string; pixelFormat: "bgra" | "gbrap16le";
}
/** A pure command plan is not a file/trust/apply capability. The Node producer owns
 * physical revalidation and its private one-use session-bound application. */
export function planSubjectOverlayProjectV1(project: EditProject, sourceClipId: string, media: SubjectOverlayMediaV1, ids: SubjectOverlayIdsV1) {
  if (!["sticker", "sheen"].includes(media.kind)) throw Error("SUBJECT_OVERLAY_MEDIA_KIND");
  const { clip: sourceClip, asset: source, frames } = admitSubjectOverlaySourceV1(project, sourceClipId, media.kind);
  for (const value of Object.values(ids)) if (typeof value !== "string" || !value.trim() || value.length > 160) throw Error("SUBJECT_OVERLAY_IDS_REQUIRED");
  if (media.width !== project.width || media.height !== project.height || media.frames !== frames || media.fps !== project.fps || !Number.isFinite(media.duration) || Math.abs(media.duration - sourceClip.duration) > 1e-8
    || media.pixelFormat !== (media.kind === "sticker" ? "bgra" : "gbrap16le") || !/^[a-f0-9]{64}$/u.test(media.sha256) || !/^[a-f0-9]{64}$/u.test(media.sourceSha256)
    || !/^[a-f0-9]{64}$/u.test(media.confirmationSha256)) throw Error("SUBJECT_OVERLAY_MEDIA_OR_SOURCE_CLOCK_CHANGED");
  const asset: MediaAsset = { id: ids.assetId, name: ids.assetName, kind: "video", uri: media.path, duration: media.duration, width: media.width, height: media.height,
    displayAspectRatio: media.width / media.height, alphaMode: "straight", color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "gbr", range: "pc" },
    ...(source.license === undefined ? {} : { license: source.license }), ...(source.rightsBasis === undefined ? {} : { rightsBasis: source.rightsBasis }),
    ...(source.redistributable === undefined ? {} : { redistributable: source.redistributable }), provenance: `editkin.subject-overlay/v1:${media.kind}:${media.sourceSha256}:${media.confirmationSha256}` };
  const clip: TimelineClip = { ...structuredClone(sourceClip), id: ids.clipId, assetId: ids.assetId, trackId: ids.trackId, sourceStart: 0, volume: 0,
    masks: undefined, chromaKey: undefined, keyframes: sourceClip.keyframes.map((k, i) => ({ ...structuredClone(k), id: `${ids.clipId}:key:${i}` })) };
  const commands: EditorCommand[] = [{ type: "import_asset", asset }, { type: "add_track", track: { id: ids.trackId, name: ids.trackName, kind: "video", locked: false, muted: true, hidden: false, clips: [] } }, { type: "add_clip", clip }];
  if (media.kind === "sticker") commands.push({ type: "update_clip_transform", clipId: sourceClip.id, patch: { opacity: 0 } },
    ...sourceClip.keyframes.map(k => ({ type: "update_keyframe" as const, clipId: sourceClip.id, keyframeId: k.id, patch: { transform: { ...k.transform, opacity: 0 } } })));
  commands.push({ type: "set_clip_links", clipIds: [sourceClip.id, clip.id], groupId: sourceClip.linkGroupId ?? ids.linkGroupId });
  const command: EditorCommand = { type: "batch", commands }; applyCommand(project, command);
  return { command, asset, derivativeClipId: clip.id, retainedSourceClipId: sourceClip.id, originalPictureRetained: media.kind === "sheen" };
}
