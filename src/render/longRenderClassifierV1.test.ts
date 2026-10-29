import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { EditProject } from "../domain/types";
import { classifyRenderV1, collectLongRenderFactsV1, estimateLongCompositeRamBytesV1 } from "./longRenderClassifierV1";
import { defaultLongRenderPolicyV1 } from "./longRenderPolicyV1";
import { isLongRenderRefusalV1 } from "./longRenderContractsV1";
import { HIGH_BIT_DEPTH_ALPHA_PROFILE } from "./ffmpegContracts";

const policy = defaultLongRenderPolicyV1(16 * 1024 ** 3);

function project(seconds: number, options: { aces2?: boolean; width?: number; height?: number } = {}): EditProject {
  const value = createDemoProject();
  value.width = options.width ?? 1920; value.height = options.height ?? 1080; value.captions = []; value.motionGraphics = [];
  Object.assign(value.assets[0], { uri: "D:/owned-control/source.mp4", width: value.width, height: value.height, duration: seconds });
  Object.assign(value.tracks[0].clips[0], { timelineStart: 0, sourceStart: 0, duration: seconds });
  if (options.aces2) value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return value;
}

describe("long-render classifier (Q-L2: LONG at 30 minutes or more)", () => {
  it("classifies by plan duration with the 1800 s threshold", () => {
    expect(classifyRenderV1(project(1799.9))).toMatchObject({ class: "short", reason: "duration-below-threshold", minLongSeconds: 1800 });
    expect(classifyRenderV1(project(1800))).toMatchObject({ class: "long", reason: "duration-at-least-threshold" });
    expect(classifyRenderV1(project(43_200))).toMatchObject({ class: "long", durationSeconds: 43_200 });
    expect(classifyRenderV1(project(5), { forceClass: "long" })).toMatchObject({ class: "long", reason: "forced-long" });
    expect(classifyRenderV1(project(120), { policy: { minLongSeconds: 60 } })).toMatchObject({ class: "long" });
  });

  it("never forces SHORT and keeps unreadable projects on the legacy path", () => {
    let error: unknown;
    try { classifyRenderV1(project(43_200), { forceClass: "short" as never }); } catch (caught) { error = caught; }
    expect(isLongRenderRefusalV1(error, "LONG_RENDER_POLICY_INVALID")).toBe(true);
    expect(classifyRenderV1({} as EditProject)).toMatchObject({ class: "short", reason: "duration-unavailable" });
  });

  it("records why the legacy route cannot run a 12 h resident render (full PNG staging) and predicts the resident stream", () => {
    const facts = collectLongRenderFactsV1(project(43_200, { aces2: true }), {}, policy);
    expect(facts).toMatchObject({ durationSeconds: 43_200, frameRate: { numerator: 30, denominator: 1 }, frameCount: 1_296_000, residentCandidate: true, sceneLinear: false, alphaDelivery: false });
    expect(facts.legacyStagingEstimateBytes).toBeGreaterThan(5e12);
    expect(facts.finalOutputEstimateBytes).toBeGreaterThan(0);
  });

  it("separates the FFmpeg composite, scene-linear and alpha-delivery candidates and estimates RAM per decoder input", () => {
    const rec709 = collectLongRenderFactsV1(project(3600), {}, policy);
    expect(rec709).toMatchObject({ residentCandidate: false, sceneLinear: false, videoInputCount: 1, audioClipCount: 1, prepassStagingBytes: 0, nativeEffectStagingBytes: 0 });
    expect(rec709.ramEstimateBytes).toBe(estimateLongCompositeRamBytesV1(project(3600), [{ width: 1920, height: 1080 }]));
    const linear = project(3600, { aces2: true }); linear.assets[0].color = { interpretation: "linear_rec709" };
    expect(collectLongRenderFactsV1(linear, {}, policy)).toMatchObject({ sceneLinear: true, residentCandidate: false });
    expect(collectLongRenderFactsV1(project(3600), { deliveryProfile: HIGH_BIT_DEPTH_ALPHA_PROFILE }, policy)).toMatchObject({ alphaDelivery: true, residentCandidate: false });
    const many = project(3600);
    for (let index = 1; index < 60; index += 1) {
      const clip = structuredClone(many.tracks[0].clips[0]); clip.id = `clip-${index}`; clip.timelineStart = index * 60; clip.duration = 60;
      many.tracks[0].clips.push(clip);
    }
    many.tracks[0].clips[0].duration = 60;
    const manyFacts = collectLongRenderFactsV1(many, {}, policy);
    expect(manyFacts.videoInputCount).toBe(60);
    expect(manyFacts.ramEstimateBytes).toBe(estimateLongCompositeRamBytesV1(many, Array.from({ length: 60 }, () => ({ width: 1920, height: 1080 }))));
    // On a 16 GiB machine 60 simultaneous 1080p decoder inputs exceed the Q007 budget: the single graph is not admitted.
    expect(manyFacts.ramEstimateBytes).toBeGreaterThan(policy.ramBudgetBytes);
    expect(rec709.ramEstimateBytes).toBeLessThan(policy.ramBudgetBytes);
  });
});
