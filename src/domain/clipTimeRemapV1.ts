import * as z from "zod/v4";
import { compileTimeRemapClockV1, type RationalFrameRateV1 } from "./timeRemapClockV1";
import type { EditProject, TimelineClip, MediaAsset } from "./types";
import { EditGraphError } from "./editGraphError";

const point = z.strictObject({ time: z.number().finite().min(0).max(1), speed: z.number().finite().min(0).max(64) });
/** Curve speed is a multiplier of clip.speed (omission=1). Timeline position/duration remain authored. */
export const clipTimeRemapSchemaV1 = z.strictObject({
  schema: z.literal("editkin.clip-time-remap/v1"), direction: z.enum(["forward", "reverse"]),
  interpolation: z.literal("frame_blending"), audioMode: z.enum(["mute", "follow_speed"]),
  segments: z.array(z.strictObject({ from: point, control1: point, control2: point, to: point })).min(1).max(256),
});
export type ClipTimeRemapV1 = z.infer<typeof clipTimeRemapSchemaV1>;
export const clipSpeedSchemaV1 = z.number().finite().min(0).max(64).refine(v => v === 0 || v >= 1 / 64, "CLIP_SPEED_POSITIVE_MINIMUM_1_OVER_64");
export const clipTimeRemapExpectedSchemaV1 = z.strictObject({ assetId: z.string().min(1).max(160), sourceStart: z.number().finite().nonnegative(),
  duration: z.number().finite().positive(), settings: z.strictObject({ speed: clipSpeedSchemaV1.nullable(), timeRemap: clipTimeRemapSchemaV1.nullable() }) });
export type ClipTimeRemapExpectedV1 = z.infer<typeof clipTimeRemapExpectedSchemaV1>;
export function hasAuthoredClipTimeRemapV1(clip: Pick<TimelineClip, "speed" | "timeRemap">) { return clip.speed !== undefined || clip.timeRemap !== undefined; }
export function clipTimeRemapExpectedV1(clip: TimelineClip): ClipTimeRemapExpectedV1 {
  return { assetId: clip.assetId, sourceStart: clip.sourceStart, duration: clip.duration,
    settings: structuredClone({ speed: clip.speed ?? null, timeRemap: clip.timeRemap ?? null }) };
}

/** No NTSC guess for 29.97: find a bounded rational that actually represents the authored project fps. */
export function clipTimeRemapRateV1(fps: number): RationalFrameRateV1 {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new EditGraphError("CLIP_TIME_REMAP_RATE_INVALID");
  let x = fps, n0 = 0, n1 = 1, d0 = 1, d1 = 0;
  for (let i = 0; i < 48; i++) {
    const whole = Math.floor(x), n = whole * n1 + n0, d = whole * d1 + d0;
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n < 0 || d < 1 || n > 1_000_000 || d > 1_000_000) break;
    if (n >= 1 && Math.abs(n / d - fps) <= 16 * Number.EPSILON * Math.max(1, fps)) return { numerator: n, denominator: d };
    n0 = n1; n1 = n; d0 = d1; d1 = d; const fraction = x - whole;
    if (!fraction) break; x = 1 / fraction;
  }
  throw new EditGraphError("CLIP_TIME_REMAP_EXACT_RATE_UNREPRESENTABLE");
}

