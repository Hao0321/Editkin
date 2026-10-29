import type { EditProject } from "../domain/types";
import type { Aces2DisplayVideoRenderRequest } from "./aces2SdrVideo";
import { durationFrameCountV1, frameRateRationalV1, secondsToSamplesV1 } from "./longRenderClockV1";
import { LongRenderRefusalV1, type LongOutputIdentityPlanV1, type LongRenderPolicyV1 } from "./longRenderContractsV1";

/** The eight-decimal native filename contract bounds absolute frame indices; each CLI call keeps its existing 1M-frame limit. */
export const SCENE_LINEAR_TIMELINE_FRAME_LIMIT_V1 = 100_000_000;

export function sceneLinearChunkPlanV1(project: EditProject, duration: number, request: Aces2DisplayVideoRenderRequest,
  identity: LongOutputIdentityPlanV1, policy: LongRenderPolicyV1) {
  const rate = frameRateRationalV1(project.fps), frames = durationFrameCountV1(duration, rate), hdr = request.outputTransform !== "rec709_sdr";
  const expectedColor = hdr ? { pixelFormat: "yuv420p10le", primaries: "bt2020", matrix: "bt2020nc",
    transfer: request.outputTransform === "rec2100_hlg_1000" ? "arib-std-b67" : "smpte2084" }
    : { pixelFormat: "yuv420p", primaries: "bt709", matrix: "bt709", transfer: "bt709" };
  if (!["rec709_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"].includes(request.outputTransform)
    || request.graph.width !== project.width || request.graph.height !== project.height || request.graph.workingFormat !== "rgba32_float"
    || request.startFrame !== 0 || request.frameCount !== frames || frames < 1 || frames > SCENE_LINEAR_TIMELINE_FRAME_LIMIT_V1
    || identity.expectedFrames !== frames || identity.width !== project.width || identity.height !== project.height
    || ![project.width, project.height].every(value => Number.isSafeInteger(value) && value > 0 && value % 2 === 0)
    || identity.frameRate.numerator !== rate.numerator || identity.frameRate.denominator !== rate.denominator
    || request.graph.timebase.numerator !== rate.denominator || request.graph.timebase.denominator !== rate.numerator
    || identity.container !== "mp4" || identity.pixelFormat !== expectedColor.pixelFormat
    || identity.colorPrimaries !== expectedColor.primaries || identity.colorTransfer !== expectedColor.transfer || identity.colorMatrix !== expectedColor.matrix
    || Math.abs(identity.durationSeconds - duration) > 1e-7 || identity.audio.codec !== "aac" || identity.audio.sampleRate !== 48000
    || identity.audio.channels !== 2 || identity.audio.expectedSamples !== secondsToSamplesV1(duration, 48000)) {
    throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "scene-linear chunk identity, display or global clock differs from the output plan");
  }
  const maximumPngFrameBytes = project.width * project.height * (hdr ? 8 : 4) + project.height * 64 + 65_536;
  const batchBudgetBytes = Math.floor(policy.stagingCapBytes / 2);
  if (!Number.isSafeInteger(maximumPngFrameBytes) || maximumPngFrameBytes > 256 * 1024 ** 2
    || !Number.isSafeInteger(policy.stagingCapBytes) || !Number.isSafeInteger(batchBudgetBytes) || maximumPngFrameBytes > batchBudgetBytes
    || !Number.isSafeInteger(policy.frameQueueBytes) || maximumPngFrameBytes > policy.frameQueueBytes
    || !Number.isSafeInteger(policy.frameQueueFrames) || policy.frameQueueFrames < 1
    || !Number.isSafeInteger(policy.maxOwnedChildren) || policy.maxOwnedChildren < 3) {
    throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "scene-linear batch, one retained PNG and producer/encoder slots cannot fit the policy");
  }
  const framesPerChunk = Math.min(1_000_000, Math.floor(batchBudgetBytes / maximumPngFrameBytes));
  // Compute a descriptor on demand; a day-long render does not retain a list of every frame or chunk.
  return { schema: "editkin.scene-linear-chunk-plan/v1" as const, frameCount: frames, framesPerChunk,
    chunkCount: Math.ceil(frames / framesPerChunk), maximumPngFrameBytes, batchBudgetBytes,
    metadataBudgetBytes: policy.stagingCapBytes - batchBudgetBytes,
    maximumRetainedPngBytes: maximumPngFrameBytes, artifactFormat: hdr ? "rgba16_unorm" as const : "rgba8" as const,
    chunk(index: number) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(frames / framesPerChunk)) {
        throw new LongRenderRefusalV1("LONG_RENDER_CLOCK_RANGE", "scene-linear chunk index is outside its parent frame schedule");
      }
      const startFrame = index * framesPerChunk;
      return { startFrame, frameCount: Math.min(framesPerChunk, frames - startFrame) };
    } };
}

