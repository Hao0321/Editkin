import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { ParameterRangeV1 } from "./ParameterRangeV1";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import { useEffect, useMemo, useRef, useState } from "react";
import { createParameterRangeGestureInputV1 } from "./parameterRangeGestureInputV1";
import { useColorLutClientV1 } from "./useColorLutClientV1";
import type { ColorLutApiV1 } from "../desktop/colorLutApiV1";
import type { ColorLutClientV1 } from "../color/colorLutClientV1";
import { sameLutPanelContextV1 } from "../domain/colorLutPanelEditsV1";
import {colorWorkspaceInputAdmissionV1} from "../color/colorWorkspaceInputAdmissionV1";
import { animatedClipState } from "../domain/editGraph";
import { combineLookColor } from "../creative/corePack";
import { hasAuthoredClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import { GpuColorScopesV1 } from "./GpuColorScopesV1";
import { ColorGradeNodePanelV1 } from "./ColorGradeNodePanelV1";
import { ColorGradeClipboardPanelV1, type ColorGradeClipboardPanelPropsV1 } from "./ColorGradeClipboardPanelV1";
import type { GradePanelEditScopeV1 } from "../domain/colorGradePanelEditsV1";
import type { AcesOutputTransform, ColorAdjustments, ColorGradeV2, ColorManagementSettings, InputColorSpace, MediaAsset, SourceAlphaMode, TimelineClip } from "../domain/types";
import { usesAcesPhoneSdrV1 } from "../color/acesPhoneInputV1";
import { DEFAULT_COLOR } from "../domain/types";
import { FILM_LOOK_GENRES, filmLooksForGenre, findFilmLookV2, type FilmLookGenre, type FilmLookV2Certification } from "../creative/filmLooksV2";
import { exportColorGradeV2Cube } from "../color/gradeLutBake";
import { gradeWorkingSpace } from "../color/gradeV2";
import {previewPickerOwnerKeyV1,previewFramePipelineKeyV1} from "../color/previewPixelPickerV1";
import {useLookThumbnailSourceV1,LookThumbnailFallbackSourceV1} from "./useLookThumbnailSourceV1";
import {FilmLookThumbnailQueueV1,FilmLookThumbnailV1} from "./FilmLookThumbnailQueueV1";
import type {LookThumbnailFrameV1} from "../color/lookThumbnailSpecV1";
import "./colorWorkspace.css";

interface ColorWorkspaceProps {
  embedded?: boolean;
  asset: MediaAsset;
  clip: TimelineClip;
  source?: string;
  playhead: number;
  colorManagement: ColorManagementSettings;
  onColorManagementChange: (patch: Partial<Pick<ColorManagementSettings, "mode" | "outputTransform">>) => void;
  onColorChange: (patch: Partial<ColorAdjustments>) => void;
  onColorGestureStart?: (key: keyof ColorAdjustments) => ParameterGestureLeaseV1 | undefined;
  colorEditScopeKey?: string;
  onInputColorSpaceChange: (interpretation: InputColorSpace) => void;
  onRec709InputChange?: (interpretation: "display" | "camera") => void;
  onAlphaModeChange: (alphaMode: SourceAlphaMode) => void;
  /** Dispatches set_clip_grade_v2 (null removes the grade). Without it the v2 panel is view/export only. */
  onGradeV2Change?: (grade: ColorGradeV2 | null) => void;
  onGradeLookGestureStart?: () => ParameterGestureLeaseV1 | undefined;
  onGradeGestureStart?: () => ParameterGestureLeaseV1<ColorGradeV2> | undefined;
  /** Canonical grade base while clip is the shared preview projection. */
  gradeBaseClip?: TimelineClip;
  gradeEditOccurrence?: unknown;
  gradeReadOnlyReason?: string;
  gradeEditScope?: GradePanelEditScopeV1;
  gradeClipboard?: ColorGradeClipboardPanelPropsV1;
  colorLutApi?: ColorLutApiV1;
  onClose: () => void;
}

const GENRE_LABELS: Record<FilmLookGenre, string> = {
  travel: "旅遊", food: "美食", night: "夜景", tech: "科技", gaming: "遊戲", vlog: "Vlog", teaching: "教學", hype: "高能",
};
const CERTIFICATION_LABELS: Record<FilmLookV2Certification["status"], string> = { certified: "已認證", pending: "待審", refused: "未通過" };

export function GradeV2Panel({ asset, clip, colorManagement, onGradeV2Change, onGradeLookGestureStart, gradeEditOccurrence, gradeReadOnlyReason, gradeEditScope, lutClient,thumbnailFrame,thumbnailColor,thumbnailUnavailable,thumbnailReadLut }: Pick<ColorWorkspaceProps, "asset" | "clip" | "colorManagement" | "onGradeV2Change" | "onGradeLookGestureStart" | "gradeEditOccurrence" | "gradeReadOnlyReason"|"gradeEditScope">&{lutClient?:ColorLutClientV1;thumbnailFrame?:LookThumbnailFrameV1;thumbnailColor?:ColorAdjustments;thumbnailUnavailable?:string;thumbnailReadLut?:(ref:import('../domain/types').ColorGradeLutRefV2)=>Promise<string>}) {
  const activeLook = clip.gradeV2?.look ? findFilmLookV2(clip.gradeV2.look.id) : undefined;
  const [genre, setGenre] = useState<FilmLookGenre>(activeLook?.genre ?? "travel");
  const [strength, setStrength] = useState(clip.gradeV2?.look?.strength ?? 1);
  const strengthGesture = useMemo(() => createParameterRangeGestureInputV1(), []);
  useEffect(() => { strengthGesture.cancel(); return () => strengthGesture.cancel(); }, [strengthGesture, clip.id, gradeEditOccurrence, clip.gradeV2?.look?.id]);
  useEffect(() => { setGenre(activeLook?.genre ?? "travel"); }, [clip.id, gradeEditOccurrence, clip.gradeV2?.look?.id]);
  useEffect(() => { setStrength(clip.gradeV2?.look?.strength ?? 1); }, [clip.id, gradeEditOccurrence, clip.gradeV2?.look?.id, clip.gradeV2?.look?.strength]);
  const strengthInput = onGradeLookGestureStart ? strengthGesture.bind(clip.id, onGradeLookGestureStart) : undefined;
  const [exportState, setExportState] = useState<string>();
  const [exportBusy,setExportBusy]=useState(false);
  const [thumbnailActive,setThumbnailActive]=useState(true);
  const latest=useRef({clip,space:gradeWorkingSpace(colorManagement),scope:gradeEditScope});latest.current={clip,space:gradeWorkingSpace(colorManagement),scope:gradeEditScope};
  const mounted=useRef(true),exportSequence=useRef(0);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;exportSequence.current++;};},[]);
  const apply = (lookId: string, value = strength) => onGradeV2Change?.({ ...(clip.gradeV2 ?? { schema: "editkin.color-grade/v2" }), look: { id: lookId, strength: value } });
  const exportCube = async () => {
    if (!clip.gradeV2) return;
    const sequence=++exportSequence.current,captured={clipId:clip.id,space:gradeWorkingSpace(colorManagement),scope:gradeEditScope,grade:clip.gradeV2,nodeId:'',editable:true};setExportBusy(true);
    const stillCurrent=()=>mounted.current&&exportSequence.current===sequence&&sameLutPanelContextV1(captured,{clipId:latest.current.clip.id,nodeId:'',grade:latest.current.clip.gradeV2,space:latest.current.space,scope:latest.current.scope,editable:true,readOnly:true});
    try {
      const exported = lutClient?await lutClient.exportGrade(structuredClone(clip.gradeV2),captured.space,`${asset.name} · ${clip.id}`):exportColorGradeV2Cube(clip.gradeV2,captured.space,`${asset.name} · ${clip.id}`);
      if(!stillCurrent())return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([exported.text], { type: "text/plain" }));
      link.download = `${clip.id}-grade-v2.cube`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      setExportState(exported.omittedSpatial.length ? uiText("已匯出 .cube（不含顆粒、光暈、bloom 與暗角）。") : uiText("已匯出 .cube。"));
    } catch (error) { if(stillCurrent())setExportState(error instanceof Error ? error.message : String(error)); }
    finally {if(mounted.current&&exportSequence.current===sequence)setExportBusy(false);}
  };
  return <details className="grade-v2-panel" open={thumbnailActive} onToggle={event=>setThumbnailActive(event.currentTarget.open)} data-testid="grade-v2-panel">
    <summary>Hao Film Looks v2</summary>
    <p>{uiText("依題材挑選原創 Look：分區色調、S 曲線與膚色保護，Rec.709 與 ACES 各自計算。")}</p>
    <label>{uiText("題材")}<select value={genre} onChange={(event) => setGenre(event.target.value as FilmLookGenre)} data-testid="grade-v2-genre">
      {FILM_LOOK_GENRES.map((value) => <option key={value} value={value}>{uiText(GENRE_LABELS[value])}</option>)}</select></label>
    <div className="film-look-list">
      <FilmLookThumbnailQueueV1 frame={thumbnailFrame} asset={asset} color={thumbnailColor??clip.color} grade={clip.gradeV2} management={colorManagement} rec709Input={clip.rec709Input} ids={filmLooksForGenre(genre).map(look=>look.id)} strength={strength} active={thumbnailActive} readLut={thumbnailReadLut} unavailable={thumbnailUnavailable}>
      {filmLooksForGenre(genre).map((look) => {
        const active = clip.gradeV2?.look?.id === look.id;
        return <button key={look.id} type="button" className={active ? "active" : ""} aria-pressed={active} disabled={!onGradeV2Change}
          title={uiText(look.summary)} onClick={() => apply(look.id)} data-testid={`film-look-${look.id}`}>
          <FilmLookThumbnailV1 id={look.id} name={uiText(look.name)}/>
          <span>{uiText(look.name)}</span><small className={`certification-${look.certification.status}`}>{uiText(CERTIFICATION_LABELS[look.certification.status])}</small>
        </button>;
      })}
      </FilmLookThumbnailQueueV1>
    </div>
    <label><span>{uiText("強度")}<output>{strength.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.05" value={strength} {...strengthInput?.events}
      disabled={!onGradeV2Change} onChange={(event) => { const value = Number(event.target.value); setStrength(value); if (!strengthInput?.change(event.currentTarget, value) && clip.gradeV2?.look) apply(clip.gradeV2.look.id, value); }} data-testid="grade-v2-strength" /></label>
    <div className="grade-v2-actions">
      <button type="button" disabled={!onGradeV2Change || !clip.gradeV2} onClick={() => onGradeV2Change?.(null)} data-testid="grade-v2-remove">{uiText("移除 v2 調色")}</button>
      <button type="button" disabled={!clip.gradeV2||exportBusy} onClick={()=>void exportCube()} data-testid="grade-v2-export">{uiText("匯出 v2 調色 .cube")}</button>
    </div>
    {exportState && <small role="status">{exportState}</small>}
    <small>{uiText(".cube 包含 v2 節點、LUT 與 Look；不包含 Primary 與空間效果。")}</small>
    {!onGradeV2Change && <small>{uiText(gradeReadOnlyReason ?? "這個版本還不能在這裡套用 v2 調色，目前只能查看與匯出 .cube。")}</small>}
    {colorManagement.mode === "aces2" && colorManagement.outputTransform === "rec709_sdr" && <small data-testid="grade-v2-aces-display-note">{uiText("ACES 2.0：套用 v2 調色的手機與其他顯示參考素材，會先用 ACES 2.0 SDR 輸出轉換的反轉還原，強度 0 就是原片外觀；沒有 v2 調色的片段維持原本的輸入轉換。")}</small>}
    <small>{uiText("舊版 Look 只調整亮度、對比與飽和；標示「舊版」的會整張轉色相，天空與膚色可能偏色。")}</small>
  </details>;
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

export function ColorWorkspace({ embedded = false, asset, clip, source, playhead, colorManagement, onColorManagementChange, onColorChange, onColorGestureStart, colorEditScopeKey, onInputColorSpaceChange, onRec709InputChange, onAlphaModeChange, onGradeV2Change, onGradeLookGestureStart, onGradeGestureStart, gradeBaseClip, gradeEditOccurrence, gradeReadOnlyReason, gradeEditScope, gradeClipboard, colorLutApi, onClose }: ColorWorkspaceProps) {
  useI18n();
  const workingSpace=gradeWorkingSpace(colorManagement),lut=useColorLutClientV1(workingSpace,colorLutApi);
  const [bypass, setBypass] = useState(false);
  const [comparison, setComparison] = useState(false);
  const admission=colorWorkspaceInputAdmissionV1(asset,colorManagement),{acesInput,legacyInput,precisionBlock}=admission;
  const blocked = admission.metadataInvalid || (colorManagement.mode === "aces2" ? acesInput === "blocked_log" || Boolean(precisionBlock) : legacyInput === "blocked_log");
  const hasWb = [clip.color,...clip.keyframes.map(k=>k.color)].some(c=>[c.whiteBalanceRed??0,c.whiteBalanceGreen??0,c.whiteBalanceBlue??0].some(v=>v!==0));
  const scopeUnavailable = admission.metadataInvalid ? precisionBlock : hasWb ? "線性白平衡已儲存；瀏覽器 8-bit 預覽與示波器尚未校準此增益，暫不顯示。"
    : blocked || colorManagement.mode === "aces2" || legacyInput !== "rec709" ? "此 HDR／Log／色彩轉換尚無已校準的瀏覽器示波器；請以正式輸出量測。"
    : hasAuthoredClipTimeRemapV1(clip) ? "此變速片段尚無已校準的調色工作區影格；請以正式預覽與輸出量測。" : undefined;
  const localTime = Math.max(0, Math.min(clip.duration, playhead - clip.timelineStart));
  const previewColor = bypass ? DEFAULT_COLOR : combineLookColor(animatedClipState(clip, localTime).color, clip.creative?.lookPresetId);
  const thumbnailColor=combineLookColor(animatedClipState(clip,localTime).color,clip.creative?.lookPresetId),thumbnailOwner=previewPickerOwnerKeyV1(clip.id,gradeEditScope),sourceTime=clip.sourceStart+localTime;
  const mainPreview=Boolean(source&&!blocked&&!scopeUnavailable),thumbnailAllowed=Boolean(source&&['image','video'].includes(asset.kind)&&!blocked&&!hasWb&&!hasAuthoredClipTimeRemapV1(clip)&&(colorManagement.mode==='aces2'||legacyInput==='rec709'));
  const thumbnailExpected={pipelineKey:previewFramePipelineKeyV1({asset,source:source??'',grade:mainPreview?(bypass?undefined:clip.gradeV2):undefined,management:colorManagement,rec709Input:clip.rec709Input,ownerKey:thumbnailOwner}),primaryKey:JSON.stringify(mainPreview?previewColor:thumbnailColor),...(asset.kind==='video'?{sourceTime}:{})};
  const thumbnailSourceKey=JSON.stringify([thumbnailOwner,asset,source,sourceTime]),thumbnailSource=useLookThumbnailSourceV1(thumbnailSourceKey,thumbnailExpected,thumbnailAllowed);

  const inputLabel = admission.metadataInvalid ? uiText("素材色彩標記需修正 · 輸出阻擋") : precisionBlock ? "此 HDR 組合精度不足 · 輸出阻擋" : blocked ? "未解讀 Log · 輸出阻擋" : colorManagement.mode === "aces2" ? `Input: ${String(acesInput).toUpperCase()}` : `Input: ${legacyInput.toUpperCase()}`;
  return <div className="modal-backdrop color-workspace-backdrop" role="presentation" data-embedded={embedded}>
    <section className="color-workspace" role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={uiText("專業調色工作區")} data-testid="color-workspace">
      <header><div><span className="eyebrow">COLOR WORKSPACE · {colorManagement.mode === "aces2" ? "ACES 2.0" : "REC.709"}</span><h2>{uiText("專業調色")}</h2><p>{colorManagement.mode === "aces2" ? "Input Transform → ACEScct → Primary → Output Transform" : uiText("快速 Rec.709 → Primary → Graphics")}</p></div><button type="button" className="modal-close" onClick={onClose} aria-label={uiText("關閉")}>×</button></header>
      <div className="color-layout">
        <div className="scope-stage">
          <div className="scope-toolbar"><strong>{asset.name}</strong><span className={blocked ? "blocked" : ""}>{inputLabel}</span><button type="button" className={bypass ? "active" : ""} onClick={() => { setComparison(false); setBypass((value) => !value); }}>A/B {bypass ? uiText("原片") : uiText("調色")}</button>
            <button type="button" disabled={!source || blocked || Boolean(scopeUnavailable)} aria-pressed={comparison && !bypass && !scopeUnavailable} className={comparison && !bypass && !scopeUnavailable ? "active" : ""}
              onClick={() => { setBypass(false); setComparison(value => !value); }} data-testid="color-comparison-toggle">{uiText("A/B 分割")}</button></div>
          {source && !blocked && !scopeUnavailable ? <GpuColorScopesV1 asset={asset} source={source} color={previewColor} grade={bypass ? undefined : clip.gradeV2}
            management={colorManagement} rec709Input={clip.rec709Input} sourceTime={sourceTime} comparison={comparison && !bypass} readLut={lut.readLut} pickerOwnerKey={thumbnailOwner} onPreviewFrame={thumbnailSource.receive} onPreviewUnavailable={thumbnailSource.previewUnavailable}/>
            : <div className="scope-unavailable" role="status" data-testid="color-scope-unavailable">{uiText(scopeUnavailable ?? precisionBlock ?? (blocked ? "請指定正確的相機 Input Transform" : "請先建立素材預覽檔"))}</div>}
          <small>{uiText("· 校色顯示器與 reference parity 仍需另行量測。")}</small>
          {!mainPreview&&thumbnailAllowed&&source&&<LookThumbnailFallbackSourceV1 source={source} kind={asset.kind==='video'?'video':'image'} contextKey={thumbnailSourceKey} identity={thumbnailExpected} onFrame={thumbnailSource.receive} onError={thumbnailSource.clear}/>} 
        </div>
        <aside className="grade-controls">
          {gradeClipboard && <ColorGradeClipboardPanelV1 {...gradeClipboard} />}
          <fieldset className="pipeline-mode"><legend>{uiText("色彩管理")}</legend><button type="button" className={colorManagement.mode === "rec709" ? "active" : ""} onClick={() => onColorManagementChange({ mode: "rec709", outputTransform: "rec709_sdr" })}>{uiText("快速 Rec.709")}</button><button type="button" className={colorManagement.mode === "aces2" ? "active" : ""} onClick={() => onColorManagementChange({ mode: "aces2" })}>{uiText("ACES 2.0 專業")}</button></fieldset>
          <label>{uiText("素材 Input Transform")}<select value={asset.color?.interpretation ?? "auto"} onChange={(event) => onInputColorSpaceChange(event.target.value as InputColorSpace)}>{INPUT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{usesAcesPhoneSdrV1(colorManagement) && value === "rec709" ? "Rec.709" : label}</option>)}</select></label>
          <label>{uiText("透明度 Alpha")}<select value={asset.alphaMode ?? "auto"} onChange={(event) => onAlphaModeChange(event.target.value as SourceAlphaMode)}><option value="auto">{uiText("自動（影片不透明／圖片直通）")}</option><option value="opaque">{uiText("強制不透明")}</option><option value="straight">Straight Alpha</option><option value="premultiplied">Premultiplied Alpha</option></select></label>
          {usesAcesPhoneSdrV1(colorManagement) && acesInput === "rec709" && <label>{uiText("這個片段的 Rec.709 解讀")}<select data-testid="clip-rec709-input" value={clip.rec709Input ?? "display"} disabled={!onRec709InputChange} onChange={event => onRec709InputChange?.(event.target.value as "display" | "camera")}><option value="display">{uiText("手機 Rec.709（保留拍攝外觀）")}</option><option value="camera">{uiText("相機 Rec.709（場景光）")}</option></select></label>}
          {colorManagement.mode === "aces2" && <label>{uiText("輸出顯示 Output Transform")}<select value={colorManagement.outputTransform} onChange={(event) => onColorManagementChange({ outputTransform: event.target.value as AcesOutputTransform })}>{OUTPUT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
          <div className="color-pipeline-note"><strong>{colorManagement.mode === "aces2" ? uiText("ACEScct 工作空間") : uiText("快速 SDR 工作流")}</strong><span>{colorManagement.mode === "aces2" ? uiText("內建官方 OCIO ACES 2.0 config 生成的高精度 transforms（SDR 65³／HDR 129³）；未知 Log 不會偷偷當 Rec.709。") : uiText("適合手機與已完成 Rec.709 素材；Log／HDR 建議切到 ACES。")}</span></div>
          <div className="grade-control-grid">{CONTROLS.map((control) => <label key={control.key}><span>{control.label}<output>{clip.color[control.key].toFixed(2)}</output></span><ParameterRangeV1 scopeKey={`${colorEditScopeKey ?? clip.id}:${control.key}`} onGestureStart={onColorGestureStart ? () => onColorGestureStart(control.key) : undefined} min={control.min} max={control.max} step={control.step} value={clip.color[control.key]} onChange={value => onColorChange({ [control.key]: value })} data-testid={`grade-${control.key}`} /></label>)}</div>
          <details><summary>{uiText("線性白平衡（進階）")}</summary><p>{uiText("RGB 通道 log2 增益：+1 stop = 2 倍，0 = 不變；不是 Kelvin 色溫。")}</p><div className="grade-control-grid">{([['whiteBalanceRed','紅'],['whiteBalanceGreen','綠'],['whiteBalanceBlue','藍']] as const).map(([key,label])=><label key={key}><span>{label}{uiText("通道（stops）")}<output>{(clip.color[key]??0).toFixed(2)}</output></span><ParameterRangeV1 scopeKey={`${colorEditScopeKey ?? clip.id}:${key}`} onGestureStart={onColorGestureStart ? () => onColorGestureStart(key) : undefined} aria-label={uiText("{value0}通道線性增益", { value0: label })} data-testid={`grade-${key}`} min="-4" max="4" step="0.05" value={clip.color[key]??0} onChange={value=>onColorChange({[key]:value})}/></label>)}</div></details>
          <button type="button" className="grade-reset" onClick={() => onColorChange({ ...DEFAULT_COLOR })}>{uiText("重設 Primary")}</button>
          <GradeV2Panel asset={asset} clip={clip} colorManagement={colorManagement} onGradeV2Change={onGradeV2Change} onGradeLookGestureStart={onGradeLookGestureStart} gradeEditOccurrence={gradeEditOccurrence} gradeReadOnlyReason={gradeReadOnlyReason} gradeEditScope={gradeEditScope} lutClient={lut.client} thumbnailFrame={thumbnailSource.frame} thumbnailColor={thumbnailColor} thumbnailUnavailable={!thumbnailAllowed?scopeUnavailable:undefined} thumbnailReadLut={lut.readLut}/>
          <ColorGradeNodePanelV1 clipId={clip.id} grade={(gradeBaseClip ?? clip).gradeV2} onGestureStart={onGradeGestureStart} onChange={onGradeV2Change} readOnlyReason={gradeReadOnlyReason} editScope={gradeEditScope} editOccurrence={gradeEditOccurrence} lutClient={lut.client} workingSpace={workingSpace}/>
        </aside>
      </div>
    </section>
  </div>;
}
