import type { Wave2MotionPreset } from "../creative/wave2Registry";
import { findMotionGraphicPreset, HOLOGRAM_MOTION_PRESETS } from "../creative/motionGraphicPresets";
import type { MediaAsset, MotionGraphic, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NormalizedRect } from "../domain/types";
import { formatTime } from "../lib/format";
import { EDITKIN_MOTION } from "../motion/identity";
import { FLOATING_VIDEO_FRAME_PRESETS, floatingVideoFramePresetV2 } from "../motion/floatingVideoFrame";
import { FLOATING_FRAME_SCENE_PRESETS, type FloatingFrameScenePresetId, type FloatingFrameSceneBindings } from "../motion/floatingFrameScenes";
import FloatingFrameSourceSlots from "./FloatingFrameSourceSlots";
import ReferenceMotionTemplateControls, { type ManualReferenceMotionTemplate } from "./ReferenceMotionTemplateControls";
import MotionVectorControls from "./MotionVectorControls";
import MotionTextLayoutControls from "./MotionTextLayoutControls";
import { MOTION_CLIP_PRESETS, type MotionClipPresetId } from "../motion/motionClipPresets";
import { NATIVE_VECTOR_PRESETS } from "../creative/nativeVectorPresets";
import { REEL_MOTION_PRESETS } from "../creative/reelMotionPresets";
import type { FloatingVideoFrame, TimelineClip } from "../domain/types";
import { bundledFontFamilies, resolveBundledFontFace } from "../typography/fontFaces";
import "./motionStudio.css";

const fontFamilies = bundledFontFamilies();

export interface MotionStudioProps {
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
  onUpdateMotionGraphic: (graphicId: string, patch: Partial<Omit<MotionGraphic, "schema" | "id">>) => void;
  onDeleteMotionGraphic: (graphicId: string) => void;
}

