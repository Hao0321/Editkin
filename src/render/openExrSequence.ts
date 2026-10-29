import { projectDuration, validateProject } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import { buildEngineRenderGraph, type EngineRenderGraph } from "./engineGraph";
import { nativeMediaPath } from "./gpuCompositor";
import { assertProofStillRouteV1 } from "./proofStillRouteV1";

export interface OpenExrSequenceRenderRequest {
  projectName: string;
  graph: EngineRenderGraph;
  assetBindings: Record<string, string>;
  startFrame: 0;
  frameCount: number;
}

export function buildOpenExrSequenceRenderRequest(input: EditProject, options?: { longTimeline?: true }): OpenExrSequenceRenderRequest {
  assertProofStillRouteV1(input, "openexr-sequence");
  if ([input.tracks, ...input.compositions.map(composition => composition.tracks)].some(tracks => tracks.some(track => track.clips.some(clip => clip.gradeV2 !== undefined)))) {
    throw new Error("Color Grade v2 尚未接入 scene-linear／OpenEXR 原生路徑；請先移除 v2 調色或改用一般影片輸出，避免輸出靜默遺失調色。");
  }
  const project = validateProject(structuredClone(input));
  // OpenEXR is a scene-linear interchange boundary. Project display management must not leak
  // into per-clip color nodes; the measured display transform is appended explicitly by the
  // SDR/HDR delivery builder only after the complete float composite.
  if (project.colorManagement) project.colorManagement.mode = "rec709";
  const graph = buildEngineRenderGraph(project);
  if (graph.workingFormat !== "rgba32_float") {
    throw new Error("OpenEXR 序列輸出需要至少一個 scene-linear Rec.709 EXR 素材。");
  }
  const unsupported = graph.nodes.find((node) => ["caption", "motion_graphic", "effect"].includes(node.kind));
  if (unsupported) {
    throw new Error(`OpenEXR 場景線性輸出尚未校準 ${unsupported.kind} 節點；已安全阻擋，避免字卡或效果亮度錯誤。`);
  }
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const assetBindings: Record<string, string> = {};
  for (const node of graph.nodes.filter((candidate) => candidate.kind === "source" && candidate.mediaKind !== "generator")) {
    const assetId = String(node.assetId ?? "");
    const asset = assets.get(assetId);
    const path = asset ? nativeMediaPath(asset.uri) : undefined;
    if (!asset || asset.kind !== "image" || asset.color?.interpretation !== "linear_rec709" || !path
      || !/\.(?:exr|ekf32|json)$/i.test(path)) {
      throw new Error(`OpenEXR 序列只接受已解讀的本機 scene-linear 圖像來源：${asset?.name ?? assetId}`);
    }
    assetBindings[assetId] = path;
  }
  if (!Object.keys(assetBindings).length) throw new Error("OpenEXR 序列沒有可輸出的場景線性圖層。");
  const duration = projectDuration(project);
  const frameCount = Math.round(duration * project.fps);
  // LONG C4 keeps the absolute graph clock; each native CLI batch still has at most1M frames.
  const maximumFrames = options?.longTimeline ? 100_000_000 : 1_000_000;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > maximumFrames
    || Math.abs(frameCount / project.fps - duration) > 0.5 / project.fps) {
    throw new Error(options?.longTimeline ? "LONG scene-linear frame count exceeds the eight-decimal frame filename contract." : "OpenEXR 序列片長必須精確對齊 1..=1,000,000 格。請先把片段邊界吸附到影格。");
  }
  return { projectName: project.name, graph: { ...graph, audio: undefined }, assetBindings, startFrame: 0, frameCount };
}
