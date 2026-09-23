import * as z from "zod/v4";

export const SOFTWARE_VIDEO_DECODE_SCHEMA = "editkin.software-video-decode/v1" as const;
export const SOFTWARE_VIDEO_BENCHMARK_SCHEMA = "editkin.software-video-decode-benchmark/v1" as const;
export const SOFTWARE_VIDEO_ROUTE = "ffmpeg-libav-software/v1" as const;
export const SOFTWARE_VIDEO_BENCHMARK_ITERATIONS = 20 as const;
export const SOFTWARE_VIDEO_REFERENCE_BUDGET_MS = 33.334 as const;
export const SOFTWARE_VIDEO_PACKAGING_BLOCKER = "The R&D runtime is hash-pinned and LGPL-labelled, but the product does not yet bundle a reproducible minimal build plus corresponding source/notices for every statically included third-party dependency." as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const safeNonnegativeIntegerSchema = z.number().int().nonnegative().safe();
const safePositiveIntegerSchema = z.number().int().positive().safe();
const finiteNonnegativeSchema = z.number().finite().nonnegative();

const runtimeIdentitySchema = z.strictObject({
  provider: z.literal("BtbN/FFmpeg-Builds"),
  releaseTag: z.literal("autobuild-2026-09-03-13-17"),
  buildRepositoryCommit: z.literal("8267213e26c1031621e6e1210fe3aa4867214f6a"),
  ffmpegCommit: z.literal("1a748fe2cd43e3ead22fafb1b5b7d77f153898a8"),
  assetName: z.literal("ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-shared-8.1.zip"),
  assetBytes: z.literal(70_835_267),
  assetSha256: z.literal("383f173d39cf610ba7d1d56bf22941f5e9470dd5ebfcf76a152e8a6f6235fe68"),
  licenseExpression: z.literal("LGPL-3.0-or-later"),
  license: z.string().regex(/^LGPL\b/).max(95),
  configurationSha256: z.literal("e8d1f4eea6fe04058e71e84365dd90f7dd0ad99e8954667f58c86b6c6baca325"),
  avutilVersion: z.literal("60.26.102"),
  avcodecVersion: z.literal("62.28.102"),
  avformatVersion: z.literal("62.12.102"),
  manifestExactMatch: z.literal(true),
  fileHashesVerified: z.literal(true),
  closedWorldLibrarySet: z.literal(true),
  reparsePointsRejected: z.literal(true),
  admissionMilliseconds: finiteNonnegativeSchema,
});

const inputIdentitySchema = z.strictObject({
  path: z.string().min(1).max(32_768),
  bytes: safePositiveIntegerSchema.max(64 * 1024 * 1024 * 1024),
  sha256: sha256Schema,
});

const planeSchema = z.strictObject({
  offset: safeNonnegativeIntegerSchema,
  strideBytes: safePositiveIntegerSchema,
  bytes: safePositiveIntegerSchema,
  sha256: sha256Schema,
  minimumSample: safeNonnegativeIntegerSchema.max(1023),
  maximumSample: safeNonnegativeIntegerSchema.max(1023),
  samplesOutsideTenBit: z.literal(0),
}).superRefine((plane, context) => {
  if (plane.minimumSample > plane.maximumSample) {
    context.addIssue({ code: "custom", path: ["minimumSample"], message: "minimumSample exceeds maximumSample" });
  }
});

