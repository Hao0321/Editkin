import { renderMotionGraphicPropertiesV1 } from "./MotionGraphicPropertiesV1";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { GraphicNumberGestureStartV1 } from "../application/graphicParameterGestureV1";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import type { Wave2MotionPreset } from "../creative/wave2Registry";
import { findMotionGraphicPreset, HOLOGRAM_MOTION_PRESETS } from "../creative/motionGraphicPresets";
import MotionV3Library from "./MotionV3Library";
import type { MediaAsset, MotionGraphic, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NormalizedRect } from "../domain/types";
import { EDITKIN_MOTION } from "../motion/identity";
import { FLOATING_VIDEO_FRAME_PRESETS, floatingVideoFramePresetV2 } from "../motion/floatingVideoFrame";
import { FLOATING_FRAME_SCENE_PRESETS, type FloatingFrameScenePresetId, type FloatingFrameSceneBindings } from "../motion/floatingFrameScenes";
import FloatingFrameSourceSlots from "./FloatingFrameSourceSlots";
import ReferenceMotionTemplateControls, { type ManualReferenceMotionTemplate } from "./ReferenceMotionTemplateControls";
import { MOTION_CLIP_PRESETS, type MotionClipPresetId } from "../motion/motionClipPresets";
import { NATIVE_VECTOR_PRESETS } from "../creative/nativeVectorPresets";
import { REEL_MOTION_PRESETS } from "../creative/reelMotionPresets";
import type { FloatingVideoFrame, TimelineClip } from "../domain/types";
import "./motionStudio.css";
import "./templateEditorEntry.css";


export interface MotionStudioProps {
  showTracking?: boolean;
  asset: MediaAsset;
  clip?: TimelineClip;
  onSetFloatingFrame?: (frame?: FloatingVideoFrame) => void;
  onApplyFloatingScene?: (preset: FloatingFrameScenePresetId, sources?: FloatingFrameSceneBindings) => void;
  sceneAssets?: readonly MediaAsset[];
  portraitCanvas?: boolean;
  onApplyClipMotionPreset?: (preset: MotionClipPresetId) => void;
  onApplyReferenceMotionTemplate?: (input: ManualReferenceMotionTemplate) => void;
  referenceMotionTemplateBusy?: boolean;
  onCancelReferenceMotionTemplate?: () => void;
  projectFps?: number;
  motionTracks: MotionTrack[];
  trackingBusy: boolean;
  trackingSelectionActive: boolean;
  trackingSelection?: NormalizedRect;
  onBeginMotionTrack: () => void;
  onCorrectMotionTrack: (trackId: string) => void;
  onDeleteMotionTrack: (trackId: string) => void;
  onAddMotionGraphic: (kind: MotionGraphicKind, trackId?: string, seed?: MotionGraphicPresetSeed) => void;
  onAddGeometryMotion?: () => void;
  wave2Presets: Wave2MotionPreset[];
  motionGraphics: MotionGraphic[];
  managedMotionGraphicIds?: readonly string[];
  editScope?: unknown;
  onTextGestureStart?: (graphicId: string) => ParameterGestureLeaseV1<string> | undefined;
  onTextDraftRejected?: () => void;
  onNumberGestureStart?: GraphicNumberGestureStartV1;
  onNumberDraftRejected?: () => void;
  onUpdateMotionGraphic: (graphicId: string, patch: Partial<Omit<MotionGraphic, "schema" | "id">>) => boolean | void;
  onDeleteMotionGraphic: (graphicId: string) => void;
  /** Which saved title template owns a graphic, so its hint can open that template's editor. */
  templateOwners?: Readonly<Record<string, { instanceId: string; title: string }>>;
}

