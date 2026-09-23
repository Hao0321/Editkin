import type { EngineNode } from "../render/engineGraph";
import type { GpuEngineVideoPreviewGraph, GpuRenderGraph } from "../render/gpuCompositor";

type GpuEngineVideoLayerLoadResult = import("./types").GpuEngineVideoLayerLoadResult;

export interface ExpectedEngineVideoLayer {
  sourceNodeId: string;
  assetId: string;
  source: EngineNode;
  transform: EngineNode;
  transformNodeId: string;
  parentTransformNodeId: string | undefined;
  parentLayerIndex: number | undefined;
  parentControllerIndex: number | undefined;
  parentDepth: number;
  effectKind: 0 | 1 | 2;
  shaderEffectExpected: boolean;
  motionBlur: EngineNode | undefined;
  grade: EngineNode;
  blendMode: GpuEngineVideoLayerLoadResult["blendMode"];
  compositeOpacity: number;
  matteLayerIndex: number | undefined;
  matteMode: "alpha" | "alpha_inverted" | "luma" | "luma_inverted" | undefined;
  precompositionNodeIds: string[];
  nestedGraphIds: string[];
}

export interface ExpectedEngineVideoController {
  sourceNodeId: string;
  source: EngineNode;
  transform: EngineNode;
  transformNodeId: string;
  parentTransformNodeId: string | undefined;
  parentLayerIndex: number | undefined;
  parentControllerIndex: number | undefined;
  parentDepth: number;
}

export interface ExpectedEngineVideoAdjustment {
  nodeIds: string[];
  adjustment: EngineNode;
  grade: EngineNode;
  effectKind: 0 | 1 | 2;
  shaderEffectExpected: boolean;
}

export const engineBlendCodes: Record<GpuEngineVideoLayerLoadResult["blendMode"], import("./types").GpuEngineVideoVisualGraph["blendMode"]> = {
  normal: 0, add: 1, screen: 2, multiply: 3, overlay: 4, soft_light: 5,
  hard_light: 6, difference: 7, darken: 8, lighten: 9, color_dodge: 10, color_burn: 11,
};

export function imageStructureKey(graph: GpuRenderGraph): string {
  return JSON.stringify({
    width: graph.width,
    height: graph.height,
    layers: graph.layers.map((layer) => ({ id: layer.id, source: layer.source })),
  });
}

function engineVisualKind(pluginId: unknown): 0 | 1 | 2 {
  return pluginId === "editkin.builtin.mono_halftone" ? 1
    : pluginId === "editkin.builtin.xerox_pulse" ? 2 : 0;
}

function expectedEngineVideoAdjustmentTopology(graph: GpuEngineVideoPreviewGraph["graph"]): { root: string; adjustments: ExpectedEngineVideoAdjustment[] } | undefined {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const output = byId.get(graph.outputNode);
  if (!output || output.kind !== "output" || output.inputs.length !== 1) return undefined;
  let root = output.inputs[0];
  const outerToInner: ExpectedEngineVideoAdjustment[] = [];
  for (;;) {
    let current = byId.get(root);
    const nodeIds: string[] = [];
    let grade: EngineNode | undefined;
    let effectKind: 0 | 1 | 2 = 0;
    let shaderEffectExpected = false;
    const visited = new Set<string>();
    while (current && (current.kind === "color" || current.kind === "effect")) {
      if (visited.has(current.id) || current.inputs.length !== 1) return undefined;
      visited.add(current.id); nodeIds.push(current.id);
      if (current.kind === "color") { if (grade) return undefined; grade = current; }
      else {
        effectKind = engineVisualKind(current.pluginId);
        shaderEffectExpected = typeof current.pluginId === "string" && !current.pluginId.startsWith("editkin.builtin.");
      }
      current = byId.get(current.inputs[0]);
    }
    if (current?.kind !== "adjustment") break;
    if (!grade || current.inputs.length !== 1 || outerToInner.length >= 4) return undefined;
    nodeIds.push(current.id);
    outerToInner.push({ nodeIds, adjustment: current, grade, effectKind, shaderEffectExpected });
    root = current.inputs[0];
  }
  return { root, adjustments: outerToInner.reverse() };
}

