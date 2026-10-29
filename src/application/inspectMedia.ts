import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { probeMedia } from "../render/mediaProcess";
import type { MediaProbe } from "../render/ffmpegContracts";
import { withIndependentRenderLifetime, withRenderLifetime, renderLifetimeSignal } from "../render/renderLifetime";
import { mediaProbeForDisplay } from "../render/mediaDisplayGeometry";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { readMaterialHeader8 } from "./materialEvidenceCache";

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  const stream = createReadStream(path, { signal });
  const closed = new Promise<void>(done => stream.once("close", () => done()));
  try {
    for await (const chunk of stream) { signal?.throwIfAborted(); hash.update(chunk); }
    signal?.throwIfAborted();
    return hash.digest("hex");
  } finally { stream.destroy(); await closed; signal?.throwIfAborted(); }
}

async function inspectOpenExrSequence(path: string, signal?: AbortSignal): Promise<MediaProbe> {
  signal?.throwIfAborted();
  const bytes = await readFile(path, { signal });
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const timebase = value.timebase as { numerator?: unknown; denominator?: unknown } | undefined;
  const frameCount = Number(value.frameCount);
  const startFrame = Number(value.startFrame);
  const lastFrame = Number(value.lastFrame);
  const width = Number(value.width);
  const height = Number(value.height);
  const numerator = Number(timebase?.numerator);
  const denominator = Number(timebase?.denominator);
  if (value.schema !== "editkin.openexr-sequence/v1" || value.status !== "GREEN"
    || value.workingColorSpace !== "linear_rec709" || value.artifactFormat !== "rgba32_float" || value.artifactContainer !== "openexr"
    || value.alphaMode !== "straight" || value.filePattern !== "frame-%08d.exr" || value.previewFile !== "preview.png"
    || !Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 1_000_000
    || !Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(lastFrame) || lastFrame !== startFrame + frameCount - 1
    || !Number.isSafeInteger(width) || width < 1 || width > 8_192 || !Number.isSafeInteger(height) || height < 1 || height > 8_192
    || !Number.isSafeInteger(numerator) || numerator < 1 || !Number.isSafeInteger(denominator) || denominator < 1
    || typeof value.sequenceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sequenceSha256)
    || typeof value.firstFrameSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.firstFrameSha256)
    || typeof value.lastFrameSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.lastFrameSha256)) {
    throw new Error("OpenEXR 影格序列 manifest 格式或色彩契約不合法");
  }
  const root = dirname(path);
  const frameName = (frame: number) => `frame-${String(frame).padStart(8, "0")}.exr`;
  const firstPath = join(root, frameName(startFrame));
  const lastPath = join(root, frameName(lastFrame));
  const previewPath = join(root, "preview.png");
  const entries = await readdir(root);
  signal?.throwIfAborted();
  const frames = entries.filter((name) => /^frame-\d{8,}\.exr$/i.test(name));
  if (frames.length !== frameCount || !frames.includes(frameName(startFrame)) || !frames.includes(frameName(lastFrame))) {
    throw new Error(`OpenEXR 影格序列不完整：預期 ${frameCount} 格，實際 ${frames.length} 格`);
  }
  const reads = [readMaterialHeader8(firstPath, signal), readMaterialHeader8(lastPath, signal), readMaterialHeader8(previewPath, signal),
    sha256File(firstPath, signal), sha256File(lastPath, signal)] as const;
  const drained = Promise.allSettled(reads);
  let values;
  try { values = await Promise.all(reads); }
  catch (error) { await drained; throw error; }
  const [firstBytes, lastBytes, previewBytes, firstSha256, lastSha256] = values;
  signal?.throwIfAborted();
  if (firstBytes.subarray(0, 4).toString("hex") !== "762f3101" || lastBytes.subarray(0, 4).toString("hex") !== "762f3101"
    || previewBytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || firstSha256 !== String(value.firstFrameSha256).toLowerCase() || lastSha256 !== String(value.lastFrameSha256).toLowerCase()) {
    throw new Error("OpenEXR 影格序列首尾影格或預覽完整性驗證失敗");
  }
  return {
    duration: frameCount * numerator / denominator,
    width, height, hasVideo: true, hasAudio: false,
    colorPrimaries: "bt709", colorTransfer: "linear", colorMatrix: "rgb", colorRange: "full",
    previewPath,
    imageSequence: {
      schema: "editkin.openexr-sequence/v1", format: "openexr", frameCount, startFrame, lastFrame,
      timebase: { numerator, denominator }, sequenceSha256: String(value.sequenceSha256).toLowerCase(),
      manifestSha256: createHash("sha256").update(bytes).digest("hex"), previewUri: previewPath,
    },
  };
}

export async function inspectMedia(path: string, ffprobePath?: string, inputOptions: readonly string[] = [], options: { signal?: AbortSignal; shared?: boolean } = {}): Promise<MediaProbe> {
  assertLocalMediaPath(path);
  options.signal?.throwIfAborted();
  if (options.shared && !options.signal) throw new Error("SHARED_MEDIA_INSPECTION_REQUIRES_SIGNAL");
  const inspect = async () => {
    const signal = options.shared ? renderLifetimeSignal() : options.signal;
    signal?.throwIfAborted();
    const result = extname(path).toLowerCase() === ".json"
      ? await inspectOpenExrSequence(path, signal)
      : mediaProbeForDisplay(await probeMedia(path, ffprobePath, inputOptions));
    signal?.throwIfAborted();
    return result;
  };
  return options.shared
    ? withIndependentRenderLifetime({ signal: options.signal!, timeoutMs: 30_000 }, inspect)
    : options.signal ? withRenderLifetime({ signal: options.signal }, inspect) : inspect();
}
