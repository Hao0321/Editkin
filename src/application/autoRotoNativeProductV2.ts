import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAnalysisProcess } from "./analysisProcess";
import { parseNativeAutoRotoV2, parseRotoV2Request, ROTO_V2_MAX_OUTPUT_BYTES, type AnalyzeProductAutoRotoRequestV2,
  type NativeAutoRotoReceiptV2 } from "./autoRotoV2Contract";
import { planRotoV2Media, ROTO_V2_MEDIA_INPUT_POLICY, type RotoV2MediaPlan } from "./rotoV2Media";
import { assertRotoV2IdentityUnchanged, assertRotoV2LocalPath, assertRotoV2Space, createRotoV2Workspace,
  measureRotoV2Tree, rotoV2Deadline, rotoV2FileIdentity } from "./rotoV2Workspace";
import { readBoundedFile } from "../shared/boundedFile";

export interface ProductAutoRotoRuntimeV2 {
  ffmpegPath: string; ffprobePath: string; nativeCorePath: string; signal?: AbortSignal; timeoutMs?: number;
  onProgress?: (progress: { stage: "probe" | "decode" | "analyze" | "verify"; completed: number; total: number }) => void;
}
export interface RotoV2FileIdentity { path: string; bytes: number; sha256: string }
export interface RotoV2MeasuredArtifact extends RotoV2FileIdentity { relativePath: string }
export interface ProductAutoRotoAnalysisResultV2 {
  schema: "editkin.auto-roto-analysis/v2"; contractVersion: "roto-v2-runtime/1"; qualityState: "diagnostic"; status: "complete"; manifestPath: string; workspace: string;
  request: AnalyzeProductAutoRotoRequestV2; media: RotoV2MediaPlan; source: RotoV2FileIdentity;
  tools: { ffmpeg: RotoV2FileIdentity; ffprobe: RotoV2FileIdentity; nativeCore: RotoV2FileIdentity };
  native: NativeAutoRotoReceiptV2; nativeRoot: string; artifacts: RotoV2MeasuredArtifact[]; analysisSha256: string;
}
export const rotoV2AnalysisDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function measureArtifacts(root: string, receipt: NativeAutoRotoReceiptV2, check: () => number) {
  const paths = [receipt.alphaPath, receipt.straightRgbPath, ...receipt.frames.map(f => f.alphaPath)];
  const artifacts: RotoV2MeasuredArtifact[] = [];
  for (const name of paths) {
    const file = await rotoV2FileIdentity(join(root, name), check);
    const expected = name === receipt.alphaPath ? receipt.alphaBytes : name === receipt.straightRgbPath ? receipt.straightRgbBytes : undefined;
    if (expected !== undefined && file.bytes !== expected) throw Error("ROTO_V2_ARTIFACT_BYTE_COUNT");
    if (expected === undefined) {
      if (file.bytes > receipt.width * receipt.height * 3 + 65536 || file.bytes < 33) throw Error("ROTO_V2_PREVIEW_BYTE_BUDGET");
      const handle = await open(file.path, "r"); const header = Buffer.alloc(29);
      try { if ((await handle.read(header, 0, 29, 0)).bytesRead !== 29) throw Error("ROTO_V2_PNG_HEADER"); } finally { await handle.close(); }
      if (header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || header.subarray(12, 16).toString("ascii") !== "IHDR"
        || header.readUInt32BE(16) !== receipt.width || header.readUInt32BE(20) !== receipt.height
        || header[24] !== (receipt.edgeSettings.alpha16 ? 16 : 8) || header[25] !== 0 || header[28] !== 0) throw Error("ROTO_V2_PREVIEW_GEOMETRY_OR_PRECISION");
    }
    artifacts.push({ ...file, relativePath: name });
  }
  return artifacts;
}

