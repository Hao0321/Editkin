import { expect, it } from "vitest";
import { colorDigest } from "./materialColorSamplingRuntime";
import { uiFocusHoldFixtureV1 } from "./longformUiFocusHoldV1.fixture";
import { assembleLongformUiFocusHoldEvidenceV1, longformUiFocusHoldTargetV1, projectLongformUiFocusTrackedQuadV1,
  verifyLongformUiFocusHoldSequenceV1 } from "./longformUiFocusHoldV1";
it("checks all 24 presentation frames with actual supplied integer clocks, preserves the initial text geometry and never declares a ready hint", () => {
  const f = uiFocusHoldFixtureV1(), result = assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan);
  expect(result.state).toBe("TRACKING_EVIDENCE_READY"); expect(result.sourceFrameCount).toBe(24);
  expect(result.frames[0].pts).toBe(6); expect(result.sourceStart).toBe(.2); expect(result.sourceEnd).toBe(1);
  expect(result.frames.every(frame => frame.templateCorrelation > .999999 && frame.templateMeanAbsoluteDifference < 1e-8)).toBe(true);
  expect(result.frames[23].endTime).toBe(1); expect(result.frames[0].targetQuad[0].x).toBeCloseTo(f.candidate.quad[0].x, 10);
  expect(result).toMatchObject({ focusHintsReady: false, semanticIdentityAcrossIntervalVerified: false, confidenceCalibrated: false, projectModified: false });
  const { receiptSha256, ...body } = result; expect(receiptSha256).toBe(colorDigest(body));
});
it("follows measured translation of the text itself, rather than exposing padded tracker context as a widget", () => {
  const f = uiFocusHoldFixtureV1({ translation: true }), result = assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan);
  expect(result.state).toBe("TRACKING_EVIDENCE_READY"); expect(result.frames[23].targetQuad[0].x - result.frames[0].targetQuad[0].x).toBeCloseTo(23 / 160, 10);
  expect(result.contextAuthority).toBe("tool-derived-padding-around-ocr-text-not-widget-edges");
  expect(result.trackingContext.width).toBeGreaterThan(f.candidate.bounds.width);
});
it("rejects manual coordinates, wrong IDs, a hold outside the clip and a changed sparse draft", () => {
  const f = uiFocusHoldFixtureV1();
  expect(() => longformUiFocusHoldTargetV1(f.draft, { ...f.request, bounds: f.candidate.bounds })).toThrow();
  expect(() => longformUiFocusHoldTargetV1(f.draft, { ...f.request, candidateId: "uif-" + "c".repeat(64) })).toThrow("UNAVAILABLE");
  expect(() => longformUiFocusHoldTargetV1(f.draft, { ...f.request, duration: 1 })).toThrow("OUTSIDE_CLIP");
  const forged = structuredClone(f.draft); forged.candidates[0].bounds.x += .01;
  expect(() => longformUiFocusHoldTargetV1(forged, f.request)).toThrow("INCONSISTENT");
});
it("rejects missing duration/frames, clock gaps, changed raw pixels and nominal native clocks substituted for source clocks", () => {
  const f = uiFocusHoldFixtureV1();
  for (const mutate of [(s: typeof f.sequence) => { s.frames[7].durationPts = 0; }, (s: typeof f.sequence) => { s.frames[7].pts++; },
    (s: typeof f.sequence) => { s.frames.pop(); }, (s: typeof f.sequence) => { s.frames[0].sourceTime = 0; }]) {
    const bad = structuredClone(f.sequence); mutate(bad); expect(() => verifyLongformUiFocusHoldSequenceV1(bad, f.pixels, f.draft, f.request)).toThrow();
  }
  const changed = f.pixels.slice(); changed[42] ^= 255;
  expect(() => verifyLongformUiFocusHoldSequenceV1(f.sequence, changed, f.draft, f.request)).toThrow("SEQUENCE_BINDING");
  const plan = structuredClone(f.plan); plan.points[3].time = f.sequence.frames[3].sourceTime;
  expect(() => assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, plan)).toThrow("NATIVE_BINDING");
});
it.each(["held", "lost"] as const)("cannot carry an unchanged box through %s frames or automatic reacquisition", status => {
  const f = uiFocusHoldFixtureV1(); f.plan.points[10].status = status; f.plan.lostRatio = status === "lost" ? 1 / 24 : 0;
  f.plan.points[11].planarDiagnostics!.globalSearch = true;
  const result = assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan);
  expect(result.state).toBe("BLOCKED"); expect(result.flags).toContain("TRACK_NOT_CONTINUOUS"); expect(result.flags).toContain("REACQUISITION_REQUIRES_NEW_CONFIRMATION");
});
it("blocks a same-decode scene cut even when the label pixels happen to remain identical", () => {
  const f = uiFocusHoldFixtureV1(); f.sequence.cuts = [{ frame: 12, sourceTime: .6, score: 10 }];
  const result = assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan);
  expect(result.state).toBe("BLOCKED"); expect(result.frames[12].flags).toContain("SCENE_CHANGE_REQUIRES_NEW_CONFIRMATION");
});
it("independently detects vanished text despite a native plan claiming perfect confidence, and refuses a textureless target", () => {
  const f = uiFocusHoldFixtureV1(), bytes = f.sequence.width * f.sequence.height;
  f.pixels.fill(240, bytes * 12, bytes * 13); f.resealPixels();
  expect(assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan).frames[12].flags).toContain("TARGET_APPEARANCE_CHANGED");
  f.pixels.fill(128); f.resealPixels();
  expect(assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan).flags).toContain("TARGET_TEXTURE_TOO_WEAK");
});
it("rejects folded/off-screen quads and abrupt jumps instead of clamping a stale target back into the picture", () => {
  const f = uiFocusHoldFixtureV1(); [f.plan.points[4].quad[1], f.plan.points[4].quad[2]] = [f.plan.points[4].quad[2], f.plan.points[4].quad[1]];
  f.plan.points[8].quad.forEach(p => { p.x += .4; });
  const result = assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan);
  expect(result.flags).toContain("TARGET_OUTSIDE_OR_INVALID_GEOMETRY"); expect(result.flags).toContain("ABRUPT_TARGET_JUMP");
});
it("projects target coordinates through a true perspective homography, keeping the tracked padding separate", () => {
  const context = { x: .1, y: .2, width: .5, height: .4 }, target = [{ x: .2, y: .3 }, { x: .4, y: .3 }, { x: .4, y: .4 }, { x: .2, y: .4 }];
  const warp = (u: number, v: number) => ({ x: .2 + .5 * u / (1 + .2 * u), y: .1 + .5 * v / (1 + .2 * u) });
  const mapped = projectLongformUiFocusTrackedQuadV1(target, context, [warp(0, 0), warp(1, 0), warp(1, 1), warp(0, 1)]);
  for (let i = 0; i < target.length; i++) { const expected = warp((target[i].x - .1) / .5, (target[i].y - .2) / .4);
    expect(mapped[i].x).toBeCloseTo(expected.x, 10); expect(mapped[i].y).toBeCloseTo(expected.y, 10); }
});
