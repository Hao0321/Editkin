import * as z from "zod/v4";

/** Measured source average only; it does not constrain project cadence or reject normal VFR footage. */
export const mediaFrameRateSchema = z.strictObject({
  numerator: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  denominator: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).refine(value => value.numerator / value.denominator <= 1000, "Source frame rate is implausible");
export type MediaFrameRate = z.infer<typeof mediaFrameRateSchema>;

export function isMediaFrameRate(value: unknown): value is MediaFrameRate {
  return mediaFrameRateSchema.safeParse(value).success;
}
