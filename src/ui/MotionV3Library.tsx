import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MOTION_DESIGN_V3_CATEGORIES, MOTION_DESIGN_V3_PRESETS, type MotionDesignV3Category } from "../creative/motionDesignV3Presets";
import type { MotionGraphic, MotionGraphicKind, MotionGraphicPresetSeed } from "../domain/types";
import { motionGraphicV3Frame, motionGraphicV3Layout } from "../motion/compositionV3";
import MotionV3Graphic from "./MotionV3Graphic";
import "./motionStudio.css";

const STAGE = { width: 1920, height: 1080, fps: 30 };
const CLIP_SECONDS = 3.2;
/** Thumbnails rest on the hold, after every element has arrived. */
const HOLD_FRAME = 56;

type Preset = (typeof MOTION_DESIGN_V3_PRESETS)[number];

function PresetCard({ preset, onAdd }: { preset: Preset; onAdd: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [frame, setFrame] = useState(HOLD_FRAME);
  const graphic = useMemo(() => ({ ...preset.seed, id: `preview-${preset.id}`, timelineStart: 0, duration: CLIP_SECONDS } as MotionGraphic), [preset]);
  const total = Math.round(CLIP_SECONDS * STAGE.fps);
  useEffect(() => {
    if (!hovered) { setFrame(HOLD_FRAME); return; }
    let current = 0;
    const timer = window.setInterval(() => { current = (current + 1) % (total + 12); setFrame(Math.min(current, total - 1)); }, 1000 / STAGE.fps);
    return () => window.clearInterval(timer);
  }, [hovered, total]);
  let thumb: ReactNode = null;
  try {
    const layout = motionGraphicV3Layout(STAGE, graphic);
    const evaluated = motionGraphicV3Frame(STAGE, graphic, frame, layout);
    thumb = evaluated.visible ? <MotionV3Graphic project={STAGE} graphic={graphic} template={layout.template} frame={evaluated} /> : null;
  } catch {
    thumb = null;
  }
  return <button type="button" className="motion-v3-card" data-testid={`motion-v3-${preset.id}`} title={`${preset.name} · ${preset.family}`}
    onClick={onAdd} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setHovered(true)} onBlur={() => setHovered(false)}>
    <span className="motion-v3-thumb">{thumb}</span>
    <span className="motion-v3-caption"><b>{preset.name}</b><small>{MOTION_DESIGN_V3_CATEGORIES[preset.category]}</small></span>
  </button>;
}

export interface MotionV3LibraryProps {
  onAddMotionGraphic: (kind: MotionGraphicKind, trackId?: string, seed?: MotionGraphicPresetSeed, options?: { ask?: boolean }) => void;
}

/** Motion Design v3 gallery: live thumbnails drawn by the same evaluator as preview and export. */
export default function MotionV3Library({ onAddMotionGraphic }: MotionV3LibraryProps) {
  const [category, setCategory] = useState<MotionDesignV3Category | "all">("all");
  const visible = MOTION_DESIGN_V3_PRESETS.filter(preset => category === "all" || preset.category === category);
  return <section className="motion-v3-library" data-testid="motion-v3-library" aria-label="Motion Design v3 版型">
    <div className="motion-v3-tabs" role="tablist">
      {(["all", ...Object.keys(MOTION_DESIGN_V3_CATEGORIES)] as Array<MotionDesignV3Category | "all">).map(key => <button type="button" role="tab" key={key}
        aria-selected={category === key} className={category === key ? "active" : ""} onClick={() => setCategory(key)}>
        {key === "all" ? `全部 ${MOTION_DESIGN_V3_PRESETS.length}` : MOTION_DESIGN_V3_CATEGORIES[key]}
      </button>)}
    </div>
    <div className="motion-v3-grid">
      {visible.map(preset => <PresetCard key={preset.id} preset={preset} onAdd={() => onAddMotionGraphic(preset.seed.kind ?? "title", undefined, preset.seed)} />)}
    </div>
    <small className="motion-v3-note">游標移到卡片上預覽動態；加入後可在清單逐行改字，預覽與輸出逐格一致。</small>
  </section>;
}
