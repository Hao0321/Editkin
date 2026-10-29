import * as z from "zod/v4";
import type { MediaProbe } from "../render/ffmpegContracts";

export const ROTO_HOLDOUT_CATEGORIES_V1 = ["hair-fur", "thin-detail", "motion-blur", "similar-distractor", "full-occlusion",
  "reappearance", "scene-cut", "multi-object", "transparent-edge", "long-duration"] as const;
export const ROTO_HOLDOUT_MAX_FRAMES_V1 = 4096;
export const ROTO_HOLDOUT_MAX_PIXELS_V1 = 2_073_600;
export const ROTO_HOLDOUT_MAX_BYTES_V1 = 256 * 1024 * 1024;
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).refine(value => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const localPath = z.string().min(1).max(4096);
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const categories = z.array(z.enum(ROTO_HOLDOUT_CATEGORIES_V1)).min(1).max(10).refine(values => new Set(values).size === values.length);
const sourceIdentity = z.strictObject({ path: localPath, sha256: digest, bytes: z.number().int().positive() });
const candidateArtifact = sourceIdentity.extend({ id });
const candidate = z.strictObject({ engine: z.string().trim().min(1).max(160), artifacts: z.array(candidateArtifact).min(1).max(64), implementationSha256: digest });
const candidateRequest = z.strictObject({ engine: z.string().trim().min(1).max(160),
  artifacts: z.array(z.strictObject({ id, path: localPath, sha256: digest })).min(1).max(64) });
const clipRequest = z.strictObject({ id, sourcePath: localPath, sourceSha256: digest,
  sourceStart: z.number().finite().min(0).max(604800), duration: z.number().finite().positive().max(120),
  analysisFps: z.number().int().min(1).max(12).default(12), categories });
const requestSchema = z.strictObject({ schema: z.literal("editkin.roto-holdout-label-request/v1"), datasetId: id,
  sampleMode: z.enum(["five-points", "contiguous"]).default("five-points"), maxDimension: z.number().int().min(16).max(1920).default(480),
  candidate: candidateRequest, clips: z.array(clipRequest).min(1).max(10) });
export type RotoHoldoutLabelRequestV1 = z.infer<typeof requestSchema>;
export interface RotoHoldoutClipPlanV1 {
  id: string; width: number; height: number; analysisFps: number; frameCount: number; selectedFrames: number[];
  sourceStart: number; duration: number; categories: RotoHoldoutLabelRequestV1["clips"][number]["categories"]; displayRotationDegrees: number; sourceSampleAspectRatio: number;
  videoStreamIndex: number;
}
const sample = z.strictObject({ frame: z.number().int().nonnegative(), timeSeconds: z.number().finite().nonnegative(),
  framePath: z.string(), frameSha256: digest, maskPath: z.string(), blankMaskSha256: digest });
const clip = z.strictObject({ id, width: z.number().int().min(2).max(1920), height: z.number().int().min(2).max(1920),
  analysisFps: z.number().int().min(1).max(12), frameCount: z.number().int().positive().max(1440), sourceStart: z.number().finite().nonnegative(),
  duration: z.number().finite().positive().max(120), categories, displayRotationDegrees: z.number().finite(),
  sourceSampleAspectRatio: z.number().finite().positive(), videoStreamIndex: z.number().int().min(0).max(1024),
  source: sourceIdentity, samples: z.array(sample).min(1).max(1440) });
const kitSchema = z.strictObject({ schema: z.literal("editkin.roto-holdout-label-kit/v1"), datasetId: id, frozenAt: utc,
  status: z.literal("AWAITING_HUMAN_LABELS"), sampleMode: z.enum(["five-points", "contiguous"]), candidate,
  samplingConvention: z.literal("ffmpeg-autorotate-fps-even-display-fit/v1"),
  sampleTimeKind: z.literal("analysis-grid-not-decoder-pts"), clips: z.array(clip).min(1).max(10) });
export type RotoHoldoutKitV1 = z.infer<typeof kitSchema>;
const point = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) });
const tracking = z.discriminatedUnion("visibility", [z.strictObject({ visibility: z.literal("visible"), corners: z.tuple([point, point, point, point]) }),
  z.strictObject({ visibility: z.literal("lost"), corners: z.null() })]).refine(value => {
  if (value.visibility === "lost") return true;
  const signs = value.corners.map((a, i, all) => { const b = all[(i + 1) % 4], c = all[(i + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); });
  return signs.every(v => v > 1e-8) || signs.every(v => v < -1e-8);
});
export const rotoHoldoutTrackingSchemaV1 = tracking;
const reviewSchema = z.strictObject({ schema: z.literal("editkin.roto-holdout-human-review/v1"), kitSha256: digest,
  reviewerIdHash: z.string().regex(/^[a-f0-9]{16,128}$/), reviewedAt: utc,
  entries: z.array(z.strictObject({ clipId: id, frame: z.number().int().nonnegative(), approved: z.literal(true),
    maskSha256: digest, allBackgroundConfirmed: z.boolean(), tracking: tracking.nullable() })).min(1).max(ROTO_HOLDOUT_MAX_FRAMES_V1) });
export type RotoHoldoutReviewV1 = z.infer<typeof reviewSchema>;
const refuse = (reason: string): never => { throw Error("ROTO_HOLDOUT_INVALID: " + reason); };
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) refuse("Duplicate " + label); }

