import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { EditProject, TimelineClip } from "../domain/types";
import {
  HIGH_BIT_DEPTH_ALPHA_PROFILE,
  type HighBitDepthAlphaCapabilityReceipt,
  type HighBitDepthAlphaDeliveryReceipt,
  type MediaProbe,
} from "./ffmpegContracts";
import { probeMedia, runProcess } from "./ffmpegMedia";

export {
  HIGH_BIT_DEPTH_ALPHA_PROFILE,
  type HighBitDepthAlphaCapabilityReceipt,
  type HighBitDepthAlphaDeliveryReceipt,
  type RenderDeliveryProfile,
} from "./ffmpegContracts";

export interface CompositePixelContract {
  rgba: "rgba" | "gbrap16le";
  rgb: "rgb24" | "gbrp16le";
  gray: "gray" | "gray16le";
  grayMaximum: 255 | 65535;
  encodedPixelFormat: "yuv420p" | "yuva444p10le";
}

export const HIGH_BIT_DEPTH_ALPHA_ENCODER_ARGS = [
  "-c:v", "prores_ks",
  "-profile:v", "4",
  "-alpha_bits", "16",
  "-vendor", "apl0",
] as const;

export function compositePixelContract(preserveHighBitDepthAlpha: boolean): CompositePixelContract {
  return preserveHighBitDepthAlpha
    ? { rgba: "gbrap16le", rgb: "gbrp16le", gray: "gray16le", grayMaximum: 65535, encodedPixelFormat: "yuva444p10le" }
    : { rgba: "rgba", rgb: "rgb24", gray: "gray", grayMaximum: 255, encodedPixelFormat: "yuv420p" };
}

export function highBitDepthAlphaEncoderArgs(): string[] {
  return [...HIGH_BIT_DEPTH_ALPHA_ENCODER_ARGS];
}

function clips(project: EditProject): TimelineClip[] {
  return project.tracks.flatMap((track) => track.clips);
}

/**
 * The first product slice intentionally covers the formal Rec.709 foreground path only.
 * Anything whose precision has not been measured on this path is rejected instead of being
 * silently flattened into an apparently professional master.
 */
export function assertHighBitDepthAlphaDeliveryProject(project: EditProject, outputPath?: string): void {
  if (outputPath && extname(outputPath).toLowerCase() !== ".mov") {
    throw new Error("ProRes 4444 Alpha 主檔必須輸出為 .mov，避免容器與 codec 標示不一致。");
  }
  if ((project.colorManagement?.mode ?? "rec709") !== "rec709") {
    throw new Error("ProRes 4444 Alpha 本輪只支援 Rec.709；ACES 2／HDR 請使用已驗證的 EXR 或顯示輸出流程。");
  }
  if (project.compositions.length > 0) {
    throw new Error("ProRes 4444 Alpha 本輪尚未驗證預合成遞迴精度；請先展開預合成。");
  }
  if (project.captions.length > 0 || project.motionGraphics.length > 0) {
    throw new Error("ProRes 4444 Alpha 本輪尚未驗證 libass 字幕／動態字卡的高位元透明合成；請先移除文字圖層。");
  }
  if (project.scene25d?.enabled || project.particleSimulation?.enabled) {
    throw new Error("ProRes 4444 Alpha 本輪尚未接通原生 2.5D／粒子 RGBA16 回傳；禁止退回 8-bit 假輸出。");
  }

  const timelineClips = clips(project);
  const unsupportedClip = timelineClips.find((clip) => {
    const creative = clip.creative;
    return (clip.layer?.role ?? "content") !== "content"
      || (clip.layer?.blendMode ?? "normal") !== "normal"
      || Boolean(clip.layer?.trackMatte)
      || Boolean(creative?.lookPresetId)
      || Boolean(creative?.effectPresetIds.length)
      || Boolean(creative?.nativeEffectInstances?.some((effect) => effect.enabled))
      || Boolean(creative?.transitionIn)
      || Boolean(creative?.transitionOut);
  });
  if (unsupportedClip) {
    throw new Error(`片段「${unsupportedClip.id}」含尚未量測的圖層混合、Track Matte、調整層或特效；ProRes 4444 Alpha 已安全阻擋。`);
  }

  const referenced = new Set(timelineClips.map((clip) => clip.assetId));
  for (const asset of project.assets.filter((candidate) => referenced.has(candidate.id) && candidate.kind !== "audio")) {
    const interpretation = asset.color?.interpretation ?? "auto";
    const transfer = asset.color?.transfer?.toLowerCase() ?? "";
    if (asset.imageSequence || asset.compositionId
      || !["auto", "rec709", "srgb"].includes(interpretation)
      || /(?:log|hlg|pq|smpte2084|arib-std-b67)/i.test(transfer)) {
      throw new Error(`素材「${asset.name}」不是本輪已驗證的 Rec.709 raster/video 輸入；高位元 Alpha 輸出已安全阻擋。`);
    }
  }
}

