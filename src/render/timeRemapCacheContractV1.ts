import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import { clipTimeRemapSchemaV1, clipTimeRemapClockV1, clipTimeRemapRateV1 } from "../domain/clipTimeRemapV1";
import type { EditProject, TimelineClip, MediaAsset } from "../domain/types";

export const TIME_REMAP_CACHE_POLICY_V1 = "lossless-source-clock-cache-rgba8/v1" as const;
export const TIME_REMAP_CACHE_MAX_BYTES_V1 = 2 * 1024 ** 3;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().safe().nonnegative();
export const timeRemapFingerprintSchemaV1 = z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/),
  size: z.string().regex(/^\d+$/), mtimeNs: z.string().regex(/^\d+$/), ctimeNs: z.string().regex(/^\d+$/) });
export type TimeRemapFingerprintV1 = z.infer<typeof timeRemapFingerprintSchemaV1>;
export const timeRemapCacheKeySchemaV1 = z.strictObject({ policy: z.literal(TIME_REMAP_CACHE_POLICY_V1), sourceSha256: hash,
  sourceStart: z.number().finite().nonnegative(), duration: z.number().finite().positive(), speed: z.number().finite().min(0).max(64).nullable(),
  timeRemap: clipTimeRemapSchemaV1.nullable(), fps: z.strictObject({ numerator: integer.positive(), denominator: integer.positive() }),
  width: integer.positive().max(8192), height: integer.positive().max(8192), audio: z.enum(["muted", "constant-pcm", "shared-phase-pcm", "absent"]),
  implementationSha256: hash, ffmpegSha256: hash, ffprobeSha256: hash });
export type TimeRemapCacheKeyV1 = z.infer<typeof timeRemapCacheKeySchemaV1>;
export const timeRemapCacheReceiptSchemaV1 = z.strictObject({ schema: z.literal("editkin.time-remap-cache/v1"), key: hash,
  policy: z.literal(TIME_REMAP_CACHE_POLICY_V1), keyInputs: timeRemapCacheKeySchemaV1,
  qualityState: z.literal("source-clock-diagnostic"), ordinaryEditorPreviewReady: z.literal(false), wholePixelQualityCertified: z.literal(false), audioQualityCertified: z.literal(false),
  sourceFingerprint: timeRemapFingerprintSchemaV1, width: integer.positive(), height: integer.positive(), fps: z.number().finite().positive(),
  frames: integer.positive(), duration: z.number().finite().positive(),
  media: z.strictObject({ name: z.literal("clip.mkv"), sha256: hash, bytes: integer.positive(), dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }),
  pixels: z.strictObject({ sha256: hash, bytes: integer.positive(), frames: integer.positive() }),
  audio: z.enum(["explicitly_muted", "absent", "pitch_preserving_constant_pcm_f32", "shared_phase_constant_pcm_f32_candidate"]),
  producer: z.strictObject({ schema: z.literal("editkin.source-clock-render/v1"), sampledPixelSha256: hash, outputPixelSha256: hash,
    originalAudio: z.string(), rawMoviePixelsStaged: z.literal(0), sceneLinearHdrReady: z.literal(false) }),
  createdAt: z.iso.datetime(), digest: hash });
export type TimeRemapCacheReceiptV1 = z.infer<typeof timeRemapCacheReceiptSchemaV1>;
export const timeRemapCacheDigestV1 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export function timeRemapCacheKeyV1(input: TimeRemapCacheKeyV1) { return timeRemapCacheDigestV1(timeRemapCacheKeySchemaV1.parse(input)); }
export function parseTimeRemapCacheReceiptV1(value: unknown) {
  const r = timeRemapCacheReceiptSchemaV1.parse(value), { digest, ...body } = r;
  const expectedAudio = r.keyInputs.audio === "absent" ? "absent" : r.keyInputs.audio === "muted" ? "explicitly_muted"
    : r.keyInputs.audio === "shared-phase-pcm" ? "shared_phase_constant_pcm_f32_candidate" : "pitch_preserving_constant_pcm_f32";
  if (digest !== timeRemapCacheDigestV1(body) || r.key !== timeRemapCacheKeyV1(r.keyInputs)
    || r.width !== r.keyInputs.width || r.height !== r.keyInputs.height || r.fps !== r.keyInputs.fps.numerator / r.keyInputs.fps.denominator
    || r.frames !== Math.round(r.duration * r.fps) || r.duration !== r.keyInputs.duration
    || r.pixels.frames !== r.frames || r.pixels.bytes !== r.frames * r.width * r.height * 4
    || r.pixels.sha256 !== r.producer.sampledPixelSha256 || r.pixels.sha256 !== r.producer.outputPixelSha256
    || r.audio !== r.producer.originalAudio || r.audio !== expectedAudio
    // A muted bake carries no sound at all, so it is consistent for any speed (freeze, a muted curve, a silent clip, or a
    // constant speed outside the pitch-preserving range); sound may only follow a constant 0.5–4x speed.
    || (["constant-pcm", "shared-phase-pcm"].includes(r.keyInputs.audio) && (r.keyInputs.timeRemap !== null || (r.keyInputs.speed ?? 1) < .5 || (r.keyInputs.speed ?? 1) > 4))) throw Error("TIME_REMAP_CACHE_RECEIPT_INCONSISTENT");
  return r;
}

/** Source-only cache stage: decorations stay on the original/render clone, never in its source bake. */
export function admitTimeRemapCacheClipV1(project: EditProject, clip: TimelineClip, asset: MediaAsset) {
  if (project.colorManagement?.mode === "aces2" || asset.kind !== "video" || asset.compositionId || asset.imageSequence || asset.clipRetime
    || (asset.color?.interpretation !== undefined && !["auto", "rec709"].includes(asset.color.interpretation))
    || ["primaries", "transfer"].some(k => asset.color?.[k as "primaries" | "transfer"] !== undefined && asset.color[k as "primaries" | "transfer"] !== "bt709")) {
    throw Error("TIME_REMAP_CACHE_REQUIRES_LINEAR_MEDIA_REC709_RGB8_SOURCE");
  }
  const clock = clipTimeRemapClockV1(project, clip, asset);
  if (!clock || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width! < 1 || asset.height! < 1
    || asset.width! * asset.height! * 8 > 64 * 1024 ** 2 || Math.abs(clock.totalOutputFrames / project.fps - clip.duration) > 1e-9) throw Error("TIME_REMAP_CACHE_CLOCK_OR_SOURCE_RASTER_INVALID");
  return { clock, width: asset.width!, height: asset.height!, fps: clipTimeRemapRateV1(project.fps) };
}
