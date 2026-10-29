import type { EngineNode, EngineRenderGraph } from "../render/engineGraph";
import { prepareUnifiedLayerNativeProgramV1, type UnifiedNativeProgramV1, type UnifiedNativeStepV1 } from "../render/unifiedLayerNativeProgramV1";
import { motionGraphicExpectedSample } from "./residentGpuPreviewReceipts";

export const UNIFIED_NATIVE_EXECUTION_SCHEMA_V1 = "editkin.unified-native-execution/v1" as const;
type RecordValue = Record<string, unknown>;
type ExecutionStep = { kind: "draw"; layer: number; nodeId: string; sourceNodeId: string }
  | { kind: "adjustment"; adjustment: number; nodeId: string };

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function keysMatch(actual: RecordValue, expected: object): boolean {
  const keys = Object.keys(actual), required = Object.keys(expected);
  return keys.length === required.length && required.every(key => Object.hasOwn(actual, key));
}
function stepMatches(actual: unknown, expected: UnifiedNativeStepV1): boolean {
  const value = record(actual);
  if (!value || !keysMatch(value, expected)) return false;
  if (expected.kind === "adjustment") return value.kind === expected.kind && value.index === expected.index
    && value.nodeId === expected.nodeId && value.tailId === expected.tailId
    && Array.isArray(value.nodeIds) && value.nodeIds.length === expected.nodeIds.length
    && value.nodeIds.every((id, index) => id === expected.nodeIds[index]);
  return value.kind === expected.kind && value.index === expected.index && value.tailId === expected.tailId
    && value.sourceNodeId === expected.sourceNodeId && value.blendMode === expected.blendMode
    && typeof value.opacity === "number" && Number.isFinite(value.opacity) && Math.fround(value.opacity) === Math.fround(expected.opacity)
    && value.matteTailId === expected.matteTailId && value.matteMode === expected.matteMode;
}
function programMatches(actual: unknown, expected: UnifiedNativeProgramV1): boolean {
  const value = record(actual);
  return Boolean(value && keysMatch(value, expected) && value.schema === expected.schema
    && value.graphId === expected.graphId && value.outputNode === expected.outputNode
    && Array.isArray(value.steps) && value.steps.length === expected.steps.length
    && value.steps.every((step, index) => stepMatches(step, expected.steps[index])));
}

/** Extra proof is required only by the explicit mixed route. Existing node, leaf and owner checks still apply. */
export function unifiedNativeLoadReceiptMatchesV1(graph: EngineRenderGraph, receipt: unknown): boolean {
  try {
    const value = record(receipt);
    if (!value) return false;
    const prepared = prepareUnifiedLayerNativeProgramV1(graph);
    if (!prepared) return value.unifiedCompositeV1 === undefined && value.videoAbsent === undefined;
    if (!programMatches(value.unifiedCompositeV1, prepared.program)) return false;
    if (prepared.program.steps.some(step => step.kind === "video")) return value.videoAbsent === undefined;
    return value.videoAbsent === true && value.decoder === null && value.visualGraph === null && value.initialFrame === null
      && value.layerCount === 0 && value.matteCount === 0 && value.precompositionCount === 0 && value.parentCount === 0
      && value.controllerCount === 0 && value.particleCount === 0 && (value.nativeMotionPaintCount ?? 0) === 0
      && [value.layers, value.visualLayers, value.controllers].every(items => Array.isArray(items) && items.length === 0)
      && value.compositeMode === "unified-layer-order/v1" && record(value.resourcePlan)?.videoLayerCount === 0
      && ["frame", "uniform", "sourceNodeId", "sourceFrame", "sourceTimeSeconds"].every(key => !Object.hasOwn(value, key));
  } catch { return false; }
}