export async function analyzeProductAutoRotoV2(input: unknown, outputPath: string, runtime: ProductAutoRotoRuntimeV2): Promise<ProductAutoRotoAnalysisResultV2> {
  const request = parseRotoV2Request(input), check = rotoV2Deadline(runtime.signal, runtime.timeoutMs);
  runtime.onProgress?.({ stage: "probe", completed: 0, total: 1 });
  const [source, ffmpeg, ffprobe, nativeCore] = await Promise.all([request.sourcePath, runtime.ffmpegPath, runtime.ffprobePath, runtime.nativeCorePath]
    .map(p => rotoV2FileIdentity(p, check)));
  request.sourcePath = source.path;
  if (request.sourceSha256 !== undefined && request.sourceSha256 !== source.sha256) throw Error("ROTO_V2_CLAIMED_SOURCE_SHA_MISMATCH");
  const probe = await runAnalysisProcess(ffprobe.path, ["-v", "error", ...ROTO_V2_MEDIA_INPUT_POLICY, "-show_entries",
    "format=duration:stream=index,codec_type,width,height,sample_aspect_ratio,color_transfer,color_primaries,pix_fmt:stream_disposition=attached_pic:stream_side_data=side_data_type,rotation:stream_tags=rotate", "-of", "json", source.path],
  { timeoutMs: Math.min(check(), 30000), signal: runtime.signal, maximumStdout: 1024 * 1024, maximumStderr: 65536, label: "ROTO_V2_PROBE" });
  const media = planRotoV2Media(JSON.parse(probe.stdout.toString("utf8")), request);
  // Native coarse input is bounded but still held in RAM. Never silently lower the requested raster/fps.
  const workspace = await createRotoV2Workspace(outputPath, ROTO_V2_MAX_OUTPUT_BYTES + media.rawBytes + 8 * 1024 ** 2, check);
  const rawPath = join(workspace, "frames.rgb24"); runtime.onProgress?.({ stage: "decode", completed: 0, total: media.frameCount });
  await runAnalysisProcess(ffmpeg.path, ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", ...ROTO_V2_MEDIA_INPUT_POLICY,
    "-ss", String(request.sourceStart), "-t", String(request.duration), "-i", source.path, "-map", `0:${media.videoStreamIndex}`, "-an", "-sn", "-dn",
    "-vf", media.filter, "-frames:v", String(media.frameCount), "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-n", rawPath],
  { timeoutMs: check(), signal: runtime.signal, maximumStdout: 65536, maximumStderr: 131072, label: "ROTO_V2_DECODE" });
  const raw = await rotoV2FileIdentity(rawPath, check); if (raw.bytes !== media.rawBytes) throw Error("ROTO_V2_DECODE_GRID_INCOMPLETE");
  await assertRotoV2IdentityUnchanged(source, check); await assertRotoV2Space(workspace, ROTO_V2_MAX_OUTPUT_BYTES);
  const nativeRoot = join(workspace, "native"), nativeRequest = join(workspace, "native-request.json");
  await writeFile(nativeRequest, JSON.stringify({ rawPath, outputDir: nativeRoot, width: media.width, height: media.height,
    frameCount: media.frameCount, analysisFps: media.fps, initialFrame: media.initialFrame, initialRect: request.initialRect,
    temporalStability: request.temporalStability, feather: request.feather, edgeShift: request.edgeShift, contrast: request.contrast,
    corrections: request.corrections, regionMemoryPolicy: "guarded_experimental", edgeRefine: request.edgeSettings }), { flag: "wx" });
  let pending = "", completed = 0;
  runtime.onProgress?.({ stage: "analyze", completed, total: media.frameCount });
  const execution = await runAnalysisProcess(nativeCore.path, ["auto-roto", nativeRequest], { timeoutMs: check(), signal: runtime.signal,
    maximumStdout: 4 * 1024 ** 2, maximumStderr: 131072, label: "ROTO_V2_NATIVE", onStderr: chunk => {
      pending += chunk; const lines = pending.split(/\r?\n/); pending = (lines.pop() ?? "").slice(-1024);
      for (const line of lines) {
        const match = /^ROTO_V2_PROGRESS (\d+)\/(\d+)$/.exec(line);
        if (match && Number(match[2]) === media.frameCount && Number(match[1]) > completed && Number(match[1]) <= media.frameCount) {
          completed = Number(match[1]); runtime.onProgress?.({ stage: "analyze", completed, total: media.frameCount });
        }
      }
    } });
  const expected = { ...media, rawSha256: raw.sha256 };
  const native = parseNativeAutoRotoV2(JSON.parse(execution.stdout.toString("utf8")), expected);
  const committed = parseNativeAutoRotoV2(JSON.parse((await readBoundedFile(join(nativeRoot, "matte-v2-manifest.json"), 4 * 1024 ** 2)).toString("utf8")), expected);
  if (JSON.stringify(native) !== JSON.stringify(committed) || JSON.stringify(native.edgeSettings) !== JSON.stringify(request.edgeSettings)) throw Error("ROTO_V2_NATIVE_MANIFEST_OR_SETTINGS_DIFFER");
  runtime.onProgress?.({ stage: "verify", completed: 0, total: native.frameCount });
  const artifacts = await measureArtifacts(nativeRoot, native, check);
  await measureRotoV2Tree(workspace, ROTO_V2_MAX_OUTPUT_BYTES + media.rawBytes + 8 * 1024 ** 2, check);
  for (const file of [source, raw, ffmpeg, ffprobe, nativeCore]) await assertRotoV2IdentityUnchanged(file, check);
  check(); const body = { schema: "editkin.auto-roto-analysis/v2" as const, contractVersion: "roto-v2-runtime/1" as const, qualityState: "diagnostic" as const, status: "complete" as const,
    request, media, source, tools: { ffmpeg, ffprobe, nativeCore }, native, nativeRoot, artifacts, workspace };
  const manifestPath = join(workspace, "analysis-v2.json"), result = { ...body, manifestPath, analysisSha256: rotoV2AnalysisDigest(body) };
  await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  runtime.onProgress?.({ stage: "verify", completed: native.frameCount, total: native.frameCount }); return result;
}