export function clipTimeRemapClockV1(project: Pick<EditProject, "fps" | "timelineTransitions" | "motionTracks">, clip: TimelineClip, asset: MediaAsset) {
  if (!hasAuthoredClipTimeRemapV1(clip)) return undefined;
  const base = clip.speed === undefined ? 1 : clipSpeedSchemaV1.parse(clip.speed), setting = clip.timeRemap === undefined ? undefined : clipTimeRemapSchemaV1.parse(clip.timeRemap);
  if (!["video", "audio"].includes(asset.kind) || asset.compositionId || asset.imageSequence || asset.clipRetime) throw new EditGraphError("CLIP_TIME_REMAP_ORIGINAL_LINEAR_MEDIA_REQUIRED");
  if (clip.linkGroupId || project.motionTracks.some(t => t.clipId === clip.id) || clip.masks?.some(m => m.trackId || m.matteSequence || m.keyframes.length > 0)
    || project.timelineTransitions?.some(t => t.fromClipId === clip.id || t.toClipId === clip.id)) throw new EditGraphError("CLIP_TIME_REMAP_TEMPORAL_BINDING_CONSUMER_REQUIRED");
  const raw = setting?.segments ?? [{ from: { time: 0, speed: 1 }, control1: { time: 1 / 3, speed: 1 }, control2: { time: 2 / 3, speed: 1 }, to: { time: 1, speed: 1 } }];
  const segments = raw.map(s => ({ from: { ...s.from, speed: s.from.speed * base }, control1: { ...s.control1, speed: s.control1.speed * base },
    control2: { ...s.control2, speed: s.control2.speed * base }, to: { ...s.to, speed: s.to.speed * base } }));
  const clock = compileTimeRemapClockV1({ timelineDurationSeconds: clip.duration, sourceStartSeconds: clip.sourceStart,
    sourceDurationSeconds: asset.duration, outputRate: clipTimeRemapRateV1(project.fps), direction: setting?.direction ?? "forward", segments });
  return clock;
}

/** Largest source raster the export's source-clock cache accepts (RGBA8 frame working set of 64 MiB at 8 bytes/pixel). */
export const CLIP_TIME_REMAP_MAX_SOURCE_PIXELS_V1 = 8 * 1024 ** 2;
/** Constant speeds whose sound keeps its pitch (shared-phase vocoder); outside it the sound is muted, never left at 1x. */
export const CLIP_SPEED_PITCH_PRESERVING_RANGE_V1 = Object.freeze({ min: 0.5, max: 4 });
export type ClipTimeRemapMuteReasonV1 = "freeze" | "curve_audio_muted" | "clip_volume_zero" | "speed_outside_pitch_range";

/** Why the exported clip carries no sound of its own, or undefined when its sound follows the speed with pitch kept. */
export function clipTimeRemapMuteReasonV1(clip: Pick<TimelineClip, "speed" | "timeRemap" | "volume">): ClipTimeRemapMuteReasonV1 | undefined {
  if (clip.speed === 0) return "freeze";
  if (clip.timeRemap?.audioMode === "mute") return "curve_audio_muted";
  if (clip.volume === 0) return "clip_volume_zero";
  const speed = clip.speed ?? 1;
  if (!clip.timeRemap && (speed < CLIP_SPEED_PITCH_PRESERVING_RANGE_V1.min || speed > CLIP_SPEED_PITCH_PRESERVING_RANGE_V1.max)) return "speed_outside_pitch_range";
  return undefined;
}

export interface ClipTimeRemapRenderRefusalV1 { code: string; message: string }

/**
 * Whether the export renders this clip's authored speed or speed curve (render/timeRemapExportV1 bakes it through the
 * source-clock cache); undefined when it does. The same answer gates set_clip_speed / set_clip_time_remap and
 * validate_project. What only the real file can tell (rotation metadata, pixel format, several audio streams) is checked
 * again at export, which then refuses with its own named reason.
 */
