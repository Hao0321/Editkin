import { projectVisualLayersV1, type ResolvedUnifiedLayerV1 } from "../domain/unifiedLayerOrderV1";
import type { EditProject, TimelineClip } from "../domain/types";
import type { EngineNode } from "./engineGraph";

interface UnifiedLayerGraphPortsV1 {
  nodes: EngineNode[];
  contentTails: ReadonlyMap<string, string>;
  overlayNode: (layer: Exclude<ResolvedUnifiedLayerV1, { kind: "clip" }>) => EngineNode;
  adjustmentNodes: (clip: TimelineClip, input: string) => { nodes: EngineNode[]; tail: string };
  appendComposite: (base: string, upper: string, index: number, clip?: TimelineClip, matteInput?: string) => string;
}

/** Mixed order only owns connections. Original clip/text/Motion/grade/matte constructors own all drawing parameters. */
export function composeUnifiedLayerGraphV1(layers: readonly ResolvedUnifiedLayerV1[], ports: UnifiedLayerGraphPortsV1): {
  tail: string | undefined; compositeIndex: number;
} {
  let tail: string | undefined, compositeIndex = 0;
  for (const layer of layers) {
    if (layer.kind === "clip") {
      const { clip, track } = layer;
      if (track.hidden || clip.layer?.enabled === false || clip.layer?.role === "controller") continue;
      if (clip.layer?.role === "adjustment") {
        if (!tail) continue;
        const built = ports.adjustmentNodes(clip, tail);
        ports.nodes.push(...built.nodes); tail = built.tail;
        continue;
      }
      const input = ports.contentTails.get(clip.id);
      if (!input) throw new Error("UNIFIED_LAYER_CLIP_TAIL_MISSING");
      const matteInput = clip.layer?.trackMatte ? ports.contentTails.get(clip.layer.trackMatte.sourceClipId) : undefined;
      if (clip.layer?.trackMatte && !matteInput) throw new Error("UNIFIED_LAYER_MATTE_SOURCE_MISSING");
      if (!tail && (matteInput || (clip.layer?.blendMode ?? "normal") !== "normal")) {
        ports.nodes.push({ id: "source:transparent", inputs: [], enabled: true, kind: "source", assetId: "editkin.generator.transparent", mediaKind: "generator", inputColorSpace: "rec709", alphaMode: "straight" });
        tail = "source:transparent";
      }
      tail = tail ? ports.appendComposite(tail, input, ++compositeIndex, clip, matteInput) : input;
    } else {
      if (!tail) {
        ports.nodes.push({ id: "source:transparent", inputs: [], enabled: true, kind: "source", assetId: "editkin.generator.transparent", mediaKind: "generator", inputColorSpace: "rec709", alphaMode: "straight" });
        tail = "source:transparent";
      }
      const node = ports.overlayNode(layer);
      ports.nodes.push(node);
      tail = ports.appendComposite(tail, node.id, ++compositeIndex);
    }
  }
  return { tail, compositeIndex };
}

/** Native node names encode project identities. Distinct raw IDs must never alias one executable node. */
export function assertUnifiedEngineNodeIdentitiesV1(nodes: readonly EngineNode[]): void {
  // The native validator admits at most 16384 nodes, including the output appended by the caller.
  if (nodes.length >= 16_384) throw new Error("UNIFIED_LAYER_ENGINE_NODE_CAPACITY");
  const identities = new Set(nodes.map(node => node.id));
  if (identities.size !== nodes.length) throw new Error("UNIFIED_LAYER_ENGINE_NODE_ID_COLLISION");
  if (nodes.some(node => node.inputs.some(input => !identities.has(input)))) throw new Error("UNIFIED_LAYER_ENGINE_INPUT_MISSING");
}

/** Exact permutation key, without a lossy hash. A requested order can change before a project revision is committed. */
export function unifiedLayerGraphOrderKeyV1(project: EditProject, layers: readonly ResolvedUnifiedLayerV1[]): string {
  const positions = new Map(projectVisualLayersV1(project).map((layer, index) => [`${layer.kind}\0${layer.id}`, index]));
  return `layer-order-v1:${layers.map(layer => {
    const position = positions.get(`${layer.kind}\0${layer.id}`);
    if (position === undefined) throw new Error("UNIFIED_LAYER_GRAPH_IDENTITY_MISSING");
    return position.toString(36);
  }).join(".")}`;
}
