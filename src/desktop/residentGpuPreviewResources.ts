import type { EngineNode, EngineRenderGraph } from "../render/engineGraph";
import { estimateGpuEngineVideoResources } from "../render/gpuCompositor";
import type { GpuEngineVideoDecodeSchedule, GpuEngineVideoResourcePlan } from "./types";
import type { ExpectedEngineVideoLayer } from "./residentGpuPreviewExpectations";

export function engineVideoResourcePlanMatches(
  plan: GpuEngineVideoResourcePlan, graph: EngineRenderGraph, videoLayerCount: number, overlayCount: number,
  adjustmentCount: number, matteCount: number, particleCount: number,
): boolean {
  const temporalNodes = graph.nodes.filter((node) => node.kind === "motion_blur" && node.sourceSampling === "decoded_temporal");
  const temporalSampleCount = temporalNodes.length === 1 ? Number(temporalNodes[0].samples) : 0;
  const sceneLinearAces2 = graph.nodes.some((node) => node.kind === "color"
    && node.processor === "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1");
  const sceneDepthAttachmentCount = graph.nodes.some((node) => node.kind === "camera") ? 1 : 0;
  const depthOfFieldPassCount = graph.nodes.some((node) => node.kind === "depth_of_field") ? 1 : 0;
  const expected = estimateGpuEngineVideoResources(graph.width, graph.height, graph.cacheBudgetMb, videoLayerCount, overlayCount,
    adjustmentCount, matteCount, particleCount, temporalSampleCount, sceneLinearAces2 ? 8 : 4, sceneDepthAttachmentCount, depthOfFieldPassCount);
  return Boolean(expected)
    && plan.schema === expected!.schema && plan.width === graph.width && plan.height === graph.height
    && plan.videoLayerCount === videoLayerCount && plan.overlayCount === overlayCount && plan.particleCount === particleCount
    && plan.adjustmentCount === adjustmentCount && plan.matteCount === matteCount && plan.pixelCount === expected!.pixelCount
    && plan.bytesPerVideoLayer === expected!.bytesPerVideoLayer && plan.workingBytesPerPixel === expected!.workingBytesPerPixel
    && plan.temporalSampleCount === expected!.temporalSampleCount && plan.temporalResidentRingSlots === expected!.temporalResidentRingSlots
    && plan.temporalResidentBytes === expected!.temporalResidentBytes && plan.compositorWorkingBytes === expected!.compositorWorkingBytes
    && plan.overlayBytes === expected!.overlayBytes && plan.particleSnapshotCapacityPerEmitter === expected!.particleSnapshotCapacityPerEmitter
    && plan.particleSnapshotBytes === expected!.particleSnapshotBytes && plan.adjustmentWorkingBytes === expected!.adjustmentWorkingBytes
    && plan.sceneDepthAttachmentCount === expected!.sceneDepthAttachmentCount && plan.sceneDepthBytes === expected!.sceneDepthBytes
    && plan.depthOfFieldPassCount === expected!.depthOfFieldPassCount && plan.depthOfFieldAdditionalWorkingBytes === 0
    && plan.maximumFullFramePassesPerPresent === expected!.maximumFullFramePassesPerPresent
    && plan.requiredBytes === expected!.requiredBytes && plan.budgetBytes === expected!.budgetBytes
    && plan.maxVideoLayers === expected!.maxVideoLayers && plan.remainingBytes === expected!.budgetBytes - expected!.requiredBytes
    && plan.requiredBytes <= plan.budgetBytes && videoLayerCount <= plan.maxVideoLayers;
}

export function engineVideoDecodeCadence(
  expected: ExpectedEngineVideoLayer, index: number, layerCount: number,
): { divisor: number; phase: number } {
  const transform = expected.transform as EngineNode & { scaleX?: number; keyframes?: Array<{ scaleX?: number; scaleY?: number }> };
  const keyframeScales = (transform.keyframes ?? []).flatMap((keyframe) => [Math.abs(Number(keyframe.scaleX)), Math.abs(Number(keyframe.scaleY))]);
  const maximumScale = Math.max(Math.abs(Number(transform.scaleX)), ...keyframeScales.filter(Number.isFinite));
  return layerCount >= 8 && index > 0 && maximumScale <= .25 ? { divisor: 2, phase: index % 2 } : { divisor: 1, phase: 0 };
}

export function engineVideoDecodeScheduleMatches(
  schedule: GpuEngineVideoDecodeSchedule, layers: ExpectedEngineVideoLayer[],
): boolean {
  const cadences = layers.map((layer, index) => engineVideoDecodeCadence(layer, index, layers.length));
  const adaptiveLayerCount = cadences.filter((cadence) => cadence.divisor > 1).length;
  return schedule.schema === "editkin.resident-video-decode-schedule/v1"
    && schedule.fullRateLayerCount === layers.length - adaptiveLayerCount && schedule.adaptiveLayerCount === adaptiveLayerCount
    && schedule.maximumDecodeCadenceDivisor === (adaptiveLayerCount ? 2 : 1)
    && schedule.maximumReuseAgeFrames === (adaptiveLayerCount ? 1 : 0);
}