export function parseRotoHoldoutRequestV1(input: unknown): RotoHoldoutLabelRequestV1 {
  const value = requestSchema.parse(input);
  unique(value.clips.map(c => c.id), "clip ID"); unique(value.candidate.artifacts.map(a => a.id), "candidate artifact ID");
  unique(value.clips.map(c => c.sourceSha256), "source SHA256");
  return value;
}

/** Labels refer to this declared analysis grid, not to invented source decoder PTS. */
export function planRotoHoldoutClipV1(request: RotoHoldoutLabelRequestV1, clipIndex: number, probe: MediaProbe & { videoStreamIndex?: number }): RotoHoldoutClipPlanV1 {
  const c = request.clips[clipIndex]; if (!c) refuse("Unknown clip index");
  if (!probe.hasVideo || !Number.isFinite(probe.duration) || c.sourceStart + c.duration > probe.duration + 1e-6) refuse("Source interval exceeds video");
  const w = probe.encodedWidth ?? probe.width, h = probe.encodedHeight ?? probe.height;
  if (![w, h].every(v => Number.isSafeInteger(v) && v! >= 2 && v! <= 32768)) refuse("Invalid source raster");
  const rotation = probe.displayRotationDegrees ?? 0, sar = probe.sampleAspectRatio ?? 1;
  const videoStreamIndex = probe.videoStreamIndex ?? 0;
  if (!Number.isSafeInteger(videoStreamIndex) || videoStreamIndex < 0 || videoStreamIndex > 1024) refuse("Invalid video stream");
  if (!Number.isFinite(rotation) || rotation % 90 !== 0 || !Number.isFinite(sar) || sar <= 0 || sar > 64) refuse("Unsupported display geometry");
  const rotated = Math.abs(rotation / 90) % 2 === 1, ratio = rotated ? h! / (w! * sar) : w! * sar / h!;
  if (ratio < 1 / 8 || ratio > 8) refuse("Unsafe display aspect ratio");
  const factor = Math.min(1, request.maxDimension / Math.max(rotated ? h! : w! * sar, rotated ? w! * sar : h!));
  const width = Math.max(2, Math.floor((rotated ? h! : w! * sar) * factor / 2) * 2);
  const height = Math.max(2, Math.floor((rotated ? w! * sar : h!) * factor / 2) * 2);
  if (width * height > ROTO_HOLDOUT_MAX_PIXELS_V1) refuse("Analysis pixel budget exceeded");
  const frameCount = Math.floor(c.duration * c.analysisFps + 1e-8);
  if (frameCount < (request.sampleMode === "five-points" ? 5 : 1) || frameCount > 1440) refuse("Invalid analysis frame count");
  const selectedFrames = request.sampleMode === "contiguous" ? Array.from({ length: frameCount }, (_, n) => n)
    : [0, 1, 2, 3, 4].map(n => Math.round((frameCount - 1) * n / 4));
  return { id: c.id, width, height, analysisFps: c.analysisFps, frameCount, selectedFrames, sourceStart: c.sourceStart,
    duration: c.duration, categories: [...c.categories], displayRotationDegrees: rotation, sourceSampleAspectRatio: sar, videoStreamIndex };
}

