import type { Wave2MotionPreset } from "../creative/wave2Registry";
import { findMotionGraphicPreset, HOLOGRAM_MOTION_PRESETS } from "../creative/motionGraphicPresets";
import { motionDesignV3FieldHint, motionDesignV3Seed } from "../creative/motionDesignV3Presets";
import { MOTION_DESIGN_V3_FIELDS } from "../domain/motionCompositionV3Contract";
import MotionV3Library from "./MotionV3Library";
import type { MediaAsset, MotionGraphic, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NormalizedRect } from "../domain/types";
import { formatTime } from "../lib/format";
import { EDITKIN_MOTION } from "../motion/identity";
import { FLOATING_VIDEO_FRAME_PRESETS, floatingVideoFramePreset } from "../motion/floatingVideoFrame";
import { FLOATING_FRAME_SCENE_PRESETS, type FloatingFrameScenePresetId } from "../motion/floatingFrameScenes";
import { MOTION_CLIP_PRESETS, type MotionClipPresetId } from "../motion/motionClipPresets";
import type { FloatingVideoFrame, TimelineClip } from "../domain/types";
import "./motionStudio.css";

export interface MotionStudioProps {
  asset: MediaAsset;
  clip?: TimelineClip;
  onSetFloatingFrame?: (frame?: FloatingVideoFrame) => void;
  onApplyFloatingScene?: (preset: FloatingFrameScenePresetId) => void;
  portraitCanvas?: boolean;
  onApplyClipMotionPreset?: (preset: MotionClipPresetId) => void;
  motionTracks: MotionTrack[];
  trackingBusy: boolean;
  trackingSelectionActive: boolean;
  trackingSelection?: NormalizedRect;
  onBeginMotionTrack: () => void;
  onCorrectMotionTrack: (trackId: string) => void;
  onDeleteMotionTrack: (trackId: string) => void;
  onAddMotionGraphic: (kind: MotionGraphicKind, trackId?: string, seed?: MotionGraphicPresetSeed, options?: { ask?: boolean }) => void;
  wave2Presets: Wave2MotionPreset[];
  motionGraphics: MotionGraphic[];
  onUpdateMotionGraphic: (graphicId: string, patch: Partial<Omit<MotionGraphic, "schema" | "id">>) => void;
  onDeleteMotionGraphic: (graphicId: string) => void;
}

export default function MotionStudio({ asset, clip, onSetFloatingFrame, onApplyFloatingScene, portraitCanvas = false, onApplyClipMotionPreset, motionTracks, trackingBusy, trackingSelectionActive, trackingSelection, onBeginMotionTrack, onCorrectMotionTrack, onDeleteMotionTrack, onAddMotionGraphic, wave2Presets, motionGraphics, onUpdateMotionGraphic, onDeleteMotionGraphic }: MotionStudioProps) {
  return <div className="motion-controls" aria-label="動態圖卡與追蹤">
    <div className="creative-heading"><div><span className="eyebrow">{EDITKIN_MOTION.name}</span><strong>{EDITKIN_MOTION.label}</strong></div><small>文字可編輯</small></div>
    <MotionV3Library onAddMotionGraphic={onAddMotionGraphic} />
    <div className="motion-quick-grid" data-testid="motion-template-previews">
      <button type="button" className="motion-preset-card title" onClick={() => onAddMotionGraphic("title", undefined, motionDesignV3Seed("v3_title_reveal"), { ask: true })}><span><b>你的主標題</b><i>reveal</i></span><small>＋ 動態標題</small></button>
      <button type="button" className="motion-preset-card card" onClick={() => onAddMotionGraphic("title", undefined, motionDesignV3Seed("v3_highlight_sweep"), { ask: true })}><span><b>本段重點</b><i>marker</i></span><small>＋ 重點卡</small></button>
      <button type="button" className="motion-preset-card counter" onClick={() => onAddMotionGraphic("counter", undefined, motionDesignV3Seed("v3_stat_counter"), { ask: true })}><span><b>01</b><i>count up</i></span><small>＋ 數字重點</small></button>
      <button type="button" className="motion-preset-card title" onClick={() => onAddMotionGraphic("title", undefined, findMotionGraphicPreset("v2-word-cascade").seed)}><span><b>逐詞登場</b><i>motion v2</i></span><small>＋ 彈性逐詞主標</small></button>
    </div>
    {asset.kind === "video" && clip && <>
      <details className="floating-video-frame-controls" data-testid="floating-video-frame-controls">
        <summary>影片浮空框 <small>原片即時嵌入 · 2.5D 透視</small></summary>
        <p>選一段自己的影片套用；框體、角度、大小可編輯，正式輸出保留原片畫面。</p>
        <div className="motion-quick-grid">
          {FLOATING_VIDEO_FRAME_PRESETS.map(preset => <button type="button" key={preset.id} className="motion-preset-card card"
            onClick={() => onSetFloatingFrame?.(floatingVideoFramePreset(preset.id))}
            disabled={!onSetFloatingFrame || (preset.id === "portrait_orbit" && !portraitCanvas)}
            title={preset.id === "portrait_orbit" && !portraitCanvas ? "請先建立直式專案" : undefined}
            data-testid={`floating-frame-${preset.id}`}><span><b>{preset.name}</b><i>{preset.yawDegrees}°</i></span><small>＋ 套用</small></button>)}
          {FLOATING_FRAME_SCENE_PRESETS.map(preset => <button type="button" key={preset.id} className="motion-preset-card card"
            title={portraitCanvas ? preset.description : "請先建立直式專案"}
            onClick={() => onApplyFloatingScene?.(preset.id)} disabled={!portraitCanvas || !onApplyFloatingScene || Boolean(clip.floatingFrame)}
            data-testid={`floating-scene-${preset.id}`}><span><b>{preset.name}</b><i>三層可編輯影片</i></span><small>＋ 套用</small></button>)}
        </div>
        {clip.floatingFrame && <div className="transform-grid">
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
        {graphic.schema === "hao.motion-composition/v3" && graphic.designV3
          ? <textarea value={graphic.text} aria-label={`${graphic.name}文字`} rows={MOTION_DESIGN_V3_FIELDS[graphic.designV3.template].length}
            placeholder={motionDesignV3FieldHint(MOTION_DESIGN_V3_FIELDS[graphic.designV3.template])} title={motionDesignV3FieldHint(MOTION_DESIGN_V3_FIELDS[graphic.designV3.template])}
            onChange={(event) => onUpdateMotionGraphic(graphic.id, { text: event.target.value })} />
          : <input value={graphic.text} aria-label={`${graphic.name}文字`} onChange={(event) => onUpdateMotionGraphic(graphic.id, { text: event.target.value })} />}
        <span>{formatTime(graphic.timelineStart)} · {graphic.name}{graphic.visualStyle && graphic.visualStyle !== "solid_panel" ? ` · ${graphic.visualStyle}` : ""}</span>
        {graphic.schema === "hao.motion-composition/v2" && graphic.layoutV2 && <label className="motion-width-mode">底框
          <select aria-label={`${graphic.name}底框寬度`} value={graphic.layoutV2.widthMode ?? "fixed"} onChange={(event) => onUpdateMotionGraphic(graphic.id, { layoutV2: { ...graphic.layoutV2!, widthMode: event.target.value as "fixed" | "fit_content" } })}>
            <option value="fixed">固定寬度</option><option value="fit_content">貼合文字</option>
          </select>
        </label>}
        <button type="button" aria-label={`刪除${graphic.name}`} onClick={() => onDeleteMotionGraphic(graphic.id)}>×</button>
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
