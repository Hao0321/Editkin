import * as z from "zod/v4";
import { assertColorGradeV2, colorGradeNodeV2Schema } from "../domain/colorGradeV2Schema";
import type { ColorGradeNodeV2, ColorGradeV2 } from "../domain/visualTypes";
import { applyColorGradeV2Rgb, type ColorLutResolver } from "./gradeV2";
import { workingLumaWeights, type GradeWorkingSpace, type Vec3 } from "./gradeV2Color";
import { compileSecondaryHslKeyV1, secondaryHslKeyWeightV1, workingRgbToHslV1 } from "./secondaryHslV1";

export type EyedropperRefusalCodeV1 = "EYEDROPPER_SAMPLE" | "EYEDROPPER_RANGE" | "EYEDROPPER_PARAMETERS"
  | "EYEDROPPER_NODE" | "EYEDROPPER_SOLVE" | "EYEDROPPER_CALIBRATION" | "EYEDROPPER_SOURCE"
  | "EYEDROPPER_GRADED" | "EYEDROPPER_STALE" | "EYEDROPPER_LOCKED" | "EYEDROPPER_LUT"
  | "EYEDROPPER_CANCELLED" | "EYEDROPPER_UNAVAILABLE" | "EYEDROPPER_NODE_LIMIT";
export class EyedropperRefusalV1 extends Error {
  constructor(readonly code: EyedropperRefusalCodeV1) { super(code); this.name = "EyedropperRefusalV1"; }
}
export function refuseEyedropperV1(code: EyedropperRefusalCodeV1): never { throw new EyedropperRefusalV1(code); }

/** Explicit host settings; no hidden selector palette or width defaults. */
export const eyedropperSelectorWidthsV1Schema = z.strictObject({
  hueHalfWidthDegrees: z.number().finite().min(0).max(180),
  hueSoftnessDegrees: z.number().finite().min(0).max(180),
  saturationRadius: z.number().finite().min(0).max(1),
  lightnessRadius: z.number().finite().min(0).max(1),
  bandSoftness: z.number().finite().min(0).max(1),
});
export type EyedropperSelectorWidthsV1 = z.infer<typeof eyedropperSelectorWidthsV1Schema>;

export function boundedEyedropperWorkingRgbV1(input: readonly number[]): Vec3 {
  if (!Array.isArray(input) || input.length !== 3 || !input.every(Number.isFinite)) refuseEyedropperV1("EYEDROPPER_SAMPLE");
  if (input.some(v => v < 0 || v > 1)) refuseEyedropperV1("EYEDROPPER_RANGE");
  return [input[0], input[1], input[2]];
}

/**
 * Neutralizes one bounded working-code sample before any following Film Look.
 * Gain is preferred; offset is used only when the schema's maximum gain cannot
 * reach the target. Existing node order is offset THEN gain, not the reverse.
 * This preserves working-code luma, not a scene-linear exposure measurement.
 */
export function neutralBalanceNodeForWorkingRgbV1(input: readonly number[], space: GradeWorkingSpace, id: string, label: string): ColorGradeNodeV2 | undefined {
  const rgb = boundedEyedropperWorkingRgbV1(input);
  if (!["rec709_display", "acescct"].includes(space) || typeof label !== "string" || !label.trim()) refuseEyedropperV1("EYEDROPPER_PARAMETERS");
  const weights = workingLumaWeights(space), target = rgb.reduce((sum, value, index) => sum + value * weights[index], 0);
  if (Math.max(...rgb) - Math.min(...rgb) <= 1e-12) return undefined;
  const factors = rgb.map(value => value > 0 ? Math.min(3, target / value) : 3);
  const offsets = rgb.map((value, index) => value * factors[index] < target ? target / factors[index] - value : 0);
  const [r, g, b] = factors.map(v => v - 1), [or, og, ob] = offsets;
  const node = colorGradeNodeV2Schema.parse({ id, label, gain: { r, g, b }, ...(offsets.some(v => v !== 0) ? { offset: { r: or, g: og, b: ob } } : {}) });
  const checked = applyColorGradeV2Rgb({ schema: "editkin.color-grade/v2", nodes: [node] }, space, rgb);
  if (checked.some(value => !Number.isFinite(value) || Math.abs(value - target) > 2e-12)) refuseEyedropperV1("EYEDROPPER_SOLVE");
  return node;
}

/** Selecting a colour changes only its qualifier, enabling it and clearing inversion. */
export function seedQualifierFromWorkingRgbV1(source: ColorGradeNodeV2, input: readonly number[], settings: EyedropperSelectorWidthsV1): ColorGradeNodeV2 {
  const node = colorGradeNodeV2Schema.parse(source), rgb = boundedEyedropperWorkingRgbV1(input);
  const widths = eyedropperSelectorWidthsV1Schema.parse(settings), hsl = workingRgbToHslV1(rgb);
  const band = (value: number, radius: number) => ({ minimum: Math.max(0, value - radius), maximum: Math.min(1, value + radius), softness: widths.bandSoftness });
  const qualifier = {
    ...(hsl.hue === undefined ? {} : { hue: { centerDegrees: hsl.hue, halfWidthDegrees: widths.hueHalfWidthDegrees, softnessDegrees: widths.hueSoftnessDegrees } }),
    saturation: band(hsl.saturation, widths.saturationRadius), lightness: band(hsl.lightness, widths.lightnessRadius),
  };
  const next = colorGradeNodeV2Schema.parse({ ...node, secondaryHslV1: {
    ...node.secondaryHslV1, schema: "editkin.secondary-hsl/v1", selectorSpace: "working_rgb_code", enabled: true, inverted: false, qualifier,
  } });
  const key = compileSecondaryHslKeyV1(qualifier, next.secondaryHslV1?.cleanup, false);
  if (Math.abs(secondaryHslKeyWeightV1(rgb, key) - 1) > 1e-12) refuseEyedropperV1("EYEDROPPER_SOLVE");
  return next;
}

/** Prefix excludes the target node, the Film Look and spatial finishing by definition. */
export function eyedropperPrefixGradeV1(grade: ColorGradeV2 | undefined, targetNodeId?: string): ColorGradeV2 {
  const parsed = assertColorGradeV2(grade ?? { schema: "editkin.color-grade/v2" });
  const nodes = parsed.nodes ?? [], index = targetNodeId === undefined ? nodes.length : nodes.findIndex(n => n.id === targetNodeId);
  if (index < 0) refuseEyedropperV1("EYEDROPPER_NODE");
  return { schema: "editkin.color-grade/v2", nodes: nodes.slice(0, index) };
}

/** Only original decoded SDR code samples admitted by the host call this projection. */
export function projectOriginalSampleThroughPrefixV1(rgb8: readonly number[], prefix: ColorGradeV2, resolveLut?: ColorLutResolver): Vec3 {
  if (!Array.isArray(rgb8) || rgb8.length !== 3 || !rgb8.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) refuseEyedropperV1("EYEDROPPER_SAMPLE");
  return boundedEyedropperWorkingRgbV1(applyColorGradeV2Rgb(prefix, "rec709_display", rgb8.map(v => v / 255) as Vec3, resolveLut));
}
