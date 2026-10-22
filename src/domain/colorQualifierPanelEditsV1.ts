import { colorGradeNodeV2Schema } from "./colorGradeV2Schema";
import type { ColorGradeNodeV2, ColorWheelV2 } from "./visualTypes";
import type { SecondaryHslV1 } from "./secondaryHslV1Types";
import type { GradeWheelKindV1 } from "./colorGradePanelEditsV1";

export type ColorQualifierNumberV1 = "hue-center" | "hue-width" | "hue-softness"
  | "sat-min" | "sat-max" | "sat-softness" | "light-min" | "light-max" | "light-softness"
  | "clean-black" | "clean-white";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const HUE_FIELDS: Readonly<Record<string, "centerDegrees" | "halfWidthDegrees" | "softnessDegrees">> = {
  "hue-center": "centerDegrees", "hue-width": "halfWidthDegrees", "hue-softness": "softnessDegrees",
};
const selection = (node: ColorGradeNodeV2): SecondaryHslV1 => structuredClone(node.secondaryHslV1 ?? {
  schema: "editkin.secondary-hsl/v1", selectorSpace: "working_rgb_code",
  qualifier: { saturation: { minimum: 0, maximum: 1 } },
});
const checked = (node: ColorGradeNodeV2, value: SecondaryHslV1) => colorGradeNodeV2Schema.parse({ ...node, secondaryHslV1: value });

/** Enabling starts with all colours; disabling retains edits while restoring the existing plain-node bake key. */
export function setColorQualifierEnabledV1(node: ColorGradeNodeV2, enabled: boolean): ColorGradeNodeV2 {
  if (typeof enabled !== "boolean") throw Error("HSL_PANEL_BOOLEAN");
  if (!node.secondaryHslV1 && !enabled) return structuredClone(node);
  return checked(node, { ...selection(node), enabled });
}
export function removeColorQualifierV1(node: ColorGradeNodeV2): ColorGradeNodeV2 {
  const { secondaryHslV1: _selection, ...plain } = structuredClone(node); return colorGradeNodeV2Schema.parse(plain);
}
export function setColorQualifierHueEnabledV1(node: ColorGradeNodeV2, enabled: boolean): ColorGradeNodeV2 {
  if (typeof enabled !== "boolean") throw Error("HSL_PANEL_BOOLEAN");
  const value = selection(node);
  if (enabled) value.qualifier.hue ??= { centerDegrees: 0, halfWidthDegrees: 30, softnessDegrees: 10 };
  else delete value.qualifier.hue;
  if (!Object.keys(value.qualifier).length) value.qualifier.saturation = { minimum: 0, maximum: 1 };
  return checked(node, value);
}
export function setColorQualifierInvertedV1(node: ColorGradeNodeV2, inverted: boolean): ColorGradeNodeV2 {
  if (typeof inverted !== "boolean") throw Error("HSL_PANEL_BOOLEAN");
  return checked(node, { ...selection(node), inverted });
}
export function setColorQualifierNumberV1(node: ColorGradeNodeV2, key: ColorQualifierNumberV1, input: number): ColorGradeNodeV2 {
  if (!Number.isFinite(input)) throw Error("HSL_PANEL_NUMBER");
  const value = selection(node);
  if (key.startsWith("hue-")) {
    const hue = value.qualifier.hue ?? { centerDegrees: 0, halfWidthDegrees: 30, softnessDegrees: 10 };
    const field = HUE_FIELDS[key];
    if (!field) throw Error("HSL_PANEL_FIELD");
    value.qualifier.hue = { ...hue, [field]: clamp(input, 0, key === "hue-center" ? 359.99 : 180) };
  } else if (key.startsWith("sat-") || key.startsWith("light-")) {
    const name = key.startsWith("sat-") ? "saturation" : "lightness";
    const band = value.qualifier[name] ?? { minimum: 0, maximum: 1 };
    if (key.endsWith("-min")) band.minimum = clamp(input, 0, band.maximum);
    else if (key.endsWith("-max")) band.maximum = clamp(input, band.minimum, 1);
    else if (key.endsWith("-softness")) band.softness = clamp(input, 0, 1);
    else throw Error("HSL_PANEL_FIELD");
    value.qualifier[name] = band;
  } else if (key === "clean-black" || key === "clean-white") {
    const cleanup = value.cleanup ?? {};
    if (key === "clean-black") cleanup.blackPoint = clamp(input, 0, Math.max(0, (cleanup.whitePoint ?? 1) - .001));
    else cleanup.whitePoint = clamp(input, Math.min(1, (cleanup.blackPoint ?? 0) + .001), 1);
    value.cleanup = cleanup;
  } else throw Error("HSL_PANEL_FIELD");
  return checked(node, value);
}
export function setColorQualifierOutsideWheelV1(node: ColorGradeNodeV2, kind: GradeWheelKindV1, wheel: ColorWheelV2): ColorGradeNodeV2 {
  if (!["offset", "lift", "gamma", "gain"].includes(kind)) throw Error("HSL_PANEL_WHEEL");
  const value = selection(node); value.outside = { ...value.outside, [kind]: structuredClone(wheel) }; return checked(node, value);
}
export function clearColorQualifierOutsideV1(node: ColorGradeNodeV2): ColorGradeNodeV2 {
  const value = selection(node); delete value.outside; return checked(node, value);
}
