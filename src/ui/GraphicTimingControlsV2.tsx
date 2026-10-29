import { DEFAULT_GRAPHIC_TIMING_V2, type GraphicTimingV2 } from "../domain/graphicTimingV2";
import { translateUi as uiText } from "./i18n/interfacePreferences";

export function GraphicTimingControlsV2({ value, disabled, onChange }: {
  value?: GraphicTimingV2; disabled: boolean; onChange: (value: GraphicTimingV2 | undefined) => void;
}) {
  const current = value ?? DEFAULT_GRAPHIC_TIMING_V2;
  const update = (key: "entranceSpeed" | "holdSeconds" | "exitSpeed", next: number) => {
    if (!disabled) onChange({ ...current, [key]: next });
  };
  return <div data-testid="graphic-timing-v2-controls">
    <label>{uiText("進場速度")}<input type="range" min="0.5" max="2" step="0.05" aria-label={uiText("已儲存模板進場速度")}
      disabled={disabled} value={current.entranceSpeed} onChange={e => update("entranceSpeed", Number(e.target.value))} />
      <output>{current.entranceSpeed.toFixed(2)}×</output></label>
    <label>{uiText("停留時間")}<input type="range" min="0.5" max="8" step="0.1" aria-label={uiText("已儲存模板停留時間")}
      disabled={disabled} value={current.holdSeconds} onChange={e => update("holdSeconds", Number(e.target.value))} />
      <output>{uiText("{seconds} 秒", { seconds: current.holdSeconds.toFixed(1) })}</output></label>
    <label>{uiText("退場速度")}<input type="range" min="0.5" max="2" step="0.05" aria-label={uiText("已儲存模板退場速度")}
      disabled={disabled} value={current.exitSpeed} onChange={e => update("exitSpeed", Number(e.target.value))} />
      <output>{current.exitSpeed.toFixed(2)}×</output></label>
    <small>{uiText("文字會保留閱讀所需時間；停留太長時請延長片段。調整後套用修改，再看一次成片。")}</small>
    {!value && <small>{uiText("目前保留原始模板時序；拖動滑桿後才會套用獨立節奏。")}</small>}
    {value && <button type="button" disabled={disabled} onClick={() => { if (!disabled) onChange(undefined); }}>{uiText("保留原始模板時序")}</button>}
  </div>;
}
