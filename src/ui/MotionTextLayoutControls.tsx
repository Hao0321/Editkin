import type { MotionGraphic } from "../domain/types";
import { motionGraphicV2ExitStaggerFrames } from "../domain/motionCompositionV2Contract";

type Patch = Partial<Omit<MotionGraphic, "schema" | "id">>;

/** Changes canvas geometry, so preview and output use the same physical glyph layout. */
export default function MotionTextLayoutControls({ graphic, onUpdate }: { graphic: MotionGraphic; onUpdate: (patch: Patch) => void }) {
  const field = (label: string, value: number, min: number, max: number, step: number, change: (value: number) => Patch) =>
    <label key={label}>{label}
      <input key={`${label}-${value}`} aria-label={`${graphic.name}${label}`} type="number" min={min} max={max} step={step} defaultValue={value}
        onBlur={event => {
          const raw = event.currentTarget.value, number = Number(raw);
          if (!raw.trim() || !Number.isFinite(number) || number === value) { event.currentTarget.value = String(value); return; }
          const next = Number(Math.max(min, Math.min(max, Math.round(number / step) * step)).toFixed(6));
          event.currentTarget.value = String(next);
          if (next !== value) onUpdate(change(next));
        }}
        onKeyDown={event => {
          if (event.key === "Escape") event.currentTarget.value = String(value);
          if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); }
        }} />
    </label>;
  return <div className="motion-text-layout-controls">
    {field("字級 px", graphic.fontSize, Math.ceil(graphic.layoutV2?.minFontSize ?? 8), Math.max(384, graphic.fontSize), 1, fontSize => ({ fontSize }))}
    {field("水平位置 %", Math.round(graphic.x * 1000) / 10, 0, 100, .1, x => ({ x: x / 100 }))}
    {field("垂直位置 %", Math.round(graphic.y * 1000) / 10, 0, 100, .1, y => ({ y: y / 100 }))}
    {graphic.motionV2 && <label>退場方式<select aria-label={`${graphic.name}退場方式`}
      value={motionGraphicV2ExitStaggerFrames(graphic.motionV2) === 0 ? "together" : "staggered"}
      onChange={event => {
        const { exitStaggerFrames: _previous, ...sequence } = graphic.motionV2!.sequence;
        onUpdate({ motionV2: { ...graphic.motionV2!, sequence: {
          ...sequence, ...(event.target.value === "together" ? { exitStaggerFrames: 0 } : {}),
        } } });
      }}><option value="together">整句離場</option><option value="staggered">跟隨進場間隔</option></select></label>}
    <small>Enter 套用，Esc 取消；位置依畫幅百分比，排版保留安全區。</small>
  </div>;
}
