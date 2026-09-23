import { useEffect, useRef, useState } from "react";
import { loadCubeLut, sampleCubeLut, type CubeLut } from "../color/cubeLut";
import { acesPrecisionBlockReason, gradeRgb, resolveAcesInput, resolveInputColorSpace } from "../color/primaryGrade";
import type { AcesOutputTransform, ColorAdjustments, ColorManagementSettings, InputColorSpace, MediaAsset, SourceAlphaMode, TimelineClip } from "../domain/types";
import { DEFAULT_COLOR } from "../domain/types";
import "./colorWorkspace.css";

interface ColorWorkspaceProps {
  asset: MediaAsset;
  clip: TimelineClip;
  source?: string;
  playhead: number;
  colorManagement: ColorManagementSettings;
  onColorManagementChange: (patch: Partial<Pick<ColorManagementSettings, "mode" | "outputTransform">>) => void;
  onColorChange: (patch: Partial<ColorAdjustments>) => void;
  onInputColorSpaceChange: (interpretation: InputColorSpace) => void;
  onAlphaModeChange: (alphaMode: SourceAlphaMode) => void;
  onClose: () => void;
}

const CONTROLS: Array<{ key: keyof ColorAdjustments; label: string; min: number; max: number; step: number }> = [
  { key: "exposure", label: "曝光（stops）", min: -3, max: 3, step: 0.05 },
  { key: "temperature", label: "色溫", min: -1, max: 1, step: 0.01 },
  { key: "tint", label: "Tint", min: -1, max: 1, step: 0.01 },
  { key: "contrast", label: "對比", min: 0.1, max: 3, step: 0.02 },
  { key: "pivot", label: "Pivot", min: 0.1, max: 0.9, step: 0.01 },
  { key: "saturation", label: "飽和度", min: 0, max: 3, step: 0.02 },
  { key: "shadows", label: "陰影", min: -1, max: 1, step: 0.01 },
  { key: "highlights", label: "高光", min: -1, max: 1, step: 0.01 },
  { key: "blacks", label: "黑位", min: -1, max: 1, step: 0.01 },
  { key: "whites", label: "白位", min: -1, max: 1, step: 0.01 },
];

const INPUT_OPTIONS: Array<[InputColorSpace, string]> = [
  ["auto", "自動偵測（推薦）"], ["rec709", "Camera Rec.709"], ["linear_rec709", "Scene-linear Rec.709（EXR）"], ["srgb", "sRGB"], ["hlg", "Rec.2100 HLG"], ["pq", "Rec.2100 PQ"],
  ["acescct", "ACEScct"], ["apple_log", "Apple Log"], ["arri_logc3", "ARRI LogC3 EI800"], ["arri_logc4", "ARRI LogC4"],
  ["bmd_film_gen5", "Blackmagic Film Gen 5"], ["canon_log2", "Canon Log 2"], ["canon_log3", "Canon Log 3"], ["dji_dlog", "DJI D-Log"],
  ["panasonic_vlog", "Panasonic V-Log"], ["red_log3g10", "RED Log3G10"], ["sony_slog3_cine", "Sony S-Log3 / S-Gamut3.Cine"], ["log_unresolved", "未知 Log（安全阻擋）"],
];

const OUTPUT_OPTIONS: Array<[AcesOutputTransform, string]> = [
  ["rec709_sdr", "Rec.709 SDR · 100 nits（社群推薦）"], ["p3d65_sdr", "Display P3 D65 · 100 nits"],
  ["rec2100_hlg_1000", "Rec.2100 HLG · 1000 nits HDR"], ["rec2100_pq_1000", "Rec.2100 PQ · 1000 nits HDR"],
];

