import * as z from "zod/v4";
import { motionScene2dSchema } from "./motionScene2dSchema";
import { assertMotionScenes2D } from "./motionScene2d";
import { assertReferenceMotionInstances, referenceMotionInstanceSchema } from "./referenceMotionInstance";
import { reviewPolicySchema } from "./reviewPolicy";
import { continuityVectorSchema } from "./motionContinuitySchema";
import { assertMotionPaintContract, motionPaintDescriptorSchema } from "./motionPaint";
import { mesh3dSceneSchema } from "../motion/mesh3dScene";
import type { EditorCommand } from "./commands";
import type { EditProject, HaoExpressionSource } from "./types";
import { AESTHETIC_BENCHMARKS, BENCHMARK_AXES } from "./aestheticBenchmarks";
import {
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
  PRODUCT_AUTO_ROTO_MAX_FRAMES,
  productAutoRotoRouteReceiptShapeSchema,
} from "./autoRotoProductReceipt";

const transformSchema = z.object({ x: z.number(), y: z.number(), scale: z.number(), rotation: z.number(), opacity: z.number() });
const templateElementOwnerSchema = z.strictObject({
  schema: z.literal("editkin.template-element-owner/v1"),
  sessionId: z.string().min(1).max(160),
  templateId: z.string().min(1).max(160),
  format: z.enum(["short", "long"]),
  role: z.string().min(1).max(80),
});
const finiteVec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const transform3dSchema = z.object({ position: finiteVec3Schema, rotationDegrees: finiteVec3Schema, scale: finiteVec3Schema });
const floatingVideoFrameFields = {
  style: z.enum(["prism", "graphite", "matte"]),
  size: z.number().finite().min(.3).max(.82),
  yawDegrees: z.number().finite().min(-35).max(35),
  pitchDegrees: z.number().finite().min(-25).max(25),
  centerX: z.number().finite().min(.2).max(.8).optional(),
  centerY: z.number().finite().min(.2).max(.8).optional(),
  orbit: z.strictObject({ amplitudeDegrees: z.number().finite().min(0).max(30), periodSeconds: z.number().finite().min(2).max(8) }).optional(),
};
const floatingVideoFrameSchema = z.discriminatedUnion("schema", [
  z.strictObject({ ...floatingVideoFrameFields, schema: z.literal("editkin.floating-video-frame/v1"),
    aspect: z.enum(["canvas", "portrait"]).optional() }),
  z.strictObject({ ...floatingVideoFrameFields, schema: z.literal("editkin.floating-video-frame/v2"),
    aspect: z.enum(["source", "canvas", "portrait"]), mediaFit: z.literal("contain"),
    motion: z.strictObject({ entranceFrames: z.number().int().min(0).max(24),
      exitFrames: z.number().int().min(0).max(24), travelY: z.number().finite().min(0).max(.03) }).optional() }),
]);
const easingSchema = z.enum(["linear", "hold", "ease_in", "ease_out", "ease_in_out", "spring_soft"]);
const scene25dCameraKeyframeSchema = z.object({
  id: z.string(), time: z.number().finite().positive(), position: finiteVec3Schema, target: finiteVec3Schema,
  verticalFovDegrees: z.number().finite(), easing: easingSchema,
});
const scene25dLensKeyframeSchema = z.object({
  id: z.string(), time: z.number().finite().positive(), focusDistance: z.number().finite(), aperture: z.number().finite(),
  maxBlurRadius: z.number().finite(), easing: easingSchema,
});
const scene25dAmbientLightKeyframeSchema = z.object({
  id: z.string(), time: z.number().finite().positive(), intensity: z.number().finite(), easing: easingSchema,
});
const scene25dDirectionalLightKeyframeSchema = z.object({
  id: z.string(), time: z.number().finite().positive(), color: finiteVec3Schema, intensity: z.number().finite(),
  direction: finiteVec3Schema, easing: easingSchema,
});
const scene25dSchema = z.object({
  schema: z.literal("editkin.scene-25d/v1"), enabled: z.boolean(),
  camera: z.object({ position: finiteVec3Schema, target: finiteVec3Schema, up: finiteVec3Schema, verticalFovDegrees: z.number().finite(), near: z.number().finite(), far: z.number().finite(), keyframes: z.array(scene25dCameraKeyframeSchema).max(16) }),
  depthOfField: z.object({ enabled: z.boolean(), focusDistance: z.number().finite(), aperture: z.number().finite(), maxBlurRadius: z.number().finite(), keyframes: z.array(scene25dLensKeyframeSchema).max(16) }),
  ambientLight: z.object({ color: finiteVec3Schema, intensity: z.number().finite(), keyframes: z.array(scene25dAmbientLightKeyframeSchema).max(16) }),
  directionalLight: z.object({ color: finiteVec3Schema, intensity: z.number().finite(), direction: finiteVec3Schema, keyframes: z.array(scene25dDirectionalLightKeyframeSchema).max(16) }),
});
const finiteVec2Schema = z.tuple([z.number().finite(), z.number().finite()]);
const particleEmitterParameterShape = {
  timeline: z.object({ start: z.number().finite().nonnegative(), duration: z.number().finite().positive() }).optional(),
  seed: z.number().int().nonnegative().max(0xffff_ffff),
  ratePerSecond: z.number().finite().positive().max(240), lifetimeSeconds: z.number().finite().positive().max(10),
  maxParticles: z.number().int().positive().max(64), emitterPosition: finiteVec2Schema,
  initialVelocity: finiteVec2Schema, gravity: finiteVec2Schema,
  radiusPixels: z.number().finite().positive().max(64),
  color: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
};
const particleEmitterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  ...particleEmitterParameterShape,
});
const particleSimulationSchema = z.object({
  schema: z.literal("editkin.particle-simulation/v1"), enabled: z.boolean(),
  ...particleEmitterParameterShape,
  additionalEmitters: z.array(particleEmitterSchema).max(3).optional(),
});
const rawColorSchema = z.object({
  brightness: z.number(), contrast: z.number(), saturation: z.number(), hue: z.number(), exposure: z.number(),
  temperature: z.number(), tint: z.number(), pivot: z.number(), shadows: z.number(), highlights: z.number(), blacks: z.number(), whites: z.number(),
  whiteBalanceRed: z.number().finite().min(-4).max(4),
  whiteBalanceGreen: z.number().finite().min(-4).max(4),
  whiteBalanceBlue: z.number().finite().min(-4).max(4),
});
// Legacy full color objects omit channel gains. Defaults belong to full
// snapshots only: Zod partials with defaults would reset authored gains.
const colorSchema = rawColorSchema.extend({
  whiteBalanceRed: rawColorSchema.shape.whiteBalanceRed.default(0),
  whiteBalanceGreen: rawColorSchema.shape.whiteBalanceGreen.default(0),
  whiteBalanceBlue: rawColorSchema.shape.whiteBalanceBlue.default(0),
});
const keyframeSchema = z.object({ id: z.string(), time: z.number(), transform: transformSchema, color: colorSchema, easing: easingSchema });
const creativeTransitionSchema = z.object({ presetId: z.string(), duration: z.number() });
const nativeEffectParameterValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const nativeEffectInstanceSchema = z.object({
  id: z.string().min(1).max(128),
  pluginId: z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),
  capabilityId: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
  pluginVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeType: z.enum(["native_effect", "gpu_effect_graph"]).optional(),
  enabled: z.boolean(),
  parameters: z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), nativeEffectParameterValueSchema),
});
const clipCreativeSchema = z.object({
  lookPresetId: z.string().optional(), effectPresetIds: z.array(z.string()),
  nativeEffectInstances: z.array(nativeEffectInstanceSchema).optional(),
  transitionIn: creativeTransitionSchema.optional(), transitionOut: creativeTransitionSchema.optional(),
});
const normalizedRectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const clipLayoutSchema = z.object({ crop: normalizedRectSchema, viewport: normalizedRectSchema });
const maskPathPointSchema = z.object({ id: z.string(), x: z.number(), y: z.number() });
const maskKeyframeSchema = z.object({ frame: z.number().int(), time: z.number(), points: z.array(maskPathPointSchema), confidence: z.number(), status: z.enum(["tracked", "held", "lost", "manual"]) });
const rotoCorrectionStrokeSchema = z.object({
  id: z.string(), frame: z.number().int(), mode: z.enum(["foreground", "background"]), radius: z.number(),
  points: z.array(z.object({ x: z.number(), y: z.number() })),
});
const productRegionMemoryRoutingSchema = z.strictObject({
  schema: z.literal("editkin.region-memory-routing/v1"), requested: z.literal("fixed_baseline"), executed: z.literal("fixed_baseline"),
  candidateAttempted: z.literal(false), deterministicFallback: z.literal(false),
});
const opticalAlphaRefinementSchema = z.strictObject({
  schema: z.literal("editkin.optical-alpha-refinement-aggregate/v1"),
  engine: z.literal("editkin-self-authored-optical-alpha-refiner/v1"),
  appliedFrames: z.number().int().positive().max(PRODUCT_AUTO_ROTO_MAX_FRAMES),
  radius: z.number().int().min(2).max(32),
  backgroundThreshold: z.number().finite().min(0).max(1),
  foregroundThreshold: z.number().finite().min(0).max(1),
  coarseWeight: z.number().finite().min(0).max(1),
  temporalStability: z.number().finite().min(0).max(1),
  temporalGate: z.number().finite().min(0).max(1),
  changedPixels: z.number().int().nonnegative().safe(),
  fractionalPixels: z.number().int().nonnegative().safe(),
  solvedPixels: z.number().int().nonnegative().safe(),
  meanSolveConfidence: z.number().finite().min(0).max(1),
});
const rotoMatteSequenceSchema = z.strictObject({
  schema: z.literal("editkin.auto-roto-matte/v1"),
  engine: z.literal(PRODUCT_AUTO_ROTO_ENGINE),
  width: z.number().int().min(16).max(32_768),
  height: z.number().int().min(16).max(32_768),
  analysisFps: z.number().finite().positive().max(12),
  frameCount: z.number().int().positive().max(PRODUCT_AUTO_ROTO_MAX_FRAMES),
  sequenceUri: z.string().min(1),
  sequenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sequenceBytes: z.number().int().positive().max(PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES).safe(),
  manifestUri: z.string().min(1),
  framePreviewUris: z.array(z.string().min(1)).min(1).max(PRODUCT_AUTO_ROTO_MAX_FRAMES).optional(),
  frameArtifactUris: z.array(z.string().min(1)).min(1).max(PRODUCT_AUTO_ROTO_MAX_FRAMES),
  meanBoundaryChatter: z.number().finite().min(0).max(1),
  correctionStrokesApplied: z.number().int().nonnegative().optional(),
  correctedFrames: z.array(z.number().int().nonnegative()).max(PRODUCT_AUTO_ROTO_MAX_FRAMES).optional(),
  stale: z.boolean().optional(),
  staleReason: z.literal("clip-time-range-changed").optional(),
  regionMemoryRouting: productRegionMemoryRoutingSchema,
  alphaRefinement: opticalAlphaRefinementSchema,
  routeReceipt: productAutoRotoRouteReceiptShapeSchema,
  frozen: z.literal(true),
  qualityState: z.literal("diagnostic"),
}).superRefine((matte, context) => {
  if (matte.staleReason !== undefined && matte.stale !== true) {
    context.addIssue({ code: "custom", path: ["stale"], message: "片段時間已變更的 Matte 必須標示為過期" });
  }
  const normalizedManifest = matte.manifestUri.replaceAll("\\", "/");
  const match = /^(?:[A-Za-z]:\/|\/)(?:[^/]+\/)*auto-roto-product\/([a-f0-9]{64})\/matte-manifest\.json$/.exec(normalizedManifest);
  const artifactRoot = match ? normalizedManifest.slice(0, -"/matte-manifest.json".length) : undefined;
  if (!artifactRoot || normalizedManifest.split("/").some((part) => part === "." || part === "..")) {
    context.addIssue({ code: "custom", path: ["manifestUri"], message: "產品 Auto Roto manifest 必須位於內容定址 artifact root" });
    return;
  }
  if (matte.sequenceUri.replaceAll("\\", "/") !== `${artifactRoot}/matte-sequence.alpha8`) {
    context.addIssue({ code: "custom", path: ["sequenceUri"], message: "產品 Auto Roto sequence 離開 artifact root" });
  }
  if (matte.sequenceBytes !== matte.width * matte.height * matte.frameCount) {
    context.addIssue({ code: "custom", path: ["sequenceBytes"], message: "產品 Auto Roto sequenceBytes 與 frame inventory 不一致" });
  }
  if ((matte.framePreviewUris !== undefined && matte.framePreviewUris.length !== matte.frameCount)
    || matte.frameArtifactUris.length !== matte.frameCount) {
    context.addIssue({ code: "custom", path: ["frameArtifactUris"], message: "產品 Auto Roto preview inventory 不完整" });
  }
  for (let frame = 0; frame < matte.frameArtifactUris.length; frame += 1) {
    const expected = `${artifactRoot}/frame-${String(frame).padStart(6, "0")}.png`;
    if (matte.frameArtifactUris[frame].replaceAll("\\", "/") !== expected) {
      context.addIssue({ code: "custom", path: ["frameArtifactUris", frame], message: "產品 Auto Roto preview 離開封閉 artifact inventory" });
    }
  }
  const alphaLimit = matte.width * matte.height * matte.frameCount;
  const alpha = matte.alphaRefinement;
  if (alpha.appliedFrames !== matte.frameCount
    || alpha.backgroundThreshold + .05 >= alpha.foregroundThreshold
    || alpha.changedPixels > alphaLimit || alpha.fractionalPixels > alphaLimit || alpha.solvedPixels > alphaLimit
    || alpha.solvedPixels > alpha.fractionalPixels) {
    context.addIssue({ code: "custom", path: ["alphaRefinement"], message: "產品 Auto Roto alpha refinement 與 matte inventory 不一致" });
  }
});
const retiredAutoRotoRecordSchema = z.strictObject({
  schema: z.literal("editkin.retired-auto-roto-record/v1"),
  reason: z.enum(["non-product-engine", "unattested-product-artifact"]),
  originalEngine: z.string().min(1).max(256),
  originalManifestUri: z.string().min(1).max(32_768).optional(),
  originalSequenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  originalQualityState: z.string().min(1).max(128).optional(),
});
const clipMaskSchema = z.strictObject({
  id: z.string(), name: z.string(), kind: z.enum(["rectangle", "ellipse", "polygon", "subject"]), mode: z.enum(["add", "subtract", "intersect"]),
  enabled: z.boolean(), inverted: z.boolean(), opacity: z.number(), feather: z.number(), expansion: z.number(), path: z.array(maskPathPointSchema),
  keyframes: z.array(maskKeyframeSchema), trackId: z.string().optional(), refine: z.object({ edgeShift: z.number(), contrast: z.number(), chatterReduction: z.number() }),
  frozenRange: z.object({ fromFrame: z.number().int(), toFrame: z.number().int() }).optional(),
  matteSequence: rotoMatteSequenceSchema.optional(),
  retiredAutoRotoRecord: retiredAutoRotoRecordSchema.optional(),
  rotoCorrections: z.array(rotoCorrectionStrokeSchema).optional(),
});
const productClipMaskSchema = clipMaskSchema;
const layerBlendModeSchema = z.enum(["normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn"]);
const layerRoleSchema = z.enum(["content", "adjustment", "controller"]);
const trackMatteModeSchema = z.enum(["alpha", "alpha_inverted", "luma", "luma_inverted"]);
const clipTrackMatteSchema = z.object({ sourceClipId: z.string(), mode: trackMatteModeSchema });
const clipLayerSchema = z.object({
  enabled: z.boolean(), blendMode: layerBlendModeSchema, role: layerRoleSchema.optional(),
  parentClipId: z.string().optional(), trackMatte: clipTrackMatteSchema.optional(),
});
const expressionPropertySchema = z.enum(["x", "y", "scale", "rotation", "opacity"]);
const haoExpressionSchema = z.string().min(19).max(512).startsWith("hao.expression/v1:").transform((value) => value as HaoExpressionSource);
const clipExpressionsSchema = z.object({
  x: haoExpressionSchema.optional(), y: haoExpressionSchema.optional(), scale: haoExpressionSchema.optional(),
  rotation: haoExpressionSchema.optional(), opacity: haoExpressionSchema.optional(),
});
const derivativesSchema = z.object({
  sourceSha256: z.string(), proxyUri: z.string().optional(), proxyWidth: z.number().int().positive().optional(), proxyHeight: z.number().int().positive().optional(),
  proxyColor: z.object({
    interpretation: z.enum(["auto", "rec709"]), primaries: z.string().optional(), transfer: z.string().optional(), matrix: z.string().optional(), range: z.string().optional(),
  }).optional(),
  proxyColorContract: z.literal("editkin.browser-display-proxy/v1").optional(),
  previewRecipe: z.string().max(160).regex(/^editkin\.browser-proxy[-a-z0-9./]+$/).optional(),
  overlayProxyUri: z.string().optional(), overlayProxyWidth: z.number().int().positive().optional(), overlayProxyHeight: z.number().int().positive().optional(),
  overlayProxyFrameRateNumerator: z.number().int().positive().optional(), overlayProxyFrameRateDenominator: z.number().int().positive().optional(),
  overlayProxyProfile: z.literal("editkin-small-overlay-performance/v1").optional(),
  thumbnailUri: z.string().optional(), waveformUri: z.string().optional(), generatedAt: z.string(),
});
const openExrImageSequenceSchema = z.object({
  schema: z.literal("editkin.openexr-sequence/v1"), format: z.literal("openexr"),
  frameCount: z.number().int().positive().max(1_000_000), startFrame: z.number().int().nonnegative(), lastFrame: z.number().int().nonnegative(),
  timebase: z.object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() }),
  sequenceSha256: z.string().regex(/^[a-f0-9]{64}$/i), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/i), previewUri: z.string().min(1),
});
const assetSchema = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["video", "audio", "image"]), uri: z.string(), duration: z.number(),
  width: z.number().optional(), height: z.number().optional(), derivatives: derivativesSchema.optional(),
  displayAspectRatio: z.number().finite().positive().optional(),
  compositionId: z.string().optional(),
  role: z.string().optional(), bpm: z.number().optional(), license: z.string().optional(), provenance: z.string().optional(), redistributable: z.boolean().optional(),
  rightsBasis: z.string().optional(), distributionScope: z.string().optional(),
  alphaMode: z.enum(["auto", "opaque", "straight", "premultiplied"]).optional(),
  imageSequence: openExrImageSequenceSchema.optional(),
  color: z.object({
    primaries: z.string().optional(), transfer: z.string().optional(), matrix: z.string().optional(), range: z.string().optional(),
    interpretation: z.enum(["auto", "rec709", "linear_rec709", "srgb", "hlg", "pq", "acescct", "apple_log", "arri_logc3", "arri_logc4", "bmd_film_gen5", "canon_log2", "canon_log3", "dji_dlog", "panasonic_vlog", "red_log3g10", "sony_slog3_cine", "log_unresolved"]),
  }).optional(),
});
const chromaKeySchema = z.object({
  schema: z.literal("editkin.chroma-key/v1"), engine: z.literal("editkin-chroma-distance-keyer/v1"), enabled: z.boolean(),
  screen: z.enum(["green", "blue"]), screenColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  similarity: z.number().finite().min(0).max(.5), softness: z.number().finite().min(.005).max(.5),
  edgeBias: z.number().finite().min(-.1).max(.1), despill: z.number().finite().min(0).max(1),
});
const clipSchema = z.object({
  id: z.string(), assetId: z.string(), trackId: z.string(), timelineStart: z.number(), sourceStart: z.number(), duration: z.number(),
  volume: z.number(), transform: transformSchema, transform3d: transform3dSchema.optional(), floatingFrame: floatingVideoFrameSchema.optional(), color: colorSchema, keyframes: z.array(keyframeSchema), creative: clipCreativeSchema.optional(), layout: clipLayoutSchema.optional(), masks: z.array(clipMaskSchema).optional(), chromaKey: chromaKeySchema.optional(),
  layer: clipLayerSchema.optional(), expressions: clipExpressionsSchema.optional(),
});
const captionSchema = z.object({
  id: z.string(), text: z.string(), start: z.number(), duration: z.number(),
  templateOwner: templateElementOwnerSchema.optional(),
  translation: z.object({ text: z.string(), language: z.string() }).optional(),
});
const captionStyleSchema = z.object({
  presetId: z.string(), fontFamily: z.string(), fontSize: z.number(), color: z.string(), outlineColor: z.string(), outlineWidth: z.number(),
  alignment: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9)]),
  marginV: z.number(), bold: z.boolean(), italic: z.boolean(), shadow: z.number(), backgroundColor: z.string(), letterSpacing: z.number(),
  translationFontFamily: z.string(), translationFontSize: z.number(), translationColor: z.string(), translationBold: z.boolean(), translationItalic: z.boolean(),
});
const motionTrackPointSchema = z.object({
  frame: z.number().int().nonnegative(), time: z.number(), rect: normalizedRectSchema, confidence: z.number(),
  status: z.enum(["tracked", "held", "lost", "manual"]), activity: z.number().optional(), rotationDegrees: z.number().optional(), scale: z.number().optional(),
  quad: z.tuple([z.object({ x: z.number(), y: z.number() }), z.object({ x: z.number(), y: z.number() }), z.object({ x: z.number(), y: z.number() }), z.object({ x: z.number(), y: z.number() })]).optional(),
});
const motionTrackSchema = z.object({
  id: z.string(), clipId: z.string(), name: z.string(), engine: z.string(), analysisFps: z.number(), initialRect: normalizedRectSchema,
  points: z.array(motionTrackPointSchema), lostRatio: z.number(), createdAt: z.string(), role: z.enum(["subject", "host", "guest"]).optional(),
});
const motionV2EasingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["linear", "ease_in", "ease_out", "ease_in_out"]) }),
  z.object({ type: z.literal("cubic_bezier"), x1: z.number().finite().min(0).max(1), y1: z.number().finite().min(-2).max(2), x2: z.number().finite().min(0).max(1), y2: z.number().finite().min(-2).max(2) }),
  z.object({ type: z.literal("spring"), stiffness: z.number().finite().min(1).max(1_000), damping: z.number().finite().min(0).max(100), mass: z.number().finite().min(.05).max(10), initialVelocity: z.number().finite().min(-20).max(20) }),
]);
const motionV2PhaseSchema = z.object({
  durationFrames: z.number().int().min(1).max(600), offsetXPixels: z.number().finite().min(-4_096).max(4_096), offsetYPixels: z.number().finite().min(-4_096).max(4_096),
  scale: z.number().finite().min(.01).max(4), opacity: z.number().finite().min(0).max(1), easing: motionV2EasingSchema,
  blurPixels: z.number().finite().min(0).max(64).optional(), rotationDegrees: z.number().finite().min(-180).max(180).optional(),
  spreadPixels: z.number().finite().min(-1_024).max(1_024).optional(),
});
const motionV2Schema = z.object({
  sequence: z.object({ unit: z.enum(["all", "word", "character"]), order: z.enum(["forward", "reverse", "center_out"]), exitOrder: z.enum(["forward", "reverse", "center_out"]), staggerFrames: z.number().int().min(0).max(120), exitStaggerFrames: z.number().int().min(0).max(120).optional(), scaleOrigin: z.enum(["top_left", "center"]).optional(), holdScale: z.number().finite().min(.8).max(1.25).optional() }),
  entrance: motionV2PhaseSchema, exit: motionV2PhaseSchema,
});
const layoutV2Schema = z.object({
  safeArea: z.object({ top: z.number().finite().min(0).max(.45), right: z.number().finite().min(0).max(.45), bottom: z.number().finite().min(0).max(.45), left: z.number().finite().min(0).max(.45) }),
  maxLines: z.number().int().min(1).max(4), minFontSize: z.number().finite().min(8).max(384), lineGap: z.number().finite().min(0).max(128), align: z.enum(["left", "center", "right"]),
  widthMode: z.enum(["fixed", "fit_content"]).optional(),
});
const vectorBase = {
  schema: z.enum(["editkin.motion-vector/v1", "editkin.motion-vector-stage/v1"]),
  heightPixels: z.number().finite().min(1).max(4096),
  revealFrames: z.number().int().min(1).max(600),
};
const shapeCoordinate = z.number().finite().min(-16_384).max(16_384);
const motionVectorShapeCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.enum(["M", "L"]), x: shapeCoordinate, y: shapeCoordinate }),
  z.strictObject({ type: z.literal("C"), x1: shapeCoordinate, y1: shapeCoordinate, x2: shapeCoordinate, y2: shapeCoordinate, x: shapeCoordinate, y: shapeCoordinate }),
  z.strictObject({ type: z.literal("Z") }),
]);
export const motionVectorV2Schema = z.discriminatedUnion("kind", [
  continuityVectorSchema,
  z.strictObject({ schema: z.literal("editkin.motion-vector-shape/v1"), kind: z.literal("shape"), heightPixels: z.number().finite().min(1).max(4096),
    revealFrames: z.number().int().min(1).max(600), revealFrom: z.enum(["left", "right", "top", "bottom"]).optional(),
    commands: z.array(motionVectorShapeCommandSchema).min(2).max(4096) }),
  z.strictObject({ ...vectorBase, schema: z.enum(["editkin.motion-vector/v1", "editkin.motion-vector-stage/v1", "editkin.motion-vector-annotation/v1"]), kind: z.literal("rule") }),
  z.strictObject({ ...vectorBase, kind: z.enum(["panel", "ellipse"]) }),
  z.strictObject({ ...vectorBase, kind: z.literal("step_progress"), steps: z.number().int().min(1).max(12),
    activeStep: z.number().int().min(0).max(12), gapPixels: z.number().finite().min(0).max(128) }),
  z.strictObject({ ...vectorBase, kind: z.literal("dot_grid"), spacingPixels: z.number().finite().min(8).max(512),
    dotRadiusPixels: z.number().finite().min(.25).max(32) }),
  z.strictObject({ ...vectorBase, kind: z.literal("line_grid"), spacingPixels: z.number().finite().min(8).max(512),
    lineWidthPixels: z.number().finite().min(.25).max(8), majorEvery: z.number().int().min(2).max(12) }),
  z.strictObject({ ...vectorBase, kind: z.literal("connection_field"), seed: z.number().int().min(0).max(0xffffffff),
    points: z.number().int().min(8).max(64), dotRadiusPixels: z.number().finite().min(.5).max(12),
    lineWidthPixels: z.number().finite().min(.5).max(8), burstFrames: z.number().int().min(1).max(180),
    gatherStartFrame: z.number().int().nonnegative().max(1800), gatherFrames: z.number().int().min(1).max(180),
    connectStartFrame: z.number().int().nonnegative().max(1800), connectFrames: z.number().int().min(1).max(180),
    groupColors: z.tuple([z.string().regex(/^#[0-9a-f]{6}$/i), z.string().regex(/^#[0-9a-f]{6}$/i), z.string().regex(/^#[0-9a-f]{6}$/i)]).optional() }),
]);
// A variant is an explicit style contract, not a second command language.
// Reject unknown nested fields instead of silently discarding expressions.
const variantEasingSchema = z.discriminatedUnion("type", [
  motionV2EasingSchema.options[0].strict(),
  motionV2EasingSchema.options[1].strict(),
  motionV2EasingSchema.options[2].strict(),
]);
const variantPhaseSchema = motionV2PhaseSchema.extend({ easing: variantEasingSchema }).strict();
export const motionPresetOverridesSchema = z.strictObject({
  compositeLayer: z.enum(["background", "foreground"]).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  x: z.number().finite().min(0).max(1).optional(),
  y: z.number().finite().min(0).max(1).optional(),
  width: z.number().finite().min(.01).max(1).optional(),
  fontSize: z.number().finite().min(8).max(384).optional(),
  fontFamily: z.string().trim().min(1).max(160).optional(),
  fontWeight: z.number().finite().min(100).max(1_000).optional(),
  letterSpacing: z.number().finite().min(-16).max(64).optional(),
  outlineWidth: z.number().finite().min(0).max(24).optional(),
  shadowDepth: z.number().finite().min(0).max(64).optional(),
  cornerRadius: z.number().finite().min(0).max(384).optional(),
  textColor: z.string().regex(/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i).optional(),
  backgroundColor: z.string().regex(/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i).optional(),
  accentColor: z.string().regex(/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i).optional(),
  motionV2: motionV2Schema.extend({
    sequence: motionV2Schema.shape.sequence.strict(),
    entrance: variantPhaseSchema,
    exit: variantPhaseSchema,
  }).strict().optional(),
  layoutV2: layoutV2Schema.extend({ safeArea: layoutV2Schema.shape.safeArea.strict() }).strict().optional(),
  vectorV2: motionVectorV2Schema.optional(),
  // A paint variant is declared before source compilation, never attached to
  // an authenticated scene afterwards. The resolved graphic validates the pair.
  visualStyle: z.literal("native_paint").optional(),
  paintV1: motionPaintDescriptorSchema.optional(),
});
export const motionPresetVariantSchema = z.strictObject({
  schema: z.literal("editkin.motion-preset-variant/v1"),
  basePresetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(480),
  overrides: motionPresetOverridesSchema.refine(
    (overrides) => Object.values(overrides).some(value => value !== undefined),
    "變體必須明確宣告至少一個視覺參數",
  ),
});
export type MotionPresetVariant = z.infer<typeof motionPresetVariantSchema>;

const motionGraphicBaseSchema = z.object({
  compositeLayer: z.enum(["background", "foreground"]).optional(),
  schema: z.enum(["hao.motion-composition/v1", "hao.motion-composition/v2"]), id: z.string(), presetId: z.string().optional(), name: z.string(), kind: z.enum(["title", "card", "tag", "counter"]),
  text: z.string(), timelineStart: z.number(), duration: z.number(), x: z.number(), y: z.number(), width: z.number(), fontSize: z.number(),
  fontFamily: z.string().optional(), fontWeight: z.number().optional(), letterSpacing: z.number().optional(), outlineWidth: z.number().optional(), shadowDepth: z.number().optional(), cornerRadius: z.number().optional(),
  textColor: z.string(), backgroundColor: z.string(), accentColor: z.string(), animation: z.enum(["fade", "slide_up", "pop", "spring_soft"]),
  visualStyle: z.enum(["native_paint", "solid_panel", "holo_scan_cyan", "holo_grid_lime", "target_lock_red", "spectral_wire_violet", "depth_glass_blue", "telemetry_beam_amber", "neon_extrude_white", "quantum_label_magenta"]).optional(),
  paintV1: motionPaintDescriptorSchema.optional(),
  trackId: z.string().optional(), trackingMode: z.enum(["anchor", "surface"]).optional(), offsetX: z.number(), offsetY: z.number(),
  motionV2: motionV2Schema.optional(), layoutV2: layoutV2Schema.optional(), vectorV2: motionVectorV2Schema.optional(),
  templateOwner: templateElementOwnerSchema.optional(),
});
export const motionGraphicSchema = motionGraphicBaseSchema.superRefine((graphic, context) => {
  try { assertMotionPaintContract(graphic); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error), path: ["paintV1"] }); }
  if (graphic.compositeLayer === "background" && (graphic.schema !== "hao.motion-composition/v2" || !graphic.vectorV2 || graphic.text || graphic.trackId)) {
    context.addIssue({ code: "custom", message: "背景合成只接受無文字／追蹤的 v2 原生向量", path: ["compositeLayer"] });
  }
  if (graphic.compositeLayer === "background" && graphic.vectorV2?.schema !== "editkin.motion-vector-stage/v1") {
    context.addIssue({ code: "custom", message: "背景合成需要 stage 向量版本，避免舊程式忽略合成位置", path: ["vectorV2", "schema"] });
  }
  if (graphic.schema === "hao.motion-composition/v1" && (graphic.motionV2 !== undefined || graphic.layoutV2 !== undefined || graphic.vectorV2 !== undefined)) {
    context.addIssue({ code: "custom", message: "v1 不可攜帶 v2 motion/layout 參數", path: ["schema"] });
  }
  if (graphic.schema === "hao.motion-composition/v2" && (!graphic.motionV2 || !graphic.layoutV2)) {
    context.addIssue({ code: "custom", message: "v2 必須同時包含 motionV2 與 layoutV2", path: ["schema"] });
  }
});
const directorMarkerSchema = z.object({
  id: z.string(), time: z.number(), title: z.string(), note: z.string(), kind: z.enum(["beat", "note", "risk", "pickup"]),
  status: z.enum(["open", "resolved"]), createdAt: z.string(), templateOwner: templateElementOwnerSchema.optional(),
});
const directorStateSchema = z.object({
  schema: z.literal("editkin.director-console/v1"), reviewState: z.enum(["draft", "reviewing", "changes_requested", "ready_for_hao_review"]),
  markers: z.array(directorMarkerSchema), updatedAt: z.string(),
});
const compositionSchema = z.object({
  schema: z.literal("editkin.composition/v1"), id: z.string(), name: z.string(), width: z.number(), height: z.number(), fps: z.number(), duration: z.number(),
  referenceMotionInstances: z.never().optional(),
  tracks: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.enum(["video", "audio", "caption"]), locked: z.boolean(), muted: z.boolean(), clips: z.array(clipSchema),
  })),
  captions: z.array(captionSchema), captionStyle: captionStyleSchema, motionTracks: z.array(motionTrackSchema), motionGraphics: z.array(motionGraphicSchema), motionScenes: z.array(motionScene2dSchema).max(16).optional(),
  director: directorStateSchema,
  colorManagement: z.object({ mode: z.enum(["rec709", "aces2"]), workingSpace: z.literal("ACEScct"), outputTransform: z.enum(["rec709_sdr", "p3d65_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"]), configId: z.literal("studio-config-v4.0.0_aces-v2.0_ocio-v2.5") }).optional(),
  scene25d: scene25dSchema.optional(),
  scene3d: mesh3dSceneSchema.optional(),
  particleSimulation: particleSimulationSchema.optional(),
  updatedAt: z.string(),
});
export const aestheticBenchmarkReviewSchema = z.strictObject({
  schema: z.literal("editkin.aesthetic-benchmark-review/v1"),
  artifact: z.strictObject({ outputSha256: z.string().regex(/^[a-f0-9]{64}$/i), fps: z.number().finite().positive(), durationFrames: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional(),
  axes: z.object({
    mrbeast_information_energy: z.record(z.string(), z.object({ rating: z.number().min(1).max(5).optional(), evidence: z.array(z.object({ fromFrame: z.number().int().nonnegative(), toFrame: z.number().int().positive(), observation: z.string() })) })).optional(),
    yingshi_hurricane_cinematic_craft: z.record(z.string(), z.object({ rating: z.number().min(1).max(5).optional(), evidence: z.array(z.object({ fromFrame: z.number().int().nonnegative(), toFrame: z.number().int().positive(), observation: z.string() })) })).optional(),
  }).strict(),
}).superRefine((review, context) => {
  for (const axis of BENCHMARK_AXES) for (const [id, item] of Object.entries(review.axes[axis] ?? {})) {
    if (!AESTHETIC_BENCHMARKS[axis].some(row => row.id === id)) context.addIssue({ code: "custom", path: ["axes", axis, id], message: "Unknown benchmark item" });
    item.evidence.forEach((e, index) => {
      if (!Number.isSafeInteger(e.fromFrame) || !Number.isSafeInteger(e.toFrame) || e.toFrame <= e.fromFrame || (review.artifact && e.toFrame > review.artifact.durationFrames)) {
        context.addIssue({ code: "custom", path: ["axes", axis, id, "evidence", index], message: "Evidence must reference a valid half-open output frame range" });
      }
    });
  }
});
const aestheticReviewSchema = z.object({
  status: z.enum(["REVIEW", "BLOCKED", "PASSED"]), score: z.number().min(0).max(100), ratings: z.record(z.string(), z.number().min(1).max(5)),
  machineBlockers: z.array(z.string()), completedAt: z.string().optional(),
  benchmarkReview: aestheticBenchmarkReviewSchema.optional(),
  reviewer: z.enum(["human", "agent"]).optional(),
});
export const aestheticSystemSchema = z.object({
  schema: z.literal("editkin.aesthetic-system/v1"), standardId: z.literal("editkin-community-aesthetic-standard"), standardVersion: z.string(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/i), format: z.enum(["shorts", "longform"]), domain: z.string(), primaryFamily: z.string(), primaryLabel: z.string(),
  supportFamilies: z.array(z.string()).max(4), avoid: z.array(z.string()).max(16), sharedDnaSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  dimensions: z.array(z.object({ id: z.string(), labelZh: z.string(), question: z.string(), weight: z.number().positive() })).length(10),
  scoreContract: z.object({ passScore: z.number(), blockBelow: z.number(), minimumDimensionRating: z.number(), humanReviewRequired: z.boolean() }),
  reviewPolicy: reviewPolicySchema.optional(),
  review: aestheticReviewSchema,
}).superRefine((system, context) => {
  if (!system.scoreContract.humanReviewRequired && system.reviewPolicy?.mode !== "agent_reference_comparison") {
    context.addIssue({ code: "custom", path: ["reviewPolicy"], message: "Agent visual review requires explicit creator authorization" });
  }
  if (system.scoreContract.humanReviewRequired && system.reviewPolicy?.mode === "agent_reference_comparison") {
    context.addIssue({ code: "custom", path: ["scoreContract"], message: "Explicit agent review policy cannot keep a contradictory human-only completion gate" });
  }
});

const templateCreativeSnapshotSchema = z.strictObject({
  clipId: z.string().min(1),
  creativePresent: z.boolean(),
  lookPresetId: z.string().nullable(),
  effectPresetIds: z.array(z.string()),
  transitionIn: creativeTransitionSchema.nullable(),
  transitionOut: creativeTransitionSchema.nullable(),
  floatingFrame: floatingVideoFrameSchema.nullable().optional(),
  transform: transformSchema.optional(),
});
const templateApplicationSnapshotSchema = z.strictObject({
  editorialProfile: z.enum(["auto", "gaming", "food", "travel", "music_mv", "podcast_on_camera", "podcast_no_face"]),
  aestheticSystem: aestheticSystemSchema.nullable(),
  captionStyle: captionStyleSchema,
  clips: z.array(templateCreativeSnapshotSchema).min(1),
});
const templateApplicationSchema = z.strictObject({
  schema: z.literal("editkin.template-application/v1"),
  sessionId: z.string().min(1).max(160),
  templateId: z.string().min(1).max(160),
  templateName: z.string().min(1).max(160),
  format: z.enum(["short", "long"]),
  createdAt: z.string(),
  before: templateApplicationSnapshotSchema,
  applied: templateApplicationSnapshotSchema,
  generatedClips: z.array(z.strictObject({ clipId: z.string().min(1), trackId: z.string().min(1) })).max(32).optional(),
}).superRefine((application, context) => {
  const originals = new Set(application.before.clips.map(clip => clip.clipId));
  const seen = new Set<string>();
  for (const owned of application.generatedClips ?? []) {
    if (originals.has(owned.clipId) || seen.has(owned.clipId)) context.addIssue({ code: "custom", message: "模板生成片段不能指向原始片段或重複身分" });
    seen.add(owned.clipId);
  }
});

const projectFields = {
  revision: z.number().int().nonnegative(), id: z.string(), name: z.string(), width: z.number(), height: z.number(), fps: z.number(),
  editorialProfile: z.enum(["auto", "gaming", "food", "travel", "music_mv", "podcast_on_camera", "podcast_no_face"]),
  aestheticSystem: aestheticSystemSchema.optional(),
  colorManagement: z.object({ mode: z.enum(["rec709", "aces2"]), workingSpace: z.literal("ACEScct"), outputTransform: z.enum(["rec709_sdr", "p3d65_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"]), configId: z.literal("studio-config-v4.0.0_aces-v2.0_ocio-v2.5") }).optional(),
  scene25d: scene25dSchema.optional(),
  scene3d: mesh3dSceneSchema.optional(),
  particleSimulation: particleSimulationSchema.optional(),
  assets: z.array(assetSchema),
  compositions: z.array(compositionSchema),
  tracks: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.enum(["video", "audio", "caption"]), locked: z.boolean(), muted: z.boolean(), clips: z.array(clipSchema),
  })),
  captions: z.array(captionSchema), captionStyle: captionStyleSchema, motionTracks: z.array(motionTrackSchema), motionGraphics: z.array(motionGraphicSchema), motionScenes: z.array(motionScene2dSchema).max(16).optional(), director: directorStateSchema,
  templateApplication: templateApplicationSchema.optional(), updatedAt: z.string(),
};
export const projectSchema: z.ZodType<EditProject> = z.discriminatedUnion("schemaVersion", [
  z.object({ ...projectFields, schemaVersion: z.literal(9), referenceMotionInstances: z.never().optional() }),
  z.object({ ...projectFields, schemaVersion: z.literal(10), referenceMotionInstances: z.array(referenceMotionInstanceSchema).max(32).optional() }),
]).superRefine((project, ctx) => {
  try {
    assertReferenceMotionInstances(project);
    assertMotionScenes2D(project);
    for (const composition of project.compositions) assertMotionScenes2D(composition);
  } catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) }); }
});

