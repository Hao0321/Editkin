import type { EditProject } from "../domain/types";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";

export const SOURCE_PRESERVING_POLICY_V1 = "preserve_original_container" as const;
function refuse(reason: string): never { throw Error(`SOURCE_PRESERVING_${reason}`); }
function keys(value: object, allowed: readonly string[], label: string) {
  const known = new Set(allowed);
  if (Object.entries(value).some(([name, field]) => field !== undefined && !known.has(name))) refuse(`${label}_UNKNOWN_FIELD`);
}
function empty(value: unknown) { return value === undefined || (Array.isArray(value) && value.length === 0); }
function neutral(value: object, defaults: object, label: string) {
  keys(value, Object.keys(defaults), label);
  for (const [name, expected] of Object.entries(defaults)) {
    const actual = (value as Record<string, unknown>)[name];
    if (canonicalJson(actual === undefined ? expected : actual) !== canonicalJson(expected)) refuse(`${label}_MODIFIED`);
  }
}
/** Explicit policy: no normal renderer colour conversion, normalization, resize or FPS conversion. */
export function admitSourcePreservingProjectV1(project: EditProject, policy: typeof SOURCE_PRESERVING_POLICY_V1) {
  if (policy !== SOURCE_PRESERVING_POLICY_V1) refuse("EXPLICIT_POLICY_REQUIRED");
  keys(project, ["schemaVersion", "revision", "id", "name", "width", "height", "fps", "editorialProfile", "colorManagement",
    "assets", "compositions", "tracks", "captions", "captionStyle", "motionTracks", "motionGraphics", "director", "updatedAt",
    "aestheticSystem", "scene25d", "scene3d", "particleSimulation", "motionScenes", "timelineTransitions", "templateApplication", "referenceMotionInstances"], "PROJECT");
  if ((project.schemaVersion !== 9 && project.schemaVersion !== 10 && project.schemaVersion !== 11) || !Number.isSafeInteger(project.revision) || project.revision < 0
    || !project.id || !Number.isSafeInteger(project.width) || !Number.isSafeInteger(project.height)
    || project.width < 1 || project.height < 1 || !Number.isFinite(project.fps) || project.fps <= 0) refuse("PROJECT_INVALID");
  if (!empty(project.compositions) || !empty(project.captions) || !empty(project.motionTracks) || !empty(project.motionGraphics)
    || !empty(project.motionScenes) || !empty(project.timelineTransitions) || !empty(project.referenceMotionInstances)
    || project.scene25d !== undefined || project.scene3d !== undefined || project.particleSimulation !== undefined
    || project.templateApplication !== undefined) refuse("RENDERING_OPERATIONS_PRESENT");
  if (project.colorManagement === null) refuse("COLOR_MANAGEMENT_INVALID");
  neutral(project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT, DEFAULT_COLOR_MANAGEMENT, "COLOR_MANAGEMENT");
  if (!Array.isArray(project.tracks) || !Array.isArray(project.assets)) refuse("PROJECT_INVALID");
  const clips = project.tracks.flatMap(track => {
    keys(track, ["id", "name", "kind", "locked", "muted", "hidden", "clips"], "TRACK");
    if (!Array.isArray(track.clips)) refuse("TRACK_INVALID");
    return track.clips.map(clip => ({ track, clip }));
  });
  if (clips.length !== 1) refuse("SINGLE_WHOLE_SOURCE_REQUIRED");
  const { track, clip } = clips[0];
  if (track.kind !== "video" || track.hidden || track.muted || clip.trackId !== track.id) refuse("ACTIVE_VIDEO_TRACK_REQUIRED");
  keys(clip, ["id", "assetId", "trackId", "timelineStart", "sourceStart", "duration", "volume", "transform", "color", "keyframes", "layer", "expressions", "linkGroupId"], "CLIP");
  if (clip.timelineStart !== 0 || clip.sourceStart !== 0 || clip.volume !== 1 || !empty(clip.keyframes)
    || (clip.expressions && Object.keys(clip.expressions).length)) refuse("CLIP_MODIFIED");
  if (!clip.transform || !clip.color) refuse("CLIP_INVALID");
  neutral(clip.transform, { ...DEFAULT_TRANSFORM, flipX: false, flipY: false }, "TRANSFORM");
  neutral(clip.color, DEFAULT_COLOR, "COLOR");
  if (clip.layer) neutral(clip.layer, { enabled: true, blendMode: "normal", role: "content" }, "LAYER");
  const asset = project.assets.find(item => item.id === clip.assetId);
  if (!asset || asset.kind !== "video" || asset.compositionId || asset.imageSequence || asset.clipRetime !== undefined || asset.role === "background-music"
    || !asset.uri || !Number.isFinite(asset.duration) || asset.duration <= 0 || !Number.isFinite(clip.duration)
    || Math.abs(clip.duration - asset.duration) > 16 * Number.EPSILON * Math.max(1, asset.duration)) refuse("SINGLE_WHOLE_SOURCE_REQUIRED");
  keys(asset, ["id", "name", "kind", "uri", "duration", "width", "height", "displayAspectRatio", "role", "bpm", "license", "provenance",
    "redistributable", "rightsBasis", "distributionScope", "alphaMode", "color", "derivatives", "compositionId", "imageSequence", "clipRetime"], "ASSET");
  if (asset.color?.interpretation !== undefined && !["auto", "rec709"].includes(asset.color.interpretation)) refuse("SOURCE_COLOR_INTERPRETATION_MODIFIED");
  for (const name of ["primaries", "transfer", "matrix"] as const) if (asset.color?.[name] !== undefined && asset.color[name] !== "bt709") refuse("SOURCE_COLOR_INTERPRETATION_MODIFIED");
  if (asset.color?.range !== undefined && !["tv", "pc"].includes(asset.color.range)) refuse("SOURCE_COLOR_INTERPRETATION_MODIFIED");
  return { schema: "editkin.source-preserving-admission/v1" as const, projectId: project.id, projectRevision: project.revision,
    clipId: clip.id, assetId: asset.id, sourceUri: asset.uri, expectedDuration: asset.duration,
    width: project.width, height: project.height, sourceRange: asset.color?.range, policy, audioPolicy: "original_streams_without_normalization" as const,
    videoClockPolicy: "original_pts_dts_and_rate" as const, colourPolicy: "original_rec709_metadata" as const };
}
const positive = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") refuse("MEDIA_METADATA_UNKNOWN");
  const number = Number(value); if (!Number.isFinite(number) || number <= 0) refuse("MEDIA_METADATA_UNKNOWN"); return number;
};
function rational(value: unknown) {
  if (typeof value !== "string") refuse("MEDIA_TIMEBASE_UNKNOWN");
  const parts = value.split("/").map(Number);
  if (parts.length !== 2 || !parts.every(v => Number.isSafeInteger(v) && v > 0)) refuse("MEDIA_TIMEBASE_UNKNOWN");
  return { numerator: parts[0], denominator: parts[1] };
}
/** Metadata is read from the exact copied candidate, never from an unpinned source pathname. */
export function admitSourcePreservingMp4V1(value: unknown, admission: ReturnType<typeof admitSourcePreservingProjectV1>) {
  const data = value as { streams?: Record<string, any>[]; format?: Record<string, any> };
  if (!data || !Array.isArray(data.streams) || !data.format || !String(data.format.format_name).split(",").includes("mp4")
    || !["isom", "iso2", "mp41", "mp42", "avc1", "dash", "M4V "].includes(data.format.tags?.major_brand)) refuse("MP4_CONTAINER_REQUIRED");
  const video = data.streams.filter(s => s.codec_type === "video"), audio = data.streams.filter(s => s.codec_type === "audio");
  if (video.length !== 1 || audio.length > 4 || video.length + audio.length !== data.streams.length) refuse("MEDIA_STREAMS_UNSUPPORTED");
  const v = video[0];
  if (!["h264", "hevc"].includes(v.codec_name) || v.disposition?.attached_pic || (v.side_data_list?.length ?? 0)
    || v.tags?.rotate || !["1:1", "1/1"].includes(v.sample_aspect_ratio) || v.width !== admission.width || v.height !== admission.height) refuse("MEDIA_GEOMETRY_OR_CODEC_UNSUPPORTED");
  if (v.color_primaries !== "bt709" || v.color_transfer !== "bt709" || v.color_space !== "bt709"
    || !["tv", "pc"].includes(v.color_range) || (admission.sourceRange !== undefined && admission.sourceRange !== v.color_range)) refuse("MEDIA_COLOR_UNKNOWN_OR_CHANGED");
  const duration = positive(data.format.duration), videoDuration = positive(v.duration), rate = rational(v.avg_frame_rate), timebase = rational(v.time_base);
  if (Math.abs(duration - admission.expectedDuration) > 1e-6
    || duration - videoDuration > rate.denominator / rate.numerator + 1e-6) refuse("MEDIA_DURATION_OR_VIDEO_EOF_MISMATCH");
  for (const stream of audio) {
    if (!["aac", "alac", "mp3", "ac3", "eac3"].includes(stream.codec_name) || !Number.isSafeInteger(stream.channels)
      || stream.channels < 1 || stream.channels > 32) refuse("MEDIA_AUDIO_UNSUPPORTED");
    positive(stream.sample_rate); rational(stream.time_base);
  }
  return { duration, width: v.width as number, height: v.height as number, sourceVideoCodec: String(v.codec_name), sourceFrameRate: rate,
    sourceTimebase: timebase, audioStreams: audio.map(s => ({ codec: String(s.codec_name), sampleRate: Number(s.sample_rate), channels: Number(s.channels), layout: s.channel_layout ?? null })),
    fullContainerMetadataPreserved: true, sourceDecodeVerificationRequired: true };
}
