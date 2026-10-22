import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { colorToolPaths, runColorProcess } from "../application/materialColorSamplingRuntime";
import type { MaterialColorRuntime } from "../application/materialColorSamplingTypes";
import { measureFinalPixelScopesV1, FINAL_PIXEL_SCOPE_LIMITS, type FinalPixelScopeMeasurement } from "../color/finalPixelScopesV1";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const finalOutputArtifactIdentityV1Schema = z.object({
  schema: z.literal("editkin.render-artifact-identity/v1"), outputSha256: digest,
  bytes: z.number().int().positive().max(64 * 1024 ** 3), fps: z.number().positive().max(240),
  durationFrames: z.number().int().positive().max(20_736_000), projectContentSha256: digest,
}).strict();
export const finalOutputScopesOptionsV1Schema = z.object({
  histogramBins: z.number().int().min(2).max(FINAL_PIXEL_SCOPE_LIMITS.histogramBins).optional(),
  waveformColumns: z.number().int().min(1).max(FINAL_PIXEL_SCOPE_LIMITS.waveformColumns).optional(),
  waveformLevels: z.number().int().min(2).max(FINAL_PIXEL_SCOPE_LIMITS.waveformLevels).optional(),
  vectorscopeBins: z.number().int().min(2).max(FINAL_PIXEL_SCOPE_LIMITS.vectorscopeBins).optional(),
}).strict();
export const finalOutputScopesRequestV1Schema = z.object({
  outputPath: z.string().min(1).max(4096).refine(isAbsolute, "Absolute output path required"),
  artifact: finalOutputArtifactIdentityV1Schema,
  timelineFrame: z.number().int().nonnegative().max(20_735_999),
  options: finalOutputScopesOptionsV1Schema.optional(),
}).strict().refine(value => value.timelineFrame < value.artifact.durationFrames, "Selected output frame outside artifact");
export type FinalOutputScopesRequestV1 = z.infer<typeof finalOutputScopesRequestV1Schema>;
interface FileDigest { sha256: string; bytes: number }
export interface FinalOutputScopesDependencies {
  hashFile(path: string, maximumBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<FileDigest>;
  run: typeof runColorProcess;
}
async function boundedFileDigest(path: string, maximumBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<FileDigest> {
  signal?.throwIfAborted();
  const before = await stat(path, { bigint: true });
  if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes)) throw Error("Scope file is not a bounded regular file");
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 }), hash = createHash("sha256");
  const abort = () => stream.destroy(Object.assign(new Error("Scope hashing cancelled"), { name: "AbortError" }));
  const timer = setTimeout(() => stream.destroy(new Error("Scope hashing deadline exceeded")), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  try {
    let bytes = 0;
    for await (const chunk of stream) { bytes += chunk.length; if (bytes > maximumBytes) throw Error("Scope hashing byte budget exceeded"); hash.update(chunk); }
    const after = await stat(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes !== Number(before.size)) throw Error("Scope file changed during hashing");
    signal?.throwIfAborted(); return { sha256: hash.digest("hex"), bytes };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); stream.destroy(); }
}
const productionDependencies: FinalOutputScopesDependencies = { hashFile: boundedFileDigest, run: runColorProcess };
const fail = (reason: string): never => { throw Error(`Final output scopes: ${reason}`); };
function rate(value: unknown): number {
  if (typeof value !== "string" || !/^\d+\/\d+$/.test(value)) return fail("output frame rate unavailable");
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0 || numerator / denominator > 240) return fail("output frame rate invalid");
  return numerator / denominator;
}
function probeOutput(raw: unknown, request: FinalOutputScopesRequestV1) {
  const rows = (raw as { streams?: Array<Record<string, unknown>> })?.streams;
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]) return fail("expected one probed video stream");
  const stream = rows[0], width = Number(stream.width), height = Number(stream.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > FINAL_PIXEL_SCOPE_LIMITS.dimension || height > FINAL_PIXEL_SCOPE_LIMITS.dimension || width * height > FINAL_PIXEL_SCOPE_LIMITS.pixels) return fail("output raster budget");
  if (stream.color_primaries !== "bt709" || stream.color_transfer !== "bt709" || stream.color_space !== "bt709"
    || !["tv", "pc"].includes(String(stream.color_range))) return fail("actual BT709 SDR output metadata required; HDR must first be rendered to SDR");
  if (stream.sample_aspect_ratio !== "1:1" || ![undefined, "unknown", "progressive"].includes(stream.field_order as string)) return fail("square progressive output required");
  if (Array.isArray(stream.side_data_list) && stream.side_data_list.some(row => typeof row === "object" && row && "rotation" in row && Number(row.rotation) !== 0)) return fail("rotated output unsupported");
  const actualRate = rate(stream.avg_frame_rate), nominalRate = rate(stream.r_frame_rate);
  if (Math.abs(actualRate - request.artifact.fps) > 1e-9 || Math.abs(actualRate - nominalRate) > 1e-9) return fail("output rate differs from expected artifact clock");
  if (stream.nb_frames !== undefined && stream.nb_frames !== "N/A" && Number(stream.nb_frames) !== request.artifact.durationFrames) return fail("output frame count differs from artifact");
  const start = typeof stream.start_time === "string" && stream.start_time.trim() ? Number(stream.start_time) : NaN;
  if (!Number.isFinite(start) || Math.abs(start) > 86400) return fail("output timeline origin unavailable");
  return { width, height, timelineOrigin: start, fps: actualRate, inputRange: stream.color_range === "tv" ? "limited" : "full", stream };
}
export interface MeasuredFinalOutputScopesV1 {
  measurement: FinalPixelScopeMeasurement;
  receipt: {
    schema: "editkin.decoded-output-scopes/v1"; origin: "decoded-encoded-output";
    artifact: FinalOutputScopesRequestV1["artifact"]; timelineFrame: number;
    timelineSeconds: number; decodedPts: number; timeBase: { numerator: number; denominator: number };
    decodedOutputTime: number; rgbSha256: string; rawFormat: "rgba64le";
    ffmpegSha256: string; ffprobeSha256: string; sourceMetadata: Record<string, unknown>; filters: string[];
    identityChecks: "pre-post-output-and-tools"; claimBoundary: "expected-artifact-bytes-and-selected-output-frame-only";
  };
}
/** Read-only instrument. Expected artifact identity is caller input, not a render authorisation/seal. */
export async function measureFinalOutputScopesV1(input: FinalOutputScopesRequestV1, runtime: MaterialColorRuntime,
  dependencies: FinalOutputScopesDependencies = productionDependencies): Promise<MeasuredFinalOutputScopesV1> {
  const request = finalOutputScopesRequestV1Schema.parse(input), tools = colorToolPaths(runtime);
  const started = performance.now(), budget = runtime.timeoutMs ?? 30000;
  if (!Number.isFinite(budget) || budget < 1 || budget > 30000) fail("total deadline must be 1..30000ms");
  const remaining = () => { runtime.signal?.throwIfAborted(); const left = budget - (performance.now() - started); if (left <= 0) return fail("total deadline exceeded"); return Math.max(1, Math.floor(left)); };
  const outputBefore = await dependencies.hashFile(request.outputPath, request.artifact.bytes, remaining(), runtime.signal);
  if (outputBefore.bytes !== request.artifact.bytes || outputBefore.sha256 !== request.artifact.outputSha256) fail("output bytes do not match expected artifact");
  const ffmpegBefore = await dependencies.hashFile(tools.ffmpeg, 512 * 1024 ** 2, remaining(), runtime.signal);
  const ffprobeBefore = await dependencies.hashFile(tools.ffprobe, 512 * 1024 ** 2, remaining(), runtime.signal);
  const probe = await dependencies.run(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,start_time,color_primaries,color_transfer,color_space,color_range,pix_fmt,bits_per_raw_sample,sample_aspect_ratio,field_order:stream_side_data=rotation",
    "-of", "json", request.outputPath], 131072, remaining(), runtime.signal);
  const actual = probeOutput(JSON.parse(probe.stdout.toString("utf8")), request), seconds = request.timelineFrame / actual.fps;
  const filters = [`select='gte(t,${actual.timelineOrigin + seconds - 1e-7})'`,
    `scale=in_range=${actual.inputRange}:out_range=full:in_color_matrix=bt709`, "format=rgba64le", "showinfo"];
  const decoded = await dependencies.run(tools.ffmpeg, ["-hide_banner", "-loglevel", "info", "-nostdin", "-copyts", "-ss", String(seconds), "-noautorotate", "-i", request.outputPath,
    "-map", "0:v:0", "-an", "-vf", filters.join(","), "-frames:v", "1", "-fps_mode", "passthrough", "-pix_fmt", "rgba64le", "-f", "rawvideo", "pipe:1"],
  actual.width * actual.height * 8, remaining(), runtime.signal);
  const tb = decoded.stderr.match(/config in time_base:\s*(\d+)\/(\d+)/), stamp = decoded.stderr.match(/n:\s*0\s+pts:\s*(-?\d+)\s+pts_time:[^\s]+[^\r\n]*\bs:(\d+)x(\d+)/);
  if (!tb || !stamp) fail("decoded output timestamp unavailable");
  const numerator = Number(tb![1]), denominator = Number(tb![2]), pts = Number(stamp![1]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0 || !Number.isSafeInteger(pts)) fail("decoded output time base invalid");
  const decodedTime = pts * numerator / denominator - actual.timelineOrigin;
  if (!Number.isFinite(decodedTime) || Math.abs(decodedTime - seconds) > 1e-7 || Number(stamp![2]) !== actual.width || Number(stamp![3]) !== actual.height || decoded.stdout.length !== actual.width * actual.height * 8) fail("decoded output frame does not match artifact clock/raster");
  const measurement = measureFinalPixelScopesV1({ width: actual.width, height: actual.height, format: "rgba16le", pixels: decoded.stdout, primaries: "bt709", transfer: "bt709", range: "full" }, request.options);
  remaining();
  const outputAfter = await dependencies.hashFile(request.outputPath, request.artifact.bytes, remaining(), runtime.signal);
  const ffmpegAfter = await dependencies.hashFile(tools.ffmpeg, 512 * 1024 ** 2, remaining(), runtime.signal);
  const ffprobeAfter = await dependencies.hashFile(tools.ffprobe, 512 * 1024 ** 2, remaining(), runtime.signal);
  if (outputAfter.sha256 !== outputBefore.sha256 || outputAfter.bytes !== outputBefore.bytes || ffmpegAfter.sha256 !== ffmpegBefore.sha256 || ffprobeAfter.sha256 !== ffprobeBefore.sha256) fail("output or decoder identity changed during measurement");
  remaining();
  return { measurement, receipt: { schema: "editkin.decoded-output-scopes/v1", origin: "decoded-encoded-output", artifact: request.artifact,
    timelineFrame: request.timelineFrame, timelineSeconds: seconds, decodedPts: pts, timeBase: { numerator, denominator }, decodedOutputTime: decodedTime,
    rgbSha256: createHash("sha256").update(decoded.stdout).digest("hex"), rawFormat: "rgba64le", ffmpegSha256: ffmpegBefore.sha256, ffprobeSha256: ffprobeBefore.sha256,
    sourceMetadata: actual.stream, filters, identityChecks: "pre-post-output-and-tools", claimBoundary: "expected-artifact-bytes-and-selected-output-frame-only" } };
}
