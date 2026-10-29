import * as z from "zod/v4";

export const ROTO_V2_MAX_RAW_BYTES = 256 * 1024 ** 2;
export const ROTO_V2_MAX_OUTPUT_BYTES = 1024 ** 3;
export const rotoV2DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const unit = z.number().finite().min(0).max(1);
export const rotoV2SettingsSchema = z.strictObject({
  bandRadius: integer.max(16), localRadius: integer.min(2).max(64), motionThreshold: z.number().finite().min(.01).max(1),
  temporalStability: z.number().finite().min(0).max(.9), temporalGate: unit, despill: z.boolean(), motionBlurEdges: z.boolean(), alpha16: z.boolean(),
}).refine(s => s.localRadius >= s.bandRadius + 2, "ROTO_V2_LOCAL_RADIUS");
export type RotoV2Settings = z.infer<typeof rotoV2SettingsSchema>;
export const ROTO_V2_DEFAULT_SETTINGS: Readonly<RotoV2Settings> = Object.freeze({ bandRadius: 2, localRadius: 8,
  motionThreshold: .08, temporalStability: .15, temporalGate: .18, despill: true, motionBlurEdges: true, alpha16: true });
const rect = z.strictObject({ x: unit, y: unit, width: unit.min(.02), height: unit.min(.02) })
  .refine(r => r.x + r.width <= 1 && r.y + r.height <= 1, "ROTO_V2_RECT_OUTSIDE");
const correction = z.strictObject({ id: z.string().trim().min(1).max(128), frame: integer.max(1439), mode: z.enum(["foreground", "background"]),
  radius: z.number().finite().min(.001).max(.25), points: z.array(z.strictObject({ x: unit, y: unit })).min(1).max(4096) });
export const rotoV2RequestSchema = z.strictObject({
  sourcePath: z.string().min(1).max(4096), sourceStart: z.number().finite().min(0).max(604800), duration: z.number().finite().positive().max(120),
  fps: z.number().finite().min(1).max(60), initialTime: z.number().finite().min(0), initialRect: rect,
  sourceColor: z.literal("rec709-rgb8"), maxDimension: integer.min(16).max(1920), edgeSettings: rotoV2SettingsSchema,
  temporalStability: z.number().finite().min(0).max(.9).default(.22), feather: z.number().finite().min(0).max(.25).default(.01),
  edgeShift: z.number().finite().min(-.25).max(.25).default(0), contrast: z.number().finite().min(0).max(4).default(1.7),
  sourceSha256: rotoV2DigestSchema.optional(), corrections: z.array(correction).max(4096).default([]),
}).superRefine((r, c) => {
  const frames = Math.floor(r.duration * r.fps + 1e-8);
  if (r.initialTime > r.duration || r.sourceStart + r.duration > 604800 || frames < 1 || frames > 1440
    || new Set(r.corrections.map(s => s.id)).size !== r.corrections.length
    || r.corrections.some(s => s.frame >= frames) || r.corrections.reduce((n, s) => n + s.points.length, 0) > 1_000_000) {
    c.addIssue({ code: "custom", message: "ROTO_V2_TIME_OR_CORRECTIONS" });
  }
});
export type AnalyzeProductAutoRotoRequestV2 = z.infer<typeof rotoV2RequestSchema>;
export function parseRotoV2Request(input: unknown): AnalyzeProductAutoRotoRequestV2 {
  const strokes = input && typeof input === "object" ? (input as { corrections?: unknown }).corrections : undefined;
  if (Array.isArray(strokes)) {
    if (strokes.length > 4096) throw Error("ROTO_V2_CORRECTION_BUDGET");
    let count = 0;
    for (const s of strokes) {
      const points = s && typeof s === "object" ? (s as { points?: unknown }).points : undefined;
      if (Array.isArray(points)) { count += points.length; if (count > 1_000_000 || points.length > 4096) throw Error("ROTO_V2_CORRECTION_BUDGET"); }
    }
  }
  return rotoV2RequestSchema.parse(input);
}

const edge = z.strictObject({ schema: z.literal("editkin.roto-edge-refinement/v2"), engine: z.literal("editkin-roto-edge/v2"),
  opticalEngine: z.literal("editkin-self-authored-texture-aware-optical-alpha-refiner/v3"), qualityState: z.literal("diagnostic"),
  alphaPrecision: z.enum(["float-solve-to-unorm16", "float-solve-to-unorm8"]), rgbPrecision: z.literal("decoded-rgb8-local-recovery"),
  edgeBandPixels: integer, motionBandPixels: integer, solvedPixels: integer, directionalColorSolvedPixels: integer,
  unsupportedPixels: integer, temporallyBlendedPixels: integer, decontaminatedPixels: integer, unsupportedColorPixels: integer, settings: rotoV2SettingsSchema });
