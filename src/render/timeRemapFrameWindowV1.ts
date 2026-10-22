import { timeRemapFrameIntervalV1, type TimeRemapClockV1 } from "../domain/timeRemapClockV1";

export const SOURCE_CLOCK_FRAME_WINDOW_POLICY_V4 = "diagnostic_lossless_source_clock_global_frame_window_v4" as const;
export interface TimeRemapFrameWindowV1 { firstFrame: number; frames: number }
/** Same encoded-RGBA8 diagnostic scope as the source cache. Missing VUI is explicitly unresolved,
 * not a claim of calibrated Rec.709; declared HDR/other primaries are never silently reinterpreted. */
export function describeTimeRemapWindowColorV1(video: Record<string, unknown>) {
  for (const key of ["color_transfer", "color_primaries"]) if (video[key] !== undefined && !["bt709", "unknown", "unspecified"].includes(video[key] as string)) throw Error("CURVE_RENDER_WINDOW_REQUIRES_SDR_SOURCE");
  if (video.color_space !== undefined && !["gbr", "bt709", "unknown", "unspecified"].includes(video.color_space as string)
    || video.color_range !== undefined && !["pc", "tv", "unknown", "unspecified"].includes(video.color_range as string)) throw Error("CURVE_RENDER_WINDOW_REQUIRES_SDR_SOURCE");
  const specified = video.color_transfer === "bt709" && video.color_primaries === "bt709"
    && ["gbr", "bt709"].includes(video.color_space as string) && ["pc", "tv"].includes(video.color_range as string);
  return { primaries: video.color_primaries ?? "unspecified", transfer: video.color_transfer ?? "unspecified", matrix: video.color_space ?? "unspecified", range: video.color_range ?? "unspecified",
    interpretationUnresolved: !specified, pixelSpace: "encoded_rgba8_candidate" as const, wholePixelQualityCertified: false as const };
}
/** The clock remains the full authored clock. No normalized curve slice or floating chunk offset. */
export function resolveTimeRemapFrameWindowV1(clock: TimeRemapClockV1, requested?: TimeRemapFrameWindowV1) {
  if (requested !== undefined && (!requested || typeof requested !== "object" || Array.isArray(requested))) throw Error("TIME_REMAP_OUTPUT_FRAME_WINDOW_INVALID");
  const firstFrame = requested?.firstFrame ?? 0, frames = requested?.frames ?? clock.totalOutputFrames, endFrame = firstFrame + frames;
  if (![firstFrame, frames, endFrame].every(Number.isSafeInteger) || firstFrame < 0 || frames < 1 || endFrame > clock.totalOutputFrames
    || requested && (Object.keys(requested).sort().join() !== "firstFrame,frames")) throw Error("TIME_REMAP_OUTPUT_FRAME_WINDOW_INVALID");
  const first = timeRemapFrameIntervalV1(clock, firstFrame), last = timeRemapFrameIntervalV1(clock, endFrame - 1);
  return { firstFrame, frames, endFrame, timelineStart: first.timelineStart, timelineEnd: last.timelineEnd,
    encodedDuration: frames * clock.outputRate.denominator / clock.outputRate.numerator };
}
