import type { ColorAdjustments, EditProject } from "../domain/types";
import { buildOpenExrSequenceRenderRequest, type OpenExrSequenceRenderRequest } from "./openExrSequence";

export interface Aces2SdrVideoRenderRequest extends OpenExrSequenceRenderRequest {
  graph: OpenExrSequenceRenderRequest["graph"];
  colorProcessor: "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
  outputTransform: "rec709_sdr";
}

export type NativeAces2OutputTransform = "rec709_sdr" | "rec2100_hlg_1000" | "rec2100_pq_1000";
export type NativeAces2ColorProcessor =
  | "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1"
  | "editkin-ocio-aces2-linear-rec709-to-rec2100-hlg-1000/v1"
  | "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1";

export interface Aces2DisplayVideoRenderRequest extends OpenExrSequenceRenderRequest {
  graph: OpenExrSequenceRenderRequest["graph"];
  colorProcessor: NativeAces2ColorProcessor;
  outputTransform: NativeAces2OutputTransform;
}

const NATIVE_PROCESSORS: Record<NativeAces2OutputTransform, NativeAces2ColorProcessor> = {
  rec709_sdr: "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1",
  rec2100_hlg_1000: "editkin-ocio-aces2-linear-rec709-to-rec2100-hlg-1000/v1",
  rec2100_pq_1000: "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1",
};

const IDENTITY_GRADE: ColorAdjustments = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  hue: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  whiteBalanceRed: 0,
  whiteBalanceGreen: 0,
  whiteBalanceBlue: 0,
  pivot: .5,
  shadows: 0,
  highlights: 0,
  blacks: 0,
  whites: 0,
};

function identityGrade(value: unknown): boolean {
  const grade = value as Partial<ColorAdjustments> | undefined;
  return !grade || Object.entries(IDENTITY_GRADE).every(([key, expected]) => {
    const field = key as keyof ColorAdjustments;
    const observed = grade[field];
    // v1 graph receipts intentionally omit the three zero-valued physical-WB
    // channels. Treat only those omitted legacy zeros as identity; every
    // authored/nonzero value and every other missing grade field still fails
    // closed until the OCIO dynamic-grading processor exists.
    return observed === expected
      || (observed === undefined && expected === 0
        && (field === "whiteBalanceRed" || field === "whiteBalanceGreen" || field === "whiteBalanceBlue"));
  });
}

export function containsSceneLinearMedia(project: EditProject): boolean {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset] as const));
  return project.tracks.some((track) => track.kind === "video" && !track.muted
    && track.clips.some((clip) => assets.get(clip.assetId)?.color?.interpretation === "linear_rec709"));
}

export function buildAces2SdrVideoRenderRequest(input: EditProject): Aces2SdrVideoRenderRequest {
  const request = buildAces2DisplayVideoRenderRequest(input);
  if (request.outputTransform !== "rec709_sdr" || request.colorProcessor !== NATIVE_PROCESSORS.rec709_sdr) {
    throw new Error("原生 ACES 2 SDR request 只能使用 Rec.709 SDR Output Transform。");
  }
  return request as Aces2SdrVideoRenderRequest;
}

export function buildAces2DisplayVideoRenderRequest(input: EditProject): Aces2DisplayVideoRenderRequest {
  if (!containsSceneLinearMedia(input)) throw new Error("原生 ACES 2 SDR 輸出需要 scene-linear Rec.709 EXR 素材。");
  const outputTransform = input.colorManagement?.outputTransform ?? "rec709_sdr";
  if (!(outputTransform in NATIVE_PROCESSORS)) throw new Error("原生 ACES 2 display 輸出尚未校準 P3 D65；請使用 Rec.709 SDR、HLG 或 PQ。");
  const nativeOutput = outputTransform as NativeAces2OutputTransform;
  const visual = structuredClone(input);
  // Captions and motion graphics are authored after the display transform so their UI colors
  // remain display-referred and subtitle typography stays single-color by contract.
  visual.captions = [];
  visual.motionGraphics = [];
  const base = buildOpenExrSequenceRenderRequest(visual);
  const unsupported = base.graph.nodes.find((node) => !["source", "transform2d", "color", "composite", "output"].includes(node.kind));
  if (unsupported) throw new Error(`原生 ACES 2 SDR 尚未校準 ${unsupported.kind} 節點；請先關閉該效果或輸出 OpenEXR。`);
  const graded = base.graph.nodes.find((node) => node.kind === "color" && !identityGrade(node.grade));
  if (graded) throw new Error("Scene-linear clip 調色必須先接入 OCIO 動態 grading processor；目前不可用 Rec.709 primary grade 代替。");
  const output = base.graph.nodes.find((node) => node.id === base.graph.outputNode && node.kind === "output");
  if (!output || output.inputs.length !== 1) throw new Error("原生 ACES 2 SDR graph 缺少單一 Output 邊界。");
  const displayNodeId = `color:display:aces2-${nativeOutput}`;
  const colorProcessor = NATIVE_PROCESSORS[nativeOutput];
  if (base.graph.nodes.some((node) => node.id === displayNodeId)) throw new Error("原生 ACES 2 SDR display node identity 衝突。");
  const display = {
    id: displayNodeId,
    inputs: [output.inputs[0]],
    enabled: true,
    kind: "color",
    processor: colorProcessor,
    inputSpace: "linear_rec709",
    workingSpace: "ACEScct",
    outputSpace: nativeOutput,
    grade: { ...IDENTITY_GRADE },
  };
  output.inputs = [displayNodeId];
  base.graph.nodes.splice(base.graph.nodes.indexOf(output), 0, display);
  return { ...base, colorProcessor, outputTransform: nativeOutput, graph: base.graph };
}