function assertProRes4444Probe(probe: MediaProbe): void {
  if (!probe.hasVideo || probe.codecName !== "prores" || probe.codecProfile !== "4444"
    || probe.pixelFormat !== "yuva444p12le" || probe.bitsPerRawSample !== 12) {
    throw new Error(`ProRes 4444 Alpha 能力不符合封閉契約：codec=${probe.codecName ?? "unknown"}, profile=${probe.codecProfile ?? "unknown"}, pix_fmt=${probe.pixelFormat ?? "unknown"}, bits=${probe.bitsPerRawSample ?? "unknown"}`);
  }
}

export function assertHighBitDepthAlphaOutputProbe(probe: MediaProbe): void {
  assertProRes4444Probe(probe);
  if (!probe.hasAudio || probe.audioCodecName !== "pcm_s24le") {
    throw new Error(`ProRes 4444 Alpha 主檔缺少 24-bit PCM 音軌：${probe.audioCodecName ?? "unknown"}`);
  }
}

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

function decodedAlphaLevelCount(bytes: Buffer): number {
  if (bytes.length !== 64 * 64 * 2) throw new Error(`Alpha capability probe byte 數錯誤：${bytes.length}`);
  const levels = new Set<number>();
  for (let offset = 0; offset < bytes.length; offset += 2) levels.add(bytes.readUInt16LE(offset));
  return levels.size;
}

/** Executes the exact encoder/pixel-format path. Merely listing an encoder is not sufficient. */
export async function probeHighBitDepthAlphaCapability(
  ffmpegPath: string,
  ffprobePath: string,
  timeoutMs: number,
): Promise<HighBitDepthAlphaCapabilityReceipt> {
  const workspace = await mkdtemp(join(tmpdir(), "editkin-alpha-capability-"));
  const artifact = join(workspace, "probe.mov");
  const decodedAlpha = join(workspace, "alpha.gray16le");
  try {
    await runProcess(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "nullsrc=s=64x64:r=1:d=1,format=gbrap16le,geq=r='65535':g='32768':b='8192':a='mod(X+Y*64,1024)*64'",
      "-frames:v", "1", "-vf", "format=yuva444p10le",
      ...highBitDepthAlphaEncoderArgs(), "-pix_fmt", "yuva444p10le", artifact,
    ], Math.min(timeoutMs, 30_000));
    const probe = await probeMedia(artifact, ffprobePath);
    assertProRes4444Probe(probe);
    await runProcess(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", artifact,
      "-frames:v", "1", "-vf", "alphaextract,format=gray16le", "-f", "rawvideo", decodedAlpha,
    ], Math.min(timeoutMs, 30_000));
    const decodedAlphaLevels = decodedAlphaLevelCount(await readFile(decodedAlpha));
    if (decodedAlphaLevels < 512) {
      throw new Error(`ProRes 4444 Alpha 實際解碼只保留 ${decodedAlphaLevels} 個 Alpha 階，未達高位元門檻。`);
    }
    const version = await runProcess(ffmpegPath, ["-version"], 10_000);
    return {
      schema: "editkin.high-bit-depth-alpha-capability/v1",
      status: "GREEN",
      encoder: "prores_ks",
      profile: "4444",
      requestedPixelFormat: "yuva444p10le",
      probedPixelFormat: "yuva444p12le",
      probedBitsPerRawSample: 12,
      configuredAlphaBits: 16,
      decodedAlphaLevels,
      effectiveMinimumAlphaBits: 10,
      probeArtifactSha256: await sha256File(artifact),
      ffmpegVersion: version.stdout.split(/\r?\n/)[0] ?? "unknown",
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function buildHighBitDepthAlphaDeliveryReceipt(
  outputPath: string,
  outputProbe: MediaProbe,
  capability: HighBitDepthAlphaCapabilityReceipt,
): Promise<HighBitDepthAlphaDeliveryReceipt> {
  assertHighBitDepthAlphaOutputProbe(outputProbe);
  const outputInfo = await stat(outputPath);
  return {
    schema: "editkin.high-bit-depth-alpha-delivery/v1",
    status: "GREEN",
    profile: HIGH_BIT_DEPTH_ALPHA_PROFILE,
    container: "mov",
    codec: "prores",
    codecProfile: "4444",
    workingPixelFormat: "gbrap16le",
    requestedEncoderPixelFormat: "yuva444p10le",
    probedOutputPixelFormat: "yuva444p12le",
    probedBitsPerRawSample: 12,
    configuredAlphaBits: 16,
    verifiedDecodedAlphaLevels: capability.decodedAlphaLevels,
    effectiveMinimumAlphaBits: 10,
    outputSha256: await sha256File(outputPath),
    outputBytes: outputInfo.size,
    capability,
    claimBoundary: "Measured for the bounded Rec.709 normal source-over path without precompositions, text, motion graphics, native effects, 2.5D, particles, adjustment layers, non-normal blend modes or track mattes. The formal compositor works in gbrap16le and the exact prores_ks path preserves at least 10 effective alpha bits in the runtime probe. This receipt does not claim scene-linear/HDR interchange, mathematically lossless RGB, 16 effective source alpha bits, or quality parity with external products.",
  };
}