export default function MotionStudio({ asset, clip, onSetFloatingFrame, onApplyFloatingScene, sceneAssets = [], portraitCanvas, onApplyClipMotionPreset, onApplyReferenceMotionTemplate, referenceMotionTemplateBusy, onCancelReferenceMotionTemplate, projectFps, motionTracks, trackingBusy, trackingSelectionActive, trackingSelection, onBeginMotionTrack, onCorrectMotionTrack, onDeleteMotionTrack, onAddMotionGraphic, onAddGeometryMotion, wave2Presets, motionGraphics, managedMotionGraphicIds = [], onUpdateMotionGraphic, onDeleteMotionGraphic }: MotionStudioProps) {
  return <div className="motion-controls" aria-label="動態圖卡與追蹤">
    <div className="creative-heading"><div><span className="eyebrow">{EDITKIN_MOTION.name}</span><strong>{EDITKIN_MOTION.label}</strong></div><small>文字可編輯</small></div>
    <div className="motion-quick-grid" data-testid="motion-template-previews">
      <button type="button" className="motion-preset-card title" onClick={() => onAddMotionGraphic("title")}><span><b>你的主標題</b><i>俐落上移</i></span><small>＋ 動態標題</small></button>
      <button type="button" className="motion-preset-card card" onClick={() => onAddMotionGraphic("card")}><span><b>本段重點</b><i>輕推入場</i></span><small>＋ 重點卡</small></button>
      <button type="button" className="motion-preset-card counter" onClick={() => onAddMotionGraphic("counter")}><span><b>01</b><i>數字淡入</i></span><small>＋ 數字重點</small></button>
      <button type="button" className="motion-preset-card title" onClick={() => onAddMotionGraphic("title", undefined, findMotionGraphicPreset("v2-word-cascade").seed)}><span><b>逐詞登場</b><i>motion v2</i></span><small>＋ 彈性逐詞主標</small></button>
      <button type="button" className="motion-preset-card card" disabled={!onAddGeometryMotion} onClick={onAddGeometryMotion} data-testid="add-continuity-geometry"><span><b>連續輪廓</b><i>圓形 → 柔角面板</i></span><small>＋ 可編輯邊緣動作</small></button>
    </div>
    {asset.kind === "video" && clip && <>
      <ReferenceMotionTemplateControls key={`reference-${clip.id}`} clip={clip} assets={sceneAssets} portrait={portraitCanvas} fps={projectFps} onApply={onApplyReferenceMotionTemplate} busy={referenceMotionTemplateBusy} onCancel={onCancelReferenceMotionTemplate} />
      <details className="floating-video-frame-controls" data-testid="floating-video-frame-controls">
        <summary>影片浮空框 <small>原片即時嵌入 · 2.5D 透視</small></summary>
        <p>新浮窗按原片比例完整嵌入，逐格進退場；直式環繞使用直式平面。這是 2.5D 透視，框體、角度、大小可編輯。</p>
        <div className="motion-quick-grid">
          {FLOATING_VIDEO_FRAME_PRESETS.map(preset => <button type="button" key={preset.id} className="motion-preset-card card"
            onClick={() => onSetFloatingFrame?.(floatingVideoFramePresetV2(preset.id))}
            disabled={!onSetFloatingFrame || (preset.id === "portrait_orbit" && portraitCanvas === false) || (projectFps !== undefined && Math.round(clip.duration * projectFps) < 13)}
            data-testid={`floating-frame-${preset.id}`}><span><b>{preset.name}</b><i>{preset.yawDegrees}°</i></span><small>＋ 套用</small></button>)}
          {FLOATING_FRAME_SCENE_PRESETS.map(preset => <button type="button" key={preset.id} className="motion-preset-card card"
            title={preset.description}
            onClick={() => onApplyFloatingScene?.(preset.id)} disabled={!onApplyFloatingScene || Boolean(clip.floatingFrame) || portraitCanvas === false || (projectFps !== undefined && Math.round(clip.duration * projectFps) < 13)}
            data-testid={`floating-scene-${preset.id}`}><span><b>{preset.name}</b><i>原片比例 · 可編輯平面</i></span><small>＋ 套用</small></button>)}
        </div>
        {projectFps !== undefined && Math.round(clip.duration * projectFps) < 13 && <small>新浮窗預設需要至少 13 格，才能保留完整進退場；請延長片段。</small>}
        <FloatingFrameSourceSlots key={clip.id} clip={clip} assets={sceneAssets} disabled={Boolean(clip.floatingFrame) || portraitCanvas === false || (projectFps !== undefined && Math.round(clip.duration * projectFps) < 13)} onApply={onApplyFloatingScene} />
        {clip.floatingFrame && <div className="transform-grid">
          <small data-testid="floating-frame-version">{clip.floatingFrame.schema === "editkin.floating-video-frame/v2" ? "v2 · 完整嵌入 · 逐格進退場" : "v1 · 保留既有裁切與動畫；重新套用預設才升級 v2"}</small>
          <label>畫面大小<input type="range" min="0.3" max="0.82" step="0.01" value={clip.floatingFrame.size}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, size: Number(event.target.value) })} /><output>{Math.round(clip.floatingFrame.size * 100)}%</output></label>
          <label>左右透視<input type="range" min="-35" max="35" step="1" value={clip.floatingFrame.yawDegrees}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, yawDegrees: Number(event.target.value) })} /><output>{clip.floatingFrame.yawDegrees}°</output></label>
          <label>上下透視<input type="range" min="-25" max="25" step="1" value={clip.floatingFrame.pitchDegrees}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, pitchDegrees: Number(event.target.value) })} /><output>{clip.floatingFrame.pitchDegrees}°</output></label>
          <label>水平位置<input type="range" min="0.2" max="0.8" step="0.01" value={clip.floatingFrame.centerX ?? .5}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, centerX: Number(event.target.value) })} /><output>{Math.round((clip.floatingFrame.centerX ?? .5) * 100)}%</output></label>
          <label>垂直位置<input type="range" min="0.2" max="0.8" step="0.01" value={clip.floatingFrame.centerY ?? .5}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, centerY: Number(event.target.value) })} /><output>{Math.round((clip.floatingFrame.centerY ?? .5) * 100)}%</output></label>
          {clip.floatingFrame.orbit && <><label>環繞角度<input type="range" min="0" max="30" step="1" value={clip.floatingFrame.orbit.amplitudeDegrees}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, orbit: { ...clip.floatingFrame!.orbit!, amplitudeDegrees: Number(event.target.value) } })} /><output>{clip.floatingFrame.orbit.amplitudeDegrees}°</output></label>
          <label>旋轉週期<input type="range" min="2" max="8" step="0.1" value={clip.floatingFrame.orbit.periodSeconds}
            onChange={event => onSetFloatingFrame?.({ ...clip.floatingFrame!, orbit: { ...clip.floatingFrame!.orbit!, periodSeconds: Number(event.target.value) } })} /><output>{clip.floatingFrame.orbit.periodSeconds}s</output></label></>}
          <button type="button" onClick={() => onSetFloatingFrame?.(undefined)}>移除浮空框</button>
        </div>}
      </details>
      <details className="motion-clip-preset-controls" data-testid="motion-clip-preset-controls">
        <summary>2D 片段動態 <small>逐格關鍵幀 · 可復原</small></summary>
        <div className="motion-quick-grid">{MOTION_CLIP_PRESETS.map(preset => <button type="button" key={preset.id}
          className="motion-preset-card title" title={preset.description} disabled={!onApplyClipMotionPreset || clip.keyframes.length > 0 || clip.duration < .5}
          onClick={() => onApplyClipMotionPreset?.(preset.id)}><span><b>{preset.name}</b><i>2D motion</i></span><small>＋ 關鍵幀</small></button>)}</div>
        {clip.keyframes.length > 0 && <small>此片段已有關鍵幀，為保留既有動畫，預設按鈕已停用。</small>}
      </details>
    </>}
    <details className="wave2-motion-library" data-testid="native-reel-motion-library">
      <summary>資訊與空間 Motion <small>可編輯圖形 · 逐格動畫</small></summary>
      <div className="wave2-motion-grid">{[...REEL_MOTION_PRESETS, ...NATIVE_VECTOR_PRESETS].map(preset => <button type="button" key={preset.id}
        data-testid={`native-motion-${preset.id}`} onClick={() => onAddMotionGraphic(preset.seed.kind ?? "card", undefined, preset.seed)}>
        <span>{preset.name}</span>
      </button>)}</div>
    </details>
    <details className="hologram-motion-library" data-testid="hologram-motion-library">
      <summary>全息／追蹤文字 <small>{HOLOGRAM_MOTION_PRESETS.length} 款 · 可即時改字</small></summary>
      <div className="hologram-motion-grid">
        {HOLOGRAM_MOTION_PRESETS.map((preset) => <button type="button" key={preset.id} data-visual-style={preset.seed.visualStyle} title={`${preset.family} · 原生 procedural`} onClick={() => onAddMotionGraphic(preset.seed.kind ?? "card", undefined, preset.seed)}>
          <i style={{ color: preset.seed.textColor, backgroundColor: preset.seed.backgroundColor, borderColor: preset.seed.accentColor }}>Aa</i>
          <span><b>{preset.name}</b><small>{preset.family}</small></span>
        </button>)}
      </div>
    </details>
    <details className="wave2-motion-library" data-testid="wave2-motion-library">
      <summary>2026 Wave 2 可編輯版型 <small>{wave2Presets.length} 款</small></summary>
      {(["label", "widget", "template"] as const).map((presetType) => <section key={presetType}>
        <strong>{presetType === "label" ? "動態標籤" : presetType === "widget" ? "資料圖卡" : "視覺家族模板"}</strong>
        <div className="wave2-motion-grid">
          {wave2Presets.filter((preset) => preset.presetType === presetType).map((preset) => <button type="button" key={preset.id} title={`${preset.family} · ${preset.license}`} style={{ borderColor: preset.seed.accentColor }} onClick={() => onAddMotionGraphic(preset.seed.kind ?? "card", undefined, preset.seed)}><i style={{ background: preset.seed.backgroundColor, color: preset.seed.textColor }}>{preset.seed.kind === "counter" ? "01" : "Aa"}</i><span>{preset.name}</span></button>)}
        </div>
      </section>)}
    </details>
    {motionGraphics.length > 0 && <div className="motion-graphic-list">
      {motionGraphics.map((graphic) => <div key={graphic.id}>
        {!graphic.vectorV2 && <input value={graphic.text} disabled={managedMotionGraphicIds.includes(graphic.id)} aria-label={`${graphic.name}文字`} onChange={(event) => {
          if (!managedMotionGraphicIds.includes(graphic.id)) onUpdateMotionGraphic(graphic.id, { text: event.target.value });
        }} />}
        {managedMotionGraphicIds.includes(graphic.id) && <small>此圖層由場景或模板管理，請使用對應的場景／模板編輯器。</small>}
        <span>{formatTime(graphic.timelineStart)} · {graphic.name}{graphic.visualStyle && graphic.visualStyle !== "solid_panel" ? ` · ${graphic.visualStyle}` : ""}</span>
        {!graphic.vectorV2 && !managedMotionGraphicIds.includes(graphic.id) && <label className="motion-width-mode">字型
          <select aria-label={`${graphic.name}字型`} value={graphic.fontFamily ?? "Noto Sans TC"} onChange={event => {
            const fontFamily = event.target.value;
            const face = resolveBundledFontFace(fontFamily, Math.min(900, Math.max(100, graphic.fontWeight ?? 700)));
            if (face) onUpdateMotionGraphic(graphic.id, { fontFamily, fontWeight: face.fontWeight });
          }}>
            {graphic.fontFamily && !fontFamilies.includes(graphic.fontFamily) && <option value={graphic.fontFamily} disabled>{graphic.fontFamily}（未驗證字型）</option>}
            {fontFamilies.map(family => <option key={family} value={family}>{family}{family === "Bebas Neue" || family === "Fredoka" ? " · 英文／數字" : ""}</option>)}
          </select>
        </label>}
        {graphic.schema === "hao.motion-composition/v2" && !graphic.vectorV2 && !graphic.trackId && !managedMotionGraphicIds.includes(graphic.id) &&
          <MotionTextLayoutControls graphic={graphic} onUpdate={patch => onUpdateMotionGraphic(graphic.id, patch)} />}
        {graphic.vectorV2 && !managedMotionGraphicIds.includes(graphic.id) && <MotionVectorControls graphic={graphic} onUpdate={patch => onUpdateMotionGraphic(graphic.id, patch)} />}
        {graphic.schema === "hao.motion-composition/v2" && graphic.vectorV2 && graphic.vectorV2.kind !== "spring_panel" && !graphic.text && !graphic.trackId && !managedMotionGraphicIds.includes(graphic.id) && <label className="motion-width-mode">合成位置
          <select aria-label={`${graphic.name}合成位置`} value={graphic.vectorV2.schema === "editkin.motion-vector-annotation/v1" ? "annotation" : graphic.compositeLayer ?? "foreground"} onChange={event => {
            const vector = graphic.vectorV2;
            if (!vector || vector.kind === "spring_panel") return;
            if (event.target.value === "annotation") {
              if (vector.kind !== "rule") return;
              onUpdateMotionGraphic(graphic.id, { compositeLayer: "foreground", vectorV2: { ...vector, schema: "editkin.motion-vector-annotation/v1", kind: "rule" } });
              return;
            }
            onUpdateMotionGraphic(graphic.id, { compositeLayer: event.target.value as "background" | "foreground", vectorV2: { ...vector, schema: "editkin.motion-vector-stage/v1" } });
          }}>
            <option value="foreground">素材前方</option><option value="background">素材後方</option>
            {graphic.vectorV2.kind === "rule" && <option value="annotation">文字上方</option>}
          </select>
        </label>}
        {graphic.schema === "hao.motion-composition/v2" && graphic.layoutV2 && !graphic.vectorV2 && !managedMotionGraphicIds.includes(graphic.id) && <label className="motion-width-mode">底框
          <select aria-label={`${graphic.name}底框寬度`} value={graphic.layoutV2.widthMode ?? "fixed"} onChange={(event) => onUpdateMotionGraphic(graphic.id, { layoutV2: { ...graphic.layoutV2!, widthMode: event.target.value as "fixed" | "fit_content" } })}>
            <option value="fixed">固定寬度</option><option value="fit_content">貼合文字</option>
          </select>
        </label>}
        <button type="button" disabled={managedMotionGraphicIds.includes(graphic.id)} aria-label={`刪除${graphic.name}`} onClick={() => {
          if (!managedMotionGraphicIds.includes(graphic.id)) onDeleteMotionGraphic(graphic.id);
        }}>×</button>
      </div>)}
    </div>}
    {asset.kind === "video" && <div className="tracking-workflow">
      <div className="tracking-preview"><span><b>重點</b></span><div><strong>讓文字跟著人或物件移動</strong><small>框選一次；低信心影格標記 lost，不會亂猜。</small></div></div>
      <button type="button" className={trackingSelectionActive ? "active" : ""} disabled={trackingBusy} onClick={onBeginMotionTrack} data-testid="motion-track-button">
        {trackingBusy ? "正在追蹤…" : trackingSelectionActive ? "請在畫面框選主體" : "1. 框選主體並自動追蹤"}
      </button>
      {trackingSelection && <small>已框選 {Math.round(trackingSelection.width * 100)}% × {Math.round(trackingSelection.height * 100)}%</small>}
      {motionTracks.map((track) => <div className="motion-track-row" key={track.id}>
        <span><b>{track.name}</b><small>{Math.round((1 - track.lostRatio) * 100)}% 有效 · {track.engine.replace("hao-core-rust-", "")}</small></span>
        <button type="button" onClick={() => onAddMotionGraphic("tag", track.id)}>2. 綁標籤</button>
        <button type="button" title="把全息網格文字四角貼合追蹤平面；文字仍可即時修改" onClick={() => onAddMotionGraphic("tag", track.id, { ...findMotionGraphicPreset("holo_surface_grid").seed, trackingMode: "surface", animation: "fade" })}>全息貼合</button>
        <button type="button" onClick={() => onCorrectMotionTrack(track.id)}>修正此幀</button>
        <button type="button" className="danger" aria-label={`刪除${track.name}`} onClick={() => onDeleteMotionTrack(track.id)}>×</button>
      </div>)}
    </div>}
  </div>;
}
