import type { SecondaryHslCleanupV1, SecondaryHslQualifierV1 } from "../domain/secondaryHslV1Types";
import type { ColorGradeLutRefV2, ColorGradeNodeV2 } from "../domain/visualTypes";
import { secondaryHslCleanupV1Schema, secondaryHslQualifierV1Schema } from "../domain/secondaryHslV1Schema";
import type { ColorLutResolver, CompiledGradeNode } from "./gradeV2";
import { clamp, smoothstep, type GradeWorkingSpace, type Vec3 } from "./gradeV2Color";

export interface CompiledSecondaryHslKeyV1 {
  qualifier: SecondaryHslQualifierV1;
  black: number;
  white: number;
  inverted: boolean;
}

export interface CompiledSecondaryHslNodeV1 {
  key: CompiledSecondaryHslKeyV1;
  inside?: CompiledGradeNode;
  outside?: CompiledGradeNode;
  mix: number;
  lutRefs: ColorGradeLutRefV2[];
}

/**
 * Standard HSL coordinate algebra on bounded components, independently implemented.
 * Reference: CSS Color4 7.2 https://www.w3.org/TR/css-color-4/#rgb-to-hsl
 * These components are explicitly working RGB code values, not a conversion to sRGB.
 * Clamping is for selection only; original RGB is retained by the grade operation.
 */
export function workingRgbToHslV1(rgb: Vec3): { hue?: number; saturation: number; lightness: number } {
  if (!rgb.every(Number.isFinite)) throw new Error("HSL selection requires finite RGB components");
  const r = clamp(rgb[0], 0, 1), g = clamp(rgb[1], 0, 1), b = clamp(rgb[2], 0, 1);
  const high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
  const lightness = (high + low) / 2;
  if (delta === 0) return { saturation: 0, lightness };
  let hue = high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = ((hue * 60) % 360 + 360) % 360;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  return saturation <= 1e-5 ? { saturation, lightness } : { hue, saturation, lightness };
}

/** Validates once at compilation, not on every pixel of the 65³ bake. */
export function compileSecondaryHslKeyV1(qualifier: SecondaryHslQualifierV1, cleanup?: SecondaryHslCleanupV1, inverted = false): CompiledSecondaryHslKeyV1 {
  const parsed = secondaryHslQualifierV1Schema.parse(qualifier);
  const points = secondaryHslCleanupV1Schema.parse(cleanup ?? {});
  return { qualifier: parsed, black: points.blackPoint ?? 0, white: points.whitePoint ?? 1, inverted };
}

function bandWeight(value: number, range: NonNullable<SecondaryHslQualifierV1["saturation"]>): number {
  if (value >= range.minimum && value <= range.maximum) return 1;
  const softness = range.softness ?? 0;
  if (softness === 0) return 0;
  return value < range.minimum ? smoothstep(range.minimum - softness, range.minimum, value)
    : 1 - smoothstep(range.maximum, range.maximum + softness, value);
}

export function secondaryHslKeyWeightV1(rgb: Vec3, key: CompiledSecondaryHslKeyV1): number {
  const hsl = workingRgbToHslV1(rgb), selection = key.qualifier;
  let weight = 1;
  if (selection.hue) {
    if (hsl.hue === undefined) weight = 0;
    else {
      const distance = Math.abs(((hsl.hue - selection.hue.centerDegrees + 540) % 360) - 180);
      const width = selection.hue.halfWidthDegrees, softness = selection.hue.softnessDegrees ?? 0;
      weight = distance <= width ? 1 : softness === 0 ? 0 : 1 - smoothstep(width, width + softness, distance);
    }
  }
  if (selection.saturation) weight *= bandWeight(hsl.saturation, selection.saturation);
  if (selection.lightness) weight *= bandWeight(hsl.lightness, selection.lightness);
  weight = clamp((weight - key.black) / (key.white - key.black), 0, 1);
  return key.inverted ? 1 - weight : weight;
}

type NodeCompiler = (node: ColorGradeNodeV2, space: GradeWorkingSpace, resolveLut?: ColorLutResolver) => CompiledGradeNode | undefined;

/**
 * The containing node owns final mix. Both branches grade the same incoming RGB.
 * Neither branch is fed through the other, and outside has no recursive selection.
 * The callback is the unchanged old node compiler with the new field omitted.
 */
export function compileSecondaryHslNodeV1(node: ColorGradeNodeV2, space: GradeWorkingSpace, resolveLut: ColorLutResolver | undefined, compile: NodeCompiler): CompiledGradeNode | undefined {
  const { secondaryHslV1: selection, ...plain } = node;
  if (!selection || selection.enabled === false) return compile(plain, space, resolveLut);
  if (selection.schema !== "editkin.secondary-hsl/v1" || selection.selectorSpace !== "working_rgb_code") throw new Error("Unsupported secondary HSL contract or selector space");
  const key = compileSecondaryHslKeyV1(selection.qualifier, selection.cleanup, selection.inverted);
  const inside = compile({ ...plain, mix: 1 }, space, resolveLut);
  const outsideSource: ColorGradeNodeV2 | undefined = selection.outside ? { id: node.id, ...selection.outside, mix: 1 } : undefined;
  const outside = outsideSource ? compile(outsideSource, space, resolveLut) : undefined;
  const representative = inside ?? outside;
  if (!representative) return undefined;
  const lutRefs: ColorGradeLutRefV2[] = [];
  if (inside?.lut && plain.lut) lutRefs.push(plain.lut);
  if (outside?.lut && outsideSource?.lut) lutRefs.push(outsideSource.lut);
  return { ...representative, lut: undefined, secondaryHslV1: { key, inside, outside, mix: node.mix ?? 1, lutRefs } };
}

export function applySecondaryHslNodeV1(node: CompiledSecondaryHslNodeV1, input: Vec3, apply: (node: CompiledGradeNode, rgb: Vec3) => Vec3): Vec3 {
  const weight = secondaryHslKeyWeightV1(input, node.key);
  const inside = weight > 0 && node.inside ? apply(node.inside, input) : input;
  const outside = weight < 1 && node.outside ? apply(node.outside, input) : input;
  const output: Vec3 = weight === 0 ? [...outside] : weight === 1 ? [...inside] : [
    outside[0] + (inside[0] - outside[0]) * weight,
    outside[1] + (inside[1] - outside[1]) * weight,
    outside[2] + (inside[2] - outside[2]) * weight,
  ];
  if (node.mix >= 1) return output;
  return [input[0] + (output[0] - input[0]) * node.mix, input[1] + (output[1] - input[1]) * node.mix, input[2] + (output[2] - input[2]) * node.mix];
}
