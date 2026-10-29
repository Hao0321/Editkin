import * as z from "zod/v4";
import type { SecondaryHslOutsideGradeV1, SecondaryHslV1 } from "./secondaryHslV1Types";

const finite = () => z.number().finite();
const band = () => z.strictObject({
  minimum: finite().min(0).max(1),
  maximum: finite().min(0).max(1),
  softness: finite().min(0).max(1).optional(),
}).refine(value => value.minimum <= value.maximum, "HSL minimum must not exceed maximum");

export const secondaryHslQualifierV1Schema = z.strictObject({
  hue: z.strictObject({
    centerDegrees: finite().min(0).lt(360),
    halfWidthDegrees: finite().min(0).max(180),
    softnessDegrees: finite().min(0).max(180).optional(),
  }).optional(),
  saturation: band().optional(),
  lightness: band().optional(),
}).refine(value => value.hue !== undefined || value.saturation !== undefined || value.lightness !== undefined,
  "HSL selection requires at least one explicit range");

export const secondaryHslCleanupV1Schema = z.strictObject({
  blackPoint: finite().min(0).lt(1).optional(),
  whitePoint: finite().gt(0).max(1).optional(),
}).refine(value => (value.blackPoint ?? 0) < (value.whitePoint ?? 1), "HSL cleanup requires blackPoint < whitePoint");

/** Reuses the old bounded node controls; no recursive secondary or arbitrary outside fields. */
export function makeSecondaryHslV1Schema(outside: z.ZodType<SecondaryHslOutsideGradeV1>): z.ZodType<SecondaryHslV1> {
  return z.strictObject({
    schema: z.literal("editkin.secondary-hsl/v1"),
    selectorSpace: z.literal("working_rgb_code"),
    enabled: z.boolean().optional(),
    qualifier: secondaryHslQualifierV1Schema,
    cleanup: secondaryHslCleanupV1Schema.optional(),
    inverted: z.boolean().optional(),
    outside: outside.optional(),
  });
}