export function rotoHoldoutFramePathV1(clipId: string, frame: number, kind: "frames" | "labels"): string {
  id.parse(clipId); if (!Number.isSafeInteger(frame) || frame < 0 || frame >= 1440) refuse("Invalid frame index");
  return `clips/${clipId}/${kind}/${String(frame).padStart(6, "0")}.png`;
}

export function parseRotoHoldoutKitV1(input: unknown): RotoHoldoutKitV1 {
  const kit = kitSchema.parse(input); let total = 0;
  unique(kit.clips.map(c => c.id), "clip ID"); unique(kit.clips.map(c => c.source.sha256), "source SHA256");
  unique(kit.candidate.artifacts.map(a => a.id), "candidate artifact ID");
  for (const c of kit.clips) {
    if (c.width * c.height > ROTO_HOLDOUT_MAX_PIXELS_V1 || c.width % 2 || c.height % 2
      || c.frameCount !== Math.floor(c.duration * c.analysisFps + 1e-8)) refuse("Invalid analysis geometry/clock");
    const expected = kit.sampleMode === "contiguous" ? Array.from({ length: c.frameCount }, (_, n) => n)
      : [0, 1, 2, 3, 4].map(n => Math.round((c.frameCount - 1) * n / 4));
    if (new Set(expected).size !== expected.length || JSON.stringify(c.samples.map(s => s.frame)) !== JSON.stringify(expected)) refuse("Sample coverage/order mismatch");
    for (const s of c.samples) {
      if (s.framePath !== rotoHoldoutFramePathV1(c.id, s.frame, "frames") || s.maskPath !== rotoHoldoutFramePathV1(c.id, s.frame, "labels")
        || s.timeSeconds !== c.sourceStart + s.frame / c.analysisFps) refuse("Sample path/clock mismatch");
    }
    total += c.samples.length;
  }
  if (total > ROTO_HOLDOUT_MAX_FRAMES_V1) refuse("Dataset frame budget exceeded");
  return kit;
}

export function parseRotoHoldoutReviewV1(input: unknown, kit: RotoHoldoutKitV1, kitSha256: string, now: number): RotoHoldoutReviewV1 {
  const review = reviewSchema.parse(input);
  if (!Number.isFinite(now) || review.kitSha256 !== kitSha256 || Date.parse(review.reviewedAt) < Date.parse(kit.frozenAt)
    || Date.parse(review.reviewedAt) > now + 300000) refuse("Review identity/time mismatch");
  const expected = kit.clips.flatMap(c => c.samples.map(s => `${c.id}:${s.frame}`));
  const keys = review.entries.map(e => `${e.clipId}:${e.frame}`); unique(keys, "review frame");
  if (JSON.stringify([...keys].sort()) !== JSON.stringify([...expected].sort())) refuse("Incomplete human review");
  return review;
}

export function rotoHoldoutReviewTemplateV1(kit: RotoHoldoutKitV1, kitSha256: string) {
  return { schema: "editkin.roto-holdout-human-review/v1", kitSha256, reviewerIdHash: null, reviewedAt: null,
    entries: kit.clips.flatMap(c => c.samples.map(s => ({ clipId: c.id, frame: s.frame, approved: false,
      maskSha256: null, allBackgroundConfirmed: false, tracking: null }))) };
}
