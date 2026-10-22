import { useCallback, useEffect, useRef, useState } from "react";
import type { ColorAdjustments, ColorGradeLutRefV2, ColorGradeV2, ColorManagementSettings, MediaAsset } from "../domain/types";
import { colorScopeBinsV1, scopeSampleSizeV1 } from "../color/colorScopesV1";
import GradedMedia from "./GradedMedia";
import { drawColorScopeV1, type ColorScopeKindV1 } from "./colorScopesCanvasV1";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import "./gpuColorScopesV1.css";
import { createColorComparisonV1, seekColorScopeSourceV1, type ComparisonMediaV1 } from "./colorGradeComparisonV1";
import "./colorGradeComparisonV1.css";
import {ColorPreviewPickerV1,type ColorPreviewPickerHandleV1} from "./ColorPreviewPickerV1";
import {previewFramePipelineKeyV1,type PreviewFrameIdentityV1} from "../color/previewPixelPickerV1";

interface Props {
  asset: MediaAsset; source: string; color: ColorAdjustments; grade?: ColorGradeV2;
  management: ColorManagementSettings; rec709Input?: "display" | "camera"; sourceTime: number;
  readLut?: (ref: ColorGradeLutRefV2) => Promise<string>;
  comparison?: boolean;
  pickerOwnerKey?:string;
  onPreviewFrame?:(source:ComparisonMediaV1,identity:PreviewFrameIdentityV1)=>void;
  onPreviewUnavailable?:(reason:'waiting'|'error')=>void;
}
const SCOPES: Array<[ColorScopeKindV1, string]> = [
  ["waveform", "RGB Waveform（近似）"], ["vectorscope", "Vectorscope（近似）"],
  ["parade", "RGB Parade（預覽像素）"], ["histogram", "RGB／Y′ Histogram（預覽像素）"],
];
export function GpuColorScopesV1({ asset, source, color, grade, management, rec709Input, sourceTime, readLut, comparison = false,pickerOwnerKey,onPreviewFrame,onPreviewUnavailable }: Props) {
  useI18n();
  const root = useRef<HTMLDivElement>(null), sample = useRef<HTMLCanvasElement>(null), video = useRef<HTMLVideoElement | null>(null);
  const picker=useRef<ColorPreviewPickerHandleV1>(null);
  const previewCallbacks=useRef({onPreviewFrame,onPreviewUnavailable});previewCallbacks.current={onPreviewFrame,onPreviewUnavailable};
  const pickerExpected:PreviewFrameIdentityV1={pipelineKey:previewFramePipelineKeyV1({asset,source,grade,management,rec709Input,ownerKey:pickerOwnerKey}),primaryKey:JSON.stringify(color),...(asset.kind==='video'?{sourceTime}:{})};
  const time = useRef(sourceTime); time.current = sourceTime;
  const canvases = useRef<Partial<Record<ColorScopeKindV1, HTMLCanvasElement>>>({});
  const [state, setState] = useState<"waiting" | "ready" | "error">("waiting");
  const [error, setError] = useState("");
  const [position, setPosition] = useState(.5), [comparisonReady, setComparisonReady] = useState(false);
  const pickerContextKey=JSON.stringify([pickerExpected,comparison,position,comparisonReady]);
  const rawComparison = useRef<HTMLCanvasElement>(null), comparisonOutput = useRef<HTMLCanvasElement>(null);
  const comparisonController = useRef<ReturnType<typeof createColorComparisonV1> | null>(null);
  if (!comparisonController.current) comparisonController.current = createColorComparisonV1(() => rawComparison.current, () => comparisonOutput.current, setComparisonReady);
  const clear = useCallback((reason:'waiting'|'error'='waiting') => {
    for (const [kind] of SCOPES) { const canvas = canvases.current[kind]; if (canvas) drawColorScopeV1(canvas, kind); }
    if (root.current) { delete root.current.dataset.scopeSamples; delete root.current.dataset.scopeRgb; }
    comparisonController.current?.clear();
    picker.current?.clear();
    previewCallbacks.current.onPreviewUnavailable?.(reason);
  }, []);
  const receiveFrame = useCallback((canvas: HTMLCanvasElement, original: ComparisonMediaV1,identity:PreviewFrameIdentityV1) => {
    try {
      const sampler = sample.current, context = sampler?.getContext("2d", { willReadFrequently: true });
      if (!sampler || !context) throw new Error(uiText("此素材協定不允許讀取像素；輸出調色仍有效"));
      const size = scopeSampleSizeV1(canvas.width, canvas.height);
      if (sampler.width !== size.width || sampler.height !== size.height) { sampler.width = size.width; sampler.height = size.height; }
      context.clearRect(0, 0, size.width, size.height);
      context.drawImage(canvas, 0, 0, size.width, size.height);
      const bins = colorScopeBinsV1(context.getImageData(0, 0, size.width, size.height));
      for (const [kind] of SCOPES) { const target = canvases.current[kind]; if (target) drawColorScopeV1(target, kind, bins); }
      if (root.current) {
        root.current.dataset.scopeSamples = String(bins.samples);
        // Small observable channel means, derived from the same sample. No image copies are retained.
        root.current.dataset.scopeRgb = [0, 1, 2].map(c => bins.histogram.subarray(c * 256, (c + 1) * 256).reduce((sum, n, i) => sum + n * i, 0) / Math.max(1, bins.samples)).join(",");
      }
      comparisonController.current?.receive(canvas, original);
      picker.current?.receive(canvas,original,identity);
      previewCallbacks.current.onPreviewFrame?.(original,identity);
      setError(""); setState("ready");
    } catch (reason) { clear('error'); setState("error"); setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [clear]);
  useEffect(() => { comparisonController.current?.setMode(comparison, position); }, [comparison, position]);
  useEffect(() => () => comparisonController.current?.clear(), []);
  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    video.current = node;
    if (node) seekColorScopeSourceV1(node, time.current);
  }, []);
  useEffect(() => { if (video.current) seekColorScopeSourceV1(video.current, sourceTime); }, [sourceTime]);
  useEffect(() => {
    const canvas = root.current?.querySelector<HTMLCanvasElement>("canvas[data-grade-status]");
    if (!canvas) return;
    const observe = () => {
      const status = canvas.dataset.gradeStatus;
      if (status !== "ready") { clear(status==='error'?'error':'waiting'); setState(status === "error" ? "error" : "waiting"); setError(status === "error" ? canvas.title : ""); }
      else picker.current?.refresh();
    };
    const observer = new MutationObserver(observe); observer.observe(canvas, { attributes: true, attributeFilter: ["data-grade-status", "title"] });
    observe();
    return () => observer.disconnect();
  }, [clear]);
  return <div ref={root} className="gpu-color-scopes" data-testid="gpu-color-scopes" data-scope-status={state}>
    <GradedMedia asset={asset} color={color} grade={grade} management={management} rec709Input={rec709Input} source={source}
      className="color-source-preview" style={comparison ? { display: "none" } : undefined} testId={asset.kind === "image" ? "preview-image" : "preview-video"} videoRef={attachVideo} readLut={readLut} onFrame={receiveFrame} frameOwnerKey={pickerOwnerKey}/>
    <canvas ref={comparisonOutput} className="color-source-preview" width="1" height="1" data-testid="color-comparison-preview" role="img"
      style={{ display: comparison ? "block" : "none" }} aria-label={uiText("{value0} · 分割比較預覽", { value0: asset.name })} />
    <canvas ref={rawComparison} width="1" height="1" hidden />
    {comparison && <>
      <div className="color-comparison-controls"><span>{uiText("原片")}</span><label><span>{uiText("分割位置")}<output>{Math.round(position * 100)}%</output></span>
        <input type="range" min="0" max="1" step="0.01" value={position} aria-label={uiText("分割位置")} data-testid="color-comparison-position" onChange={event => setPosition(Number(event.target.value))} /></label><span>{uiText("調色")}</span></div>
      <small>{uiText(comparisonReady ? "分割僅影響預覽；示波器顯示完整調色畫面，輸出不變。" : "分割比較等待影格…")}</small>
    </>}
    <ColorPreviewPickerV1 ref={picker} getRoot={()=>root.current} contextKey={pickerContextKey} expected={pickerExpected}/>
    <canvas ref={sample} width="1" height="1" hidden />
    <div className="scope-grid">{SCOPES.map(([kind, label]) => <figure key={kind}>
      <figcaption>{uiText(label)}</figcaption><canvas ref={node => { if (node) canvases.current[kind] = node; else delete canvases.current[kind]; }}
        data-testid={`color-scope-${kind}`} width={kind === "vectorscope" ? 180 : 360} height="180" role="img" aria-label={uiText(label)}
        style={kind === "vectorscope" ? { width: "150px", height: "150px", margin: "auto" } : undefined} />
    </figure>)}</div>
    <small role="status">{state === "error" ? error : uiText(state === "ready" ? "示波器讀取 GPU 預覽影格；SDR 8-bit，非正式輸出量測。" : "等待影格…")}</small>
    <small>{uiText("虛線是膚色色相參考，並非膚色偵測或校正目標。")}</small>
  </div>;
}
