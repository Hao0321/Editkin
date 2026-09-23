import { easingProgress } from "../domain/editGraph";
import type { KeyframeEasing } from "../domain/types";
import type { GpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import {
  engineBlendCodes,
  type ExpectedEngineVideoAdjustment,
  type ExpectedEngineVideoController,
  type ExpectedEngineVideoLayer,
} from "./residentGpuPreviewExpectations";
import { sameF32 } from "./residentGpuPreviewReceipts";
import type {
  GpuEngineVideoAdjustmentReceipt,
  GpuEngineVideoControllerReceipt,
  GpuEngineVideoMotionBlurReceipt,
  GpuEngineVideoTemporalSamplingReceipt,
  GpuEngineVideoVisualGraph,
} from "./types";

const linearWhiteBalanceProcessors = new Set([
  "editkin-rec709-primary/v2",
  "editkin-rec709-to-linear-rec709-primary/v2",
  "editkin-linear-primary/v2",
]);
function whiteBalanceMatches(visual: GpuEngineVideoVisualGraph, grade: Record<string, unknown> | undefined, processor: unknown): boolean {
  const keys = ["whiteBalanceRed", "whiteBalanceGreen", "whiteBalanceBlue"] as const;
  const expected = keys.map(key => grade?.[key] === undefined ? 0 : grade[key]);
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= -4 && value <= 4;
  if (!expected.every(valid)) return false;
  const v2 = typeof processor === "string" && linearWhiteBalanceProcessors.has(processor);
  const legacyZero = typeof processor === "string" && processor.endsWith("/v1") && expected.every(value => value === 0);
  if (!v2 && !legacyZero) return false;
  const inputTransfer = processor === "editkin-rec709-to-linear-rec709-primary/v2" ? 2
    : processor === "editkin-linear-primary/v2" || processor === "editkin-linear-primary/v1" ? 0 : 1;
  if ((v2 || visual.inputTransfer !== undefined) && visual.inputTransfer !== inputTransfer) return false;
  return keys.every((key, index) => {
    const actual = visual[key] === undefined && legacyZero ? 0 : visual[key];
    return valid(actual) && sameF32(actual, expected[index]);
  });
}

export function adjustmentActiveAt(expected: ExpectedEngineVideoAdjustment, timelineFrame: number): boolean {
  const timeline = expected.adjustment.timeline as { timelineStartFrame: number; durationFrames: number } | undefined;
  return Boolean(timeline && timelineFrame >= timeline.timelineStartFrame && timelineFrame < timeline.timelineStartFrame + timeline.durationFrames);
}

function adjustmentVisualMatches(
  visual: GpuEngineVideoVisualGraph,
  expected: ExpectedEngineVideoAdjustment,
  graph: GpuEngineVideoPreviewGraph["graph"],
): boolean {
  const grade = expected.grade.grade as Record<string, unknown> | undefined;
  return visual.effectKind === expected.effectKind
    && (expected.shaderEffectExpected ? visual.shaderOpCount >= 1 && visual.shaderOpCount <= 16 : visual.shaderOpCount === 0)
    && visual.sourceWidth === graph.width && visual.sourceHeight === graph.height
    && sameF32(visual.translateX, 0) && sameF32(visual.translateY, 0)
    && sameF32(visual.scale, 1) && sameF32(visual.rotation, 0) && sameF32(visual.opacity, 1)
    && Boolean(grade)
    && sameF32(visual.brightness, grade?.brightness)
    && sameF32(visual.contrast, grade?.contrast)
    && sameF32(visual.saturation, grade?.saturation)
    && sameF32(visual.hue, grade?.hue)
    && sameF32(visual.exposure, grade?.exposure)
    && sameF32(visual.temperature, grade?.temperature)
    && sameF32(visual.tint, grade?.tint)
    && whiteBalanceMatches(visual, grade, expected.grade.processor)
    && sameF32(visual.pivot, grade?.pivot)
    && sameF32(visual.shadows, grade?.shadows)
    && sameF32(visual.highlights, grade?.highlights)
    && sameF32(visual.blacks, grade?.blacks)
    && sameF32(visual.whites, grade?.whites)
    && visual.blendMode === 0 && visual.matteMode === 0 && sameF32(visual.compositeOpacity, 1)
    && visual.motionSampleCount === 0 && visual.motionContractCode === 0 && sameF32(visual.motionShutterAngle, 0);
}

export function adjustmentReceiptMatches(
  receipt: GpuEngineVideoAdjustmentReceipt,
  expected: ExpectedEngineVideoAdjustment,
  graph: GpuEngineVideoPreviewGraph["graph"],
): boolean {
  const timeline = expected.adjustment.timeline as { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number } | undefined;
  return JSON.stringify(receipt.nodeIds) === JSON.stringify(expected.nodeIds)
    && Boolean(timeline)
    && receipt.timeline.timelineStartFrame === timeline?.timelineStartFrame
    && receipt.timeline.sourceStartFrame === timeline?.sourceStartFrame
    && receipt.timeline.durationFrames === timeline?.durationFrames
    && adjustmentVisualMatches(receipt.visualGraph, expected, graph);
}

interface SampledExpectedTransform {
  x: number;
  y: number;
  scaleX: number;
  rotationRadians: number;
  opacity: number;
}

type ExpectedEngineVideoTransformOwner = ExpectedEngineVideoLayer | ExpectedEngineVideoController;

function sampledExpectedTransform(expected: ExpectedEngineVideoTransformOwner, timelineFrame: number): SampledExpectedTransform {
  const base = {
    x: Number(expected.transform.x), y: Number(expected.transform.y), scaleX: Number(expected.transform.scaleX),
    rotationRadians: Number(expected.transform.rotationRadians), opacity: Number(expected.transform.opacity),
  };
  const keyframes = (expected.transform.keyframes as Array<Record<string, unknown>> | undefined) ?? [];
  if (!keyframes.length) return base;
  const timeline = expected.source.timeline as { timelineStartFrame: number } | undefined;
  const localFrame = Math.max(0, timelineFrame - (timeline?.timelineStartFrame ?? 0));
  const points = [{ frame: 0, ...base, easing: "linear" }, ...keyframes.map((keyframe) => ({
    frame: Number(keyframe.frame), x: Number(keyframe.x), y: Number(keyframe.y), scaleX: Number(keyframe.scaleX),
    rotationRadians: Number(keyframe.rotationRadians), opacity: Number(keyframe.opacity), easing: String(keyframe.easing),
  }))];
  const nextIndex = points.findIndex((point) => point.frame >= localFrame);
  if (nextIndex < 0) return points.at(-1)!;
  if (nextIndex === 0) return points[0];
  const previous = points[nextIndex - 1]; const next = points[nextIndex];
  if (previous.easing === "hold" || next.frame === previous.frame) return previous;
  const ratio = easingProgress((localFrame - previous.frame) / (next.frame - previous.frame), previous.easing as KeyframeEasing);
  return Object.fromEntries(["x", "y", "scaleX", "rotationRadians", "opacity"].map((key) => [key, previous[key as keyof typeof previous] as number + ((next[key as keyof typeof next] as number) - (previous[key as keyof typeof previous] as number)) * ratio])) as unknown as SampledExpectedTransform;
}

function sampledExpectedComposedTransform(
  expected: ExpectedEngineVideoTransformOwner,
  layers: ExpectedEngineVideoLayer[],
  controllers: ExpectedEngineVideoController[],
  timelineFrame: number,
): SampledExpectedTransform {
  const local = sampledExpectedTransform(expected, timelineFrame);
  const parentOwner = expected.parentLayerIndex !== undefined ? layers[expected.parentLayerIndex]
    : expected.parentControllerIndex !== undefined ? controllers[expected.parentControllerIndex] : undefined;
  if (!parentOwner) return local;
  const parent = sampledExpectedComposedTransform(parentOwner, layers, controllers, timelineFrame);
  const cosine = Math.cos(parent.rotationRadians); const sine = Math.sin(parent.rotationRadians);
  return {
    x: parent.x + (local.x * cosine - local.y * sine) * parent.scaleX,
    y: parent.y + (local.x * sine + local.y * cosine) * parent.scaleX,
    scaleX: parent.scaleX * local.scaleX,
    rotationRadians: parent.rotationRadians + local.rotationRadians,
    opacity: parent.opacity * local.opacity,
  };
}

export function engineVisualMatches(
  visual: GpuEngineVideoVisualGraph,
  expected: ExpectedEngineVideoLayer,
  layers: ExpectedEngineVideoLayer[],
  controllers: ExpectedEngineVideoController[],
  graph: GpuEngineVideoPreviewGraph["graph"],
  timelineFrame: number,
  motionSamplesRequired = false,
): boolean {
  const grade = expected.grade.grade as Record<string, unknown> | undefined;
  const projective = expected.transform.kind === "transform3d";
  const transform = projective ? { x: 0, y: 0, scaleX: 1, rotationRadians: 0, opacity: 1 }
    : sampledExpectedComposedTransform(expected, layers, controllers, timelineFrame);
  const motionBlur = expected.motionBlur;
  const shutterAngle = Number(motionBlur?.shutterAngle ?? 0);
  const sampleCount = Number(motionBlur?.samples ?? 0);
  const sampleFrames = motionBlur ? Array.from({ length: sampleCount }, (_, index) => {
    const timeline = expected.source.timeline as { timelineStartFrame: number; durationFrames: number };
    const centered = (index + .5) / sampleCount - .5;
    return Math.min(timeline.timelineStartFrame + timeline.durationFrames - 1, Math.max(timeline.timelineStartFrame, timelineFrame + shutterAngle / 360 * centered));
  }) : [];
  const observedFrames = visual.motionSampleFrames.flat().slice(0, sampleCount);
  const expectedContractCode = motionBlur?.sourceSampling === "decoded_temporal" ? 2 : 1;
  const motionSamplesMatch = !motionBlur
    ? visual.motionSampleCount === 0 && visual.motionContractCode === 0 && sameF32(visual.motionShutterAngle, 0)
    : !motionSamplesRequired
      ? visual.motionSampleCount === 0 && visual.motionContractCode === 0 && sameF32(visual.motionShutterAngle, shutterAngle)
      : visual.motionSampleCount === sampleCount && visual.motionContractCode === expectedContractCode && sameF32(visual.motionShutterAngle, shutterAngle)
        && observedFrames.length === sampleCount && observedFrames.every((frame, index) => sameF32(frame, sampleFrames[index]))
        && visual.motionSamples.slice(0, sampleCount).every((sample, index) => {
          const expectedSample = sampledExpectedComposedTransform(expected, layers, controllers, sampleFrames[index]);
          return sameF32(sample[0], expectedSample.x) && sameF32(sample[1], expectedSample.y)
            && sameF32(sample[2], expectedSample.scaleX) && sameF32(sample[3], expectedSample.rotationRadians);
        });
  return visual.effectKind === expected.effectKind
    && (expected.shaderEffectExpected ? visual.shaderOpCount >= 1 && visual.shaderOpCount <= 16 : visual.shaderOpCount === 0)
    && visual.sourceWidth === graph.width && visual.sourceHeight === graph.height
    && (projective
      ? visual.projectiveEnabled > .5
        && [visual.projectiveH0, visual.projectiveH1, visual.projectiveH2, visual.projectiveH3, visual.projectiveH4, visual.projectiveH5, visual.projectiveH6, visual.projectiveH7,
          visual.shadeR, visual.shadeG, visual.shadeB].every(Number.isFinite)
        && visual.shadeR >= 0 && visual.shadeG >= 0 && visual.shadeB >= 0
      : visual.projectiveEnabled <= .5)
    && sameF32(visual.translateX, transform.x)
    && sameF32(visual.translateY, transform.y)
    && sameF32(visual.scale, transform.scaleX)
    && sameF32(visual.rotation, transform.rotationRadians)
    && sameF32(visual.opacity, transform.opacity)
    && Boolean(grade)
    && sameF32(visual.brightness, grade?.brightness)
    && sameF32(visual.contrast, grade?.contrast)
    && sameF32(visual.saturation, grade?.saturation)
    && sameF32(visual.hue, grade?.hue)
    && sameF32(visual.exposure, grade?.exposure)
    && sameF32(visual.temperature, grade?.temperature)
    && sameF32(visual.tint, grade?.tint)
    && whiteBalanceMatches(visual, grade, expected.grade.processor)
    && sameF32(visual.pivot, grade?.pivot)
    && sameF32(visual.shadows, grade?.shadows)
    && sameF32(visual.highlights, grade?.highlights)
    && sameF32(visual.blacks, grade?.blacks)
    && sameF32(visual.whites, grade?.whites)
    && visual.blendMode === engineBlendCodes[expected.blendMode]
    && visual.matteMode === 0
    && sameF32(visual.compositeOpacity, expected.compositeOpacity)
    && motionSamplesMatch;
}

export function motionBlurReceiptMatches(
  receipt: GpuEngineVideoMotionBlurReceipt | null | undefined,
  expected: ExpectedEngineVideoLayer,
): boolean {
  if (!expected.motionBlur) return receipt == null;
  const expectedSourceSampling = expected.motionBlur.sourceSampling === "decoded_temporal" ? "decoded_temporal" : "current_frame";
  const expectedContract = expectedSourceSampling === "decoded_temporal"
    ? "decoded-temporal-shutter-accumulation/v1"
    : "transform-shutter-accumulation/v1";
  return receipt?.contract === expectedContract
    && receipt.sourceSampling === expectedSourceSampling
    && receipt.nodeId === expected.motionBlur.id
    && sameF32(receipt.shutterAngle, expected.motionBlur.shutterAngle)
    && receipt.sampleCount === expected.motionBlur.samples;
}

export function temporalSamplingReceiptMatches(
  receipt: GpuEngineVideoTemporalSamplingReceipt | null | undefined,
  expectedLayers: ExpectedEngineVideoLayer[],
  graph: GpuEngineVideoPreviewGraph["graph"],
  timelineFrame: number,
): boolean {
  const temporalLayers = expectedLayers.filter((layer) => layer.motionBlur?.sourceSampling === "decoded_temporal");
  if (!temporalLayers.length) return receipt == null;
  if (temporalLayers.length !== 1 || !receipt) return false;
  const expected = temporalLayers[0];
  const samples = Number(expected.motionBlur?.samples ?? 0);
  const shutterAngle = Number(expected.motionBlur?.shutterAngle ?? 0);
  const timeline = expected.source.timeline as { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number };
  const expectedTargets = Array.from({ length: samples }, (_, index) => {
    const centered = (index + .5) / samples - .5;
    const sampledTimelineFrame = Math.min(timeline.timelineStartFrame + timeline.durationFrames - 1,
      Math.max(timeline.timelineStartFrame, timelineFrame + shutterAngle / 360 * centered));
    return (timeline.sourceStartFrame + sampledTimelineFrame - timeline.timelineStartFrame)
      * graph.timebase.numerator / graph.timebase.denominator;
  });
  return receipt.schema === "editkin.decoded-temporal-shutter-window/v1"
    && receipt.contract === "decoded-temporal-shutter-accumulation/v1"
    && receipt.sourceSampling === "decoded_temporal"
    && receipt.sampleCount === samples && receipt.sampleReceipts.length === samples
    && receipt.sampleReceipts.every((sample, index) => sameF32(sample.targetSeconds, expectedTargets[index])
      && Number.isInteger(sample.slotIndex) && sample.slotIndex >= 0 && sample.slotIndex < receipt.residentFrameRingSize
      && sample.clockWithinTolerance === true && Number.isSafeInteger(sample.gpuSubmissionSequence))
    && Number.isInteger(receipt.distinctDecodedTimestampCount) && receipt.distinctDecodedTimestampCount >= 1 && receipt.distinctDecodedTimestampCount <= samples
    && receipt.residentFrameRingSize >= samples && receipt.residentBytes > 0
    && receipt.gpuCopyCount >= 0 && receipt.gpuCopyCount <= samples
    && receipt.cacheHitCount === samples - receipt.gpuCopyCount
    && receipt.requestedToleranceSeconds > 0 && receipt.effectiveToleranceSeconds > 0
    && receipt.effectiveToleranceSeconds <= receipt.requestedToleranceSeconds
    && receipt.decodePathCpuPixelCopies === 0 && receipt.stagingCpuPixelReadbacks === 0
    && receipt.productPathCpuPixelCopies === 0;
}

export function controllerReceiptMatches(
  receipt: GpuEngineVideoControllerReceipt,
  expected: ExpectedEngineVideoController,
  layers: ExpectedEngineVideoLayer[],
  controllers: ExpectedEngineVideoController[],
  graph: GpuEngineVideoPreviewGraph["graph"],
  timelineFrame: number,
): boolean {
  const timeline = expected.source.timeline as { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number } | undefined;
  const transform = sampledExpectedComposedTransform(expected, layers, controllers, timelineFrame);
  const visual = receipt.visualGraph;
  return receipt.sourceNodeId === expected.sourceNodeId && receipt.transformNodeId === expected.transformNodeId
    && (receipt.parentTransformNodeId ?? undefined) === expected.parentTransformNodeId
    && (receipt.parentLayerIndex ?? undefined) === expected.parentLayerIndex
    && (receipt.parentControllerIndex ?? undefined) === expected.parentControllerIndex
    && receipt.parentDepth === expected.parentDepth && Boolean(timeline)
    && receipt.timeline.range.timelineStartFrame === timeline?.timelineStartFrame
    && receipt.timeline.range.sourceStartFrame === timeline?.sourceStartFrame
    && receipt.timeline.range.durationFrames === timeline?.durationFrames
    && receipt.timeline.timebaseNumerator === graph.timebase.numerator
    && receipt.timeline.timebaseDenominator === graph.timebase.denominator
    && sameF32(visual.translateX, transform.x) && sameF32(visual.translateY, transform.y)
    && sameF32(visual.scale, transform.scaleX) && sameF32(visual.rotation, transform.rotationRadians)
    && visual.shaderOpCount === 0
    && sameF32(visual.opacity, transform.opacity) && visual.effectKind === 0
    && sameF32(visual.brightness, 0) && sameF32(visual.contrast, 1) && sameF32(visual.saturation, 1)
    && sameF32(visual.hue, 0) && sameF32(visual.exposure, 0) && sameF32(visual.temperature, 0)
    && sameF32(visual.tint, 0) && sameF32(visual.pivot, .5) && sameF32(visual.shadows, 0)
    && whiteBalanceMatches(visual, undefined, "editkin-linear-primary/v1")
    && sameF32(visual.highlights, 0) && sameF32(visual.blacks, 0) && sameF32(visual.whites, 0)
    && visual.blendMode === 0 && visual.matteMode === 0 && sameF32(visual.compositeOpacity, 1)
    && visual.motionSampleCount === 0 && visual.motionContractCode === 0 && sameF32(visual.motionShutterAngle, 0);
}
