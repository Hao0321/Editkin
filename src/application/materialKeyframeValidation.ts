import { canonicalJson } from "../shared/canonicalJson";
import type { MediaColorMetadata } from "../domain/types";
import { colorDigest } from "./materialColorSamplingRuntime";
import { imageKeyframeFilters, materialKeyframeFilters } from "./materialKeyframeExtraction";
import { sourceDisplayColorMetadata } from "./sourceDisplayMetadata";
import type { MaterialKeyframeAnalysis, MaterialKeyframeDisplay } from "./materialKeyframeTypes";

interface DisplayFrame { id: string; time: number; sceneIndex: number; sha256: string; bytes: number; display?: MaterialKeyframeDisplay }
const digest = /^[a-f0-9]{64}$/;
/** Integrity and consistency only; no receipt self-signature grants human approval. */
export function verifyMaterialKeyframeDisplay(analysis: MaterialKeyframeAnalysis | undefined, frames: DisplayFrame[], source: { sourceSha256: string; sourceStart: number; duration: number; kind: string; color?: MediaColorMetadata }, runtimeSha: string, cuts?: number[]) {
  if (!analysis || analysis.schema !== "editkin.material-keyframe-analysis/v1"
    || analysis.policy !== (source.kind === "image" ? "source-image-display-v1" : "neutral-srgb-display-v1")
    || analysis.runtimeIdentitySha256 !== runtimeSha) throw Error("keyframe-display-analysis-binding");
  if (!Array.isArray(analysis.requestedSamples) || analysis.requestedSamples.length > 12 || !Array.isArray(analysis.omitted)) throw Error("keyframe-display-coverage");
  const ids = analysis.requestedSamples.map(s => s.id), completed = frames.map(f => f.id), omitted = analysis.omitted.map(s => s.id);
  if (new Set(ids).size !== ids.length || completed.length + omitted.length !== ids.length || new Set([...completed, ...omitted]).size !== ids.length || [...completed, ...omitted].some(id => !ids.includes(id))
    || analysis.omitted.some(s => !/^[a-z][a-z0-9-]+$/.test(s.reason))) throw Error("keyframe-display-coverage");
  if (source.kind === "audio") { if (analysis.state !== "not_applicable" || ids.length || frames.length || omitted.length) throw Error("keyframe-audio-applicability"); return; }
  if (!ids.length || analysis.state !== (frames.length === ids.length ? "ready" : frames.length ? "partial" : "blocked")) throw Error("keyframe-display-state");
  if (source.kind === "image" && (source.sourceStart !== 0 || ids.length !== 1 || analysis.requestedSamples[0].time !== 0))
    throw Error("keyframe-image-source-clock");
  if (new Set(frames.map(f => f.time)).size !== frames.length) throw Error("keyframe-duplicate-decoded-frame");
  for (const sample of analysis.requestedSamples) if (!Number.isFinite(sample.time) || sample.time < 0 || sample.time >= source.duration || !Number.isSafeInteger(sample.sceneIndex) || sample.sceneIndex < 0 || (cuts && sample.sceneIndex !== cuts.filter(cut => sample.time >= cut).length)) throw Error("keyframe-display-request");
  for (const frame of frames) {
    const d = frame.display;
    if (!d || d.schema !== "editkin.material-keyframe-display/v1" || !digest.test(d.receiptSha256) || d.receiptSha256 !== colorDigest({ ...d, receiptSha256: undefined }) || d.runtimeIdentitySha256 !== runtimeSha) throw Error("keyframe-display-receipt-integrity");
    if (canonicalJson(d.source) !== canonicalJson({ sha256: source.sourceSha256, start: source.sourceStart, duration: source.duration }) || canonicalJson(d.requested) !== canonicalJson(analysis.requestedSamples.find(s => s.id === frame.id))) throw Error("keyframe-display-source-request-binding");
    const clock = d.decoded, tb = clock.timeBase;
    if (![tb.numerator, tb.denominator, clock.width, clock.height].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(clock.pts) || clock.width > 1280 || clock.height > 1280) throw Error("keyframe-display-clock");
    const actual = clock.pts * tb.numerator / tb.denominator - clock.timelineOrigin;
    if (![actual, clock.sourceTime, clock.relativeTime].every(Number.isFinite) || Math.abs(actual - clock.sourceTime) > 1e-7 || Math.abs(actual - source.sourceStart - clock.relativeTime) > 1e-7 || clock.relativeTime < d.requested.time - 1e-7 || clock.relativeTime < 0 || clock.relativeTime >= source.duration || frame.time !== clock.relativeTime) throw Error("keyframe-display-clock");
    if (clock.sceneAttributionVerified !== (cuts !== undefined) || frame.sceneIndex !== clock.sceneIndex || clock.sceneIndex !== (cuts?.filter(cut => clock.relativeTime >= cut).length ?? d.requested.sceneIndex)) throw Error("keyframe-display-scene-binding");
    if (!digest.test(d.probe.sha256)) throw Error("keyframe-display-probe");
    const stream = d.probe.metadata.stream, image = source.kind === "image";
    if ((image ? 0 : Number(d.probe.metadata.format.start_time ?? stream.start_time)) !== clock.timelineOrigin)
      throw Error("keyframe-display-origin");
    if (![Number(stream.width), Number(stream.height)].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768)) throw Error("keyframe-display-probe-dimensions");
    if (image && stream.codec_name !== "mjpeg") throw Error("keyframe-image-codec");
    const verifiedColor = image ? undefined : sourceDisplayColorMetadata(stream, source.color);
    const input = verifiedColor?.interpretation as "rec709" | "hlg" | "pq";
    const expected = image ? { interpretation: "unverified-image", filters: imageKeyframeFilters(Number(stream.width), Number(stream.height)),
      purpose: "source-image-display-proxy", transfer: "unverified", primaries: "unverified", range: "full", exposure: 0,
      creativeLook: false, maximumDimension: 1280 }
      : { interpretation: input, filters: materialKeyframeFilters(input, Number(stream.width), Number(stream.height), verifiedColor!),
        intermediateTransfer: "bt709", displayEotf: "bt1886-ideal", purpose: "neutral-display-proxy", transfer: "srgb",
        primaries: "bt709", range: "full", exposure: 0, creativeLook: false, maximumDimension: 1280 };
    if (canonicalJson(d.normalization) !== canonicalJson(expected)) throw Error("keyframe-display-normalization");
    if (!digest.test(frame.sha256) || !Number.isSafeInteger(frame.bytes) || frame.bytes < 4 || frame.bytes > 8 * 1024 * 1024 || canonicalJson(d.jpeg) !== canonicalJson({ sha256: frame.sha256, bytes: frame.bytes, mimeType: "image/jpeg" })) throw Error("keyframe-display-jpeg-binding");
  }
}