function drawScopes(image: ImageData, waveform: HTMLCanvasElement, vectorscope: HTMLCanvasElement) {
  const wave = waveform.getContext("2d");
  const vector = vectorscope.getContext("2d");
  if (!wave || !vector) return;
  wave.clearRect(0, 0, waveform.width, waveform.height);
  wave.fillStyle = "#070b12";
  wave.fillRect(0, 0, waveform.width, waveform.height);
  vector.clearRect(0, 0, vectorscope.width, vectorscope.height);
  vector.fillStyle = "#070b12";
  vector.fillRect(0, 0, vectorscope.width, vectorscope.height);
  vector.strokeStyle = "#3a4659";
  vector.beginPath();
  vector.arc(vectorscope.width / 2, vectorscope.height / 2, vectorscope.width * 0.42, 0, Math.PI * 2);
  vector.stroke();
  const step = Math.max(1, Math.floor((image.width * image.height) / 22_000));
  for (let pixel = 0; pixel < image.width * image.height; pixel += step) {
    const offset = pixel * 4;
    const [r, g, b] = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    const sourceX = pixel % image.width;
    const x = Math.round((sourceX / Math.max(1, image.width - 1)) * (waveform.width - 1));
    for (const [value, color] of [[r, "#ff526f"], [g, "#56f2a7"], [b, "#55a6ff"]] as const) {
      wave.fillStyle = `${color}30`;
      wave.fillRect(x, Math.round((1 - value / 255) * (waveform.height - 1)), 1, 1);
    }
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const u = (b - y) / 1.8556;
    const v = (r - y) / 1.5748;
    vector.fillStyle = `rgba(${r},${g},${b},0.16)`;
    vector.fillRect(vectorscope.width / 2 + (u / 255) * vectorscope.width * 0.8, vectorscope.height / 2 - (v / 255) * vectorscope.height * 0.8, 1, 1);
  }
}

function processFrame(image: ImageData, grade: ColorAdjustments, bypass: boolean, luts?: { input: CubeLut; output: CubeLut }): ImageData {
  if (bypass) return image;
  const pixels = image.data;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    let rgb: [number, number, number] = [pixels[offset] / 255, pixels[offset + 1] / 255, pixels[offset + 2] / 255];
    if (luts) rgb = sampleCubeLut(luts.input, rgb);
    const graded = gradeRgb(rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, grade);
    rgb = [graded[0] / 255, graded[1] / 255, graded[2] / 255];
    if (luts) rgb = sampleCubeLut(luts.output, rgb);
    pixels[offset] = Math.round(Math.max(0, Math.min(1, rgb[0])) * 255);
    pixels[offset + 1] = Math.round(Math.max(0, Math.min(1, rgb[1])) * 255);
    pixels[offset + 2] = Math.round(Math.max(0, Math.min(1, rgb[2])) * 255);
  }
  return image;
}