export const softwareVideoDecodeReceiptSchema = z.strictObject({
  schema: z.literal(SOFTWARE_VIDEO_DECODE_SCHEMA),
  status: z.literal("GREEN_RD_CELL"),
  route: z.literal(SOFTWARE_VIDEO_ROUTE),
  shippingEligible: z.literal(false),
  packagedLatencyMeasured: z.literal(false),
  scope: z.strictObject({
    codecs: z.tuple([z.literal("h264"), z.literal("hevc")]),
    pixelFormat: z.literal("yuv422p10le"),
    color: z.literal("rec709-limited"),
    scan: z.literal("progressive"),
    execution: z.literal("cpu-software"),
    integration: z.literal("standalone-rd-cli-only"),
  }),
  runtime: runtimeIdentitySchema,
  input: inputIdentitySchema,
  request: z.strictObject({
    target100ns: safeNonnegativeIntegerSchema,
    targetSeconds: finiteNonnegativeSchema.max(86_400),
    tolerance100ns: safeNonnegativeIntegerSchema.max(50_000_000),
    toleranceSeconds: finiteNonnegativeSchema.max(5),
    timeoutMilliseconds: z.literal(5_000),
  }),
  frame: z.strictObject({
    width: safePositiveIntegerSchema.max(7_680),
    height: safePositiveIntegerSchema.max(4_320),
    codec: z.enum(["h264", "hevc"]),
    codecId: z.union([z.literal(27), z.literal(173)]),
    pixelFormat: z.literal("yuv422p10le"),
    pixelFormatId: z.literal(64),
    colorRange: z.literal("limited"),
    colorSpace: z.literal("bt709"),
    colorPrimaries: z.literal("bt709"),
    colorTransfer: z.literal("bt709"),
    scan: z.literal("progressive"),
    pts100ns: safeNonnegativeIntegerSchema,
    ptsSeconds: finiteNonnegativeSchema,
    duration100ns: safeNonnegativeIntegerSchema,
    durationSeconds: finiteNonnegativeSchema,
    absoluteDrift100ns: safeNonnegativeIntegerSchema,
    clockWithinTolerance: z.literal(true),
    frameRateNumerator: safeNonnegativeIntegerSchema,
    frameRateDenominator: safeNonnegativeIntegerSchema,
    packetsRead: safePositiveIntegerSchema.max(16_384),
    framesDecoded: safePositiveIntegerSchema.max(8_192),
    keyFrame: z.boolean(),
  }),
  planes: z.strictObject({
    layout: z.literal("yuv422p10le-tight-planar/v1"),
    totalBytes: safePositiveIntegerSchema.max(512 * 1024 * 1024),
    combinedSha256: sha256Schema,
    y: planeSchema,
    u: planeSchema,
    v: planeSchema,
  }),
  copyAccounting: z.strictObject({
    decoderOutputMemory: z.literal("libav-cpu-frame"),
    decoderOutputFrames: safePositiveIntegerSchema.max(8_192),
    bridgeTightPlaneCpuCopyCount: z.literal(1),
    bridgeTightPlaneCpuCopyBytes: safePositiveIntegerSchema.max(512 * 1024 * 1024),
    rustPixelBufferCopyCount: z.literal(0),
    gpuUploadCount: z.literal(0),
    gpuCopyCount: z.literal(0),
    zeroCopy: z.literal(false),
  }),
  timings: z.strictObject({
    decodeMilliseconds: finiteNonnegativeSchema,
    measurementBoundary: z.literal("same-process bridge call: dynamic DLL load, demux open, seek, software decode, and one tight-plane CPU copy; excludes runtime/input hashing, GPU upload, composition, UI, and packaging"),
  }),
  packagingBlocker: z.literal(SOFTWARE_VIDEO_PACKAGING_BLOCKER),
}).superRefine((receipt, context) => {
  const { width, height, codec, codecId, pts100ns, ptsSeconds, duration100ns, durationSeconds, absoluteDrift100ns, framesDecoded } = receipt.frame;
  if (width < 2 || height < 2 || width % 2 !== 0) {
    context.addIssue({ code: "custom", path: ["frame", "width"], message: "4:2:2 dimensions must be bounded and width-even" });
  }
  if ((codec === "h264" ? 27 : 173) !== codecId) {
    context.addIssue({ code: "custom", path: ["frame", "codecId"], message: "codec ID does not match codec name" });
  }
  if (receipt.request.target100ns !== Math.round(receipt.request.targetSeconds * 10_000_000)
    || receipt.request.tolerance100ns !== Math.round(receipt.request.toleranceSeconds * 10_000_000)) {
    context.addIssue({ code: "custom", path: ["request"], message: "seconds and 100ns request clocks disagree" });
  }
  const recomputedDrift = Math.abs(pts100ns - receipt.request.target100ns);
  if (recomputedDrift !== absoluteDrift100ns || recomputedDrift > receipt.request.tolerance100ns) {
    context.addIssue({ code: "custom", path: ["frame", "absoluteDrift100ns"], message: "PTS is outside the requested tolerance" });
  }
  if (Math.abs(ptsSeconds - pts100ns / 10_000_000) > 1e-9
    || Math.abs(durationSeconds - duration100ns / 10_000_000) > 1e-9) {
    context.addIssue({ code: "custom", path: ["frame"], message: "frame seconds and 100ns clocks disagree" });
  }
  const pixels = width * height;
  const yBytes = pixels * 2;
  const chromaBytes = pixels;
  const totalBytes = pixels * 4;
  if (receipt.planes.totalBytes !== totalBytes
    || receipt.planes.y.offset !== 0 || receipt.planes.y.strideBytes !== width * 2 || receipt.planes.y.bytes !== yBytes
    || receipt.planes.u.offset !== yBytes || receipt.planes.u.strideBytes !== width || receipt.planes.u.bytes !== chromaBytes
    || receipt.planes.v.offset !== yBytes + chromaBytes || receipt.planes.v.strideBytes !== width || receipt.planes.v.bytes !== chromaBytes) {
    context.addIssue({ code: "custom", path: ["planes"], message: "tight yuv422p10le plane layout does not match dimensions" });
  }
  if (receipt.copyAccounting.decoderOutputFrames !== framesDecoded
    || receipt.copyAccounting.bridgeTightPlaneCpuCopyBytes !== totalBytes) {
    context.addIssue({ code: "custom", path: ["copyAccounting"], message: "copy accounting does not match decoded frame/layout" });
  }
});

