import { extname, isAbsolute } from "node:path";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset, type MediaColorMetadata } from "../domain/types";
import { compositorSourceColorPlan } from "../render/sourceColorFilters";
import { colorBytesSha, colorDigest, colorFileSha, colorToolPaths, getMaterialColorRuntimeIdentity, runColorProcess } from "./materialColorSamplingRuntime";
import { validateMaterialColorRequest } from "./materialColorSamplingValidation";
import type { MaterialColorRequest, MaterialColorRuntime, MaterialColorRuntimeIdentity } from "./materialColorSamplingTypes";
import { sourceDisplayColorMetadata, stillImageDisplayColorV1, type StillImageDisplayColorV1 } from "./sourceDisplayMetadata";
import { sourceDisplayFrame } from "./sourceDisplayFrame";
import type { MaterialKeyframeAnalysis, MaterialKeyframeDisplay, MaterialKeyframeStillNormalizationV1 } from "./materialKeyframeTypes";
import { rec709DisplayToSrgbFilters } from "../color/displayTransfer";

/** Display-referred Rec709 uses ideal BT.1886 EOTF → sRGB, not inverse camera OETF. */
export function materialKeyframeFilters(input: "rec709" | "hlg" | "pq", width: number, height: number, color: MediaColorMetadata): string[] {
  if (color.interpretation !== input) throw Error("contradictory-color-interpretation");
  const asset: MediaAsset = { id: "neutral-keyframe", name: "neutral-keyframe", uri: "neutral", kind: "video", duration: 1, color };
  return [...compositorSourceColorPlan(asset, Math.min(1280, Math.max(width, height)), Math.min(1280, Math.max(width, height)), "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, 0).filters,
    ...rec709DisplayToSrgbFilters(), "scale=in_range=full:out_range=full:out_color_matrix=bt601", "format=yuvj444p"];
}

/** A single-image container (design P1) is probed and decoded through image2:
 * one frame at its own origin 0, never an -ss seek or a select past that frame. */
export const STILL_IMAGE_INPUT = ["-f", "image2", "-pattern_type", "none"] as const;
export function stillImageRequest(request: Pick<MaterialColorRequest, "kind" | "sourcePath">): boolean {
  return request.kind === "image" && /\.(?:png|jpe?g|webp)$/i.test(request.sourcePath);
}
export function assertStillImageStream(stream: Record<string, unknown>, origin: number, sourceStart: number): void {
  if (!["png", "mjpeg", "webp"].includes(String(stream.codec_name))) throw Error("unsupported-still-codec");
  if (origin !== 0) throw Error("still-image-origin-unverified");
  // The one decoded frame sits at source time 0; a clip window starting later has no frame of its own.
  if (sourceStart !== 0) throw Error("still-image-source-start-not-zero");
}

/**
 * One decision shared by extraction and validation. Video, and any still whose tags
 * pass the strict video admission (e.g. BT.709-tagged PNG), keep the unchanged strict
 * path. Only an image-kind image2 PNG/JPEG/WebP the strict path refuses may be admitted
 * as an sRGB display still, with its tagged/assumed provenance recorded.
 */
export type MaterialKeyframeDisplayPlanV1 =
  | { mode: "strict"; color: MediaColorMetadata; input: "rec709" | "hlg" | "pq" }
  | { mode: "still-srgb"; still: StillImageDisplayColorV1 };
export function materialKeyframeDisplayPlanV1(probe: { stream: Record<string, unknown>; format: Record<string, unknown> }, kind: string,
  authored?: MediaColorMetadata): MaterialKeyframeDisplayPlanV1 {
  const strict = () => { const color = sourceDisplayColorMetadata(probe.stream, authored); return { mode: "strict" as const, color, input: color.interpretation as "rec709" | "hlg" | "pq" }; };
  const stillContainer = kind === "image" && probe.format.format_name === "image2" && ["png", "mjpeg", "webp"].includes(String(probe.stream.codec_name));
  if (!stillContainer) return strict();
  try { return strict(); } catch { return { mode: "still-srgb", still: stillImageDisplayColorV1(probe.stream, authored) }; }
}

/** sRGB still → neutral sRGB JPEG: no transfer change, an explicit BT.601 decode for YCbCr, transparent pixels over black. */
export function materialStillKeyframeFilters(still: StillImageDisplayColorV1, width: number, height: number): string[] {
  const size = Math.min(1280, Math.max(width, height));
  const decode = still.encoding === "rgb" ? "" : `:in_range=${still.encoding === "yuv-bt601-full" ? "full" : "limited"}:in_color_matrix=bt601`;
  return [`scale=${size}:${size}:force_original_aspect_ratio=decrease${decode}`, "format=gbrap",
    "geq=r='r(X,Y)*alpha(X,Y)/255':g='g(X,Y)*alpha(X,Y)/255':b='b(X,Y)*alpha(X,Y)/255':a=255", "format=gbrp",
    "scale=in_range=full:out_range=full:out_color_matrix=bt601", "format=yuvj444p"];
}
export function materialStillKeyframeNormalizationV1(still: StillImageDisplayColorV1, width: number, height: number): MaterialKeyframeStillNormalizationV1 {
  return { interpretation: "srgb", colorInterpretation: still.colorInterpretation, sourceEncoding: still.encoding, alpha: "flattened-over-black",
    filters: materialStillKeyframeFilters(still, width, height), purpose: "neutral-display-proxy", transfer: "srgb", primaries: "bt709", range: "full",
    exposure: 0, creativeLook: false, maximumDimension: 1280 };
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
    const still = stillImageRequest(request), stillInput = still ? [...STILL_IMAGE_INPUT] : [];
    const probeResult = await runColorProcess(tools.ffprobe, ["-v", "error", ...stillInput, "-show_streams", "-show_format", "-of", "json", request.sourcePath], 131072, timeout, runtime.signal);
    const probe = JSON.parse(probeResult.stdout.toString("utf8"));
    const streams = Array.isArray(probe.streams) ? probe.streams.filter((s: Record<string, unknown>) => s.codec_type === "video") : [];
    if (streams.length !== 1) throw Error("single-video-stream-required");
    const stream = streams[0] as Record<string, unknown>, displayPlan = materialKeyframeDisplayPlanV1({ stream, format: probe.format ?? {} }, request.kind, request.color);
    const width = Number(stream.width), height = Number(stream.height), origin = Number(probe.format?.start_time ?? stream.start_time);
    if (!Number.isFinite(origin)) throw Error("source-timeline-origin-unverified");
    if (still) assertStillImageStream(stream, origin, request.sourceStart);
    if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768)) throw Error("invalid-source-dimensions");
    const filters = displayPlan.mode === "strict" ? materialKeyframeFilters(displayPlan.input, width, height, displayPlan.color) : materialStillKeyframeFilters(displayPlan.still, width, height);
    for (const sample of request.samples) {
      const remaining = deadline - Date.now(); if (remaining <= 0) throw Error("display-time-budget");
      const target = request.sourceStart + sample.time;
      const decode = still ? [...stillInput, "-i", request.sourcePath] : ["-copyts", "-ss", String(target), "-i", request.sourcePath];
      const result = await runColorProcess(tools.ffmpeg, ["-hide_banner", "-loglevel", "info", "-nostdin", ...decode,
        "-map", "0:v:0", "-an", "-vf", [...(still ? [] : [`select='gte(t,${origin + target})'`]), ...filters, "showinfo"].join(","), "-frames:v", "1", "-fps_mode", "passthrough",
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
        normalization: displayPlan.mode === "strict"
          ? { interpretation: displayPlan.input, filters, intermediateTransfer: "bt709", displayEotf: "bt1886-ideal", purpose: "neutral-display-proxy", transfer: "srgb", primaries: "bt709", range: "full", exposure: 0, creativeLook: false, maximumDimension: 1280 }
          : materialStillKeyframeNormalizationV1(displayPlan.still, width, height),
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
