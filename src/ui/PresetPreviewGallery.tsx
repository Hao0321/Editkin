import { useRef, useState } from "react";
import { useNativeWheelScroll } from "./wheelScroll";
import { cssFontFamily, resolveBundledFontFace } from "../typography/fontFaces";
import { EFFECT_PRESETS, LOOK_PRESETS, TEXT_STYLE_PRESETS, TRANSITION_PRESETS, combineLookColor, previewEffectFilter, transitionRenderers } from "../creative/corePack";
import { DEFAULT_COLOR, type ClipCreativeState } from "../domain/types";
import { CinematicLanguageExplorer } from "./CinematicLanguageExplorer";
import "./presetPreviewGallery.css";

function imageStyle(lookPresetId?: string, effectIds: string[] = []) {
  const color = combineLookColor(DEFAULT_COLOR, lookPresetId);
  return { filter: `brightness(${1 + color.brightness + color.exposure}) contrast(${color.contrast}) saturate(${color.saturation}) hue-rotate(${color.hue}deg) ${previewEffectFilter(effectIds)}` };
}

function Visual({ source, style }: { source?: string; style?: React.CSSProperties }) {
  const [failedSource, setFailedSource] = useState<string>();
  return <span className="preset-visual" style={style}>{source && source !== failedSource ? <img src={source} alt="目前畫面效果預覽" onError={() => setFailedSource(source)} /> : <i>請先選取畫面</i>}</span>;
}

