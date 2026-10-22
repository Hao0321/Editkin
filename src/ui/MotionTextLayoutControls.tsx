import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import type { MotionGraphic } from "../domain/types";
import { motionGraphicV2ExitStaggerFrames } from "../domain/motionCompositionV2Contract";
import { NumberEditFieldV1 } from "./NumberEditFieldV1";
import type { GraphicNumberGestureStartV1 } from "../application/graphicParameterGestureV1";

type Patch = Partial<Omit<MotionGraphic, "schema" | "id">>;

/** Changes canvas geometry, so preview and output use the same physical glyph layout. */
export function renderMotionTextLayoutControlsV1({ graphic, editScope, onNumberGestureStart, onNumberDraftRejected, onUpdate }: { graphic: MotionGraphic; editScope?: unknown; onNumberGestureStart?: GraphicNumberGestureStartV1; onNumberDraftRejected?: () => void; onUpdate: (patch: Patch) => boolean | void }) {
  const field = (label: string, value: number, min: number, max: number, step: number, change: (value: number) => Patch,
    initial = value, original = change(initial)) => {
    const normalize = (next: number) => next === initial || next === value ? initial
      : Number(Math.max(min, Math.min(max, Math.round(next / step) * step)).toFixed(6));
    const patch = (next: number) => next === initial ? original : change(normalize(next));
    return <label key={label}>{label}
      <NumberEditFieldV1 aria-label={`${graphic.name}${label}`} min={min} max={max} step={step} value={value} scope={editScope ?? graphic}
        onGestureStart={onNumberGestureStart ? () => onNumberGestureStart(graphic.id, { parameterId: `layout.${label}`, initial, normalize, patch }) : undefined}
        onDraftRejected={onNumberDraftRejected}
        onDraftConfirm={(number, control) => { control.value = String(number === initial || number === value ? value : normalize(number)); return true; }}
        onCommit={(number, control) => {
          const next = normalize(number);
          if (control) control.value = String(next === initial ? value : next);
          return next === initial ? true : onUpdate(patch(next));
        }} />
    </label>;
  };
  return <div className="motion-text-layout-controls">
    {field("字級 px", graphic.fontSize, Math.ceil(graphic.layoutV2?.minFontSize ?? 8), Math.max(384, graphic.fontSize), 1, fontSize => ({ fontSize }))}
    {field("水平位置 %", Math.round(graphic.x * 1000) / 10, 0, 100, .1, x => ({ x: x / 100 }), graphic.x * 100, { x: graphic.x })}
    {field("垂直位置 %", Math.round(graphic.y * 1000) / 10, 0, 100, .1, y => ({ y: y / 100 }), graphic.y * 100, { y: graphic.y })}
    {graphic.motionV2 && <label>{uiText("退場方式")}<select aria-label={uiText("{value0}退場方式", { value0: graphic.name })}
      value={motionGraphicV2ExitStaggerFrames(graphic.motionV2) === 0 ? "together" : "staggered"}
      onChange={event => {
        const { exitStaggerFrames: _previous, ...sequence } = graphic.motionV2!.sequence;
        onUpdate({ motionV2: { ...graphic.motionV2!, sequence: {
          ...sequence, ...(event.target.value === "together" ? { exitStaggerFrames: 0 } : {}),
        } } });
      }}><option value="together">{uiText("整句離場")}</option><option value="staggered">{uiText("跟隨進場間隔")}</option></select></label>}
    <small>{uiText("Enter 套用，Esc 取消；位置依畫幅百分比，排版保留安全區。")}</small>
  </div>;
}
export default function MotionTextLayoutControls(props: Parameters<typeof renderMotionTextLayoutControlsV1>[0]) {
  useI18n();
  return renderMotionTextLayoutControlsV1(props);
}