const frozenBenchmarkInputSchema = z.strictObject({
  path: z.string().min(1).max(32_768),
  bytes: z.literal(87_065),
  sha256: z.literal("31bf4b41551665fb5d1a0f2d1acc442856f849556eb4c84f79ace6b8458aa33a"),
});

export const softwareVideoDecodeBenchmarkReceiptSchema = z.strictObject({
  schema: z.literal(SOFTWARE_VIDEO_BENCHMARK_SCHEMA),
  status: z.literal("MEASURED_RD_ONLY"),
  route: z.literal(SOFTWARE_VIDEO_ROUTE),
  shippingEligible: z.literal(false),
  packagedLatencyMeasured: z.literal(false),
  runtime: runtimeIdentitySchema,
  input: frozenBenchmarkInputSchema,
  warmupIterations: z.literal(1),
  measuredIterations: z.literal(SOFTWARE_VIDEO_BENCHMARK_ITERATIONS),
  targetSequenceSeconds: z.array(finiteNonnegativeSchema).length(SOFTWARE_VIDEO_BENCHMARK_ITERATIONS),
  samplesMilliseconds: z.array(finiteNonnegativeSchema).length(SOFTWARE_VIDEO_BENCHMARK_ITERATIONS),
  decodedPtsSeconds: z.array(finiteNonnegativeSchema).length(SOFTWARE_VIDEO_BENCHMARK_ITERATIONS),
  p50Milliseconds: finiteNonnegativeSchema,
  p95Milliseconds: finiteNonnegativeSchema,
  maximumMilliseconds: finiteNonnegativeSchema,
  referenceFrameBudgetMilliseconds: z.literal(SOFTWARE_VIDEO_REFERENCE_BUDGET_MS),
  withinReferenceFrameBudget: z.boolean(),
  measurementBoundary: z.literal("single host/process; each sample reloads the pinned DLLs, opens the container, seeks, software-decodes one selected CPU frame, and copies tight planes; excludes hashing/admission, persistent scheduler/cache, GPU upload, composition, packaged app, and UI"),
  packagingBlocker: z.literal(SOFTWARE_VIDEO_PACKAGING_BLOCKER),
}).superRefine((receipt, context) => {
  const frozenTargets = [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6];
  for (let index = 0; index < SOFTWARE_VIDEO_BENCHMARK_ITERATIONS; index += 1) {
    const target = frozenTargets[index % frozenTargets.length];
    if (receipt.targetSequenceSeconds[index] !== target || Math.abs(receipt.decodedPtsSeconds[index] - target) > 0.001) {
      context.addIssue({ code: "custom", path: ["targetSequenceSeconds", index], message: "benchmark corpus/seek target drifted" });
    }
  }
  const sorted = [...receipt.samplesMilliseconds].sort((left, right) => left - right);
  const nearestRank = (quantile: number) => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
  const expectedP50 = nearestRank(0.5);
  const expectedP95 = nearestRank(0.95);
  const expectedMaximum = sorted[sorted.length - 1];
  if (Math.abs(receipt.p50Milliseconds - expectedP50) > 1e-9
    || Math.abs(receipt.p95Milliseconds - expectedP95) > 1e-9
    || Math.abs(receipt.maximumMilliseconds - expectedMaximum) > 1e-9) {
    context.addIssue({ code: "custom", path: ["p95Milliseconds"], message: "benchmark percentiles do not match raw samples" });
  }
  if (receipt.withinReferenceFrameBudget !== (receipt.p95Milliseconds <= SOFTWARE_VIDEO_REFERENCE_BUDGET_MS)) {
    context.addIssue({ code: "custom", path: ["withinReferenceFrameBudget"], message: "benchmark budget verdict is inconsistent" });
  }
});

export type SoftwareVideoDecodeReceipt = z.infer<typeof softwareVideoDecodeReceiptSchema>;
export type SoftwareVideoDecodeBenchmarkReceipt = z.infer<typeof softwareVideoDecodeBenchmarkReceiptSchema>;

export const parseSoftwareVideoDecodeReceipt = (value: unknown): SoftwareVideoDecodeReceipt =>
  softwareVideoDecodeReceiptSchema.parse(value);

export const parseSoftwareVideoDecodeBenchmarkReceipt = (value: unknown): SoftwareVideoDecodeBenchmarkReceipt =>
  softwareVideoDecodeBenchmarkReceiptSchema.parse(value);
