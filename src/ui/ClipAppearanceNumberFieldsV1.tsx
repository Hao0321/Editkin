import type { ColorAdjustments, Transform2D } from "../domain/types";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import { translateUi as uiText } from "./i18n/interfacePreferences";
import { NumberEditFieldV1 } from "./NumberEditFieldV1";

export type TransformNumberFieldV1 = "x" | "y" | "scale" | "rotation" | "opacity";
export type ColorNumberFieldV1 = "brightness" | "contrast" | "saturation" | "hue";
interface Fields<V, K extends keyof V> {
  values: Pick<V, K>;
  editScope?: unknown;
  onChange: (patch: Partial<V>) => boolean | void;
  onGestureStart?: (field: K) => ParameterGestureLeaseV1 | undefined;
}

/** Only the existing numeric views; no project, animation, history or preview owner lives here. */
export function ClipTransformNumberFieldsV1({ values, editScope, onChange, onGestureStart }: Fields<Transform2D, TransformNumberFieldV1>) {
  const fields = [
    { field: "x", label: "左右位置 " },
    { field: "y", label: "上下位置 " },
    { field: "scale", label: "畫面大小 ", min: "0.01", step: "0.05" },
    { field: "rotation", label: "旋轉角度 ", step: "1" },
    { field: "opacity", label: "透明度 ", min: "0", max: "1", step: "0.05" },
  ] as const;
  return <div className="transform-grid">{fields.map(({ field, label, ...bounds }) =>
    <label key={field}>{uiText(label)}<NumberEditFieldV1 {...bounds} data-appearance-field={field}
      scope={editScope} value={values[field]} onCommit={value => onChange({ [field]: value })}
      onGestureStart={onGestureStart ? () => onGestureStart(field) : undefined} /></label>)}</div>;
}

export function ClipColorNumberFieldsV1({ values, editScope, onChange, onGestureStart }: Fields<ColorAdjustments, ColorNumberFieldV1>) {
  const fields = [
    { field: "brightness", label: "亮度 ", min: "-1", max: "1", step: "0.05" },
    { field: "contrast", label: "對比 ", min: "0.1", max: "3", step: "0.1" },
    { field: "saturation", label: "鮮豔度 ", min: "0", max: "3", step: "0.1" },
    { field: "hue", label: "色相 ", min: "-180", max: "180", step: "1" },
  ] as const;
  return <div className="transform-grid">{fields.map(({ field, label, ...bounds }) =>
    <label key={field}>{uiText(label)}<NumberEditFieldV1 {...bounds} data-appearance-field={field}
      scope={editScope} value={values[field]} onCommit={value => onChange({ [field]: value })}
      onGestureStart={onGestureStart ? () => onGestureStart(field) : undefined} /></label>)}</div>;
}