export const editorCommandSchema: z.ZodType<EditorCommand> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("import_asset"), asset: assetSchema }),
  z.object({ type: z.literal("delete_asset"), assetId: z.string() }),
  z.object({ type: z.literal("add_clip"), clip: clipSchema }),
  z.strictObject({ type: z.literal("replace_clip_source"),
    clipId: z.string().min(1).max(160).refine(value => value === value.trim() && !/[\u0000\r\n]/.test(value)),
    expectedAssetId: z.string().min(1).max(160).refine(value => value === value.trim() && !/[\u0000\r\n]/.test(value)),
    assetId: z.string().min(1).max(160).refine(value => value === value.trim() && !/[\u0000\r\n]/.test(value)),
    sourceStart: z.number().finite().nonnegative() }),
  z.object({ type: z.literal("add_track"), track: z.object({ id: z.string(), name: z.string(), kind: z.enum(["video", "audio", "caption"]), locked: z.boolean(), muted: z.boolean(), clips: z.array(clipSchema) }) }),
  z.object({ type: z.literal("precompose_clips"), compositionId: z.string(), assetId: z.string(), replacementClipId: z.string(), targetTrackId: z.string(), name: z.string(), clipIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("delete_track"), trackId: z.string() }),
  z.object({ type: z.literal("rename_track"), trackId: z.string(), name: z.string() }),
  z.object({ type: z.literal("toggle_track_lock"), trackId: z.string() }),
  z.object({ type: z.literal("toggle_track_mute"), trackId: z.string() }),
  z.object({ type: z.literal("move_clip_to_track"), clipId: z.string(), trackId: z.string(), timelineStart: z.number() }),
  z.object({ type: z.literal("split_clip"), clipId: z.string(), at: z.number(), newClipId: z.string() }),
  z.object({ type: z.literal("delete_clip"), clipId: z.string() }),
  z.object({ type: z.literal("ripple_delete_clip"), clipId: z.string() }),
  z.object({ type: z.literal("move_clip"), clipId: z.string(), timelineStart: z.number() }),
  z.object({ type: z.literal("trim_clip_start"), clipId: z.string(), seconds: z.number() }),
  z.object({ type: z.literal("trim_clip_end"), clipId: z.string(), seconds: z.number() }),
  z.object({ type: z.literal("set_clip_volume"), clipId: z.string(), volume: z.number() }),
  z.object({ type: z.literal("compact_track"), trackId: z.string() }),
  z.object({
    type: z.literal("smart_cut_clip"), clipId: z.string(),
    keepRanges: z.array(z.object({ start: z.number(), end: z.number() })).min(1),
    segmentIds: z.array(z.string()).min(1),
  }),
  z.object({ type: z.literal("update_clip_transform"), clipId: z.string(), patch: transformSchema.partial() }),
  z.strictObject({ type: z.literal("set_mesh_3d_scene"), scene: mesh3dSceneSchema.optional() }),
  z.object({ type: z.literal("configure_scene_25d"), enabled: z.boolean() }),
  z.object({ type: z.literal("set_scene_25d_settings"), settings: scene25dSchema }),
  z.object({ type: z.literal("update_clip_transform_3d"), clipId: z.string(), patch: transform3dSchema.partial() }),
  z.object({ type: z.literal("set_clip_floating_frame"), clipId: z.string(), frame: floatingVideoFrameSchema.optional() }),
  z.object({ type: z.literal("configure_particle_simulation"), enabled: z.boolean() }),
  z.object({ type: z.literal("set_particle_simulation_settings"), settings: particleSimulationSchema }),
  z.object({ type: z.literal("set_clip_color"), clipId: z.string(), patch: rawColorSchema.partial() }),
  z.object({ type: z.literal("set_clip_creative"), clipId: z.string(), patch: z.object({
    lookPresetId: z.string().nullable().optional(), effectPresetIds: z.array(z.string()).optional(),
    transitionIn: creativeTransitionSchema.nullable().optional(), transitionOut: creativeTransitionSchema.nullable().optional(),
  }) }),
  z.object({ type: z.literal("add_native_effect"), clipId: z.string(), instance: nativeEffectInstanceSchema }),
  z.object({ type: z.literal("update_native_effect"), clipId: z.string(), instanceId: z.string(), patch: z.object({
    enabled: z.boolean().optional(), parameters: nativeEffectInstanceSchema.shape.parameters.optional(),
  }) }),
  z.object({ type: z.literal("reorder_native_effect"), clipId: z.string(), instanceId: z.string(), toIndex: z.number().int().nonnegative() }),
  z.object({ type: z.literal("remove_native_effect"), clipId: z.string(), instanceId: z.string() }),
  z.object({ type: z.literal("set_clip_layout"), clipId: z.string(), layout: clipLayoutSchema.optional() }),
  z.object({ type: z.literal("add_clip_mask"), clipId: z.string(), mask: productClipMaskSchema }),
  z.object({ type: z.literal("update_clip_mask"), clipId: z.string(), maskId: z.string(), patch: productClipMaskSchema.omit({ id: true }).partial() }),
  z.object({ type: z.literal("delete_clip_mask"), clipId: z.string(), maskId: z.string() }),
  z.object({ type: z.literal("set_clip_mask_track"), clipId: z.string(), maskId: z.string(), trackId: z.string().optional() }),
  z.object({ type: z.literal("set_clip_mask_keyframe"), clipId: z.string(), maskId: z.string(), keyframe: maskKeyframeSchema }),
  z.object({ type: z.literal("freeze_clip_mask_range"), clipId: z.string(), maskId: z.string(), fromFrame: z.number().int(), toFrame: z.number().int() }),
  z.object({ type: z.literal("set_clip_chroma_key"), clipId: z.string(), settings: chromaKeySchema.optional() }),
  z.object({ type: z.literal("set_clip_layer"), clipId: z.string(), patch: z.object({
    enabled: z.boolean().optional(), blendMode: layerBlendModeSchema.optional(), role: layerRoleSchema.optional(),
    parentClipId: z.string().optional(), trackMatte: clipTrackMatteSchema.optional(),
  }) }),
  z.object({ type: z.literal("set_clip_expression"), clipId: z.string(), property: expressionPropertySchema, expression: haoExpressionSchema.nullable() }),
  z.object({ type: z.literal("add_keyframe"), clipId: z.string(), keyframe: keyframeSchema }),
  z.object({ type: z.literal("update_keyframe"), clipId: z.string(), keyframeId: z.string(), patch: z.object({ time: z.number(), transform: transformSchema, color: colorSchema, easing: easingSchema }).partial() }),
  z.object({ type: z.literal("delete_keyframe"), clipId: z.string(), keyframeId: z.string() }),
  z.object({ type: z.literal("add_motion_track"), track: motionTrackSchema }),
  z.object({ type: z.literal("delete_motion_track"), trackId: z.string() }),
  z.object({ type: z.literal("set_motion_track_point"), trackId: z.string(), point: motionTrackPointSchema }),
  z.strictObject({ type: z.literal("add_motion_scene"), scene: motionScene2dSchema }),
  z.strictObject({ type: z.literal("update_motion_scene"), sceneId: z.string(), scene: motionScene2dSchema }),
  z.strictObject({ type: z.literal("revise_motion_scene_graphics"), expectedRevision: z.number().int().nonnegative(), expectedScene: motionScene2dSchema,
    expectedGraphics: z.array(motionGraphicSchema).min(1).max(32), graphics: z.array(motionGraphicSchema).min(1).max(32) }),
  z.strictObject({ type: z.literal("revise_original_motion_scene_graphic"), sceneId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i),
    expectedGraphic: motionGraphicSchema, graphic: motionGraphicSchema }),
  z.strictObject({ type: z.literal("delete_motion_scene"), sceneId: z.string() }),
  z.object({ type: z.literal("add_motion_graphic"), graphic: motionGraphicSchema }),
  z.object({ type: z.literal("update_motion_graphic"), graphicId: z.string(), patch: motionGraphicBaseSchema.omit({ id: true }).partial() }),
  z.object({ type: z.literal("delete_motion_graphic"), graphicId: z.string() }),
  z.strictObject({ type: z.literal("reorder_motion_graphics"), graphicIds: z.array(z.string().min(1).max(160)).min(1).max(128).refine(ids => new Set(ids).size === ids.length, "Motion graphic reorder identities must be unique") }),
  z.object({ type: z.literal("set_asset_derivatives"), assetId: z.string(), derivatives: derivativesSchema.optional() }),
  z.strictObject({ type: z.literal("relink_asset_source"), assetId: z.string().min(1), sourceUri: z.string().trim().min(1).max(1024), expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ type: z.literal("set_asset_color_interpretation"), assetId: z.string(), interpretation: z.enum(["auto", "rec709", "linear_rec709", "srgb", "hlg", "pq", "acescct", "apple_log", "arri_logc3", "arri_logc4", "bmd_film_gen5", "canon_log2", "canon_log3", "dji_dlog", "panasonic_vlog", "red_log3g10", "sony_slog3_cine", "log_unresolved"]) }),
  z.object({ type: z.literal("set_asset_alpha_mode"), assetId: z.string(), alphaMode: z.enum(["auto", "opaque", "straight", "premultiplied"]) }),
  z.object({ type: z.literal("set_project_color_management"), patch: z.object({ mode: z.enum(["rec709", "aces2"]), outputTransform: z.enum(["rec709_sdr", "p3d65_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"]) }).partial() }),
  z.object({ type: z.literal("add_caption"), caption: captionSchema }),
  z.object({ type: z.literal("update_caption"), captionId: z.string(), patch: z.object({
    text: z.string().optional(), start: z.number().optional(), duration: z.number().optional(),
    translation: z.object({ text: z.string(), language: z.string() }).nullable().optional(),
  }) }),
  z.object({ type: z.literal("delete_caption"), captionId: z.string() }),
  z.object({ type: z.literal("set_caption_style"), patch: captionStyleSchema.partial() }),
  z.object({ type: z.literal("add_director_marker"), marker: directorMarkerSchema }),
  z.object({ type: z.literal("update_director_marker"), markerId: z.string(), patch: directorMarkerSchema.pick({ time: true, title: true, note: true, kind: true, status: true }).partial() }),
  z.object({ type: z.literal("delete_director_marker"), markerId: z.string() }),
  z.object({ type: z.literal("set_director_review_state"), reviewState: z.enum(["draft", "reviewing", "changes_requested", "ready_for_hao_review"]) }),
  z.object({ type: z.literal("set_editorial_profile"), profile: z.enum(["auto", "gaming", "food", "travel", "music_mv", "podcast_on_camera", "podcast_no_face"]) }),
  z.object({ type: z.literal("set_aesthetic_system"), aestheticSystem: aestheticSystemSchema }),
  z.object({ type: z.literal("set_aesthetic_review"), review: aestheticReviewSchema }),
  z.object({ type: z.literal("set_project_resolution"), width: z.number().int().positive(), height: z.number().int().positive() }),
  z.object({ type: z.literal("set_template_application"), application: templateApplicationSchema }),
  z.object({ type: z.literal("clear_template_application") }),
  z.strictObject({ type: z.literal("upsert_reference_motion_instance"), instance: referenceMotionInstanceSchema, expectedInstanceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }),
  z.strictObject({ type: z.literal("remove_reference_motion_instance"), id: z.string().min(1).max(160), expectedInstanceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.object({ type: z.literal("rename_project"), name: z.string() }),
  z.object({ type: z.literal("batch"), commands: z.array(editorCommandSchema) }),
]));
