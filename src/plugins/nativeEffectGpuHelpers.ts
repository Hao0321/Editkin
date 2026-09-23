import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { EditProject, TimelineClip } from "../domain/types";
import type { NativeEffectRenderRuntime } from "./nativeEffectTypes";

export async function runProcess(executable: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${basename(executable)} 執行逾時`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-100_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-100_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${basename(executable)} exit ${code}: ${stderr.slice(-4_000)}`));
    });
  });
}

export async function rgba8ToRgba32f(inputPath: string, outputPath: string): Promise<void> {
  await pipeline(
    createReadStream(inputPath),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const output = Buffer.allocUnsafe(chunk.length * 4);
        for (let index = 0; index < chunk.length; index += 1) output.writeFloatLE(chunk[index] / 255, index * 4);
        callback(null, output);
      },
    }),
    createWriteStream(outputPath, { flags: "wx" }),
  );
}

export async function rgba32fToRgba8(inputPath: string, outputPath: string): Promise<void> {
  let remainder = Buffer.alloc(0);
  await pipeline(
    createReadStream(inputPath),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const input = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
        const complete = input.length - input.length % 4;
        const output = Buffer.allocUnsafe(complete / 4);
        for (let offset = 0; offset < complete; offset += 4) {
          const value = input.readFloatLE(offset);
          if (!Number.isFinite(value)) return callback(new Error("原生效果輸出包含非有限 RGBA32F"));
          output[offset / 4] = Math.round(Math.min(1, Math.max(0, value)) * 255);
        }
        remainder = Buffer.from(input.subarray(complete));
        callback(null, output);
      },
      flush(callback) {
        callback(remainder.length === 0 ? undefined : new Error("原生效果輸出不是完整 RGBA32F"));
      },
    }),
    createWriteStream(outputPath, { flags: "wx" }),
  );
}

export async function decodeClipToRgba8(
  clip: TimelineClip,
  assetPath: string,
  assetKind: "video" | "audio" | "image",
  project: EditProject,
  frameCount: number,
  outputPath: string,
  runtime: NativeEffectRenderRuntime,
): Promise<void> {
  const inputArgs = assetKind === "image"
    ? ["-loop", "1", "-i", assetPath]
    : ["-ss", String(clip.sourceStart), "-i", assetPath];
  await runProcess(runtime.ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin", ...inputArgs,
    "-an", "-sn", "-dn", "-vf",
    `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease,pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=${project.fps},format=rgba`,
    "-frames:v", String(frameCount), "-f", "rawvideo", "-pix_fmt", "rgba", outputPath,
  ], runtime.timeoutMs);
  const expected = project.width * project.height * 4 * frameCount;
  const actual = (await stat(outputPath)).size;
  if (actual !== expected) throw new Error(`原生效果 decode frame byte length ${actual} != ${expected}`);
}