function activeAt(node: EngineNode | undefined, frame: number): boolean {
  const timeline = node?.timeline as { timelineStartFrame?: number; durationFrames?: number } | undefined;
  return Boolean(timeline && Number.isSafeInteger(timeline.timelineStartFrame) && Number.isSafeInteger(timeline.durationFrames)
    && timeline.durationFrames! > 0 && frame >= timeline.timelineStartFrame! && frame - timeline.timelineStartFrame! < timeline.durationFrames!);
}
function activeSteps(graph: EngineRenderGraph, program: UnifiedNativeProgramV1, frame: number): ExecutionStep[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const active = program.steps.filter(step => step.kind === "adjustment" ? activeAt(nodes.get(step.nodeId), frame)
    : activeAt(nodes.get(step.sourceNodeId), frame) && (step.kind !== "motion_graphic"
      || motionGraphicExpectedSample(nodes.get(step.sourceNodeId)!, graph, frame) !== undefined));
  // Texture vectors remain grouped for resource reuse; the program alone determines visible order.
  const draws = ["video", "caption", "motion_graphic"].flatMap(kind => active.filter(step => step.kind === kind));
  const layerIndices = new Map(draws.map((step, index) => [step, index]));
  const adjustments = active.filter(step => step.kind === "adjustment");
  const adjustmentIndices = new Map(adjustments.map((step, index) => [step, index]));
  return active.map(step => step.kind === "adjustment"
    ? { kind: "adjustment", adjustment: adjustmentIndices.get(step)!, nodeId: step.nodeId }
    : { kind: "draw", layer: layerIndices.get(step)!, nodeId: step.tailId, sourceNodeId: step.sourceNodeId });
}
function executionMatches(actual: unknown, graph: EngineRenderGraph, program: UnifiedNativeProgramV1, frame: number): boolean {
  const value = record(actual), expected = activeSteps(graph, program, frame);
  const shape = { schema: 0, graphId: 0, outputNode: 0, timelineFrame: 0, steps: 0, workingSeed: 0,
    deliveryBackground: 0, workingPingPongTextures: 0, seedTextures: 0, retainedFrameHistory: 0 };
  return Boolean(value && keysMatch(value, shape) && value.schema === UNIFIED_NATIVE_EXECUTION_SCHEMA_V1
    && value.graphId === graph.graphId && value.outputNode === graph.outputNode && value.timelineFrame === frame
    && value.workingSeed === "transparent" && value.deliveryBackground === "opaque_black"
    && value.workingPingPongTextures === 2 && value.seedTextures === 1 && value.retainedFrameHistory === 0
    && Array.isArray(value.steps) && value.steps.length === expected.length && value.steps.every((item, index) => {
      const step = record(item), target = expected[index];
      return step && keysMatch(step, target) && Object.entries(target).every(([key, value]) => step[key] === value);
    }));
}

/** Works with a swap-chain surface or a verified offscreen receipt. It does not certify pixels or runtime provenance. */
export function unifiedNativeFrameReceiptMatchesV1(graph: EngineRenderGraph, frame: number, receipt: unknown): boolean {
  try {
    const value = record(receipt);
    if (!value || !Number.isSafeInteger(frame) || frame < 0) return false;
    const surface = record(value.surface), prepared = prepareUnifiedLayerNativeProgramV1(graph);
    const rootProof = value.unifiedCompositeExecutionV1, surfaceProof = surface?.unifiedCompositeExecutionV1;
    if (!prepared) return rootProof === undefined && surfaceProof === undefined;
    if (rootProof === undefined && surfaceProof === undefined) return false;
    return (rootProof === undefined || executionMatches(rootProof, graph, prepared.program, frame))
      && (surfaceProof === undefined || executionMatches(surfaceProof, graph, prepared.program, frame));
  } catch { return false; }
}

/** A layer-only picture must retain its real overlay/adjustment proof and cannot invent a video frame. */
export function unifiedNativeVideoStateReceiptMatchesV1(graph: EngineRenderGraph, frame: number, receipt: unknown): boolean {
  try {
    const value = record(receipt);
    if (!value || !Number.isSafeInteger(frame) || frame < 0) return false;
    const prepared = prepareUnifiedLayerNativeProgramV1(graph);
    if (!prepared) return value.videoAbsent === undefined;
    const steps = activeSteps(graph, prepared.program, frame);
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const hasVideo = steps.some(step => step.kind === "draw" && nodes.get(step.sourceNodeId)?.kind === "source");
    if (hasVideo) return value.videoAbsent === undefined && value.active === true && value.nativeSurfaceCleared === false;
    return value.videoAbsent === true && value.active === (steps.length > 0) && value.nativeSurfaceCleared === (steps.length === 0)
      && value.sourceFrame === null && value.sourceTimeSeconds === null && value.frame === undefined && value.visualGraph === undefined
      && [value.layers, value.layerFrames, value.visualLayers].every(items => Array.isArray(items) && items.length === 0)
      && value.temporalSampling == null && value.productPathCpuPixelCopies === 0 && value.decodedVideoCpuPixelCopies === 0
      && unifiedNativeFrameReceiptMatchesV1(graph, frame, value);
  } catch { return false; }
}