/** The graph/bindings/ASS share the remaining half of the staging cap, checked before any metadata file is written. */
export function sceneLinearMetadataBytesV1(parts: readonly string[], budgetBytes: number): number {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "metadata staging budget must be a positive safe integer");
  let total = 0;
  for (const text of parts) {
    total += Buffer.byteLength(text, "utf8");
    if (!Number.isSafeInteger(total) || total > budgetBytes) throw new LongRenderRefusalV1("LONG_RENDER_STAGING_LIMIT", "scene-linear graph, bindings and ASS exceed their metadata staging budget");
  }
  return total;
}

export interface SceneLinearChunkReceiptV1 {
  schema: "editkin.ocio-display-sequence/v1"; status: "GREEN"; colorProcessor: string; ocioVersion: string; acesVersion: string;
  configSha256: string; lutSha256: string; deviceCreationCount: 1; startFrame: number; frameCount: number; lastFrame: number;
  graphId: string; width: number; height: number; timebase: { numerator: number; denominator: number };
  filePattern: "frame-%08d.png"; artifactFormat: "rgba8" | "rgba16_unorm"; displayColorSpace: string; audioIncluded: false;
  totalBytes: number; renderMilliseconds?: { total: number };
}

export function assertSceneLinearChunkReceiptV1(value: unknown, request: Aces2DisplayVideoRenderRequest,
  chunk: { startFrame: number; frameCount: number }, format: "rgba8" | "rgba16_unorm", maximumBytes: number): asserts value is SceneLinearChunkReceiptV1 {
  const r = value as Partial<SceneLinearChunkReceiptV1> | undefined;
  if (!r || r.schema !== "editkin.ocio-display-sequence/v1" || r.status !== "GREEN" || r.colorProcessor !== request.colorProcessor
    || r.ocioVersion !== "2.5.2" || r.acesVersion !== "2.0" || r.filePattern !== "frame-%08d.png" || r.artifactFormat !== format
    || r.displayColorSpace !== request.outputTransform || r.deviceCreationCount !== 1 || r.audioIncluded !== false
    || r.startFrame !== chunk.startFrame || r.frameCount !== chunk.frameCount || r.lastFrame !== chunk.startFrame + chunk.frameCount - 1
    || r.width !== request.graph.width || r.height !== request.graph.height || r.graphId !== request.graph.graphId
    || r.timebase?.numerator !== request.graph.timebase.numerator || r.timebase?.denominator !== request.graph.timebase.denominator
    || !/^[a-f0-9]{64}$/.test(r.configSha256 ?? "") || !/^[a-f0-9]{64}$/.test(r.lutSha256 ?? "")
    || !Number.isSafeInteger(r.totalBytes) || r.totalBytes! <= 0 || r.totalBytes! > maximumBytes
    || (r.renderMilliseconds !== undefined && (r.renderMilliseconds === null || typeof r.renderMilliseconds !== "object"
      || !Number.isFinite(r.renderMilliseconds.total) || r.renderMilliseconds.total < 0))) {
    throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "native scene-linear chunk receipt does not match its exact graph, range, color or staging contract");
  }
}
