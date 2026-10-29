import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAnalysisProcess } from "./analysisProcess";
import { verifyProductAutoRotoV2, type ProductAutoRotoAnalysisResultV2, type ProductAutoRotoRuntimeV2, type RotoV2FileIdentity } from "./autoRotoNativeProductV2";
import { ROTO_V2_MAX_OUTPUT_BYTES } from "./autoRotoV2Contract";
import { assertRotoV2IdentityUnchanged, assertRotoV2LocalPath, assertRotoV2Space, createRotoV2Workspace, rotoV2Deadline, rotoV2FileIdentity } from "./rotoV2Workspace";
import { ROTO_V2_MEDIA_INPUT_POLICY } from "./rotoV2Media";
import { rotoMatteIdentitySchemaV1, type RotoMatteIdentityV1 } from "./rotoMatteTrustV1";

export interface RotoCutoutClipResultV1 {
  schema: "editkin.roto-cutout-clip/v1"; qualityState: "diagnostic"; subjectConfirmation: "required"; benchmarkAccepted: false;
  manifestPath: string; clip: RotoV2FileIdentity; width: number; height: number; frameCount: number; fps: number; duration: number;
  alphaMode: "straight"; codec: "ffv1"; pixelFormat: "gbrap16le"; inputAlphaBits: 8 | 16; audio: "source-pcm24" | "none";
  sourcePath: string; sourceSha256: string; analysisSha256: string; alphaSha256: string; matteIdentity: RotoMatteIdentityV1;
}

/** Hash the actual decoded stream without accumulating frames in RAM or creating a second raw sequence. */
async function decodedIdentity(path: string, format: "rgb24" | "gray" | "gray16le", expectedBytes: number,
  runtime: ProductAutoRotoRuntimeV2, check: () => number) {
  const hash = createHash("sha256"); let bytes = 0;
  await runAnalysisProcess(runtime.ffmpegPath, ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", "-i", path,
    "-map", "0:v:0", "-an", ...(format === "rgb24" ? [] : ["-vf", "alphaextract"]), "-threads", "1", "-f", "rawvideo", "-pix_fmt", format, "pipe:1"],
  { timeoutMs: check(), signal: runtime.signal, maximumStdout: expectedBytes, maximumStderr: 65536, label: "ROTO_CUTOUT_DECODE_VERIFY",
    captureStdout: false, onStdout: data => { check(); bytes += data.length; hash.update(data); } });
  if (bytes !== expectedBytes) throw Error("ROTO_CUTOUT_DECODED_FRAME_COUNT"); return hash.digest("hex");
}

/** Calibratable pixel verifier. Expected digests must come from a verified analysis; this
 * reports conservation only and cannot create subject trust or benchmark acceptance. */
export async function verifyRotoCutoutPixelsV1(path: string, expected: { rgbBytes: number; rgbSha256: string; alphaBytes: number;
  alphaSha256: string; alphaFormat: "gray" | "gray16le" }, runtime: ProductAutoRotoRuntimeV2, check = rotoV2Deadline(runtime.signal, runtime.timeoutMs)) {
  await assertRotoV2LocalPath(path);
  if (![expected.rgbBytes, expected.alphaBytes].every(v => Number.isSafeInteger(v) && v > 0 && v <= 256 * 1024 ** 2)
    || ![expected.rgbSha256, expected.alphaSha256].every(v => /^[a-f0-9]{64}$/.test(v))
    || !["gray", "gray16le"].includes(expected.alphaFormat)) throw Error("ROTO_CUTOUT_EXPECTED_PIXELS_INVALID");
  const rgbSha256 = await decodedIdentity(path, "rgb24", expected.rgbBytes, runtime, check);
  const alphaSha256 = await decodedIdentity(path, expected.alphaFormat, expected.alphaBytes, runtime, check);
  if (rgbSha256 !== expected.rgbSha256 || alphaSha256 !== expected.alphaSha256) throw Error("ROTO_CUTOUT_LOSSLESS_RGB_OR_ALPHA_FAILED");
  return { rgbSha256, alphaSha256 };
}