function extractExpectedEngineVideoLayers(graph: GpuEngineVideoPreviewGraph["graph"]): ExpectedEngineVideoLayer[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const topology = expectedEngineVideoAdjustmentTopology(graph);
  if (!topology) return [];
  const branchTails: Array<{ id: string; blendMode: GpuEngineVideoLayerLoadResult["blendMode"]; compositeOpacity: number; matteInput?: string; matteMode?: ExpectedEngineVideoLayer["matteMode"] }> = [];
  const compositeNodes = new Set<string>();
  const collectBranchTails = (nodeId: string): boolean => {
    const node = byId.get(nodeId);
    if (!node) return false;
    if (node.kind !== "composite") {
      branchTails.push({ id: node.id, blendMode: "normal", compositeOpacity: 1 });
      return branchTails.length <= 14;
    }
    if (compositeNodes.has(node.id) || node.inputs.length !== 2) return false;
    compositeNodes.add(node.id);
    if (!collectBranchTails(node.inputs[0])) return false;
    const previousLength = branchTails.length;
    if (!collectBranchTails(node.inputs[1]) || branchTails.length !== previousLength + 1) return false;
    const blendMode = node.blendMode as GpuEngineVideoLayerLoadResult["blendMode"];
    if (!(blendMode in engineBlendCodes) || typeof node.opacity !== "number") return false;
    const matteInput = typeof node.matteInput === "string" ? node.matteInput : undefined;
    const matteMode = node.matteMode as ExpectedEngineVideoLayer["matteMode"];
    if (Boolean(matteInput) !== Boolean(matteMode)) return false;
    branchTails[branchTails.length - 1] = { ...branchTails[branchTails.length - 1], blendMode, compositeOpacity: node.opacity, matteInput, matteMode };
    return true;
  };
  if (!collectBranchTails(topology.root) || branchTails.length < 1) return [];
  const videoBranchTails: string[] = []; let overlayPhase = 0; let particleCount = 0; let captionCount = 0; let motionGraphicCount = 0;
  for (const branchTail of branchTails) {
    const kind = byId.get(branchTail.id)?.kind;
    if (kind === "particle_emitter") { if (overlayPhase > 1) return []; overlayPhase = 1; particleCount += 1; continue; }
    if (kind === "caption") { if (overlayPhase > 2) return []; overlayPhase = 2; captionCount += 1; continue; }
    if (kind === "motion_graphic") { overlayPhase = 3; motionGraphicCount += 1; continue; }
    if (overlayPhase > 0) return [];
    videoBranchTails.push(branchTail.id);
  }
  if (videoBranchTails.length < 1 || videoBranchTails.length > 14 || particleCount > 4 || captionCount > 8 || motionGraphicCount > 4) return [];
  const layers = videoBranchTails.map((branchTail): ExpectedEngineVideoLayer | undefined => {
    let current = byId.get(branchTail);
    let transform: EngineNode | undefined;
    let grade: EngineNode | undefined;
    let motionBlur: EngineNode | undefined;
    let effectKind: 0 | 1 | 2 = 0;
    let shaderEffectExpected = false;
    const precompositionNodeIds: string[] = [];
    const nestedGraphIds: string[] = [];
    const visited = new Set<string>();
    while (current && current.kind !== "source") {
      if (visited.has(current.id) || current.inputs.length !== 1) return undefined;
      visited.add(current.id);
      if (current.kind === "transform2d" || current.kind === "transform3d") transform = current;
      if (current.kind === "color") grade = current;
      if (current.kind === "effect") {
        effectKind = engineVisualKind(current.pluginId);
        shaderEffectExpected = typeof current.pluginId === "string" && !current.pluginId.startsWith("editkin.builtin.");
      }
      if (current.kind === "motion_blur") {
        if (motionBlur) return undefined;
        motionBlur = current;
      }
      if (current.kind === "precomposition") {
        if (typeof current.nestedGraphId !== "string") return undefined;
        precompositionNodeIds.push(current.id); nestedGraphIds.push(current.nestedGraphId);
      }
      current = byId.get(current.inputs[0]);
    }
    const composite = branchTails.find((candidate) => candidate.id === branchTail);
    return current && transform && grade && composite && typeof current.assetId === "string"
      ? { sourceNodeId: current.id, assetId: current.assetId, source: current, transform, transformNodeId: transform.id,
        // Native 2.5D parenting is already flattened by the camera oracle into the final
        // projective homography. The separate affine parenting table must not apply it twice.
        parentTransformNodeId: transform.kind === "transform2d" && typeof transform.parent === "string" ? transform.parent : undefined,
        parentLayerIndex: undefined, parentControllerIndex: undefined, parentDepth: 0,
        effectKind, shaderEffectExpected, motionBlur, grade, blendMode: composite.blendMode, compositeOpacity: composite.compositeOpacity,
        matteLayerIndex: composite.matteInput ? videoBranchTails.indexOf(composite.matteInput) : undefined, matteMode: composite.matteMode,
        precompositionNodeIds, nestedGraphIds }
      : undefined;
  }).filter((layer): layer is ExpectedEngineVideoLayer => Boolean(layer));
  if (layers.length !== videoBranchTails.length
    || !layers.every((layer, index) => layer.matteLayerIndex === undefined || (layer.matteLayerIndex >= 0 && layer.matteLayerIndex !== index))) return [];
  return layers;
}

