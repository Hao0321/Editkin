import { runProcess } from "./mediaProcess";
import { assertTimelineTransitionProbeV1, type TimelineTransitionReadViewV1 } from "./timelineTransitionReadV1";
import type { MediaProbe } from "./ffmpegContracts";

const missing = () => Error("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING");
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function positive(value: unknown): number | undefined {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return undefined;
  const result = Number(value); return Number.isFinite(result) && result > 0 ? result : undefined;
}
function durationTag(value: unknown, start: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{2,}:[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(value)) return undefined;
  // Matroska DURATION may be an end timestamp. Do not invent its origin for
  // nonzero/unknown stream starts; a numeric stream duration can still work.
  if (Number(start) !== 0 || (typeof start !== "number" && typeof start !== "string")) return undefined;
  const [hours, minutes, seconds] = value.split(":").map(Number);
  const result = hours * 3600 + minutes * 60 + seconds; return Number.isFinite(result) && result > 0 ? result : undefined;
}

/** Container duration may belong to a longer audio stream. This contract is
 * private to paired video reads; the public probe and all no-pair inputs retain
 * their old metadata and behavior. Unknown mixed-media timing fails closed. */
export function pairedVideoDurationV2(raw: unknown): number {
  const data = record(raw), streams = data?.streams;
  if (!Array.isArray(streams) || streams.length > 256) throw missing();
  const rows = streams.map(record);
  const video = rows.find(row => row?.codec_type === "video" && !record(row.disposition)?.attached_pic);
  if (!video) throw Error("TIMELINE_TRANSITION_VIDEO_STREAM_MISSING");
  const candidates: number[] = [], direct = positive(video.duration);
  if (direct !== undefined) candidates.push(direct);
  if (typeof video.time_base === "string" && /^\d+\/\d+$/.test(video.time_base)) {
    const [numerator, denominator] = video.time_base.split("/").map(Number), ticks = positive(video.duration_ts);
    if ([numerator, denominator, ticks].every(Number.isSafeInteger) && numerator > 0 && denominator > 0 && ticks !== undefined) {
      const result = ticks * numerator / denominator; if (Number.isFinite(result) && result > 0) candidates.push(result);
    }
  }
  const tags = record(video.tags), tagged = durationTag(tags?.DURATION, video.start_time);
  if (tagged !== undefined) candidates.push(tagged);
  if (!candidates.length && !rows.some(row => row?.codec_type === "audio")) {
    const container = positive(record(data?.format)?.duration); if (container !== undefined) candidates.push(container);
  }
  if (!candidates.length) throw missing();
  return Math.min(...candidates);
}

export async function assertTimelineTransitionVideoBoundsV2(view: TimelineTransitionReadViewV1,
  assetPath: string, ffprobePath: string, originalProbe: MediaProbe): Promise<void> {
  const { stdout } = await runProcess(ffprobePath, ["-v", "error", "-show_entries",
    "format=duration:stream=codec_type,duration,duration_ts,time_base,start_time:stream_disposition=attached_pic:stream_tags=DURATION", "-of", "json", assetPath], 30000);
  if (Buffer.byteLength(stdout, "utf8") > 262144) throw missing();
  const videoDuration = pairedVideoDurationV2(JSON.parse(stdout));
  assertTimelineTransitionProbeV1(view, "video", { ...originalProbe, duration: Math.min(originalProbe.duration, videoDuration) });
}
