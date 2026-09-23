import { DEFAULT_COLOR_MANAGEMENT, type ColorAdjustments, type MediaAsset } from "../domain/types";
import type { ShotColorFrame } from "../color/shotColorAnalysis";
import { primaryExposureFilter, primaryToneFilters } from "../color/primaryGrade";
import { compositorSourceColorPlan } from "../render/sourceColorFilters";
import { assertReferenceWhiteBalanceInput, sourceLinearWhiteBalancePlan } from "../render/sourceLinearWhiteBalance";
import { hasPrimaryToneAdjustment } from "../render/ffmpegExpressions";
import { colorBytesSha, colorToolPaths, runColorProcess } from "./materialColorSamplingRuntime";
import type { MaterialColorRuntime } from "./materialColorSampling";
import type { MaterialIntelligencePacket } from "./materialIntelligence";
import { sourceDisplayColorMetadata } from "./sourceDisplayMetadata";

/** Upright source-frame primary grade only; never a final composited-frame or beauty claim. */
export function autoColorCandidateFilters(asset: MediaAsset, color: ColorAdjustments): string[] {
  const source = compositorSourceColorPlan(asset, 256, 256, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, color.exposure, color);
  return [...source.filters,
    ...(hasPrimaryToneAdjustment(color) ? primaryToneFilters(color) : []),
    ...(!source.exposureConsumed && color.exposure !== 0 ? [primaryExposureFilter(color.exposure)] : []),
    ...(color.brightness !== 0 || color.contrast !== 1 || color.saturation !== 1
      ? [`eq=brightness=${color.brightness}:contrast=${color.contrast}:saturation=${color.saturation}`] : []),
    ...(color.hue !== 0 ? [`hue=h=${color.hue}`] : []), "format=rgb24"];
}

export function autoColorSourceAsset(packet: MaterialIntelligencePacket, sourcePath: string): MediaAsset {
  const measured = packet.analysis.color;
  const stream = measured?.probe?.metadata?.stream;
  if (!measured?.normalization) throw Error("Colour source interpretation unavailable");
  // Reconstruct the same closed-world colour metadata that was verified while
  // sampling. Keeping only the interpretation discards the BT.2100 tags and
  // causes the strict HDR input gate to reject otherwise valid PQ/HLG evidence.
  // Historical SDR receipts without embedded probe tags remain deterministic;
  // HDR never receives that fallback because its transform requires BT.2100.
  const color = stream && typeof stream === "object" && !Array.isArray(stream)
    ? sourceDisplayColorMetadata(stream as Record<string, unknown>, packet.source.color)
    : measured.normalization.interpretation === "rec709" ? { interpretation: "rec709" as const }
    : (() => { throw Error("Colour source interpretation unavailable"); })();
  if (color.interpretation !== measured.normalization.interpretation) throw Error("Colour source interpretation drift");
  return { id: packet.source.assetId, name: "colour-candidate", uri: sourcePath,
    kind: packet.source.kind, duration: packet.source.duration, color };
}

/** One source-clock check for both independent FLOAT and display RGB8 decodes. */
async function readBoundAutoColorFrame(packet: MaterialIntelligencePacket, sampleIndex: number,
  filters: string[], pixelFormat: "rgb24" | "gbrapf32le", sourcePath: string, runtime: MaterialColorRuntime, remainingMs: number) {
  const measured = packet.analysis.color, sample = measured?.mapping[sampleIndex];
  if (!measured?.probe || !measured.normalization || !sample || !Number.isFinite(remainingMs) || remainingMs <= 0) throw Error("Invalid automatic colour sample/budget");
  const vf = [`select='gte(t,${measured.probe.timelineOrigin + sample.decodedSourceTime - 1e-7})'`, ...filters, "showinfo"].join(",");
  const bytesPerPixel = pixelFormat === "rgb24" ? 3 : 16;
  const output = await runColorProcess(colorToolPaths(runtime).ffmpeg, ["-hide_banner", "-loglevel", "info", "-nostdin", "-copyts",
    "-ss", String(sample.decodedSourceTime), "-i", sourcePath, "-map", "0:v:0", "-an", "-vf", vf,
    "-frames:v", "1", "-fps_mode", "passthrough", "-pix_fmt", pixelFormat, "-f", "rawvideo", "pipe:1"],
  256 * 256 * bytesPerPixel, Math.min(30000, runtime.timeoutMs ?? 30000, remainingMs));
  const tb = output.stderr.match(/config in time_base:\s*(\d+)\/(\d+)/);
  const match = output.stderr.match(/n:\s*0\s+pts:\s*(-?\d+)\s+pts_time:[^\s]+[\s\S]*?\bs:(\d+)x(\d+)/);
  if (!tb || !match) throw Error("Candidate decoded timestamp unavailable");
  const width = Number(match[2]), height = Number(match[3]);
  const decodedTime = Number(match[1]) * Number(tb[1]) / Number(tb[2]) - measured.probe.timelineOrigin;
  if (!Number.isFinite(decodedTime) || Math.abs(decodedTime - sample.decodedSourceTime) > 1e-7
    || width < 1 || height < 1 || width > 256 || height > 256 || output.stdout.length !== width * height * bytesPerPixel) throw Error("Candidate frame does not match measured source sample");
  return { sampleId: sample.id, timeSeconds: sample.decodedRelativeTime, width, height, decodedTime, bytes: output.stdout };
}

