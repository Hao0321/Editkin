import { useState } from "react";
import type { ColorGradeNodeV2 } from "../domain/visualTypes";
import { clearColorQualifierOutsideV1, removeColorQualifierV1, setColorQualifierEnabledV1, setColorQualifierHueEnabledV1,
  setColorQualifierInvertedV1, setColorQualifierNumberV1, setColorQualifierOutsideWheelV1, type ColorQualifierNumberV1 } from "../domain/colorQualifierPanelEditsV1";
import { ColorGradeWheelV1 } from "./ColorGradeWheelV1";
import { useGradeRangeInputV1 } from "./gradeRangeInputV1";
import { translateUi as t, useI18n } from "./i18n/interfacePreferences";
import "./colorQualifierControlsV1.css";

type NodeEdit = (node: ColorGradeNodeV2) => ColorGradeNodeV2;
export interface ColorQualifierControlsPropsV1 {
  node: ColorGradeNodeV2; disabled?: boolean;
  editIdentity?: readonly unknown[];
  onDraft: (edit: NodeEdit) => void; onAction: (edit: NodeEdit) => void;
  onCommit: () => void; onCancel: () => void;
}
const RANGES: ReadonlyArray<{ key: ColorQualifierNumberV1; label: string; max: number; step: number }> = [
  { key: "hue-center", label: "色相中心", max: 359.99, step: 1 },
  { key: "hue-width", label: "色相半寬", max: 180, step: 1 },
  { key: "hue-softness", label: "色相柔和範圍", max: 180, step: 1 },
  { key: "sat-min", label: "飽和度下限", max: 1, step: .005 },
  { key: "sat-max", label: "飽和度上限", max: 1, step: .005 },
  { key: "sat-softness", label: "飽和度柔和範圍", max: 1, step: .005 },
  { key: "light-min", label: "明度下限", max: 1, step: .005 },
  { key: "light-max", label: "明度上限", max: 1, step: .005 },
  { key: "light-softness", label: "明度柔和範圍", max: 1, step: .005 },
  { key: "clean-black", label: "清理黑位", max: .999, step: .005 },
  { key: "clean-white", label: "清理白位", max: 1, step: .005 },
];
export function colorQualifierPanelValueV1(node: ColorGradeNodeV2, key: ColorQualifierNumberV1): number {
  const value = node.secondaryHslV1, hue = value?.qualifier.hue;
  switch (key) {
    case "hue-center": return hue?.centerDegrees ?? 0;
    case "hue-width": return hue?.halfWidthDegrees ?? 30;
    case "hue-softness": return hue?.softnessDegrees ?? 10;
    case "sat-min": return value?.qualifier.saturation?.minimum ?? 0;
    case "sat-max": return value?.qualifier.saturation?.maximum ?? 1;
    case "sat-softness": return value?.qualifier.saturation?.softness ?? 0;
    case "light-min": return value?.qualifier.lightness?.minimum ?? 0;
    case "light-max": return value?.qualifier.lightness?.maximum ?? 1;
    case "light-softness": return value?.qualifier.lightness?.softness ?? 0;
    case "clean-black": return value?.cleanup?.blackPoint ?? 0;
    case "clean-white": return value?.cleanup?.whitePoint ?? 1;
  }
}

/** Manual pointwise selector, using the existing node gesture and validator; spatial controls are separate. */
export function ColorQualifierControlsV1(props: ColorQualifierControlsPropsV1) {
  useI18n();
  const [outside, setOutside] = useState(false);
  const { node, disabled, onAction, onDraft, onCommit, onCancel } = props;
  const selector = node.secondaryHslV1, enabled = Boolean(selector && selector.enabled !== false);
  const rangeInput = useGradeRangeInputV1([node.id, ...(props.editIdentity ?? [])]);
  return <section className="color-qualifier-controls" aria-label={t("選色 HSL")} data-testid="color-qualifier-controls">
    <label className="color-qualifier-check"><input type="checkbox" aria-label={t("使用選色範圍")} checked={enabled} disabled={disabled}
      onChange={event => { const checked = event.target.checked; onAction(n => setColorQualifierEnabledV1(n, checked)); }} />{t("選色 HSL")}</label>
    <p>{t("選取符合色相、飽和度與明度的顏色。")}</p>
    <div className="grade-node-actions" role="group" aria-label={t("選色編輯區")}>
      <button type="button" aria-pressed={!outside} onClick={() => { onCancel(); setOutside(false); }}>{t("選色 HSL")}</button>
      <button type="button" aria-pressed={outside} onClick={() => { onCancel(); setOutside(true); }}>{t("範圍外")}</button>
      <button type="button" disabled={disabled || !selector} onClick={() => onAction(removeColorQualifierV1)}>{t("移除選色")}</button>
    </div>
    <fieldset disabled={disabled || !enabled}>
      {!outside ? <>
        <label className="color-qualifier-check"><input type="checkbox" aria-label={t("限制色相")} checked={Boolean(selector?.qualifier.hue)}
          onChange={event => { const checked = event.target.checked; onAction(n => setColorQualifierHueEnabledV1(n, checked)); }} />{t("限制色相")}</label>
        <div className="grade-control-grid">{RANGES.map(range => <label key={range.key}>
          <span>{t(range.label)}<output>{colorQualifierPanelValueV1(node, range.key).toFixed(range.max > 1 ? 1 : 3)}</output></span>
          <input type="range" min={range.key === "clean-white" ? .001 : 0} max={range.max} step={range.step} value={colorQualifierPanelValueV1(node, range.key)}
            aria-label={t(range.label)} data-testid={`qualifier-${range.key}`} disabled={disabled || !enabled || (range.key.startsWith("hue-") && !selector?.qualifier.hue)}
            {...rangeInput.bind(range.key, {disabled: disabled || !enabled || (range.key.startsWith("hue-") && !selector?.qualifier.hue), onBegin: onCancel,
              onDraft: value => onDraft(n => setColorQualifierNumberV1(n, range.key, value)), onCommit, onCancel})} />
        </label>)}</div>
        <label className="color-qualifier-check"><input type="checkbox" checked={selector?.inverted ?? false} aria-label={t("反轉選取")}
          onChange={event => { const checked = event.target.checked; onAction(n => setColorQualifierInvertedV1(n, checked)); }} />{t("反轉選取")}</label>
        <small>{t("範圍內沿用上方色輪。")}</small>
      </> : <div className="color-qualifier-outside" role="group" aria-label={t("範圍外調色")}>
        <div className="grade-node-wheels">{(["offset", "lift", "gamma", "gain"] as const).map(kind => <ColorGradeWheelV1 key={kind} kind={kind}
          wheel={selector?.outside?.[kind]} disabled={disabled || !enabled}
          onDraft={wheel => onDraft(n => setColorQualifierOutsideWheelV1(n, kind, wheel))} onCommit={onCommit} onCancel={onCancel} />)}</div>
        <button type="button" disabled={disabled || !enabled || !selector?.outside} onClick={() => onAction(clearColorQualifierOutsideV1)}>{t("清除範圍外調色")}</button>
      </div>}
    </fieldset>
  </section>;
}
