import { mediaDisplayRotation, mediaSampleAspectRatio } from "../render/mediaDisplayGeometry";
import { ROTO_V2_MAX_RAW_BYTES, type AnalyzeProductAutoRotoRequestV2 } from "./autoRotoV2Contract";

export const ROTO_V2_MEDIA_INPUT_POLICY = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "matroska,webm,mov,avi,mpegts,mpeg"] as const;
interface ProbeStream {
  index?: number; codec_type?: string; width?: number; height?: number; sample_aspect_ratio?: string;
  color_transfer?: string; color_primaries?: string; pix_fmt?: string; disposition?: { attached_pic?: number };
  side_data_list?: Array<{ side_data_type?: string; rotation?: unknown }>; tags?: { rotate?: unknown };
}
export function planRotoV2Media(input: unknown, request: AnalyzeProductAutoRotoRequestV2) {
  const probe = input as { format?: { duration?: string }; streams?: ProbeStream[] };
  if (!probe || !Array.isArray(probe.streams)) throw Error("ROTO_V2_MEDIA_PROBE_INVALID");
  const video = probe.streams.find(s => s.codec_type === "video" && !s.disposition?.attached_pic);
  const duration = Number(probe.format?.duration);
  if (!video || !Number.isFinite(duration) || request.sourceStart + request.duration > duration + 1e-6
    || !Number.isInteger(video.index) || video.index! < 0 || video.index! > 1024
    || ![video.width, video.height].every(v => Number.isSafeInteger(v) && v! >= 16 && v! <= 32768)) throw Error("ROTO_V2_MEDIA_RANGE_OR_GEOMETRY");
  if (/(?:smpte2084|arib-std-b67|log|linear)/i.test(video.color_transfer ?? "")
    || (video.color_transfer !== undefined && !["bt709", "unknown", "unspecified", "N/A"].includes(video.color_transfer))
    || (video.color_primaries !== undefined && !["bt709", "unknown", "unspecified", "N/A"].includes(video.color_primaries))
    || /(?:gbrpf|rgbaf|f32|f16|rgba|bgra|argb|abgr|gbrap|yuva)/i.test(video.pix_fmt ?? "")) throw Error("ROTO_V2_REQUIRES_DECLARED_SDR_RGB8");
  const rotation = mediaDisplayRotation(video) ?? 0, reportedSar = mediaSampleAspectRatio(video.sample_aspect_ratio), sar = reportedSar ?? 1;
  if (rotation % 90 !== 0 || sar <= 0 || sar > 64) throw Error("ROTO_V2_DISPLAY_GEOMETRY_UNSUPPORTED");
  const swap = Math.abs(rotation / 90) % 2 === 1;
  const displayW = swap ? video.height! : video.width! * sar, displayH = swap ? video.width! * sar : video.height!;
  if (displayW / displayH < 1 / 8 || displayW / displayH > 8) throw Error("ROTO_V2_DISPLAY_ASPECT_UNSUPPORTED");
  const scale = Math.min(1, request.maxDimension / Math.max(displayW, displayH));
  const width = Math.floor(displayW * scale / 2) * 2, height = Math.floor(displayH * scale / 2) * 2;
  const frameCount = Math.floor(request.duration * request.fps + 1e-8), rawBytes = width * height * frameCount * 3;
  if (width < 16 || height < 16 || width * height > 2073600 || frameCount < 1 || frameCount > 1440 || rawBytes > ROTO_V2_MAX_RAW_BYTES) {
    throw Error("ROTO_V2_BOUNDED_ANALYSIS_EXCEEDED_SHORTEN_RANGE_OR_RESOLUTION");
  }
  return { width, height, frameCount, rawBytes, fps: request.fps, videoStreamIndex: video.index!,
    hasAudio: probe.streams.some(s => s.codec_type === "audio"),
    initialFrame: Math.min(frameCount - 1, Math.max(0, Math.round(request.initialTime * request.fps))),
    displayRotationDegrees: rotation, sourceSampleAspectRatio: sar, sourceSarAssumedSquare: reportedSar === undefined,
    sourceDisplayWidth: displayW, sourceDisplayHeight: displayH,
    filter: `fps=${request.fps},scale=${width}:${height}:flags=bilinear,format=rgb24` };
}
export type RotoV2MediaPlan = ReturnType<typeof planRotoV2Media>;
