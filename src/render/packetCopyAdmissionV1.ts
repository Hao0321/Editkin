import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { admitSourcePreservingProjectV1, admitSourcePreservingMp4V1, SOURCE_PRESERVING_POLICY_V1 } from "./sourcePreservingAdmissionV1";
import { avcConfigurationV1, type PacketTimebaseV1 } from "./sourcePacketV1";

export const EXACT_PACKET_COPY_POLICY_V1 = "copy_exact_idr_video_window" as const;
/** Retain requested trim independently; use the existing closed neutral-project admission. */
export function admitPacketCopyProjectV1(project: EditProject, policy: typeof EXACT_PACKET_COPY_POLICY_V1) {
  if (policy !== EXACT_PACKET_COPY_POLICY_V1) throw Error("PACKET_COPY_EXPLICIT_POLICY_REQUIRED");
  const clips = project.tracks.flatMap(t => t.clips);
  if (clips.length !== 1) throw Error("PACKET_COPY_SINGLE_CLIP_REQUIRED");
  const clip = clips[0], asset = project.assets.find(a => a.id === clip.assetId);
  if (!asset || !Number.isFinite(clip.sourceStart) || clip.sourceStart < 0 || !Number.isFinite(clip.duration) || clip.duration <= 0
    || clip.sourceStart + clip.duration > asset.duration) throw Error("PACKET_COPY_SOURCE_WINDOW_INVALID");
  const neutral = structuredClone(project), whole = neutral.tracks.flatMap(t => t.clips)[0];
  whole.sourceStart = 0; whole.duration = asset.duration;
  const admission = admitSourcePreservingProjectV1(neutral, SOURCE_PRESERVING_POLICY_V1);
  return { ...admission, policy, requestedSourceStart: clip.sourceStart, requestedSourceEnd: clip.sourceStart + clip.duration,
    requestedDuration: clip.duration, audioPolicy: "source_must_have_no_audio" as const };
}
function exactTick(seconds: number, timebase: PacketTimebaseV1) {
  const raw = seconds * timebase.denominator / timebase.numerator, tick = Math.round(raw);
  // Only floating representation error is tolerated, never a fraction of a frame or tick.
  if (!Number.isSafeInteger(tick) || Math.abs(raw - tick) > Math.min(1e-5, 16 * Number.EPSILON * Math.max(1, Math.abs(raw)))) throw Error("PACKET_COPY_REQUEST_NOT_EXACT_TICK");
  return tick;
}
/** First cut branch excludes reordering/audio until their dependency and priming proof exists. */
export function admitPacketCopyMediaV1(value: unknown, admission: ReturnType<typeof admitPacketCopyProjectV1>) {
  const data = value as { streams: Record<string, any>[]; format: Record<string, any> };
  const whole = admitSourcePreservingMp4V1(value, { ...admission, policy: SOURCE_PRESERVING_POLICY_V1, audioPolicy: "original_streams_without_normalization" });
  if (data.streams.length !== 1 || data.streams[0].codec_type !== "video") throw Error("PACKET_COPY_AUDIO_OR_OTHER_STREAM_REQUIRES_RENDERER");
  const stream = data.streams[0];
  if (stream.codec_name !== "h264" || !["Baseline", "Constrained Baseline"].includes(stream.profile) || stream.has_b_frames !== 0
    || stream.is_avc !== "true" || stream.nal_length_size !== "4" || stream.pix_fmt !== "yuv420p" || stream.field_order !== "progressive"
    || stream.start_pts !== 0 || Number(stream.start_time) !== 0) throw Error("PACKET_COPY_CODEC_DEPENDENCY_UNSUPPORTED");
  const codec = avcConfigurationV1(stream.extradata, stream.extradata_size), timebase = whole.sourceTimebase;
  const startTicks = exactTick(admission.requestedSourceStart, timebase), endTicks = exactTick(admission.requestedSourceEnd, timebase);
  if (startTicks < 0 || endTicks <= startTicks) throw Error("PACKET_COPY_SOURCE_WINDOW_INVALID");
  const codecBinding = { codec: "h264", configurationSha256: codec.sha256, profile: stream.profile, pixelFormat: stream.pix_fmt,
    width: stream.width, height: stream.height, sar: stream.sample_aspect_ratio, primaries: stream.color_primaries,
    transfer: stream.color_transfer, matrix: stream.color_space, range: stream.color_range, fieldOrder: stream.field_order };
  return { ...whole, fullContainerMetadataPreserved: false as const, codec, codecBinding, codecBindingCanonical: canonicalJson(codecBinding), timebase, startTicks, endTicks,
    startTimeRational: { numerator: (BigInt(startTicks) * BigInt(timebase.numerator)).toString(), denominator: String(timebase.denominator) },
    endTimeRational: { numerator: (BigInt(endTicks) * BigInt(timebase.numerator)).toString(), denominator: String(timebase.denominator) },
    sourceDecodeVerificationRequired: true, fallbackRequiredForOtherCases: "normal_renderer" as const };
}
