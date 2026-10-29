import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import type { RotoCutoutClipResultV1 } from "./rotoCutoutClipV1";

export function rotoCutoutLocalSourcePathV1(input: string) {
  let value = input;
  if (value.startsWith("file:")) {
    const url = new URL(value); if (url.hostname && url.hostname !== "localhost") throw Error("ROTO_CUTOUT_LOCAL_SOURCE_REQUIRED");
    value = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, "$1");
  }
  return value;
}
const localPathKey = (input: string) => rotoCutoutLocalSourcePathV1(input).replaceAll("\\", "/").toLowerCase();

/** Adds an editable ordinary foreground clip in one Undo. The original remains as linked audio/
 * analysis context with zero picture opacity. No source asset, old mask, or authored key is deleted. */
export function planRotoCutoutProjectV1(project: EditProject, clipId: string, result: RotoCutoutClipResultV1,
  ids: { assetId: string; clipId: string; trackId: string; linkGroupId: string; assetName: string; trackName: string }) {
  const { sourceClip, source } = assertRotoCutoutSourceV1(project, clipId);
  return planAdmittedRotoCutout(project, sourceClip, source, result, ids);
}

/** Preflight before long work. Shared editor/desktop hooks remain owned by the integrator. */
export function assertRotoCutoutSourceV1(project: EditProject, clipId: string) {
  const sourceTrack = project.tracks.find(t => t.clips.some(c => c.id === clipId));
  const sourceClip = sourceTrack?.clips.find(c => c.id === clipId);
  const source = project.assets.find(a => a.id === sourceClip?.assetId);
  if (!sourceTrack || !sourceClip || !source || sourceTrack.kind !== "video" || source.kind !== "video") throw Error("ROTO_CUTOUT_VIDEO_CLIP_REQUIRED");
  if (sourceTrack.locked) throw Error(TRACK_LOCKED_MESSAGE);
  if ((project.colorManagement?.mode ?? "rec709") !== "rec709" || sourceClip.gradeV2
    || (source.color?.interpretation !== undefined && !["auto", "rec709"].includes(source.color.interpretation))
    || source.compositionId || source.imageSequence || sourceClip.floatingFrame || sourceClip.proofStill || sourceClip.transform3d
    || sourceClip.timeRemap || (sourceClip.speed ?? 1) !== 1 || sourceClip.expressions
    || sourceClip.chromaKey?.enabled
    || (sourceClip.layer?.role ?? "content") !== "content" || (sourceClip.layer?.blendMode ?? "normal") !== "normal" || sourceClip.layer?.trackMatte
    || sourceClip.creative?.transitionIn || sourceClip.creative?.transitionOut
    || project.timelineTransitions?.some(t => t.fromClipId === clipId || t.toClipId === clipId)
    || sourceClip.masks?.some(m => m.kind !== "subject" && (m.trackId || m.matteSequence || m.frozenRange))
    || project.scene3d?.segments.some(s => s.objects.some(o => o.material.clipId === sourceClip.id))) throw Error("ROTO_CUTOUT_CLIP_REQUIRES_SEPARATE_EFFECT_OR_TRACK_REBIND");
  if ((project.referenceMotionInstances ?? []).some(i => i.input.clipId === sourceClip.id || i.roles.some(r => r.id === sourceClip.id || r.parentId === sourceClip.id))
    || project.templateApplication?.generatedClips?.some(c => c.clipId === sourceClip.id)
    || project.templateApplication?.applied.clips.some(c => c.clipId === sourceClip.id)) throw Error("ROTO_CUTOUT_TEMPLATE_RECOMPILE_REQUIRED");
  return { sourceTrack, sourceClip, source };
}

function planAdmittedRotoCutout(project: EditProject, sourceClip: TimelineClip, source: MediaAsset, result: RotoCutoutClipResultV1,
  ids: { assetId: string; clipId: string; trackId: string; linkGroupId: string; assetName: string; trackName: string }) {
  if (result.schema !== "editkin.roto-cutout-clip/v1" || result.qualityState !== "diagnostic" || result.subjectConfirmation !== "required" || result.benchmarkAccepted !== false
    || result.fps !== project.fps || Math.abs(sourceClip.duration - result.duration) > 1e-6
    || Math.abs(sourceClip.sourceStart - result.matteIdentity.sourceStart) > 1e-6
    || result.matteIdentity.sourceSha256 !== result.sourceSha256 || result.matteIdentity.cutoutSha256 !== result.clip.sha256
    || result.matteIdentity.alphaSha256 !== result.alphaSha256 || result.matteIdentity.analysisSha256 !== result.analysisSha256
    || result.width !== result.matteIdentity.width || result.height !== result.matteIdentity.height || result.fps !== result.matteIdentity.fps
    || result.frameCount !== result.matteIdentity.frameCount || Math.abs(result.duration - result.frameCount / result.fps) > 1e-7
    || result.alphaMode !== "straight" || result.codec !== "ffv1" || result.pixelFormat !== "gbrap16le"
    || localPathKey(source.uri) !== localPathKey(result.sourcePath)
    || (source.derivatives?.sourceSha256 !== undefined && source.derivatives.sourceSha256 !== result.sourceSha256)) throw Error("ROTO_CUTOUT_SOURCE_WINDOW_OR_RESULT_CHANGED");
  const asset: MediaAsset = { id: ids.assetId, name: ids.assetName, kind: "video", uri: result.clip.path, duration: result.duration,
    width: result.width, height: result.height, displayAspectRatio: result.width / result.height, alphaMode: "straight",
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "gbr", range: "pc" },
    ...(source.license === undefined ? {} : { license: source.license }), ...(source.rightsBasis === undefined ? {} : { rightsBasis: source.rightsBasis }),
    ...(source.redistributable === undefined ? {} : { redistributable: source.redistributable }),
    provenance: `editkin.roto-cutout-clip/v1:${result.analysisSha256}` };
  const clip: TimelineClip = { ...structuredClone(sourceClip), id: ids.clipId, assetId: ids.assetId, trackId: ids.trackId,
    sourceStart: 0, volume: 0, masks: sourceClip.masks?.filter(m => m.kind !== "subject").map(m => structuredClone(m)),
    keyframes: sourceClip.keyframes.map((k, i) => ({ ...structuredClone(k), id: `${ids.clipId}:key:${i}` })) };
  const command: EditorCommand = { type: "batch", commands: [
    { type: "import_asset", asset }, { type: "add_track", track: { id: ids.trackId, name: ids.trackName, kind: "video", locked: false, muted: true, hidden: false, clips: [] } },
    { type: "add_clip", clip }, { type: "update_clip_transform", clipId: sourceClip.id, patch: { opacity: 0 } },
    ...sourceClip.keyframes.map(k => ({ type: "update_keyframe" as const, clipId: sourceClip.id, keyframeId: k.id, patch: { transform: { ...k.transform, opacity: 0 } } })),
    { type: "set_clip_links", clipIds: [sourceClip.id, clip.id], groupId: sourceClip.linkGroupId ?? ids.linkGroupId },
  ] };
  applyCommand(project, command); return { command, asset, clipId: clip.id, retainedSourceClipId: sourceClip.id };
}
