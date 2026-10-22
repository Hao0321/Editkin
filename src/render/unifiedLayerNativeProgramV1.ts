import type { LayerBlendMode, TrackMatteMode } from "../domain/types";
import type { EngineNode, EngineRenderGraph } from "./engineGraph";

export const UNIFIED_NATIVE_PROGRAM_SCHEMA_V1 = "editkin.unified-native-composite/v1" as const;
const blends = new Set<LayerBlendMode>(["normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn"]);
const mattes = new Set<TrackMatteMode>(["alpha", "alpha_inverted", "luma", "luma_inverted"]);
export interface UnifiedNativeDrawV1 {
  kind: "video" | "caption" | "motion_graphic";
  index: number;
  tailId: string;
  sourceNodeId: string;
  blendMode: LayerBlendMode;
  opacity: number;
  matteTailId?: string;
  matteMode?: TrackMatteMode;
}
export interface UnifiedNativeAdjustmentV1 {
  kind: "adjustment";
  index: number;
  nodeId: string;
  tailId: string;
  nodeIds: string[];
}
export type UnifiedNativeStepV1 = UnifiedNativeDrawV1 | UnifiedNativeAdjustmentV1;
export interface UnifiedNativeProgramV1 {
  schema: typeof UNIFIED_NATIVE_PROGRAM_SCHEMA_V1;
  graphId: string;
  outputNode: string;
  steps: UnifiedNativeStepV1[];
}
interface ResourceReservation {
  pixelCount: number; bytesPerVideoLayer: number; compositorWorkingBytes: number;
  requiredBytes: number; budgetBytes: number; maximumFullFramePassesPerPresent: number; maxVideoLayers: number;
}
/** Reserve one cleared transparent working seed. Legacy estimates and objects are unchanged. */
export function reserveUnifiedLayerNativeResourcesV1<T extends ResourceReservation>(plan: T | undefined, videoLayers: number): (T & { unifiedSeedBytes: number }) | undefined {
  if (!plan || !Number.isSafeInteger(videoLayers) || videoLayers < 0) return undefined;
  const unifiedSeedBytes = plan.pixelCount * 4;
  const requiredBytes = plan.requiredBytes + unifiedSeedBytes;
  const compositorWorkingBytes = plan.compositorWorkingBytes + unifiedSeedBytes;
  const fixedBytes = requiredBytes - plan.bytesPerVideoLayer * videoLayers;
  const maxVideoLayers = Math.max(0, Math.floor((plan.budgetBytes - fixedBytes) / plan.bytesPerVideoLayer));
  const maximumFullFramePassesPerPresent = plan.maximumFullFramePassesPerPresent + 1;
  if (![unifiedSeedBytes, requiredBytes, compositorWorkingBytes, fixedBytes, maxVideoLayers, maximumFullFramePassesPerPresent].every(Number.isSafeInteger)
    || unifiedSeedBytes <= 0 || plan.bytesPerVideoLayer <= 0 || fixedBytes < 0 || requiredBytes > plan.budgetBytes || videoLayers > maxVideoLayers) return undefined;
  return { ...plan, unifiedSeedBytes, requiredBytes, compositorWorkingBytes, maxVideoLayers, maximumFullFramePassesPerPresent };
}
function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Explicit opt-in identity emitted by the saved-order graph builder. This is a route version, never drawing authority. */
export function isUnifiedLayerNativeGraphV1(graph: Pick<EngineRenderGraph, "graphId">): boolean {
  const marker = ":layer-order-v1:", position = graph.graphId.lastIndexOf(marker);
  return position >= 0 && /^(?:[0-9a-z]+(?:\.[0-9a-z]+)*)?$/.test(graph.graphId.slice(position + marker.length));
}

/** Extract the actual left-associated draw/adjustment DAG. The leaf projection only reuses existing admission;
 * it must never be submitted as the picture. Program steps, source identities and the original graph own execution. */
