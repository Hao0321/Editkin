import { extname, isAbsolute } from "node:path";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset, type MediaColorMetadata } from "../domain/types";
import { compositorSourceColorPlan } from "../render/sourceColorFilters";
import { colorBytesSha, colorDigest, colorFileSha, colorToolPaths, getMaterialColorRuntimeIdentity, runColorProcess } from "./materialColorSamplingRuntime";
import { validateMaterialColorRequest } from "./materialColorSamplingValidation";
import type { MaterialColorRequest, MaterialColorRuntime, MaterialColorRuntimeIdentity } from "./materialColorSamplingTypes";
import { sourceDisplayColorMetadata } from "./sourceDisplayMetadata";
import { sourceDisplayFrame } from "./sourceDisplayFrame";
import type { MaterialKeyframeAnalysis, MaterialKeyframeDisplay } from "./materialKeyframeTypes";
import { rec709DisplayToSrgbFilters } from "../color/displayTransfer";

/** Display-referred Rec709 uses ideal BT.1886 EOTF → sRGB, not inverse camera OETF. */
export function materialKeyframeFilters(input: "rec709" | "hlg" | "pq", width: number, height: number, color: MediaColorMetadata): string[] {
  if (color.interpretation !== input) throw Error("contradictory-color-interpretation");
  const asset: MediaAsset = { id: "neutral-keyframe", name: "neutral-keyframe", uri: "neutral", kind: "video", duration: 1, color };
  return [...compositorSourceColorPlan(asset, Math.min(1280, Math.max(width, height)), Math.min(1280, Math.max(width, height)), "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, 0).filters,
    ...rec709DisplayToSrgbFilters(), "scale=in_range=full:out_range=full:out_color_matrix=bt601", "format=yuvj444p"];
}

/** Each returned JPEG and decoded clock comes from the same bounded FFmpeg process. */
export async function extractMaterialKeyframes(request: MaterialColorRequest, runtime: MaterialColorRuntime, expectedIdentity: MaterialColorRuntimeIdentity) {
  validateMaterialColorRequest(request);
  const analysis: MaterialKeyframeAnalysis = { schema: "editkin.material-keyframe-analysis/v1", state: "blocked", policy: "neutral-srgb-display-v1", runtimeIdentitySha256: expectedIdentity.identitySha256, requestedSamples: structuredClone(request.samples), omitted: [] };
  const frames: Array<{ id: string; time: number; sceneIndex: number; display: MaterialKeyframeDisplay; data: Buffer }> = [];
  if (request.kind === "audio") return { analysis: { ...analysis, state: "not_applicable" as const }, frames };
  let reason = "display-extraction-failed";
  try {
    if (expectedIdentity.status !== "verified") throw Error("runtime-identity-unverified");
    if (!isAbsolute(request.sourcePath) || [".exr", ".json"].includes(extname(request.sourcePath).toLowerCase())) throw Error("unsupported-source-container");
    if (await colorFileSha(request.sourcePath) !== request.sourceSha256) throw Error("source-sha-mismatch");
    const tools = colorToolPaths(runtime), timeout = Math.min(30000, Math.max(1, runtime.timeoutMs ?? 30000)), deadline = Date.now() + 120000;
    const probeResult = await runColorProcess(tools.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", request.sourcePath], 131072, timeout, runtime.signal);
    const probe = JSON.parse(probeResult.stdout.toString("utf8"));
    const streams = Array.isArray(probe.streams) ? probe.streams.filter((s: Record<string, unknown>) => s.codec_type === "video") : [];
    if (streams.length !== 1) throw Error("single-video-stream-required");
    const stream = streams[0] as Record<string, unknown>, verifiedColor = sourceDisplayColorMetadata(stream, request.color), input = verifiedColor.interpretation as "rec709" | "hlg" | "pq";
    const width = Number(stream.width), height = Number(stream.height), origin = Number(probe.format?.start_time ?? stream.start_time);
    if (!Number.isFinite(origin)) throw Error("source-timeline-origin-unverified");
    if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768)) throw Error("invalid-source-dimensions");
    const filters = materialKeyframeFilters(input, width, height, verifiedColor);
    for (const sample of request.samples) {
      const remaining = deadline - Date.now(); if (remaining <= 0) throw Error("display-time-budget");
      const target = request.sourceStart + sample.time;
      const result = await runColorProcess(tools.ffmpeg, ["-hide_banner", "-loglevel", "info", "-nostdin", "-copyts", "-ss", String(target), "-i", request.sourcePath,
        "-map", "0:v:0", "-an", "-vf", [`select='gte(t,${origin + target})'`, ...filters, "showinfo"].join(","), "-frames:v", "1", "-fps_mode", "passthrough",
        // q=1 alone is clamped by the encoder's default qmin=2. Permit the
        // lower quantizer explicitly to retain calibrated colored-edge detail.
        "-c:v", "mjpeg", "-q:v", "1", "-qmin", "1", "-pix_fmt", "yuvj444p", "-f", "image2pipe", "pipe:1"], 8 * 1024 * 1024, Math.min(timeout, remaining), runtime.signal);
      const decoded = sourceDisplayFrame(result.stderr, origin, request.sourceStart, request.duration, sample.time, 1280);
      if (result.stdout.length < 4 || result.stdout[0] !== 0xff || result.stdout[1] !== 0xd8 || result.stdout.at(-2) !== 0xff || result.stdout.at(-1) !== 0xd9) throw Error("invalid-jpeg-output");
      if (frames.some(frame => frame.time === decoded.relativeTime)) { analysis.omitted.push({ id: sample.id, reason: "duplicate-decoded-frame" }); continue; }
      const sceneIndex = request.sceneCuts?.filter(cut => decoded.relativeTime >= cut).length ?? sample.sceneIndex;
      const display: MaterialKeyframeDisplay = { schema: "editkin.material-keyframe-display/v1", receiptSha256: "", runtimeIdentitySha256: expectedIdentity.identitySha256,
        source: { sha256: request.sourceSha256, start: request.sourceStart, duration: request.duration }, requested: { ...sample },
        decoded: { ...decoded, timelineOrigin: origin, sceneIndex, sceneAttributionVerified: request.sceneCuts !== undefined },
        probe: { sha256: colorBytesSha(probeResult.stdout), metadata: { stream, format: probe.format ?? {} } },
        normalization: { interpretation: input, filters, intermediateTransfer: "bt709", displayEotf: "bt1886-ideal", purpose: "neutral-display-proxy", transfer: "srgb", primaries: "bt709", range: "full", exposure: 0, creativeLook: false, maximumDimension: 1280 },
        jpeg: { sha256: colorBytesSha(result.stdout), bytes: result.stdout.length, mimeType: "image/jpeg" } };
      display.receiptSha256 = colorDigest({ ...display, receiptSha256: undefined });
      frames.push({ id: sample.id, time: decoded.relativeTime, sceneIndex, display, data: result.stdout });
    }
    analysis.state = analysis.omitted.length ? "partial" : "ready";
  } catch (error) {
    if (error instanceof Error && ["source-sha-mismatch", "runtime-identity-drift"].includes(error.message)) throw error;
    reason = error instanceof Error && /^[a-z][a-z0-9-]+$/.test(error.message) ? error.message : "display-extraction-failed";
    analysis.state = frames.length ? "partial" : "blocked";
  }
  // A changed source/tool/code identity must not be converted into cacheable partial success.
  if (await colorFileSha(request.sourcePath) !== request.sourceSha256) throw Error("source-sha-mismatch");
  if (colorDigest(await getMaterialColorRuntimeIdentity(runtime)) !== colorDigest(expectedIdentity)) throw Error("runtime-identity-drift");
  for (const sample of request.samples) if (!frames.some(frame => frame.id === sample.id) && !analysis.omitted.some(frame => frame.id === sample.id)) analysis.omitted.push({ id: sample.id, reason });
  return { analysis, frames };
}