export default function MotionStudio({ showTracking = true, asset, clip, onSetFloatingFrame, onApplyFloatingScene, sceneAssets = [], portraitCanvas, onApplyClipMotionPreset, onApplyReferenceMotionTemplate, referenceMotionTemplateBusy, onCancelReferenceMotionTemplate, projectFps, motionTracks, trackingBusy, trackingSelectionActive, trackingSelection, onBeginMotionTrack, onCorrectMotionTrack, onDeleteMotionTrack, onAddMotionGraphic, onAddGeometryMotion, wave2Presets, motionGraphics, managedMotionGraphicIds = [], editScope, onTextGestureStart, onTextDraftRejected, onNumberGestureStart, onNumberDraftRejected, onUpdateMotionGraphic, onDeleteMotionGraphic, templateOwners }: MotionStudioProps) {
  useI18n();
  // One clear button per template (on its first graphic); its other graphics say which template they belong to.
  const templateHintGraphicIds = new Set<string>(), hintedTemplates = new Set<string>();
  for (const graphic of motionGraphics) {
    const owner = templateOwners?.[graphic.id];
    if (owner && !hintedTemplates.has(owner.instanceId)) { hintedTemplates.add(owner.instanceId); templateHintGraphicIds.add(graphic.id); }
  }
  return <div className="motion-controls" aria-label={uiText("動態圖卡與追蹤")}>
    <div className="creative-heading"><div><span className="eyebrow">{EDITKIN_MOTION.name}</span><strong>{EDITKIN_MOTION.label}</strong></div><small>{uiText("文字可編輯")}</small></div>
    <MotionV3Library onAddMotionGraphic={onAddMotionGraphic} />
    <div className="motion-quick-grid" data-testid="motion-template-previews">
      <button type="button" className="motion-preset-card title" onClick={() => onAddMotionGraphic("title")}><span><b>{uiText("你的主標題")}</b><i>{uiText("俐落上移")}</i></span><small>{uiText("＋ 動態標題")}</small></button>
      <button type="button" className="motion-preset-card card" onClick={() => onAddMotionGraphic("card")}><span><b>{uiText("本段重點")}</b><i>{uiText("輕推入場")}</i></span><small>{uiText("＋ 重點卡")}</small></button>
      <button type="button" className="motion-preset-card counter" onClick={() => onAddMotionGraphic("counter")}><span><b>01</b><i>{uiText("數字淡入")}</i></span><small>{uiText("＋ 數字重點")}</small></button>
      <button type="button" className="motion-preset-card title" onClick={() => onAddMotionGraphic("title", undefined, findMotionGraphicPreset("v2-word-cascade").seed)}><span><b>{uiText("逐詞登場")}</b><i>motion v2</i></span><small>{uiText("＋ 彈性逐詞主標")}</small></button>
      <button type="button" className="motion-preset-card card" disabled={!onAddGeometryMotion} onClick={onAddGeometryMotion} data-testid="add-continuity-geometry"><span><b>{uiText("連續輪廓")}</b><i>{uiText("圓形 → 柔角面板")}</i></span><small>{uiText("＋ 可編輯邊緣動作")}</small></button>
    </div>
    {asset.kind === "video" && clip && <>
      <ReferenceMotionTemplateControls key={`reference-${clip.id}`} clip={clip} assets={sceneAssets} portrait={portraitCanvas} fps={projectFps} onApply={onApplyReferenceMotionTemplate} busy={referenceMotionTemplateBusy} onCancel={onCancelReferenceMotionTemplate} />
      <details className="floating-video-frame-controls" data-testid="floating-video-frame-controls">
        <summary>{uiText("影片浮空框")}<small>{uiText("原片即時嵌入 · 2.5D 透視")}</small></summary>
        <p>{uiText("新浮窗按原片比例完整嵌入，逐格進退場；直式環繞使用直式平面。這是 2.5D 透視，框體、角度、大小可編輯。")}</p>
        <div className="motion-quick-grid">
          {FLOATING_VIDEO_FRAME_PRESETS.map(preset => <button type="button" key={preset.id} className="motion-preset-card card"
            onClick={() => onSetFloatingFrame?.(floatingVideoFramePresetV2(preset.id))}
            disabled={!onSetFloatingFrame || (preset.id === "portrait_orbit" && portraitCanvas === false) || (projectFps !== undefined && Math.round(clip.duration * projectFps) < 13)}
            data-testid={`floating-frame-${preset.id}`}><span><b>{preset.name}</b><i>{preset.yawDegrees}°</i></span><small>{uiText("＋ 套用")}</small></button>)}
          {FLOATING_FRAME_SCENE_PRESETS.map(preset => <button type="button" key={preset.id} className="motion-preset-card card"
            title={preset.description}
            onClick={() => onApplyFloatingScene?.(preset.id)} disabled={!onApplyFloatingScene || Boolean(clip.floatingFrame) || portraitCanvas === false || (projectFps !== undefined && Math.round(clip.duration * projectFps) < 13)}
            data-testid={`floating-scene-${preset.id}`}><span><b>{preset.name}</b><i>{uiText("原片比例 · 可編輯平面")}</i></span><small>{uiText("＋ 套用")}</small></button>)}
        </div>
        {projectFps !== undefined && Math.round(clip.duration * projectFps) < 13 && <small>{uiText("新浮窗預設需要至少 13 格，才能保留完整進退場；請延長片段。")}</small>}
        <FloatingFrameSourceSlots key={clip.id} clip={clip} assets={sceneAssets} disabled={Boolean(clip.floatingFrame) || portraitCanvas === false || (projectFps !== undefined && Math.round(clip.duration * projectFps) < 13)} onApply={onApplyFloatingScene} />
        {clip.floatingFrame && <div className="transform-grid">
          <small data-testid="floating-frame-version">{clip.floatingFrame.schema === "editkin.floating-video-frame/v2" ? uiText("v2 · 完整嵌入 · 逐格進退場") : uiText("v1 · 保留既有裁切與動畫；重新套用預設才升級 v2")}</small>
          <label>{uiText("畫面大小")}<input type="range" min="0.3" max="0.82" step="0.01" value={clip.floatingFrame.size}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, size: Number(event.target.value) })} /><output>{Math.round(clip.floatingFrame.size * 100)}%</output></label>
          <label>{uiText("左右透視")}<input type="range" min="-35" max="35" step="1" value={clip.floatingFrame.yawDegrees}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, yawDegrees: Number(event.target.value) })} /><output>{clip.floatingFrame.yawDegrees}°</output></label>
          <label>{uiText("上下透視")}<input type="range" min="-25" max="25" step="1" value={clip.floatingFrame.pitchDegrees}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, pitchDegrees: Number(event.target.value) })} /><output>{clip.floatingFrame.pitchDegrees}°</output></label>
          <label>{uiText("水平位置")}<input type="range" min="0.2" max="0.8" step="0.01" value={clip.floatingFrame.centerX ?? .5}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, centerX: Number(event.target.value) })} /><output>{Math.round((clip.floatingFrame.centerX ?? .5) * 100)}%</output></label>
          <label>{uiText("垂直位置")}<input type="range" min="0.2" max="0.8" step="0.01" value={clip.floatingFrame.centerY ?? .5}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, centerY: Number(event.target.value) })} /><output>{Math.round((clip.floatingFrame.centerY ?? .5) * 100)}%</output></label>
          {clip.floatingFrame.orbit && <><label>{uiText("環繞角度")}<input type="range" min="0" max="30" step="1" value={clip.floatingFrame.orbit.amplitudeDegrees}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, orbit: { ...clip.floatingFrame!.orbit!, amplitudeDegrees: Number(event.target.value) } })} /><output>{clip.floatingFrame.orbit.amplitudeDegrees}°</output></label>
          <label>{uiText("旋轉週期")}<input type="range" min="2" max="8" step="0.1" value={clip.floatingFrame.orbit.periodSeconds}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, orbit: { ...clip.floatingFrame!.orbit!, periodSeconds: Number(event.target.value) } })} /><output>{clip.floatingFrame.orbit.periodSeconds}s</output></label></>}
          <button type="button" onClick={() => onSetFloatingFrame?.(undefined)}>{uiText("移除浮空框")}</button>
        </div>}
      </details>
      <details className="motion-clip-preset-controls" data-testid="motion-clip-preset-controls">
        <summary>{uiText("2D 片段動態")}<small>{uiText("逐格關鍵幀 · 可復原")}</small></summary>
        <div className="motion-quick-grid">{MOTION_CLIP_PRESETS.map(preset => <button type="button" key={preset.id}
          className="motion-preset-card title" title={preset.description} disabled={!onApplyClipMotionPreset || clip.keyframes.length > 0 || clip.duration < .5}
          onClick={() => onApplyClipMotionPreset?.(preset.id)}><span><b>{preset.name}</b><i>2D motion</i></span><small>{uiText("＋ 關鍵幀")}</small></button>)}</div>
        {clip.keyframes.length > 0 && <small>{uiText("此片段已有關鍵幀，為保留既有動畫，預設按鈕已停用。")}</small>}
      </details>
    </>}
    <details className="wave2-motion-library" data-testid="native-reel-motion-library">
      <summary>{uiText("資訊與空間 Motion")}<small>{uiText("可編輯圖形 · 逐格動畫")}</small></summary>
      <div className="wave2-motion-grid">{[...REEL_MOTION_PRESETS, ...NATIVE_VECTOR_PRESETS].map(preset => <button type="button" key={preset.id}
        data-testid={`native-motion-${preset.id}`} onClick={() => onAddMotionGraphic(preset.seed.kind ?? "card", undefined, preset.seed)}>
        <span>{preset.name}</span>
      </button>)}</div>
    </details>
    <details className="hologram-motion-library" data-testid="hologram-motion-library">
      <summary>{uiText("全息／追蹤文字")}<small>{HOLOGRAM_MOTION_PRESETS.length} {uiText("款 · 可即時改字")}</small></summary>
      <div className="hologram-motion-grid">
        {HOLOGRAM_MOTION_PRESETS.map((preset) => <button type="button" key={preset.id} data-visual-style={preset.seed.visualStyle} title={uiText("{value0} · 原生 procedural", { value0: preset.family })} onClick={() => onAddMotionGraphic(preset.seed.kind ?? "card", undefined, preset.seed)}>
          <i style={{ color: preset.seed.textColor, backgroundColor: preset.seed.backgroundColor, borderColor: preset.seed.accentColor }}>Aa</i>
          <span><b>{preset.name}</b><small>{preset.family}</small></span>
        </button>)}
      </div>
    </details>
    <details className="wave2-motion-library" data-testid="wave2-motion-library">
      <summary>{uiText("2026 Wave 2 可編輯版型")}<small>{wave2Presets.length} {uiText("款")}</small></summary>
      {(["label", "widget", "template"] as const).map((presetType) => <section key={presetType}>
        <strong>{presetType === "label" ? uiText("動態標籤") : presetType === "widget" ? uiText("資料圖卡") : uiText("視覺家族模板")}</strong>
        <div className="wave2-motion-grid">
          {wave2Presets.filter((preset) => preset.presetType === presetType).map((preset) => <button type="button" key={preset.id} title={`${preset.family} · ${preset.license}`} style={{ borderColor: preset.seed.accentColor }} onClick={() => onAddMotionGraphic(preset.seed.kind ?? "card", undefined, preset.seed)}><i style={{ background: preset.seed.backgroundColor, color: preset.seed.textColor }}>{preset.seed.kind === "counter" ? "01" : "Aa"}</i><span>{preset.name}</span></button>)}
        </div>
      </section>)}
    </details>
    {motionGraphics.length > 0 && <div className="motion-graphic-list">
      {motionGraphics.map(graphic => <div key={graphic.id}>
        {renderMotionGraphicPropertiesV1({ graphic, managedMotionGraphicIds, templateOwners, editScope, onTextGestureStart, onTextDraftRejected, onNumberGestureStart, onNumberDraftRejected,
          showTemplateHint: templateHintGraphicIds.has(graphic.id), onUpdateMotionGraphic, onDeleteMotionGraphic })}
      </div>)}
    </div>}
    {showTracking && asset.kind === "video" && <div className="tracking-workflow">
      <div className="tracking-preview"><span><b>{uiText("重點")}</b></span><div><strong>{uiText("讓文字跟著人或物件移動")}</strong><small>{uiText("框選一次；低信心影格標記 lost，不會亂猜。")}</small></div></div>
      <button type="button" className={trackingSelectionActive ? "active" : ""} disabled={trackingBusy} onClick={onBeginMotionTrack} data-testid="motion-track-button">
        {trackingBusy ? uiText("正在追蹤…") : trackingSelectionActive ? uiText("請在畫面框選主體") : uiText("1. 框選主體並自動追蹤")}
      </button>
      {trackingSelection && <small>{uiText("已框選")}{Math.round(trackingSelection.width * 100)}% × {Math.round(trackingSelection.height * 100)}%</small>}
      {motionTracks.map((track) => <div className="motion-track-row" key={track.id}>
        <span><b>{track.name}</b><small>{Math.round((1 - track.lostRatio) * 100)}{uiText("% 有效 ·")}{track.engine.replace("hao-core-rust-", "")}</small></span>
        <button type="button" onClick={() => onAddMotionGraphic("tag", track.id)}>{uiText("2. 綁標籤")}</button>
        <button type="button" title={uiText("把全息網格文字四角貼合追蹤平面；文字仍可即時修改")} onClick={() => onAddMotionGraphic("tag", track.id, { ...findMotionGraphicPreset("holo_surface_grid").seed, trackingMode: "surface", animation: "fade" })}>{uiText("全息貼合")}</button>
        <button type="button" onClick={() => onCorrectMotionTrack(track.id)}>{uiText("修正此幀")}</button>
        <button type="button" className="danger" aria-label={uiText("刪除{value0}", { value0: track.name })} onClick={() => onDeleteMotionTrack(track.id)}>×</button>
      </div>)}
    </div>}
  </div>;
}
