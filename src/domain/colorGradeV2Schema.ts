import { makeSecondaryHslV1Schema } from "./secondaryHslV1Schema";
import * as z from "zod/v4";
import { EditGraphError } from "./editGraphError";
import type { ColorGradeV2 } from "./visualTypes";

/**
 * editkin.color-grade/v2 persisted contract. Every field is optional and the whole
 * object is an optional clip field: projects that omit it keep schema 9/10 and the
 * exact pre-v2 render graph. Strict objects reject misspelled controls instead of
 * silently dropping them.
 */
export const COLOR_GRADE_V2_SCHEMA = "editkin.color-grade/v2" as const;
export const COLOR_GRADE_V2_MAX_NODES = 4;
export const COLOR_GRADE_V2_MAX_CURVE_POINTS = 16;
export const COLOR_GRADE_V2_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const COLOR_GRADE_V2_LOOK_ID = /^[a-z][a-z0-9_]{2,63}$/;
export const COLOR_LUT_ID = /^lut:[a-f0-9]{16}$/;

const finite = () => z.number().finite();
const wheel = (minimum: number, maximum: number) => z.strictObject({
  r: finite().min(minimum).max(maximum).optional(),
  g: finite().min(minimum).max(maximum).optional(),
  b: finite().min(minimum).max(maximum).optional(),
  master: finite().min(minimum).max(maximum).optional(),
});

const increasing = (values: number[]) => values.every((value, index) => index === 0 || value > values[index - 1] + 1e-6);

const curvePointsSchema = z.array(z.strictObject({ x: finite().min(0).max(1), y: finite().min(0).max(1) }))
  .min(2).max(COLOR_GRADE_V2_MAX_CURVE_POINTS)
  .refine(points => increasing(points.map(point => point.x)), "曲線控制點的 x 必須嚴格遞增");

const hueCurveSchema = (minimum: number, maximum: number) => z.array(z.strictObject({
  hue: finite().min(0).lt(360),
  value: finite().min(minimum).max(maximum),
})).min(2).max(COLOR_GRADE_V2_MAX_CURVE_POINTS)
  .refine(points => increasing(points.map(point => point.hue)), "色相曲線控制點必須依色相嚴格遞增");

const lumCurveSchema = z.array(z.strictObject({ lum: finite().min(0).max(1), value: finite().min(0).max(2) }))
  .min(2).max(COLOR_GRADE_V2_MAX_CURVE_POINTS)
  .refine(points => increasing(points.map(point => point.lum)), "Lum vs Sat 控制點必須依亮度嚴格遞增");

export const colorGradeLutRefV2Schema = z.strictObject({
  id: z.string().regex(COLOR_LUT_ID),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  strength: finite().min(0).max(1),
}).refine(ref => ref.id === `lut:${ref.sha256.slice(0, 16)}`, "LUT id 必須由完整 SHA-256 前 16 碼構成");

const logWheelsSchema = z.strictObject({
  shadow: wheel(-.5, .5).optional(),
  midtone: wheel(-.5, .5).optional(),
  highlight: wheel(-.5, .5).optional(),
  lowRange: finite().min(.05).max(.6).optional(),
  highRange: finite().min(.3).max(.95).optional(),
}).refine(log => (log.lowRange ?? .333) < (log.highRange ?? .55) - .05, "Log 色輪的 low range 必須低於 high range");

const colorGradeNodeBaseV2Schema = z.strictObject({
  id: z.string().regex(COLOR_GRADE_V2_NODE_ID),
  label: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
  lut: colorGradeLutRefV2Schema.optional(),
  offset: wheel(-.5, .5).optional(),
  lift: wheel(-.5, .5).optional(),
  gamma: wheel(-1, 1).optional(),
  gain: wheel(-1, 2).optional(),
  log: logWheelsSchema.optional(),
  contrast: finite().min(0).max(3).optional(),
  pivot: finite().min(.05).max(.95).optional(),
  saturation: finite().min(0).max(3).optional(),
  colorBoost: finite().min(-1).max(1).optional(),
  curves: z.strictObject({
    y: curvePointsSchema.optional(), r: curvePointsSchema.optional(), g: curvePointsSchema.optional(), b: curvePointsSchema.optional(),
  }).optional(),
  hueVsHue: hueCurveSchema(-45, 45).optional(),
  hueVsSat: hueCurveSchema(0, 2).optional(),
  hueVsLum: hueCurveSchema(-.25, .25).optional(),
  lumVsSat: lumCurveSchema.optional(),
  skinProtection: finite().min(0).max(1).optional(),
  skyProtection: finite().min(0).max(1).optional(),
  gamutLimit: z.boolean().optional(),
  softClip: finite().min(0).max(1).optional(),
  mix: finite().min(0).max(1).optional(),
});

export const colorGradeNodeV2Schema = colorGradeNodeBaseV2Schema.extend({
  secondaryHslV1: makeSecondaryHslV1Schema(colorGradeNodeBaseV2Schema.omit({ id: true, label: true, enabled: true, mix: true })).optional(),
});

const glowSchema = z.strictObject({
  amount: finite().min(0).max(1),
  threshold: finite().min(.3).max(.98).optional(),
  radius: finite().min(.001).max(.1).optional(),
});

export const colorGradeFinishingV2Schema = z.strictObject({
  grain: z.strictObject({ amount: finite().min(0).max(1), size: finite().min(1).max(4).optional() }).optional(),
  halation: glowSchema.optional(),
  bloom: glowSchema.optional(),
  vignette: z.strictObject({ amount: finite().min(0).max(1) }).optional(),
});

export const colorGradeV2Schema: z.ZodType<ColorGradeV2> = z.strictObject({
  schema: z.literal(COLOR_GRADE_V2_SCHEMA),
  nodes: z.array(colorGradeNodeV2Schema).max(COLOR_GRADE_V2_MAX_NODES)
    .refine(nodes => new Set(nodes.map(node => node.id)).size === nodes.length, "調色節點 id 不可重複").optional(),
  look: z.strictObject({ id: z.string().regex(COLOR_GRADE_V2_LOOK_ID), strength: finite().min(0).max(1).optional() }).optional(),
  finishing: colorGradeFinishingV2Schema.optional(),
});

/** Parses one grade with the persisted schema; failures become ordinary edit-graph errors. */
export function assertColorGradeV2(value: unknown): ColorGradeV2 {
  const parsed = colorGradeV2Schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EditGraphError(`Color Grade v2 不合法：${issue ? `${issue.path.join(".") || "grade"} ${issue.message}` : "unknown"}`);
  }
  return parsed.data;
}
