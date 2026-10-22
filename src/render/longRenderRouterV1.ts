// LONG-render router (design C1/C3/C5, LONG only): staging/floating refusals before any work, route choice,
// source coverage against the measured video end, the up-front output identity plan, and the provider seam
// through which WP-B routes (resident v3, chunked composite, chunked scene-linear) are dispatched.
import type { EditProject } from "../domain/types";
import type { RenderPlan } from "./planner";
import type { VideoEncoder } from "./ffmpegTypes";
import { encoderArgs, isHdrOutput } from "./ffmpegComposite";
import { outputColorMetadataArgs } from "./outputColorMetadata";
import { resolveMediaPath, runProcess } from "./ffmpegMedia";
import { assertRenderActive } from "./renderLifetime";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";
import { durationFrameCountV1, frameRateRationalV1, secondsToSamplesV1 } from "./longRenderClockV1";
import { LongRenderRefusalV1, type LongOutputIdentityPlanV1, type LongRenderFactsV1, type LongRenderPolicyV1,
  type LongRenderRouteProvidersV1, type LongRenderRouteV1 } from "./longRenderContractsV1";

const providers: LongRenderRouteProvidersV1 = {};

/** WP-B registers its providers here (one wiring line in ffmpeg.ts when it lands). Returns an undo for tests. */
export function registerLongRenderRouteProvidersV1(next: LongRenderRouteProvidersV1): () => void {
  const previous = { ...providers };
  Object.assign(providers, next);
  return () => { for (const key of Object.keys(providers) as Array<keyof LongRenderRouteProvidersV1>) delete providers[key]; Object.assign(providers, previous); };
}

export function longRenderRouteProvidersV1(): Readonly<LongRenderRouteProvidersV1> {
  return { ...providers };
}

/** Staging and floating-frame refusals that must happen before any prepass or decode (C1). */
export function assertLongRenderAdmissibleV1(facts: LongRenderFactsV1, policy: LongRenderPolicyV1): void {
  const cap = policy.stagingCapBytes;
  if (facts.prepassStagingBytes > cap) throw new LongRenderRefusalV1("LONG_RENDER_PREPASS_STAGING", "referenced compositions or the mesh pass would stage more than the staging cap before the final route",
    { estimateBytes: facts.prepassStagingBytes, capBytes: cap });
  if (facts.nativeEffectStagingBytes > cap) throw new LongRenderRefusalV1("LONG_RENDER_NATIVE_EFFECT_STAGING", "native-effect materialization would stage more than the staging cap",
    { estimateBytes: facts.nativeEffectStagingBytes, capBytes: cap });
  if (facts.fixedMaskStagingBytes > cap) throw new LongRenderRefusalV1("LONG_RENDER_FIXED_MASK_STAGING", "fixed-window mask rasters would stage more than the staging cap",
    { estimateBytes: facts.fixedMaskStagingBytes, capBytes: cap });
  if (facts.maxFloatingFramesPerClip > policy.maxFloatingFramesPerClip) throw new LongRenderRefusalV1("LONG_RENDER_FLOATING_FRAMES", "a floating video frame clip exceeds the per-clip frame limit",
    { frames: facts.maxFloatingFramesPerClip, limit: policy.maxFloatingFramesPerClip });
}

export interface LongRouteDecisionV1 { route: LongRenderRouteV1; residentStreamVersion?: 2 | 3 }

/** Route for the actual dispatch point (scene-linear, resident or FFmpeg composite) of a LONG render. */
export function chooseLongRouteV1(input: { kind: "scene-linear" | "resident" | "composite"; audioClipCount: number; ramEstimateBytes: number },
  policy: LongRenderPolicyV1, available: LongRenderRouteProvidersV1 = providers): LongRouteDecisionV1 {
  if (input.kind === "scene-linear") {
    if (!available.chunkedSceneLinear) throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "scene-linear LONG renders need the chunked sequence route (WP-B), which is not available in this build",
      { route: "scene-linear-chunked" });
    return { route: "scene-linear-chunked" };
  }
  if (input.kind === "resident") {
    if (input.audioClipCount <= policy.residentStreamV2MaxAudioClips) return { route: "resident-stream-v2", residentStreamVersion: 2 };
    if (!available.residentStreamV3) throw new LongRenderRefusalV1("LONG_RENDER_AUDIO_CLIPS_REQUIRE_V3", "this LONG resident render has more audio clips than stream v2 mixes; it needs resident stream v3 (WP-B)",
      { audioClipCount: input.audioClipCount, v2Limit: policy.residentStreamV2MaxAudioClips });
    return { route: "resident-stream-v3", residentStreamVersion: 3 };
  }
  if (input.ramEstimateBytes <= policy.ramBudgetBytes) return { route: "ffmpeg-single-graph" };
  if (!available.chunkedComposite) throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "the single FFmpeg graph exceeds the RAM budget and the chunked composite route (WP-B) is not available in this build",
    { route: "ffmpeg-chunked", ramEstimateBytes: input.ramEstimateBytes, ramBudgetBytes: policy.ramBudgetBytes });
  return { route: "ffmpeg-chunked" };
}

