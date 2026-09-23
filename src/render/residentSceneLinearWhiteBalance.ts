import type { EngineRenderGraph } from "./engineGraph";
import { expectedEngineVideoLayers, expectedEngineVideoAdjustments } from "../desktop/residentGpuPreviewExpectations";
import { sameF32 } from "../desktop/residentGpuPreviewReceipts";
export type ResidentSceneLinearInputTransform = "editkin-srgb-to-linear-rec709-primary/v1" | "editkin-rec709-to-linear-rec709-primary/v2";
export const INPUT = "editkin-srgb-to-linear-rec709-primary/v1";
export const INPUT_V2 = "editkin-rec709-to-linear-rec709-primary/v2";
export function residentSceneLinearVisualExpectations(graph: EngineRenderGraph) {
  // The desktop topology reader consumes the visual graph before its terminal
  // display node. Build only an inspection view; never change the executed graph.
  const output = graph.nodes.find(node => node.id === graph.outputNode);
  const display = output?.inputs.length === 1 ? graph.nodes.find(node => node.id === output.inputs[0]) : undefined;
  const view = display?.processor === "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1" && display.inputs.length === 1
    ? { ...graph, nodes: graph.nodes.map(node => node === output ? { ...node, inputs: [...display.inputs] } : node) } : graph;
  return { layers: expectedEngineVideoLayers(view), adjustments: expectedEngineVideoAdjustments(view) };
}
const WB_KEYS = ["whiteBalanceRed", "whiteBalanceGreen", "whiteBalanceBlue"] as const;
function activeRange(node: Record<string, unknown>, frame: number): boolean {
  const timeline = node.timeline as { timelineStartFrame: number; durationFrames: number } | undefined;
  return Boolean(timeline && frame >= timeline.timelineStartFrame && frame < timeline.timelineStartFrame + timeline.durationFrames);
}
function expectedWhiteBalance(node: Record<string, unknown>, source: boolean): number[] {
  const grade = node.grade as Record<string, unknown> | undefined;
  const values = WB_KEYS.map(key => grade?.[key] === undefined ? 0 : grade[key]);
  if (!values.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 4)) throw new Error("Resident sequence white balance is invalid");
  const v2 = source ? INPUT_V2 : "editkin-linear-primary/v2";
  const v1 = source ? INPUT : "editkin-linear-primary/v1";
  if (node.processor !== v1 && node.processor !== v2
    || node.inputSpace !== (source ? "rec709" : "linear_rec709")
    || node.workingSpace !== "linear_rec709" || node.outputSpace !== "linear_rec709"
    || (values.some(value => value !== 0) && node.processor !== v2)) throw new Error("Resident sequence input/white-balance processor is unsupported");
  return values as number[];
}
export function residentSceneLinearInputAtFrame(graph: EngineRenderGraph, frame: number): ResidentSceneLinearInputTransform {
  const { layers, adjustments } = residentSceneLinearVisualExpectations(graph);
  for (const node of graph.nodes.filter(node => node.kind === "color" && node.grade !== undefined)) {
    if (node.processor === "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1") {
      if (WB_KEYS.some(key => Number((node.grade as Record<string, unknown>)[key] ?? 0) !== 0)) throw new Error("Resident display white balance is unsupported");
      continue;
    }
    expectedWhiteBalance(node, node.inputSpace !== "linear_rec709");
  }
  if (!layers.length && graph.nodes.some(node => WB_KEYS.some(key => Number((node.grade as Record<string, unknown>)?.[key] ?? 0) !== 0))) throw new Error("Resident WB visual topology is unsupported");
  for (const layer of layers) expectedWhiteBalance(layer.grade, true);
  for (const adjustment of adjustments) expectedWhiteBalance(adjustment.grade, false);
  const active = layers.filter(layer => activeRange(layer.source, frame));
  const participating = [...active, ...active.flatMap(layer => layer.matteLayerIndex === undefined ? [] : [layers[layer.matteLayerIndex]!])];
  if (participating.some(layer => !layer)) throw new Error("Resident sequence matte topology is unsupported");
  return participating.some(layer => layer.grade.processor === INPUT_V2) ? INPUT_V2 : INPUT;
}
/** Actual per-frame receipt binding, not native pixel equivalence evidence. */
export function assertResidentSceneLinearWhiteBalanceReceipt(graph: EngineRenderGraph, frame: number, receipt: Record<string, unknown>): void {
  if (receipt.inputTransform !== residentSceneLinearInputAtFrame(graph, frame)) throw new Error("Resident sequence input transform receipt mismatch");
  const { layers, adjustments } = residentSceneLinearVisualExpectations(graph);
  const requiresV2 = [...layers, ...adjustments].some(item => WB_KEYS.some(key => Number((item.grade.grade as Record<string, unknown>)?.[key] ?? 0) !== 0));
  if (!requiresV2) return; // Preserve the exact old zero-only receipt contract.
  const activeLayers = layers.filter(layer => activeRange(layer.source, frame));
  const activeAdjustments = adjustments.filter(item => activeRange(item.adjustment, frame));
  const observedLayers = receipt.layers as Array<Record<string, unknown>> | undefined;
  const observedAdjustments = receipt.activeAdjustments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(observedLayers) || observedLayers.length !== activeLayers.length || !Array.isArray(observedAdjustments) || observedAdjustments.length !== activeAdjustments.length) throw new Error("Resident sequence white-balance visual receipts missing");
  const matches = (visual: Record<string, unknown> | undefined, node: Record<string, unknown>, source: boolean) => {
    const expected = expectedWhiteBalance(node, source), v2 = String(node.processor).endsWith("/v2");
    const inputTransfer = source ? (v2 ? 2 : 1) : 0;
    return visual && (visual.inputTransfer === undefined && !v2 ? inputTransfer : visual.inputTransfer) === inputTransfer
      && WB_KEYS.every((key, index) => {
        const actual = visual[key] === undefined && !v2 ? 0 : visual[key];
        return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual) <= 4 && sameF32(actual, expected[index]);
      });
  };
  for (const [index, layer] of activeLayers.entries()) {
    const actual = observedLayers[index]!;
    if (actual.sourceNodeId !== layer.sourceNodeId || !matches(actual.visualGraph as Record<string, unknown>, layer.grade, true)) throw new Error("Resident sequence source white-balance receipt mismatch");
  }
  for (const [index, adjustment] of activeAdjustments.entries()) {
    const actual = observedAdjustments[index]!;
    if (JSON.stringify(actual.nodeIds) !== JSON.stringify(adjustment.nodeIds) || !matches(actual.visualGraph as Record<string, unknown>, adjustment.grade, false)) throw new Error("Resident sequence adjustment white-balance receipt mismatch");
  }
}