export function clipTimeRemapRenderRefusalV1(project: Pick<EditProject, "fps" | "timelineTransitions" | "motionTracks" | "assets" | "colorManagement">,
  clip: TimelineClip, options: { nested?: boolean } = {}): ClipTimeRemapRenderRefusalV1 | undefined {
  if (!hasAuthoredClipTimeRemapV1(clip)) return undefined;
  const refuse = (code: string, message: string) => ({ code, message });
  if (options.nested) return refuse("CLIP_SPEED_NESTED_UNSUPPORTED", "預合成裡的片段變速還不能輸出；請在主時間軸上變速");
  if (project.colorManagement?.mode === "aces2") return refuse("CLIP_SPEED_ACES2_UNSUPPORTED", "ACES 2 色彩管理的專案還不能輸出變速片段");
  const asset = project.assets.find(item => item.id === clip.assetId);
  if (!asset || asset.kind !== "video" || asset.compositionId || asset.imageSequence || asset.clipRetime) {
    return refuse("CLIP_SPEED_ORIGINAL_VIDEO_REQUIRED", "變速只支援一般影片原檔（不含聲音檔、圖片、預合成、影格序列或已烘焙的速度衍生檔）");
  }
  const color = asset.color;
  if ((color?.interpretation !== undefined && !["auto", "rec709"].includes(color.interpretation))
    || [color?.primaries, color?.transfer].some(value => value !== undefined && value !== "bt709")) {
    return refuse("CLIP_SPEED_REC709_SDR_SOURCE_REQUIRED", "變速目前只支援 Rec.709 SDR 影片（HDR／Log 素材還不行）");
  }
  if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width! < 1 || asset.height! < 1
    || asset.width! * asset.height! > CLIP_TIME_REMAP_MAX_SOURCE_PIXELS_V1) {
    return refuse("CLIP_SPEED_SOURCE_RASTER_UNSUPPORTED", "變速需要已知且不超過約 4K（8,388,608 像素）的影片尺寸");
  }
  if (asset.displayAspectRatio !== undefined && Math.abs(asset.displayAspectRatio - asset.width! / asset.height!) > 0.01 * asset.width! / asset.height!) {
    return refuse("CLIP_SPEED_ROTATED_OR_ANAMORPHIC_SOURCE_UNSUPPORTED", "旋轉或非方形像素的影片還不能變速輸出");
  }
  if (clip.timeRemap?.audioMode === "follow_speed" && clip.volume !== 0) {
    return refuse("CLIP_TIME_REMAP_FOLLOW_AUDIO_UNAVAILABLE", "變速曲線的聲音還不能跟著變速；請把曲線的 audioMode 設為 mute，或改用固定速度");
  }
  let clock: ReturnType<typeof clipTimeRemapClockV1>;
  try { clock = clipTimeRemapClockV1(project, clip, asset); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); return refuse(message.split(/[:：]/)[0] || "CLIP_TIME_REMAP_INVALID", message); }
  if (!clock || Math.abs(clock.totalOutputFrames / project.fps - clip.duration) > 1e-9) {
    return refuse("CLIP_SPEED_DURATION_NOT_FRAME_ALIGNED", "變速片段的長度需要對齊專案影格");
  }
  return undefined;
}

export function clipTimeRemapAudioPlanV1(clip: TimelineClip) {
  if (!hasAuthoredClipTimeRemapV1(clip)) return { mode: "legacy" as const, atempo: [] as number[] };
  if (clip.speed === 0 || clip.timeRemap?.audioMode === "mute") return { mode: "mute" as const, atempo: [] as number[] };
  if (clip.timeRemap) return { mode: "follow_speed" as const, atempo: [] as number[], sharedClockConsumerRequired: true };
  const speed = clipSpeedSchemaV1.parse(clip.speed); let rest = speed; const atempo: number[] = [];
  while (rest > 2) { atempo.push(2); rest /= 2; } while (rest < .5) { atempo.push(.5); rest /= .5; }
  if (rest !== 1 || !atempo.length) atempo.push(rest);
  return { mode: "pitch_preserving_constant" as const, atempo };
}

/** Consumers must explicitly use the shared clock. An old sourceStart+time path must never silently ignore it. */
export function assertLegacyTimeRemapRouteV1(project: Pick<EditProject, "tracks" | "compositions">) {
  if ([project.tracks, ...project.compositions.map(c => c.tracks)].some(tracks => tracks.some(t => t.clips.some(hasAuthoredClipTimeRemapV1)))) {
    throw new EditGraphError("CLIP_TIME_REMAP_SHARED_FRAME_CONSUMER_REQUIRED");
  }
}