/** The route the facts predict (admission estimates only; the dispatch point decides with the actual graph). */
export function predictLongRouteV1(facts: LongRenderFactsV1, policy: LongRenderPolicyV1, available: LongRenderRouteProvidersV1 = providers): LongRouteDecisionV1 {
  return chooseLongRouteV1({ kind: facts.sceneLinear ? "scene-linear" : facts.residentCandidate ? "resident" : "composite",
    audioClipCount: facts.audioClipCount, ramEstimateBytes: facts.ramEstimateBytes }, policy, available);
}

/** Work-volume staging the predicted route needs (admission only; the guard enforces the cap during the run). */
export function predictedLongStagingBytesV1(decision: LongRouteDecisionV1, facts: LongRenderFactsV1, policy: LongRenderPolicyV1): number {
  const route = decision.route;
  const bytes = route === "resident-stream-v2" || route === "resident-stream-v3" ? 256 * 1024 ** 2 + 16 * 1024 ** 2
    : route === "ffmpeg-single-graph" ? facts.nativeEffectStagingBytes + facts.fixedMaskStagingBytes + 16 * 1024 ** 2
    : policy.stagingCapBytes;
  return Math.min(policy.stagingCapBytes, bytes);
}

export interface LongSourceCoverageV1 { assetId: string; path: string; measuredVideoEndSeconds: number; requiredEndSeconds: number }

function parseRational(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : undefined;
}

/**
 * Measured end of the first video stream: the largest pts + duration among the packets of the last ~30 s of the
 * file, read to EOF. A truncated tail or a container duration that only audio reaches cannot hide behind
 * container metadata.
 */