const routing = z.strictObject({ schema: z.literal("editkin.region-memory-routing/v1"), requested: z.literal("guarded_experimental"),
  executed: z.enum(["guarded_experimental", "fixed_baseline"]), candidateAttempted: z.literal(true), deterministicFallback: z.boolean(), fallbackReason: z.string().min(1).max(8192).optional() });
export const nativeAutoRotoV2Schema = z.strictObject({ schema: z.literal("editkin.auto-roto-matte/v2"), engine: z.literal("editkin-native-roto-edge/v2"),
  qualityState: z.literal("diagnostic"), sampleTimeKind: z.literal("analysis-grid-not-decoder-pts"), width: integer.min(16).max(8192), height: integer.min(16).max(8192),
  frameCount: integer.min(1).max(1440), analysisFps: z.number().finite().min(1).max(60), initialFrame: integer, sourceRawSha256: rotoV2DigestSchema,
  alphaFormat: z.enum(["gray", "gray16le"]), alphaPath: z.enum(["matte-sequence.alpha8", "matte-sequence.alpha16le"]), straightRgbPath: z.literal("foreground.rgb24"),
  alphaBytes: integer, straightRgbBytes: integer, coarseEngine: z.literal("editkin-native-color-temporal-roto/v1"), coarseRouting: routing,
  correctionStrokesApplied: integer.max(4096), correctedFrames: z.array(integer).max(1440), edgeSettings: rotoV2SettingsSchema,
  frames: z.array(z.strictObject({ frame: integer, time: z.number().finite().nonnegative(), alphaPath: z.string(), confidence: unit,
    manualPixelsRestored: integer, edgeRefinement: edge })).min(1).max(1440),
}).superRefine((r, ctx) => {
  const p = r.width * r.height, high = r.edgeSettings.alpha16;
  const valid = p <= 2073600 && r.initialFrame < r.frameCount && r.frames.length === r.frameCount
    && r.straightRgbBytes === p * r.frameCount * 3 && r.straightRgbBytes <= ROTO_V2_MAX_RAW_BYTES
    && r.alphaBytes === p * r.frameCount * (high ? 2 : 1)
    && r.alphaPath === (high ? "matte-sequence.alpha16le" : "matte-sequence.alpha8") && r.alphaFormat === (high ? "gray16le" : "gray")
    && r.coarseRouting.deterministicFallback === (r.coarseRouting.executed === "fixed_baseline")
    && Boolean(r.coarseRouting.fallbackReason) === r.coarseRouting.deterministicFallback
    && new Set(r.correctedFrames).size === r.correctedFrames.length && r.correctedFrames.every(f => f < r.frameCount)
    && r.frames.every((f, i) => {
      const e = f.edgeRefinement;
      return f.frame === i && Math.abs(f.time - i / r.analysisFps) < 1e-7 && f.alphaPath === `frame-${String(i).padStart(6, "0")}.png`
        && f.manualPixelsRestored <= p && e.edgeBandPixels <= p && e.motionBandPixels <= p && e.solvedPixels + e.unsupportedPixels === e.edgeBandPixels
        && e.directionalColorSolvedPixels <= e.solvedPixels && e.temporallyBlendedPixels <= e.solvedPixels
        && e.decontaminatedPixels + e.unsupportedColorPixels <= e.edgeBandPixels
        && JSON.stringify(e.settings) === JSON.stringify(r.edgeSettings)
        && e.alphaPrecision === (high ? "float-solve-to-unorm16" : "float-solve-to-unorm8");
    });
  if (!valid) ctx.addIssue({ code: "custom", message: "ROTO_V2_RECEIPT_INVARIANT" });
});
export type NativeAutoRotoReceiptV2 = z.infer<typeof nativeAutoRotoV2Schema>;
export function parseNativeAutoRotoV2(input: unknown, expected: { width: number; height: number; frameCount: number; fps: number; initialFrame: number; rawSha256: string }) {
  const value = nativeAutoRotoV2Schema.parse(input);
  if (value.width !== expected.width || value.height !== expected.height || value.frameCount !== expected.frameCount || value.analysisFps !== expected.fps
    || value.initialFrame !== expected.initialFrame || value.sourceRawSha256 !== expected.rawSha256) throw Error("ROTO_V2_EXPECTED_SHAPE_OR_SOURCE");
  return value;
}