function extractExpectedEngineVideoControllers(graph: GpuEngineVideoPreviewGraph["graph"]): ExpectedEngineVideoController[] {
  const controllers: ExpectedEngineVideoController[] = [];
  for (const source of graph.nodes.filter((node) => node.kind === "source" && node.mediaKind === "generator")) {
    if (source.assetId !== "editkin.generator.null") return [];
    const consumers = graph.nodes.filter((node) => node.inputs.length === 1 && node.inputs[0] === source.id);
    const transform = consumers.length === 1 && consumers[0].kind === "transform2d" ? consumers[0] : undefined;
    if (!transform) return [];
    controllers.push({
      sourceNodeId: source.id, source, transform, transformNodeId: transform.id,
      parentTransformNodeId: typeof transform.parent === "string" ? transform.parent : undefined,
      parentLayerIndex: undefined, parentControllerIndex: undefined, parentDepth: 0,
    });
  }
  return controllers.length <= 8 ? controllers : [];
}

function expectedEngineVideoTopology(graph: GpuEngineVideoPreviewGraph["graph"]): { layers: ExpectedEngineVideoLayer[]; controllers: ExpectedEngineVideoController[] } {
  const layers = extractExpectedEngineVideoLayers(graph);
  const controllers = extractExpectedEngineVideoControllers(graph);
  if (!layers.length) return { layers: [], controllers: [] };
  const targets = [
    ...layers.map((owner, index) => ({ kind: "layer" as const, index, owner })),
    ...controllers.map((owner, index) => ({ kind: "controller" as const, index, owner })),
  ];
  const byTransform = new Map(targets.map((target) => [target.owner.transformNodeId, target]));
  for (const target of targets) {
    const parentId = target.owner.parentTransformNodeId;
    if (!parentId) continue;
    const parent = byTransform.get(parentId);
    if (!parent || parent === target) return { layers: [], controllers: [] };
    target.owner.parentLayerIndex = parent.kind === "layer" ? parent.index : undefined;
    target.owner.parentControllerIndex = parent.kind === "controller" ? parent.index : undefined;
    const parentTimeline = parent.owner.source.timeline as { timelineStartFrame: number; durationFrames: number } | undefined;
    const childTimeline = target.owner.source.timeline as { timelineStartFrame: number; durationFrames: number } | undefined;
    if (!parentTimeline || !childTimeline || parentTimeline.timelineStartFrame > childTimeline.timelineStartFrame
      || parentTimeline.timelineStartFrame + parentTimeline.durationFrames < childTimeline.timelineStartFrame + childTimeline.durationFrames) return { layers: [], controllers: [] };
  }
  for (const target of targets) {
    const visited = new Set([target.owner.transformNodeId]);
    let current = target;
    let depth = 0;
    while (current.owner.parentLayerIndex !== undefined || current.owner.parentControllerIndex !== undefined) {
      const parent = current.owner.parentLayerIndex !== undefined
        ? targets.find((candidate) => candidate.kind === "layer" && candidate.index === current.owner.parentLayerIndex)
        : targets.find((candidate) => candidate.kind === "controller" && candidate.index === current.owner.parentControllerIndex);
      if (!parent || visited.has(parent.owner.transformNodeId) || ++depth > 4) return { layers: [], controllers: [] };
      visited.add(parent.owner.transformNodeId);
      current = parent;
    }
    target.owner.parentDepth = depth;
  }
  return { layers, controllers };
}

export function expectedEngineVideoLayers(graph: GpuEngineVideoPreviewGraph["graph"]): ExpectedEngineVideoLayer[] {
  return expectedEngineVideoTopology(graph).layers;
}

export function expectedEngineVideoControllers(graph: GpuEngineVideoPreviewGraph["graph"]): ExpectedEngineVideoController[] {
  return expectedEngineVideoTopology(graph).controllers;
}

export function expectedEngineVideoAdjustments(graph: GpuEngineVideoPreviewGraph["graph"]): ExpectedEngineVideoAdjustment[] {
  return expectedEngineVideoAdjustmentTopology(graph)?.adjustments ?? [];
}

export function expectedEngineVideoCaptions(graph: GpuEngineVideoPreviewGraph["graph"]): EngineNode[] {
  return graph.nodes.filter((node) => node.kind === "caption");
}

export function expectedEngineVideoParticles(graph: GpuEngineVideoPreviewGraph["graph"]): EngineNode[] {
  return graph.nodes.filter((node) => node.kind === "particle_emitter");
}

export function expectedEngineVideoMotionGraphics(graph: GpuEngineVideoPreviewGraph["graph"]): EngineNode[] {
  return graph.nodes.filter((node) => node.kind === "motion_graphic");
}