export function CaptionPresetGallery({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  const row = useRef<HTMLDivElement>(null);
  useNativeWheelScroll(row, "horizontal");
  return <div ref={row} className="caption-preset-gallery" tabIndex={0} aria-label="字幕樣式預覽，可捲動瀏覽">
    {TEXT_STYLE_PRESETS.map((preset) => { const face = resolveBundledFontFace(preset.style.fontFamily, preset.style.bold ? 800 : 400); return <button key={preset.id} type="button" className={selected === preset.id ? "active" : ""} aria-pressed={selected === preset.id} onClick={() => onSelect(preset.id)}>
      <span data-font-weight-substituted={face?.weightSubstituted} title={face?.weightSubstituted ? `字重 ${face.requestedWeight} → ${face.fontWeight}` : undefined} style={{ fontFamily: cssFontFamily(face?.fontFamily ?? preset.style.fontFamily), fontWeight: face?.fontWeight ?? (preset.style.bold ? 800 : 400), fontSynthesis: "style", color: preset.style.color, background: preset.style.backgroundColor, WebkitTextStroke: `${Math.min(1.25, preset.style.outlineWidth * 16 / preset.style.fontSize)}px ${preset.style.outlineColor}`, paintOrder: "stroke fill" }}>字幕預覽</span><small>{preset.name}</small>
    </button>; })}
  </div>;
}

interface CreativeProps {
  source?: string;
  creative?: ClipCreativeState;
  duration: number;
  canTransitionIn: boolean;
  canTransitionOut: boolean;
  onChange: (patch: { lookPresetId?: string | null; effectPresetIds?: string[]; transitionIn?: ClipCreativeState["transitionIn"] | null; transitionOut?: ClipCreativeState["transitionOut"] | null }) => void;
  section?: "all" | "look" | "effect" | "transition";
}

export type TransitionLibraryGroup = "recommended" | "gentle" | "motion" | "flash" | "compound" | "all";

const RECOMMENDED_TRANSITION_IDS = new Set(["luma_fade", "cine_short_fade_through_base", "cine_soft_fade_push", "cine_semantic_punch", "cine_ui_detail_push", "cine_left_slide_fade", "cine_right_slide_fade", "cine_proof_flash", "cine_proof_flash_push", "studio_chapter_breath", "studio_ui_focus", "studio_location_slide"]);

export function filterTransitionPresets(group: TransitionLibraryGroup) {
  return TRANSITION_PRESETS.filter((preset) => {
    const renderers = transitionRenderers(preset);
    if (group === "recommended") return RECOMMENDED_TRANSITION_IDS.has(preset.id);
    if (group === "gentle") return renderers.includes("transition-fade") || preset.routing?.intensity === "low";
    if (group === "motion") return renderers.includes("transition-zoom") || renderers.includes("transition-whip");
    if (group === "flash") return renderers.includes("transition-flash");
    if (group === "compound") return renderers.length > 1;
    return true;
  });
}

export function CreativePresetGallery({ source, creative, duration, canTransitionIn, canTransitionOut, onChange, section = "all" }: CreativeProps) {
  const lookRow = useRef<HTMLDivElement>(null), effectRow = useRef<HTMLDivElement>(null), transitionGrid = useRef<HTMLDivElement>(null);
  useNativeWheelScroll(lookRow, "horizontal", section);
  useNativeWheelScroll(effectRow, "horizontal", section);
  useNativeWheelScroll(transitionGrid, "vertical", section);
  const effects = creative?.effectPresetIds ?? [];
  const [transitionGroup, setTransitionGroup] = useState<TransitionLibraryGroup>("recommended");
  const visibleTransitions = filterTransitionPresets(transitionGroup);
  return <div className="creative-preview-galleries">
    {(section === "all" || section === "look") && <><div className="preset-gallery-heading"><strong>濾鏡</strong><small>直接看套用後的畫面</small></div>
    <div ref={lookRow} className="visual-preset-row" data-testid="look-preview-list" tabIndex={0} aria-label="濾鏡預覽，可捲動瀏覽">
      <button type="button" className={!creative?.lookPresetId ? "active" : ""} onClick={() => onChange({ lookPresetId: null })}><Visual source={source} /><small>原始自然</small></button>
      {LOOK_PRESETS.map((preset) => <button key={preset.id} type="button" className={creative?.lookPresetId === preset.id ? "active" : ""} onClick={() => onChange({ lookPresetId: preset.id })}><Visual source={source} style={imageStyle(preset.id)} /><small>{preset.name}</small></button>)}
    </div></>}
    {(section === "all" || section === "effect") && <><div className="preset-gallery-heading"><strong>畫面特效</strong><small>最多疊加 4 個</small></div>
    <div ref={effectRow} className="visual-preset-row" data-testid="effect-preset-list" tabIndex={0} aria-label="特效預覽，可捲動瀏覽">
      {EFFECT_PRESETS.map((preset) => {
        const active = effects.includes(preset.id);
        return <button key={preset.id} type="button" className={active ? "active" : ""} aria-pressed={active} disabled={!active && effects.length >= 4} title={active ? "再次點選即可移除" : effects.length >= 4 ? "已套用 4 個特效，請先移除一個" : preset.name} onClick={() => onChange({ effectPresetIds: active ? effects.filter((id) => id !== preset.id) : [...effects, preset.id].slice(0, 4) })}><Visual source={source} style={imageStyle(creative?.lookPresetId, [preset.id])} /><small>{active ? "✓ " : ""}{preset.name}</small></button>;
      })}
    </div></>}
    {(section === "all" || section === "transition") && <><div className="preset-gallery-heading"><strong>入場與出場</strong><small>{TRANSITION_PRESETS.length} 款 · 相鄰片段才會啟用</small></div>
    {(creative?.transitionIn || creative?.transitionOut) && <div className="applied-transition-actions" aria-label="已套用的轉場">
      {creative.transitionIn && <button type="button" onClick={() => onChange({ transitionIn: null })} data-testid="remove-transition-in">移除入場 ×</button>}
      {creative.transitionOut && <button type="button" onClick={() => onChange({ transitionOut: null })} data-testid="remove-transition-out">移除出場 ×</button>}
    </div>}
    <div className="transition-library-tabs" role="tablist" aria-label="轉場分類">{([
      ["recommended", "推薦"], ["gentle", "柔和"], ["motion", "動感"], ["flash", "亮閃"], ["compound", "複合"], ["all", "全部"],
    ] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={transitionGroup === id} className={transitionGroup === id ? "active" : ""} onClick={() => setTransitionGroup(id)}>{label}</button>)}</div>
    <small className="transition-truth-note">這裡是可直接輸出的片段入出場；蒙太奇與子彈時間會先檢查素材條件，不會用假名稱代替。</small>
    <div ref={transitionGrid} className="transition-preview-grid" data-testid="transition-preview-list" tabIndex={0} aria-label="轉場預覽，可捲動瀏覽">
      {visibleTransitions.map((preset) => <article key={preset.id} className={creative?.transitionIn?.presetId === preset.id || creative?.transitionOut?.presetId === preset.id ? "active" : ""}>
        <div className={`transition-demo ${transitionRenderers(preset).map((renderer) => renderer.replace("transition-", "")).join(" ")}`}><i /><b /></div><strong>{preset.name}</strong><small>{transitionRenderers(preset).length > 1 ? `${transitionRenderers(preset).length} 種動作` : "單一動作"}</small><div><button type="button" disabled={!canTransitionIn} onClick={() => onChange({ transitionIn: { presetId: preset.id, duration: Math.min(preset.defaultDuration, duration) } })}>入場</button><button type="button" disabled={!canTransitionOut} onClick={() => onChange({ transitionOut: { presetId: preset.id, duration: Math.min(preset.defaultDuration, duration) } })}>離場</button></div>
      </article>)}
    </div><CinematicLanguageExplorer /></>}
  </div>;
}
