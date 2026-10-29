import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { buildRenderPlan } from "./planner";
import type { LongOutputIdentityPlanV1 } from "./longRenderContractsV1";
import { resolveLongRenderPolicyV1 } from "./longRenderPolicyV1";
import { residentMuxFrameLimitArgsV3, residentStreamPlanV3 } from "./residentStreamPlanV3";

const policy = resolveLongRenderPolicyV1(undefined, 32 * 1024 ** 3);
function fixture(duration = 2) {
  const project = createEmptyProject("resident bounds", { width: 128, height: 72, fps: 30 });
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  project.assets.push({ id: "src", name: "src", kind: "video", uri: "D:/clock-only-never-opened.mp4", width: 128, height: 72, duration });
  project.tracks[0].clips.push({ id: "clip", assetId: "src", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const plan = buildRenderPlan(project, uri => uri), identity: LongOutputIdentityPlanV1 = {
    schema: "editkin.long-output-identity-plan/v1", container: "mp4", width: 128, height: 72, durationSeconds: duration,
    frameRate: { numerator: 30, denominator: 1 }, expectedFrames: Math.round(duration * 30), pixelFormat: "yuv420p", colorPrimaries: "bt709",
    colorTransfer: "bt709", colorMatrix: "bt709", encoder: "libx264", encoderArgs: ["-c:v", "libx264"],
    audio: { codec: "aac", sampleRate: 48000, channels: 2, expectedSamples: Math.round(duration * 48000) },
  };
  return { project, plan, identity };
}
describe("resident V3 PNG queue and parent output clock", () => {
  it("keeps aligned legacy mux arguments but lets fractional audio reach EOF", () => {
    expect(residentMuxFrameLimitArgsV3(2, 24, 48)).toEqual(["-frames:v", "48"]);
    expect(residentMuxFrameLimitArgsV3(2.01, 24, 48)).toEqual([]);
    expect(residentMuxFrameLimitArgsV3(60 * 1001 / 30000, 30000 / 1001, 60)).toEqual(["-frames:v", "60"]);
  });
  it.each([1, 2, 8])("reserves producer/writer frames inside a%d-frame limit", depth => {
    const { project, plan, identity } = fixture(), result = residentStreamPlanV3(project, plan, identity, { ...policy, frameQueueFrames: depth });
    expect(result.frameQueueLimit).toBe(depth); expect(result.queueCapacity).toBe(Math.max(0, depth - 2));
    expect(result.maximumRetainedPngBytes).toBeLessThanOrEqual(policy.frameQueueBytes); expect(result.maximumPendingDiskFrames).toBe(1);
  });
  it.each([12, 24])("keeps the%dh frame/sample clock beyond old staging-sized limits without allocating frame arrays", hours => {
    const { project, plan, identity } = fixture(hours * 3600), result = residentStreamPlanV3(project, plan, identity, policy);
    expect(result.frameCount).toBe(hours * 3600 * 30); expect(result.frameCount).toBeGreaterThan(1_000_000);
  });
  it("rejects colour/audio/frame identity drift while retaining the canonical rounded video endpoint", () => {
    const { project, plan, identity } = fixture();
    for (const changed of [{ ...identity, colorTransfer: "smpte2084" }, { ...identity, expectedFrames: 59 },
      { ...identity, audio: { ...identity.audio, expectedSamples: 95999 } }]) {
      expect(() => residentStreamPlanV3(project, plan, changed, policy)).toThrow("LONG_RENDER_OUTPUT_QA");
    }
    const partial = fixture(1.01);
    expect(residentStreamPlanV3(partial.project, partial.plan, partial.identity, policy).frameCount).toBe(30);
    expect(partial.identity.audio.expectedSamples).toBe(48480);
  });
  it("refuses an undersized queue or fewer than three child slots", () => {
    const { project, plan, identity } = fixture();
    expect(() => residentStreamPlanV3(project, plan, identity, { ...policy, frameQueueBytes: 1 })).toThrow("LONG_RENDER_POLICY_INVALID");
    expect(() => residentStreamPlanV3(project, plan, identity, { ...policy, maxOwnedChildren: 2 })).toThrow("LONG_RENDER_POLICY_INVALID");
  });
});