export async function encodeRgba8Intermediate(
  inputPath: string,
  outputPath: string,
  project: EditProject,
  frameCount: number,
  runtime: NativeEffectRenderRuntime,
): Promise<void> {
  await runProcess(runtime.ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${project.width}x${project.height}`,
    "-framerate", String(project.fps), "-i", inputPath, "-frames:v", String(frameCount), "-an",
    "-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra", outputPath,
  ], runtime.timeoutMs);
}

export async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _encoding, callback) { digest.update(chunk); callback(); } }));
  return digest.digest("hex");
}

export interface GpuEffectSequenceResult {
  executableSha256: string;
  stackSha256: string;
  programs: Array<{
    nodeId: string;
    pluginIdentity: string;
    programSha256: string;
    shaderOpCount: number;
  }>;
  firstFrameSha256: string;
  lastFrameSha256: string;
  temporalSampling?: {
    contract: "decoded-temporal-shutter-accumulation/v1";
    sourceSampling: "decoded_temporal";
    framesWithReceipt: number;
    maximumDistinctDecodedTimestampCount: number;
    residentFrameRingSize: number;
    residentBytes: number;
    productPathCpuPixelCopies: 0;
  };
  composite?: {
    contract: "decoded-temporal-video-overlay/v1";
    layerCount: number;
    overlayClipIds: string[];
    timelineRanges: Array<{ clipId: string; timelineStartFrame: number; durationFrames: number; fullyMaterialized: boolean }>;
    framesWithReceipt: number;
    executionMode: "dirty-rect-ping-pong/v1" | "fused-four-layer/v1";
    productPathCpuPixelCopies: 0;
  };
  typography?: {
    contract: "decoded-temporal-typography-overlays/v1";
    captionCueIds: string[];
    motionGraphicIds: string[];
    captionTextureUploads: number;
    motionGraphicTextureUploads: number;
    framesWithActiveCaptions: number;
    framesWithActiveMotionGraphics: number;
    singleColourCaptions: true;
    productPathCpuPixelCopies: 0;
  };
  adjustment?: {
    contract: "decoded-temporal-trailing-adjustment/v1" | "decoded-temporal-pre-typography-adjustment/v1" | "decoded-temporal-pre-typography-multi-adjustment/v1";
    adjustmentClipIds: string[];
    nodeIdsByClip: Record<string, string[]>;
    timelineRanges: Array<{ clipId: string; timelineStartFrame: number; durationFrames: number }>;
    framesWithActiveAdjustments: number;
    totalAdjustmentPasses: number;
    minimumActiveAdjustmentCount: number;
    maximumActiveAdjustmentCount: number;
    executionMode: "trailing-full-frame/v1" | "pre-typography-full-frame/v1";
    baseLayerCount: number;
    minimumBaseLayerCount: number;
    maximumBaseLayerCount: number;
    productPathCpuPixelCopies: 0;
  };
  particle?: {
    contract: "decoded-temporal-particle-overlay/v1" | "decoded-temporal-multi-particle-overlay/v1";
    simulationContract: "screen_space_analytic_particles/v1";
    emitterNodeIds: string[];
    timelineRanges: Array<{ nodeId: string; timelineStartFrame: number; durationFrames: number }>;
    framesWithActiveParticles: number;
    totalParticleEmitterPasses: number;
    minimumActiveEmitterCount: number;
    maximumActiveEmitterCount: number;
    particleCeiling: number;
    maximumGpuTextureWrites: number;
    executionMode: "resident-analytic-overlay/v1";
    productPathCpuPixelCopies: 0;
  };
  matte?: {
    contract: "decoded-temporal-track-matte/v1";
    sourceClipId: string;
    targetClipIds: string[];
    sourceNodeId: string;
    targetNodeIds: Record<string, string>;
    mode: "alpha" | "alpha_inverted" | "luma" | "luma_inverted";
    framesWithActiveMatteTargets: number;
    executionMode: "sampled-track-matte/v1";
    productPathCpuPixelCopies: 0;
  };
}

export async function encodePngSequenceIntermediate(
  framePattern: string,
  outputPath: string,
  project: EditProject,
  frameCount: number,
  runtime: NativeEffectRenderRuntime,
): Promise<void> {
  await runProcess(runtime.ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-framerate", String(project.fps), "-start_number", "0", "-i", framePattern,
    "-frames:v", String(frameCount), "-an", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra", outputPath,
  ], runtime.timeoutMs);
}

export type GpuAdjustmentExecution = {
  clipId: string;
  adjustmentNodeId: string;
  timelineStartFrame: number;
  durationFrames: number;
  contract?: "decoded-temporal-trailing-adjustment/v1" | "decoded-temporal-pre-typography-adjustment/v1" | "decoded-temporal-pre-typography-multi-adjustment/v1";
  executionMode?: "trailing-full-frame/v1" | "pre-typography-full-frame/v1";
  baseLayerCount?: number;
  baseLayerCountByCompositeActivity?: boolean;
};

export type GpuParticleExecution = {
  nodeId: string;
  timelineStartFrame: number;
  durationFrames: number;
  particleCeiling: number;
  seed: number;
};