export async function probeVideoStreamEndV1(path: string, ffprobePath: string, timeoutMs = 120_000): Promise<{ endSeconds: number } | { error: string }> {
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 600);
  let info: { streams?: Array<{ time_base?: string }>; format?: { duration?: string } };
  try {
    info = JSON.parse((await runProcess(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base:format=duration", "-of", "json", path],
      Math.min(timeoutMs, 60_000), { completeStdoutMaxChars: 64 * 1024 })).stdout);
  } catch (error) {
    if (error instanceof PendingNativeCloseError) throw error;
    return { error: `ffprobe stream info failed: ${reason(error)}` };
  }
  const timeBase = parseRational(info.streams?.[0]?.time_base);
  const containerDuration = Number(info.format?.duration);
  if (!timeBase || !Number.isFinite(containerDuration) || containerDuration <= 0) return { error: "no video stream time base or container duration" };
  // The bundled probe can finish a zero-start seek early with exit0. Short files must be read to EOF without seeking.
  const seek = Math.max(0, containerDuration - 30);
  let stdout = "", tailError = "";
  try {
    stdout = (await runProcess(ffprobePath, ["-v", "error", "-select_streams", "v:0", ...(seek > 0 ? ["-read_intervals", `${seek.toFixed(3)}%`] : []),
      "-show_entries", "packet=pts,duration", "-of", "csv=p=0", path], timeoutMs, { completeStdoutMaxChars: 8 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (error instanceof PendingNativeCloseError) throw error;
    // A damaged tail can make ffprobe exit non-zero after it printed the readable packets.
    stdout = (error as { stdout?: string }).stdout ?? "";
    tailError = reason(error);
  }
  let endTicks = -1;
  for (const line of stdout.split(/\r?\n/)) {
    const [pts, duration] = line.split(",").map(value => Number(value));
    if (Number.isFinite(pts) && Number.isFinite(duration)) endTicks = Math.max(endTicks, pts + duration);
  }
  return endTicks >= 0 ? { endSeconds: endTicks * timeBase } : { error: `no readable video packets in the last 30 s${tailError ? `: ${tailError}` : ""}` };
}

export async function measureVideoStreamEndSecondsV1(path: string, ffprobePath: string, timeoutMs = 120_000): Promise<number | undefined> {
  const measured = await probeVideoStreamEndV1(path, ffprobePath, timeoutMs);
  return "endSeconds" in measured ? measured.endSeconds : undefined;
}

/** Read-only and idempotent, so a transient probe failure is retried a bounded number of times (never while aborted). */
export const LONG_SOURCE_MEASURE_ATTEMPTS_V1 = 3;

/** Every visible video clip must be backed by real video up to its last frame (within half a frame). */
export async function measureLongSourceCoverageV1(project: EditProject, plan: RenderPlan, input: { ffprobePath: string; assetBase?: string; timeoutMs?: number }): Promise<LongSourceCoverageV1[]> {
  const required = new Map<string, { path: string; end: number; clipId: string; time: number }>();
  for (const layer of plan.videoLayers) for (const segment of layer.segments) {
    if (segment.kind !== "clip") continue;
    const asset = project.assets.find(candidate => candidate.id === segment.clip.assetId);
    if (!asset || asset.kind !== "video" || asset.compositionId) continue;
    const speed = segment.clip.speed && segment.clip.speed > 0 ? segment.clip.speed : 1;
    const end = segment.clip.sourceStart + segment.clip.duration * speed;
    const previous = required.get(asset.id);
    if (!previous || end > previous.end) required.set(asset.id, { path: resolveMediaPath(asset.uri, input.assetBase), end, clipId: segment.clip.id, time: segment.clip.timelineStart + segment.clip.duration });
  }
  const tolerance = .5 / project.fps;
  const coverage: LongSourceCoverageV1[] = [];
  for (const [assetId, need] of required) {
    let probed: { endSeconds: number } | { error: string } = { error: "not measured" };
    const errors: string[] = [];
    for (let attempt = 1; attempt <= LONG_SOURCE_MEASURE_ATTEMPTS_V1; attempt += 1) {
      assertRenderActive();
      probed = await probeVideoStreamEndV1(need.path, input.ffprobePath, input.timeoutMs);
      if ("endSeconds" in probed) break;
      errors.push(probed.error);
      if (attempt < LONG_SOURCE_MEASURE_ATTEMPTS_V1) await new Promise(done => setTimeout(done, 500 * attempt));
    }
    if (!("endSeconds" in probed)) throw new LongRenderRefusalV1("LONG_RENDER_SOURCE_UNMEASURED", `the video end of ${need.path} could not be measured: ${errors.at(-1)}`,
      { assetId, path: need.path, attempts: errors.length, errors });
    const measured = probed.endSeconds;
    if (need.end > measured + tolerance) throw new LongRenderRefusalV1("LONG_RENDER_SOURCE_SHORT", `clip ${need.clipId} needs ${need.end.toFixed(3)} s of video but the source ends at ${measured.toFixed(3)} s`,
      { clipId: need.clipId, time: need.time, assetId, requiredEndSeconds: need.end, measuredVideoEndSeconds: measured });
    coverage.push({ assetId, path: need.path, measuredVideoEndSeconds: measured, requiredEndSeconds: need.end });
  }
  return coverage;
}

/** Output identity recorded up front (C1) from the same encoder/colour policy the legacy route of this project uses. */
export function planLongOutputIdentityV1(project: EditProject, plan: RenderPlan, encoder: VideoEncoder, options: { alphaDelivery: boolean; sceneLinear: boolean }): LongOutputIdentityPlanV1 {
  const frameRate = frameRateRationalV1(project.fps);
  const transform = project.colorManagement?.mode === "aces2" ? project.colorManagement.outputTransform : "rec709_sdr";
  const hdr = isHdrOutput(project);
  const tags = options.alphaDelivery ? ["-color_primaries", "bt709", "-colorspace", "bt709", "-color_trc", "bt709"] : outputColorMetadataArgs(encoder, transform);
  const tag = (name: string) => tags[tags.indexOf(name) + 1];
  return {
    schema: "editkin.long-output-identity-plan/v1",
    container: options.alphaDelivery ? "mov" : "mp4",
    width: project.width, height: project.height, frameRate,
    expectedFrames: durationFrameCountV1(plan.duration, frameRate),
    durationSeconds: plan.duration,
    pixelFormat: options.alphaDelivery ? "yuva444p12le" : hdr ? "yuv420p10le" : "yuv420p",
    colorPrimaries: tag("-color_primaries"), colorTransfer: tag("-color_trc"), colorMatrix: tag("-colorspace"),
    encoder, encoderArgs: encoderArgs(encoder),
    audio: { codec: options.alphaDelivery ? "pcm_s24le" : "aac", sampleRate: 48000, channels: 2, expectedSamples: secondsToSamplesV1(plan.duration, 48000) },
  };
}