export function ColorWorkspace({ asset, clip, source, playhead, colorManagement, onColorManagementChange, onColorChange, onInputColorSpaceChange, onAlphaModeChange, onClose }: ColorWorkspaceProps) {
  const sampleRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const vectorRef = useRef<HTMLCanvasElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [bypass, setBypass] = useState(false);
  const [scopeState, setScopeState] = useState("等待影格…");
  const [luts, setLuts] = useState<{ input: CubeLut; output: CubeLut }>();
  const acesInput = resolveAcesInput(asset);
  const legacyInput = resolveInputColorSpace(asset);
  const precisionBlock = colorManagement.mode === "aces2" ? acesPrecisionBlockReason(asset, colorManagement) : undefined;
  const blocked = colorManagement.mode === "aces2" ? acesInput === "blocked_log" || Boolean(precisionBlock) : legacyInput === "blocked_log";
  const hasWb = [clip.color,...clip.keyframes.map(k=>k.color)].some(c=>[c.whiteBalanceRed??0,c.whiteBalanceGreen??0,c.whiteBalanceBlue??0].some(v=>v!==0));
  const scopeUnavailable = hasWb ? "線性白平衡已儲存；瀏覽器 8-bit 預覽與示波器尚未校準此增益，暫不顯示。"
    : blocked || colorManagement.mode === "aces2" || legacyInput !== "rec709" ? "此 HDR／Log／色彩轉換尚無已校準的瀏覽器示波器；請以正式輸出量測。" : undefined;

  useEffect(() => {
    let active = true;
    if (scopeUnavailable || colorManagement.mode !== "aces2" || acesInput === "blocked_log" || precisionBlock) { setLuts(undefined); return () => { active = false; }; }
    setScopeState("載入 ACES 2.0 transforms…");
    Promise.all([
      loadCubeLut(`/color/aces2/luts/input-${acesInput}-to-acescct.cube`),
      loadCubeLut(`/color/aces2/luts/output-acescct-to-${colorManagement.outputTransform}.cube`),
    ]).then(([input, output]) => { if (active) { setLuts({ input, output }); setScopeState("ACES 2.0 transforms 已載入"); } }).catch((error) => { if (active) setScopeState(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [acesInput, colorManagement.mode, colorManagement.outputTransform, precisionBlock, scopeUnavailable]);

  const analyze = () => {
    const sample = sampleRef.current;
    const preview = previewRef.current;
    const waveform = waveformRef.current;
    const vector = vectorRef.current;
    const media = asset.kind === "image" ? imageRef.current : mediaRef.current;
    if (!sample || !preview || !waveform || !vector || !media || blocked || scopeUnavailable || (colorManagement.mode === "aces2" && !luts)) return;
    try {
      const context = sample.getContext("2d", { willReadFrequently: true });
      const previewContext = preview.getContext("2d");
      if (!context || !previewContext) return;
      context.drawImage(media, 0, 0, sample.width, sample.height);
      const frame = processFrame(context.getImageData(0, 0, sample.width, sample.height), clip.color, bypass, colorManagement.mode === "aces2" ? luts : undefined);
      previewContext.putImageData(frame, 0, 0);
      drawScopes(frame, waveform, vector);
      setScopeState("瀏覽器 8-bit 近似示波器 · 非正式輸出色彩量測");
    } catch {
      setScopeState("此素材協定不允許讀取像素；輸出調色仍有效");
    }
  };

  useEffect(() => {
    const video = mediaRef.current;
    if (!video || asset.kind === "image") return;
    video.currentTime = Math.max(0, clip.sourceStart + Math.max(0, playhead - clip.timelineStart));
  }, [asset.kind, clip.sourceStart, clip.timelineStart, playhead, source]);
  useEffect(() => { analyze(); }, [bypass, clip.color, colorManagement, luts]);

  const inputLabel = precisionBlock ? "此 HDR 組合精度不足 · 輸出阻擋" : blocked ? "未解讀 Log · 輸出阻擋" : colorManagement.mode === "aces2" ? `Input: ${String(acesInput).toUpperCase()}` : `Input: ${legacyInput.toUpperCase()}`;
  return <div className="modal-backdrop color-workspace-backdrop" role="presentation">
    <section className="color-workspace" role="dialog" aria-modal="true" aria-label="專業調色工作區" data-testid="color-workspace">
      <header><div><span className="eyebrow">COLOR WORKSPACE · {colorManagement.mode === "aces2" ? "ACES 2.0" : "REC.709"}</span><h2>專業調色</h2><p>{colorManagement.mode === "aces2" ? "Input Transform → ACEScct → Primary → Output Transform" : "快速 Rec.709 → Primary → Graphics"}</p></div><button type="button" className="modal-close" onClick={onClose} aria-label="關閉">×</button></header>
      <div className="color-layout">
        <div className="scope-stage">
          <div className="scope-toolbar"><strong>{asset.name}</strong><span className={blocked ? "blocked" : ""}>{inputLabel}</span><button type="button" className={bypass ? "active" : ""} onClick={() => setBypass((value) => !value)}>A/B {bypass ? "原片" : "調色"}</button></div>
          {source && asset.kind === "image" ? <img ref={imageRef} className="color-source-sampler" src={source} alt="" onLoad={analyze} /> : source ? <video ref={mediaRef} className="color-source-sampler" src={source} muted playsInline preload="auto" onLoadedData={analyze} onSeeked={analyze} /> : null}
          {source && !blocked && !scopeUnavailable ? <canvas ref={previewRef} className="color-source-preview" width="320" height="180" /> : <div className="scope-unavailable" role="status" data-testid="color-scope-unavailable">{scopeUnavailable ?? precisionBlock ?? (blocked ? "請指定正確的相機 Input Transform" : "請先建立素材預覽檔")}</div>}
          <canvas ref={sampleRef} width="320" height="180" hidden />
          {!scopeUnavailable && <div className="scope-grid"><figure><figcaption>RGB Waveform（近似）</figcaption><canvas ref={waveformRef} width="360" height="150" /></figure><figure><figcaption>Vectorscope（近似）</figcaption><canvas ref={vectorRef} width="180" height="180" /></figure></div>}
          <small>{scopeUnavailable ?? scopeState} · 校色顯示器與 reference parity 仍需另行量測。</small>
        </div>
        <aside className="grade-controls">
          <fieldset className="pipeline-mode"><legend>色彩管理</legend><button type="button" className={colorManagement.mode === "rec709" ? "active" : ""} onClick={() => onColorManagementChange({ mode: "rec709", outputTransform: "rec709_sdr" })}>快速 Rec.709</button><button type="button" className={colorManagement.mode === "aces2" ? "active" : ""} onClick={() => onColorManagementChange({ mode: "aces2" })}>ACES 2.0 專業</button></fieldset>
          <label>素材 Input Transform<select value={asset.color?.interpretation ?? "auto"} onChange={(event) => onInputColorSpaceChange(event.target.value as InputColorSpace)}>{INPUT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>透明度 Alpha<select value={asset.alphaMode ?? "auto"} onChange={(event) => onAlphaModeChange(event.target.value as SourceAlphaMode)}><option value="auto">自動（影片不透明／圖片直通）</option><option value="opaque">強制不透明</option><option value="straight">Straight Alpha</option><option value="premultiplied">Premultiplied Alpha</option></select></label>
          {colorManagement.mode === "aces2" && <label>輸出顯示 Output Transform<select value={colorManagement.outputTransform} onChange={(event) => onColorManagementChange({ outputTransform: event.target.value as AcesOutputTransform })}>{OUTPUT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
          <div className="color-pipeline-note"><strong>{colorManagement.mode === "aces2" ? "ACEScct 工作空間" : "快速 SDR 工作流"}</strong><span>{colorManagement.mode === "aces2" ? "內建官方 OCIO ACES 2.0 config 生成的高精度 transforms（SDR 65³／HDR 129³）；未知 Log 不會偷偷當 Rec.709。" : "適合手機與已完成 Rec.709 素材；Log／HDR 建議切到 ACES。"}</span></div>
          <div className="grade-control-grid">{CONTROLS.map((control) => <label key={control.key}><span>{control.label}<output>{clip.color[control.key].toFixed(2)}</output></span><input type="range" min={control.min} max={control.max} step={control.step} value={clip.color[control.key]} onChange={(event) => onColorChange({ [control.key]: Number(event.target.value) })} data-testid={`grade-${control.key}`} /></label>)}</div>
          <details><summary>線性白平衡（進階）</summary><p>RGB 通道 log2 增益：+1 stop = 2 倍，0 = 不變；不是 Kelvin 色溫。</p><div className="grade-control-grid">{([['whiteBalanceRed','紅'],['whiteBalanceGreen','綠'],['whiteBalanceBlue','藍']] as const).map(([key,label])=><label key={key}><span>{label}通道（stops）<output>{(clip.color[key]??0).toFixed(2)}</output></span><input aria-label={`${label}通道線性增益`} data-testid={`grade-${key}`} type="range" min="-4" max="4" step="0.05" value={clip.color[key]??0} onChange={event=>onColorChange({[key]:Number(event.target.value)})}/></label>)}</div></details>
          <button type="button" className="grade-reset" onClick={() => onColorChange({ ...DEFAULT_COLOR })}>重設 Primary</button>
        </aside>
      </div>
    </section>
  </div>;
}
