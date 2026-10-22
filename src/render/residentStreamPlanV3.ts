import type { EditProject } from "../domain/types";
import type { RenderPlan } from "./planner";
import type { LongOutputIdentityPlanV1, LongRenderPolicyV1 } from "./longRenderContractsV1";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";
import { durationFrameCountV1, frameRateRationalV1, secondsToSamplesV1 } from "./longRenderClockV1";

/** The producer already emits exactly frameCount PNGs. A video frame cap can end the mux before fractional audio EOF. */
export function residentMuxFrameLimitArgsV3(duration: number, fps: number, frameCount: number): string[] {
  return Math.abs(duration * fps - frameCount) < 1e-6 ? ["-frames:v", String(frameCount)] : [];
}

/** Bounds TS-owned PNG buffers; native textures, codec buffers and pipe buffering are separate from this estimate. */
export function residentStreamPlanV3(project: EditProject, plan: RenderPlan, identity: LongOutputIdentityPlanV1, policy: LongRenderPolicyV1) {
  const rate = frameRateRationalV1(project.fps), frames = durationFrameCountV1(plan.duration, rate);
  if (project.colorManagement?.mode !== "aces2" || project.colorManagement.outputTransform !== "rec709_sdr"
    || identity.container !== "mp4" || identity.pixelFormat !== "yuv420p" || identity.colorPrimaries !== "bt709"
    || identity.colorTransfer !== "bt709" || identity.colorMatrix !== "bt709" || identity.width !== project.width || identity.height !== project.height
    || ![project.width, project.height].every(value => Number.isSafeInteger(value) && value > 0 && value % 2 === 0)
    || rate.numerator !== identity.frameRate.numerator || rate.denominator !== identity.frameRate.denominator
    || frames !== identity.expectedFrames || Math.abs(identity.durationSeconds - plan.duration) > 1e-7
    || identity.audio.codec !== "aac" || identity.audio.sampleRate !== 48000 || identity.audio.channels !== 2
    || identity.audio.expectedSamples !== secondsToSamplesV1(plan.duration, 48000)) {
    throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "resident V3 requires the unchanged ACES2 SDR display/frame identity");
  }
  const maximumPngFrameBytes = project.width * project.height * 4 + project.height * 64 + 65_536;
  if (!Number.isSafeInteger(maximumPngFrameBytes) || maximumPngFrameBytes > 256 * 1024 ** 2
    || !Number.isSafeInteger(policy.frameQueueBytes) || maximumPngFrameBytes > policy.frameQueueBytes
    || !Number.isSafeInteger(policy.frameQueueFrames) || policy.frameQueueFrames < 1
    || !Number.isSafeInteger(policy.maxOwnedChildren) || policy.maxOwnedChildren < 3) throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "resident PNG queue and three-child budget cannot fit this output");
  const depth = Math.min(8, policy.frameQueueFrames, Math.floor(policy.frameQueueBytes / maximumPngFrameBytes));
  return { schema: "editkin.resident-stream-plan/v3" as const, frameCount: frames, maximumPngFrameBytes, frameQueueLimit: depth,
    queueCapacity: Math.max(0, depth - 2), maximumRetainedPngBytes: depth * maximumPngFrameBytes, maximumPendingDiskFrames: 1 as const };
}