export function prepareUnifiedLayerNativeProgramV1(graph: EngineRenderGraph): { program: UnifiedNativeProgramV1; leafGraph: EngineRenderGraph } | undefined {
  if (!isUnifiedLayerNativeGraphV1(graph)) return undefined;
  if (graph.audio) refuse("UNIFIED_NATIVE_AUDIO_SEPARATE_REQUIRED");
  if (graph.nodes.length > 16_384 || graph.nodes.length < 1) refuse("UNIFIED_NATIVE_NODE_CAPACITY");
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length || graph.nodes.some(node => node.inputs.some(id => !nodes.has(id)))) refuse("UNIFIED_NATIVE_NODE_IDENTITIES_INVALID");
  const output = nodes.get(graph.outputNode);
  if (!output || output.kind !== "output" || !output.enabled || output.inputs.length !== 1) refuse("UNIFIED_NATIVE_OUTPUT_INVALID");
  if (graph.nodes.some(node => ["camera", "light", "transform3d", "depth_of_field", "particle_emitter", "timeline_transition_v1", "native_motion_paint", "floating_video_frame_2d"].includes(node.kind)
    || node.kind === "motion_blur" && node.sourceSampling === "decoded_temporal")) refuse("UNIFIED_NATIVE_GROUP_REQUIRED");
  const consumedStack = new Set<string>(), drawTails = new Set<string>();
  const steps: UnifiedNativeStepV1[] = [];
  const counters = { video: 0, caption: 0, motion_graphic: 0, adjustment: 0 };
  const lookup = (id: string) => { const node = nodes.get(id); if (!node) refuse("UNIFIED_NATIVE_INPUT_MISSING"); return node; };
  const ownStack = (node: EngineNode) => {
    if (!node.enabled || consumedStack.has(node.id)) refuse("UNIFIED_NATIVE_SHARED_OR_CYCLIC_STACK");
    consumedStack.add(node.id);
  };
  function adjustmentTail(id: string): { adjustment: EngineNode; nodeIds: string[] } | undefined {
    const seen = new Set<string>(), nodeIds: string[] = [];
    let current = lookup(id);
    while (current.kind === "color" || current.kind === "effect") {
      if (seen.has(current.id) || current.inputs.length !== 1) refuse("UNIFIED_NATIVE_ADJUSTMENT_CHAIN_INVALID");
      seen.add(current.id); nodeIds.push(current.id); current = lookup(current.inputs[0]);
    }
    return current.kind === "adjustment" ? { adjustment: current, nodeIds: [...nodeIds, current.id] } : undefined;
  }
  function sourceOf(id: string): EngineNode {
    let current = lookup(id); const seen = new Set<string>();
    while (current.kind !== "source") {
      if (seen.has(current.id) || !["transform2d", "color", "effect", "motion_blur", "precomposition"].includes(current.kind)
        || current.inputs.length !== 1 || !current.enabled) refuse("UNIFIED_NATIVE_VIDEO_BRANCH_INVALID");
      seen.add(current.id); current = lookup(current.inputs[0]);
    }
    if (!current.enabled || current.inputs.length || current.mediaKind !== "video") refuse("UNIFIED_NATIVE_VIDEO_BRANCH_INVALID");
    return current;
  }
  function visit(id: string, upper = false, depth = 0): void {
    if (depth > 64) refuse("UNIFIED_NATIVE_STACK_CAPACITY");
    const node = lookup(id);
    if (node.kind === "composite") {
      ownStack(node);
      if (upper || node.inputs.length !== 2 || lookup(node.inputs[1]).kind === "composite") refuse("UNIFIED_NATIVE_RIGHT_NESTED_GROUP_REQUIRED");
      const blendMode = node.blendMode as LayerBlendMode, opacity = node.opacity;
      if (!blends.has(blendMode) || typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) refuse("UNIFIED_NATIVE_COMPOSITE_STYLE_INVALID");
      const matteTailId = node.matteInput as string | undefined, matteMode = node.matteMode as TrackMatteMode | undefined;
      if (matteTailId !== undefined && (typeof matteTailId !== "string" || !matteTailId || !nodes.has(matteTailId))
        || Boolean(matteTailId) !== Boolean(matteMode) || matteMode !== undefined && !mattes.has(matteMode)) refuse("UNIFIED_NATIVE_MATTE_INVALID");
      visit(node.inputs[0], false, depth + 1);
      const previous = steps.length;
      visit(node.inputs[1], true, depth + 1);
      if (steps.length !== previous + 1 || steps.at(-1)?.kind === "adjustment") refuse("UNIFIED_NATIVE_UPPER_BRANCH_INVALID");
      Object.assign(steps.at(-1)!, { blendMode, opacity, ...(matteTailId ? { matteTailId, matteMode } : {}) });
      return;
    }
    const adjustment = adjustmentTail(id);
    if (adjustment) {
      if (upper || adjustment.adjustment.inputs.length !== 1
        || JSON.stringify(adjustment.adjustment.affectedInputs) !== JSON.stringify(adjustment.adjustment.inputs)) refuse("UNIFIED_NATIVE_ADJUSTMENT_SCOPE_INVALID");
      for (const owned of adjustment.nodeIds) ownStack(lookup(owned));
      visit(adjustment.adjustment.inputs[0], false, depth + 1);
      steps.push({ kind: "adjustment", index: counters.adjustment++, nodeId: adjustment.adjustment.id, tailId: id, nodeIds: adjustment.nodeIds });
      if (counters.adjustment > 4) refuse("UNIFIED_NATIVE_ADJUSTMENT_CAPACITY");
      return;
    }
    if (node.kind === "source" && node.assetId === "editkin.generator.transparent") {
      if (upper || steps.length || node.inputs.length || !node.enabled || node.mediaKind !== "generator"
        || node.alphaMode !== "straight" || node.inputColorSpace !== "rec709") refuse("UNIFIED_NATIVE_TRANSPARENT_SEED_INVALID");
      ownStack(node); return;
    }
    if (!node.enabled || drawTails.has(id)) refuse("UNIFIED_NATIVE_DRAW_IDENTITY_INVALID");
    drawTails.add(id);
    const kind = node.kind === "caption" ? "caption" : node.kind === "motion_graphic" ? "motion_graphic" : "video";
    const source = kind === "video" ? sourceOf(id) : node;
    if (kind !== "video" && node.inputs.length) refuse("UNIFIED_NATIVE_OVERLAY_INPUT_INVALID");
    steps.push({ kind, index: counters[kind]++, tailId: id, sourceNodeId: source.id, blendMode: "normal", opacity: 1 });
    if (counters.video + counters.caption + counters.motion_graphic > 14 || counters.caption > 8 || counters.motion_graphic > 4) refuse("UNIFIED_NATIVE_DRAW_CAPACITY");
  }
  visit(output.inputs[0]);
  if (!counters.video) {
    const owned = new Set([...consumedStack, ...drawTails]);
    if (graph.nodes.some(node => node.id !== output.id && !owned.has(node.id))) refuse("UNIFIED_NATIVE_COVERAGE_INCOMPLETE");
  }
  const videos = steps.filter((step): step is UnifiedNativeDrawV1 => step.kind === "video");
  const byTail = new Map(videos.map(step => [step.tailId, step]));
  for (const step of steps) if (step.kind !== "adjustment") {
    if (step.kind !== "video" && (step.blendMode !== "normal" || step.opacity !== 1 || step.matteTailId)) refuse("UNIFIED_NATIVE_OVERLAY_STYLE_INVALID");
    if (step.matteTailId && (!byTail.has(step.matteTailId) || step.matteTailId === step.tailId)) refuse("UNIFIED_NATIVE_MATTE_INVALID");
  }
  for (const video of videos) {
    const seen = new Set<string>(); let current: UnifiedNativeDrawV1 | undefined = video;
    while (current?.matteTailId) {
      if (seen.has(current.tailId)) refuse("UNIFIED_NATIVE_MATTE_CYCLE");
      seen.add(current.tailId); current = byTail.get(current.matteTailId);
    }
  }
  const leafGraph = structuredClone(graph);
  // This internal ID cannot opt back into mixed preparation. It is never a public cache/frame identity.
  leafGraph.graphId = "editkin.internal-unified-leaf-preparation/v1";
  const adjustmentIds = new Set(steps.flatMap(step => step.kind === "adjustment" ? step.nodeIds : []));
  leafGraph.nodes = leafGraph.nodes.filter(node => node.id !== output.id && (!consumedStack.has(node.id) || adjustmentIds.has(node.id)));
  const projected = new Map(leafGraph.nodes.map(node => [node.id, node]));
  let tail: string | undefined;
  let generated = 0;
  const draws = ["video", "caption", "motion_graphic"].flatMap(kind => steps.filter((step): step is UnifiedNativeDrawV1 => step.kind === kind));
  for (const draw of draws) {
    if (!tail) { tail = draw.tailId; continue; }
    let id: string;
    do { id = `unified-leaf-preparation:composite:${generated++}`; } while (nodes.has(id) || projected.has(id));
    const composite: EngineNode = { id, inputs: [tail, draw.tailId], enabled: true, kind: "composite", blendMode: draw.blendMode,
      opacity: draw.opacity, ...(draw.matteTailId ? { matteInput: draw.matteTailId, matteMode: draw.matteMode } : {}) };
    leafGraph.nodes.push(composite); projected.set(id, composite); tail = id;
  }
  if (!tail) {
    const seed = graph.nodes.find(node => consumedStack.has(node.id) && node.kind === "source" && node.assetId === "editkin.generator.transparent");
    if (!seed) refuse("UNIFIED_NATIVE_TRANSPARENT_SEED_REQUIRED");
    const preparedSeed = structuredClone(seed);
    leafGraph.nodes.push(preparedSeed); projected.set(preparedSeed.id, preparedSeed); tail = preparedSeed.id;
  }
  for (const step of steps) if (step.kind === "adjustment") {
    const adjustment = projected.get(step.nodeId)!;
    adjustment.inputs = [tail!]; adjustment.affectedInputs = [tail!]; tail = step.tailId;
  }
  leafGraph.nodes.push({ ...structuredClone(output), inputs: [tail!] });
  return { program: { schema: UNIFIED_NATIVE_PROGRAM_SCHEMA_V1, graphId: graph.graphId, outputNode: graph.outputNode, steps }, leafGraph };
}
