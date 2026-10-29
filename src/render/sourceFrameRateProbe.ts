import { mediaFrameRateSchema, type MediaFrameRate } from "../domain/mediaFrameRate";

/** Read the observed avg_frame_rate rational. Missing/zero/invalid averages remain unknown; no nominal-rate fallback. */
export function sourceFrameRateFromProbe(raw: unknown): MediaFrameRate | undefined {
  if (typeof raw !== "string" || !/^\d+\/\d+$/.test(raw)) return undefined;
  const [numerator, denominator] = raw.split("/").map(Number);
  const parsed = mediaFrameRateSchema.safeParse({ numerator, denominator });
  return parsed.success ? parsed.data : undefined;
}
