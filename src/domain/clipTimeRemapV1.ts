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
