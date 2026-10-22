import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import { inspectMotionBlurAdmissionV1 } from "./motionBlurAdmissionV1";
const capabilities = { gpuCompositorAvailable: true, colorWindowAttached: false };
describe("pure spatial preflight for future H4 motion blur hookup", () => {
  it("requires explicit fresh window/runtime knowledge", () => {
    const p = createDemoProject(), c = p.tracks[0].clips[0];
    expect(inspectMotionBlurAdmissionV1(p, c)).toEqual({ allowed: false, reason: "capabilities-unverified" });
    expect(inspectMotionBlurAdmissionV1(p, c, capabilities)).toEqual({ allowed: true });
  });
  it("does not drop active masks; a disabled mask stays saved and has no spatial effect", () => {
    const p = createDemoProject(), c = p.tracks[0].clips[0]; c.masks = [createClipMask("mask", "rectangle")];
    expect(inspectMotionBlurAdmissionV1(p, c, capabilities)).toEqual({ allowed: false, reason: "clip-mask" });
    c.masks[0].enabled = false; const before = structuredClone(c.masks);
    expect(inspectMotionBlurAdmissionV1(p, c, capabilities)).toEqual({ allowed: true }); expect(c.masks).toEqual(before);
  });
  it("refuses varying opacity and keeps constant opacity legal", () => {
    const p = createDemoProject(), c = p.tracks[0].clips[0];
    c.keyframes = [{ id: "pose", time: 1, easing: "linear", transform: { ...c.transform, opacity: .5 }, color: { ...c.color } }];
    expect(inspectMotionBlurAdmissionV1(p, c, capabilities)).toEqual({ allowed: false, reason: "animated-opacity" });
    c.keyframes[0].transform.opacity = c.transform.opacity;
    expect(inspectMotionBlurAdmissionV1(p, c, capabilities)).toEqual({ allowed: true });
  });
  it("does not blanket-refuse nonspatial grade data as if it were a colour window", () => {
    const p = createDemoProject(), c = p.tracks[0].clips[0]; c.gradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "primary", saturation: 1.1 }] };
    expect(inspectMotionBlurAdmissionV1(p, c, capabilities)).toEqual({ allowed: true });
    expect(inspectMotionBlurAdmissionV1(p, c, { ...capabilities, colorWindowAttached: true })).toEqual({ allowed: false, reason: "color-window" });
  });
});
