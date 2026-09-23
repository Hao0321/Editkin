import type { Wave2MotionPreset } from "../creative/wave2Registry";
import { findMotionGraphicPreset, HOLOGRAM_MOTION_PRESETS } from "../creative/motionGraphicPresets";
import type { MediaAsset, MotionGraphic, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NormalizedRect } from "../domain/types";
import { formatTime } from "../lib/format";
import { EDITKIN_MOTION } from "../motion/identity";
import "./motionStudio.css";

export interface MotionStudioProps {
  asset: MediaAsset;
  motionTracks: MotionTrack[];
  trackingBusy: boolean;
  trackingSelectionActive: boolean;
  trackingSelection?: NormalizedRect;
  onBeginMotionTrack: () => void;
  onCorrectMotionTrack: (trackId: string) => void;
  onDeleteMotionTrack: (trackId: string) => void;
  onAddMotionGraphic: (kind: MotionGraphicKind, trackId?: string, seed?: MotionGraphicPresetSeed) => void;
  wave2Presets: Wave2MotionPreset[];
  motionGraphics: MotionGraphic[];
  onUpdateMotionGraphic: (graphicId: string, patch: Partial<Omit<MotionGraphic, "schema" | "id">>) => void;
  onDeleteMotionGraphic: (graphicId: string) => void;
}

export default function MotionStudio({ asset, motionTracks, trackingBusy, trackingSelectionActive, trackingSelection, onBeginMotionTrack, onCorrectMotionTrack, onDeleteMotionTrack, onAddMotionGraphic, wave2Presets, motionGraphics, onUpdateMotionGraphic, onDeleteMotionGraphic }: MotionStudioProps) {
  return <div className="motion-controls" aria-label="動態圖卡與追蹤">
    <div className="creative-heading"><div><span className="eyebrow">{EDITKIN_MOTION.name}</span><strong>{EDITKIN_MOTION.label}</strong></div><small>文字可編輯</small></div>
    <div className="motion-quick-grid" data-testid="motion-template-previews">
      <button type="button" className="motion-preset-card title" onClick={() => onAddMotionGraphic("title")}><span><b>你的主標題</b><i>slide up</i></span><small>＋ 動態標題</small></button>
      <button type="button" className="motion-preset-card card" onClick={() => onAddMotionGraphic("card")}><span><b>本段重點</b><i>pop</i></span><small>＋ 重點卡</small></button>
      <button type="button" className="motion-preset-card counter" onClick={() => onAddMotionGraphic("counter")}><span><b>01</b><i>spring</i></span><small>＋ 數字重點</small></button>
      <button type="button" className="motion-preset-card title" onClick={() => onAddMotionGraphic("title", undefined, findMotionGraphicPreset("v2-word-cascade").seed)}><span><b>逐詞登場</b><i>motion v2</i></span><small>＋ 彈性逐詞主標</small></button>
    </div>
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
        <input value={graphic.text} aria-label={`${graphic.name}文字`} onChange={(event) => onUpdateMotionGraphic(graphic.id, { text: event.target.value })} />
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