export async function readAutoColorCandidateFrame(packet: MaterialIntelligencePacket, sampleIndex: number,
  color: ColorAdjustments, sourcePath: string, runtime: MaterialColorRuntime, remainingMs: number) {
  const filters = autoColorCandidateFilters(autoColorSourceAsset(packet, sourcePath), color);
  const output = await readBoundAutoColorFrame(packet, sampleIndex, filters, "rgb24", sourcePath, runtime, remainingMs);
  const frame: ShotColorFrame = { sampleId: output.sampleId, timeSeconds: output.timeSeconds, width: output.width, height: output.height, format: "rgb8",
    primaries: "bt709", transfer: "bt709-oetf", range: "full", pixels: output.bytes };
  return { frame, surface: { sampleId: output.sampleId, decodedTime: output.decodedTime, rgbSha256: colorBytesSha(output.bytes), filters } };
}

/** No post-tone RGB8 can enter this reference path. Basis + convention + exact
 * filters and raw FLOAT bytes are recorded independently from output safety.
 */
export function autoWhiteBalanceReferencePlan(asset: MediaAsset, color: ColorAdjustments) {
  assertReferenceWhiteBalanceInput(asset);
  const source = sourceLinearWhiteBalancePlan(asset, color);
  // swscale can negotiate a bounded integer intermediate even with FLOAT on
  // both sides: it clips HDR/signed values and quantizes alpha. zscale resizes
  // these linear planes without that hidden clamp (verified with real pixels).
  return { ...source, filters: [...source.filters,
    "zscale=w='if(gte(iw,ih),256,-1)':h='if(gte(ih,iw),256,-1)'", "format=gbrapf32le"] };
}

export async function readAutoWhiteBalanceReferenceFrame(packet: MaterialIntelligencePacket, sampleIndex: number,
  color: ColorAdjustments, sourcePath: string, runtime: MaterialColorRuntime, remainingMs: number) {
  const plan = autoWhiteBalanceReferencePlan(autoColorSourceAsset(packet, sourcePath), color);
  const output = await readBoundAutoColorFrame(packet, sampleIndex, plan.filters, "gbrapf32le", sourcePath, runtime, remainingMs);
  const count = output.width * output.height, pixels = new Float32Array(count * 4);
  // FFmpeg gbrapf32le is planar G, B, R, A. Never treat it as packed RGBA.
  for (let i = 0; i < count; i++) for (const [channel, plane] of [2, 0, 1, 3].entries()) {
    const value = output.bytes.readFloatLE((plane * count + i) * 4);
    if (!Number.isFinite(value) || (channel === 3 ? value < -1e-6 || value > 1 + 1e-6 : Math.abs(value) > 10000)) throw Error("Invalid source-linear FLOAT surface");
    pixels[i * 4 + channel] = value;
  }
  return { frame: { sampleId: output.sampleId, timeSeconds: output.timeSeconds, width: output.width, height: output.height,
    pixels, basis: plan.basis, inputConvention: plan.inputConvention },
  surface: { sampleId: output.sampleId, decodedTime: output.decodedTime, floatSha256: colorBytesSha(output.bytes),
    format: "gbrapf32le" as const, basis: plan.basis, inputConvention: plan.inputConvention, filters: plan.filters } };
}