/** New ordinary lossless straight-alpha media; full decoded RGB/alpha verified before commit. */
export async function bakeRotoCutoutClipV1(analysis: ProductAutoRotoAnalysisResultV2, outputPath: string, runtime: ProductAutoRotoRuntimeV2): Promise<RotoCutoutClipResultV1> {
  const check = rotoV2Deadline(runtime.signal, runtime.timeoutMs);
  await verifyProductAutoRotoV2(analysis, check);
  for (const [name, path] of [["ffmpeg", runtime.ffmpegPath], ["ffprobe", runtime.ffprobePath], ["nativeCore", runtime.nativeCorePath]] as const) {
    const actual = await rotoV2FileIdentity(path, check), expected = analysis.tools[name];
    if (actual.path !== expected.path || actual.sha256 !== expected.sha256) throw Error("ROTO_CUTOUT_RUNTIME_DIFFERENT_FROM_ANALYSIS");
  }
  const { media: m, native: n } = analysis;
  // An explicitly reduced diagnostic analysis is useful for review, not a full-resolution replacement.
  if (m.width !== m.sourceDisplayWidth || m.height !== m.sourceDisplayHeight) throw Error("ROTO_CUTOUT_FULL_DISPLAY_RESOLUTION_REQUIRED");
  const workspace = await createRotoV2Workspace(outputPath, ROTO_V2_MAX_OUTPUT_BYTES + 1024 ** 2, check);
  const output = join(workspace, "cutout.mkv"), rgb = analysis.artifacts.find(a => a.relativePath === n.straightRgbPath)!,
    alpha = analysis.artifacts.find(a => a.relativePath === n.alphaPath)!;
  const videoInput = (format: string, path: string) => ["-f", "rawvideo", "-pixel_format", format, "-video_size", `${m.width}x${m.height}`,
    "-framerate", String(m.fps), "-i", path];
  const duration = m.frameCount / m.fps;
  // Planar merge copies alpha16; no 8-bit alphamerge negotiation or RGB premultiplication.
  const filter = "[0:v]format=gbrp16le[c];[1:v]format=gray16le[a];[c][a]mergeplanes=0x00010210:format=gbrap16le[v]";
  await runAnalysisProcess(runtime.ffmpegPath, ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1",
    ...videoInput("rgb24", rgb.path), ...videoInput(n.alphaFormat, alpha.path),
    ...(m.hasAudio ? [...ROTO_V2_MEDIA_INPUT_POLICY, "-ss", String(analysis.request.sourceStart), "-t", String(duration), "-i", analysis.source.path] : []),
    "-filter_complex", filter, "-map", "[v]", ...(m.hasAudio ? ["-map", "2:a:0", "-af", `atrim=duration=${duration},asetpts=PTS-STARTPTS`, "-c:a", "pcm_s24le"] : ["-an"]),
    "-frames:v", String(m.frameCount), "-t", String(duration), "-c:v", "ffv1", "-level", "3", "-slicecrc", "1", "-pix_fmt", "gbrap16le",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "0", "-color_range", "pc", "-threads", "1", "-fs", String(ROTO_V2_MAX_OUTPUT_BYTES), "-n", output],
  { timeoutMs: check(), signal: runtime.signal, maximumStdout: 65536, maximumStderr: 131072, label: "ROTO_CUTOUT_FFV1_ENCODE" });
  const clip = await rotoV2FileIdentity(output, check); if (clip.bytes > ROTO_V2_MAX_OUTPUT_BYTES) throw Error("ROTO_CUTOUT_OUTPUT_BYTE_BUDGET");
  await assertRotoV2Space(workspace, 0);
  await verifyRotoCutoutPixelsV1(output, { rgbBytes: rgb.bytes, rgbSha256: rgb.sha256, alphaBytes: alpha.bytes, alphaSha256: alpha.sha256, alphaFormat: n.alphaFormat }, runtime, check);
  const probe = await runAnalysisProcess(runtime.ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height:format=duration", "-of", "json", output],
    { timeoutMs: Math.min(check(), 30000), signal: runtime.signal, maximumStdout: 65536, maximumStderr: 65536, label: "ROTO_CUTOUT_OUTPUT_PROBE" });
  const data = JSON.parse(probe.stdout.toString("utf8")) as { streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number }>; format?: { duration?: string } };
  const video = data.streams?.find(s => s.codec_type === "video"), audio = data.streams?.find(s => s.codec_type === "audio");
  if (!video || video.codec_name !== "ffv1" || video.pix_fmt !== "gbrap16le" || video.width !== m.width || video.height !== m.height
    || (m.hasAudio ? audio?.codec_name !== "pcm_s24le" : Boolean(audio)) || Math.abs(Number(data.format?.duration) - duration) > .002) throw Error("ROTO_CUTOUT_OUTPUT_PROBE_MISMATCH");
  await verifyProductAutoRotoV2(analysis, check); await assertRotoV2IdentityUnchanged(clip, check);
  const matteIdentity = rotoMatteIdentitySchemaV1.parse({ schema: "editkin.roto-matte-identity/v1", sourceSha256: analysis.source.sha256,
    cutoutSha256: clip.sha256, alphaSha256: alpha.sha256, analysisSha256: analysis.analysisSha256, nativeCoreSha256: analysis.tools.nativeCore.sha256,
    sourceStart: analysis.request.sourceStart, width: m.width, height: m.height, frameCount: m.frameCount, fps: m.fps, qualityState: "diagnostic" });
  const result: RotoCutoutClipResultV1 = { schema: "editkin.roto-cutout-clip/v1", qualityState: "diagnostic", subjectConfirmation: "required", benchmarkAccepted: false,
    manifestPath: join(workspace, "cutout-v1.json"), clip, width: m.width, height: m.height, frameCount: m.frameCount, fps: m.fps, duration,
    alphaMode: "straight", codec: "ffv1", pixelFormat: "gbrap16le", inputAlphaBits: n.edgeSettings.alpha16 ? 16 : 8,
    audio: m.hasAudio ? "source-pcm24" : "none", sourcePath: analysis.source.path, sourceSha256: analysis.source.sha256, analysisSha256: analysis.analysisSha256,
    alphaSha256: alpha.sha256, matteIdentity };
  check(); await writeFile(result.manifestPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }); return result;
}