/** Re-admit a local result before any bake/trust action; JSON/paths/hashes never grant human quality approval. */
export async function verifyProductAutoRotoV2(result: ProductAutoRotoAnalysisResultV2, check: () => number) {
  const keys = ["schema", "contractVersion", "qualityState", "status", "manifestPath", "workspace", "request", "media", "source", "tools", "native", "nativeRoot", "artifacts", "analysisSha256"];
  if (!result || typeof result !== "object" || Object.keys(result).length !== keys.length || Object.keys(result).some(k => !keys.includes(k))
    || result.schema !== "editkin.auto-roto-analysis/v2" || result.contractVersion !== "roto-v2-runtime/1" || result.qualityState !== "diagnostic" || result.status !== "complete") throw Error("ROTO_V2_ANALYSIS_SHAPE");
  check(); await assertRotoV2LocalPath(result.workspace); await assertRotoV2LocalPath(result.nativeRoot);
  if (result.nativeRoot !== join(result.workspace, "native") || result.manifestPath !== join(result.workspace, "analysis-v2.json")) throw Error("ROTO_V2_MANIFEST_PATH");
  const { manifestPath: _manifest, analysisSha256, ...body } = result;
  if (analysisSha256 !== rotoV2AnalysisDigest(body)) throw Error("ROTO_V2_ANALYSIS_DIGEST");
  const persisted = JSON.parse((await readBoundedFile(result.manifestPath, 8 * 1024 ** 2)).toString("utf8"));
  if (JSON.stringify(persisted) !== JSON.stringify(result)) throw Error("ROTO_V2_ANALYSIS_MANIFEST_CHANGED");
  const request = parseRotoV2Request(result.request);
  parseNativeAutoRotoV2(result.native, { ...result.media, rawSha256: result.native.sourceRawSha256 });
  if (result.media.frameCount !== Math.floor(request.duration * request.fps + 1e-8) || result.media.fps !== request.fps
    || result.source.path !== request.sourcePath || result.media.rawBytes !== result.native.straightRgbBytes || typeof result.media.hasAudio !== "boolean"
    || result.media.filter !== `fps=${request.fps},scale=${result.native.width}:${result.native.height}:flags=bilinear,format=rgb24`
    || ![result.media.sourceDisplayWidth, result.media.sourceDisplayHeight].every(v => Number.isFinite(v) && v >= 16 && v <= 2097152)) throw Error("ROTO_V2_REQUEST_GRID_CHANGED");
  const actual = await measureArtifacts(result.nativeRoot, result.native, check);
  if (JSON.stringify(actual) !== JSON.stringify(result.artifacts) || JSON.stringify(result.native.edgeSettings) !== JSON.stringify(request.edgeSettings)) throw Error("ROTO_V2_ARTIFACT_CHANGED");
  await assertRotoV2IdentityUnchanged(result.source, check); for (const tool of Object.values(result.tools)) await assertRotoV2IdentityUnchanged(tool, check);
  check(); return result;
}
