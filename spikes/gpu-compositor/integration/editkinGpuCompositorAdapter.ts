/**
 * Staged adapter contract only.  This file is intentionally not imported by
 * Editkin while another session owns the core project schema and renderer.
 */
export type GpuBlendMode = "normal" | "add" | "screen" | "multiply";

export interface GpuLayerTransform {
  x: number;
  y: number;
  scale: number;
  /** Radians, matching the Rust render graph. */
  rotation: number;
}

export type GpuLayerSource =
  | { kind: "image"; path: string }
  | { kind: "solid"; color: [number, number, number, number] }
  | { kind: "gradient"; start: [number, number, number, number]; end: [number, number, number, number]; horizontal: boolean };

export interface GpuLayerNode {
  id: string;
  source: GpuLayerSource;
  blendMode: GpuBlendMode;
  opacity: number;
  transform: GpuLayerTransform;
  enabled: boolean;
}

export interface GpuRenderGraph {
  schema: "hao.gpu-render-graph/v1";
  width: number;
  height: number;
  layers: GpuLayerNode[];
}

export function assertGpuGraph(graph: GpuRenderGraph): GpuRenderGraph {
  if (graph.width <= 0 || graph.height <= 0 || graph.width > 8192 || graph.height > 8192) throw new Error("GPU render size 無效");
  if (graph.layers.length < 1 || graph.layers.length > 64) throw new Error("GPU layer 數量必須是 1..64");
  for (const layer of graph.layers) {
    if (!layer.id.trim() || layer.opacity < 0 || layer.opacity > 1 || !Number.isFinite(layer.opacity)) throw new Error(`GPU layer 無效：${layer.id}`);
    if (layer.transform.scale <= 0 || !Object.values(layer.transform).every(Number.isFinite)) throw new Error(`GPU transform 無效：${layer.id}`);
  }
  return graph;
}

