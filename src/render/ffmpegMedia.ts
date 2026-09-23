import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EditProject } from "../domain/types";
import type { RenderPlan } from "./planner";
import { finite } from "./ffmpegExpressions";
import type { NativeFinalAudioReceipt, RenderOptions } from "./ffmpegTypes";
import { probeMedia, runProcess } from "./mediaProcess";
export { probeMedia, runProcess, resolveMediaPath } from "./mediaProcess";

export function masterAudioFilter(inputLabel: string, duration: number): string {
  // The true-peak target leaves headroom for AAC/platform transcoding while
  // retaining the long spin-down dynamics instead of crushing every impact.
  return `${inputLabel}loudnorm=I=-18:LRA=11:TP=-3,atrim=duration=${finite(duration)}[aout]`;
}

export interface PreparedNativeFinalAudio {
  outputPath: string;
  receipt: NativeFinalAudioReceipt;
}

export interface NativeFinalAudioEligibility {
  alphaIntermediate: boolean;
  nativeCoreReady: boolean;
  durationSeconds: number;
  decodableAudioSourceCount: number;
}

export function shouldUseNativeFinalAudio(input: NativeFinalAudioEligibility): boolean {
  return !input.alphaIntermediate
    && input.nativeCoreReady
    && Number.isFinite(input.durationSeconds)
    && input.durationSeconds > 0
    && input.durationSeconds <= 30
    && Number.isInteger(input.decodableAudioSourceCount)
    && input.decodableAudioSourceCount > 0
    && input.decodableAudioSourceCount <= 8;
}

export async function countDecodableNativeAudioSources(plan: RenderPlan, ffprobePath: string): Promise<number> {
  const sourceMultiplicity = new Map<string, number>();
  for (const item of plan.audioClips) {
    sourceMultiplicity.set(item.assetPath, (sourceMultiplicity.get(item.assetPath) ?? 0) + 1);
  }
  let count = 0;
  for (const [path, multiplicity] of sourceMultiplicity) {
    if ((await probeMedia(path, ffprobePath)).hasAudio) count += multiplicity;
    if (count > 8) return count;
  }
  return count;
}

interface NativeAudioMixCommandReceipt {
  schema?: string;
  status?: string;
  manifestSha256?: string;
  decoderExecutor?: string;
  mixExecutor?: string;
  nativeGraphExecution?: boolean;
  sourceCount?: number;
  voiceClipCount?: number;
  musicClipCount?: number;
  signal?: { outputSha256?: string; outputBytes?: number; postLimitPeak?: number; limiterCeilingDb?: number };
}

export async function prepareNativeFinalAudio(
  project: EditProject,
  plan: RenderPlan,
  workspace: string,
  options: Required<Pick<RenderOptions, "ffmpegPath" | "ffprobePath" | "nativeCorePath" | "timeoutMs">> & Pick<RenderOptions, "assetBase">,
): Promise<PreparedNativeFinalAudio> {
  const { stageNativeAudioPreview } = await import("../application/nativeAudioPreview");
  const stage = await stageNativeAudioPreview(project, {
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    cacheRoot: join(workspace, "native-final-audio"),
    assetBase: options.assetBase,
    timelineStartSeconds: 0,
    maxDurationSeconds: plan.duration,
    timeoutMs: Math.min(options.timeoutMs, 120_000),
  });
  const outputPath = join(stage.sessionRoot, "native-final-mix.f32le");
  const command = await runProcess(options.nativeCorePath, ["audio-preview-mix", stage.manifestPath, outputPath], Math.min(options.timeoutMs, 120_000));
  const mix = JSON.parse(command.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as NativeAudioMixCommandReceipt;
  const outputBytes = await readFile(outputPath);
  const outputSha256 = createHash("sha256").update(outputBytes).digest("hex");
  const outputInfo = await stat(outputPath);
  if (mix.schema !== "editkin.native-audio-preview-mix-receipt/v1" || mix.status !== "GREEN"
    || mix.decoderExecutor !== "ffmpeg-source-decode/v1" || mix.mixExecutor !== "hao-core-native-dag/v1"
    || mix.nativeGraphExecution !== true || mix.manifestSha256 !== stage.manifestSha256
    || mix.sourceCount !== stage.clipCount || mix.voiceClipCount !== stage.voiceClipCount
    || mix.musicClipCount !== stage.musicClipCount || mix.signal?.outputSha256 !== outputSha256
    || mix.signal.outputBytes !== outputInfo.size || !Number.isFinite(mix.signal.postLimitPeak)
    || mix.signal.postLimitPeak! > 10 ** (-3 / 20) + 1e-6 || mix.signal.limiterCeilingDb !== -3) {
    throw new Error("原生最終音訊 receipt、manifest 或 PCM identity 不一致");
  }
  const bindingSha256 = createHash("sha256").update([
    "editkin.native-final-audio/v1",
    stage.manifestSha256,
    outputSha256,
    String(outputInfo.size),
    String(stage.durationSeconds),
    String(stage.clipCount),
    String(stage.voiceClipCount),
    String(stage.musicClipCount),
  ].join("\0")).digest("hex");
  return {
    outputPath,
    receipt: {
      schema: "editkin.native-final-audio/v1",
      status: "GREEN",
      stageSchema: stage.schema,
      mixSchema: "editkin.native-audio-preview-mix-receipt/v1",
      decoderExecutor: "ffmpeg-source-decode/v1",
      mixExecutor: "hao-core-native-dag/v1",
      nativeGraphExecution: true,
      manifestSha256: stage.manifestSha256,
      outputSha256,
      bindingSha256,
      outputBytes: outputInfo.size,
      durationSeconds: stage.durationSeconds,
      sourceCount: stage.clipCount,
      voiceClipCount: stage.voiceClipCount,
      musicClipCount: stage.musicClipCount,
      postLimitPeak: mix.signal.postLimitPeak!,
      limiterCeilingDb: mix.signal.limiterCeilingDb!,
      claimBoundary: "For bounded non-scene-linear exports up to 30 seconds and eight decodable timeline sources, FFmpeg independently decodes source PCM and performs final AAC/video packaging; hao-core executes placement, gain/fade automation, voice/music buses, ducking, limiting and output summing before the encoded artifact. Wider or longer exports are not covered by this receipt.",
    },
  };
}
