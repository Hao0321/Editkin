import { describe, expect, it } from "vitest";
import { createMotionTrackSamplerV2 } from "./motionTrackSamplerV2";
import { motionTrackPoseAt } from "./motionTrackSampling";
import type { MotionTrack, MotionTrackPoint } from "./types";

const point = (time: number, patch: Partial<MotionTrackPoint> = {}): MotionTrackPoint => ({ frame: Math.round(time * 15), time,
  rect: { x: .2, y: .2, width: .2, height: .2 }, confidence: 1, status: "tracked", rotationDegrees: 0, scale: 1, ...patch });
const track = (points: MotionTrackPoint[]): MotionTrack => ({ id: "track", clipId: "clip", name: "fixture", engine: "fixture",
  analysisFps: 15, initialRect: points[0]?.rect ?? { x: 0, y: 0, width: 1, height: 1 }, points, lostRatio: 0, createdAt: "" });
const quad: NonNullable<MotionTrackPoint["quad"]> = [{ x: .1, y: .1 }, { x: .3, y: .1 }, { x: .3, y: .3 }, { x: .1, y: .3 }];

describe("opt-in indexed tracking sampler v2", () => {
  it("rejects a sparse quad rather than converting missing coordinates into a degenerate surface", () => {
    const sparse = new Array(4) as NonNullable<MotionTrackPoint["quad"]>;
    expect(() => createMotionTrackSamplerV2(track([point(0, { quad: sparse })]), { requireQuad: true })).toThrow("QUAD_INVALID");
  });
  it("takes the short arc at 360/0, exposing the old 180-degree reversal", () => {
    const input = track([point(0, { rotationDegrees: 359 }), point(1, { rotationDegrees: 1 })]);
    expect(motionTrackPoseAt(input, .5)!.rotationDegrees).toBe(180);
    const sampler = createMotionTrackSamplerV2(input, { maxInterpolationGapSeconds: 1.1 });
    expect(sampler.sample(.5).pose!.rotationDegrees).toBe(0);
    expect(sampler.sample(0).pose!.rotationDegrees).toBe(359);
    expect(sampler.sample(1).pose!.rotationDegrees).toBe(1);
  });
  it("does not invent leading samples or an indefinitely live tail", () => {
    const input = track([point(1)]), sampler = createMotionTrackSamplerV2(input);
    expect(motionTrackPoseAt(input, 10)).toBeDefined();
    expect(sampler.sample(.99).reason).toBe("before_range");
    expect(sampler.sample(1).reason).toBe("visible");
    expect(sampler.sample(1.1).pose!.status).toBe("held");
    expect(sampler.sample(1.13).reason).toBe("expired");
    expect(sampler.sample(NaN).reason).toBe("invalid_time");
  });
  it("hides explicit lost spans and only reacquires at the actual new observation", () => {
    const sampler = createMotionTrackSamplerV2(track([point(0), point(.1, { status: "lost" }), point(.2)]));
    expect(sampler.sample(.05).pose!.status).toBe("held");
    expect(sampler.sample(.1).reason).toBe("lost");
    expect(sampler.sample(.199).pose).toBeUndefined();
    expect(sampler.sample(.2).reason).toBe("visible");
  });
  it("does not interpolate toward a low-confidence jump", () => {
    const input = track([point(0), point(.1, { confidence: .1, rect: { x: .7, y: .2, width: .2, height: .2 } }), point(.2)]);
    const sampler = createMotionTrackSamplerV2(input);
    expect(sampler.sample(.05).pose!.rect.x).toBe(.2);
    expect(sampler.sample(.1).pose!.rect.x).toBe(.2);
    expect(sampler.sample(.15).pose).toBeUndefined();
    expect(sampler.sample(.2).reason).toBe("visible");
  });
  it("does not renew the deadline from held observations", () => {
    const sampler = createMotionTrackSamplerV2(track([point(0), point(.1, { status: "held" }), point(.2, { status: "held" })]));
    expect(sampler.sample(.1).reason).toBe("held");
    expect(sampler.sample(.2).pose).toBeUndefined();
    expect(sampler.sample(.25).pose).toBeUndefined();
  });
  it("does not connect a sparse-data gap with an invented smooth trajectory", () => {
    const sampler = createMotionTrackSamplerV2(track([point(0), point(1, { rect: { x: .7, y: .2, width: .2, height: .2 } })]));
    expect(sampler.sample(.05).pose!.rect.x).toBe(.2);
    expect(sampler.sample(.5).reason).toBe("gap");
    expect(sampler.sample(1).pose!.rect.x).toBe(.7);
  });
  it("preserves verified manual poses and explicit unwrapped turns without extra smoothing", () => {
    const sampler = createMotionTrackSamplerV2(track([point(0, { status: "manual", confidence: 0 }),
      point(.2, { status: "manual", confidence: 0, rotationDegrees: 360, rect: { x: .6, y: .2, width: .2, height: .2 } })]),
    { rotationInterpolation: "unwrapped" });
    expect(sampler.sample(.1).pose).toMatchObject({ status: "manual", rotationDegrees: 180, rect: { x: .4 } });
    expect(sampler.sample(.2).pose!.rotationDegrees).toBe(360);
  });
  it("snapshots inputs and returns independent output poses", () => {
    const input = track([point(0, { quad: structuredClone(quad) })]), sampler = createMotionTrackSamplerV2(input);
    input.points[0].rect.x = .6; input.points[0].quad![0].x = .5;
    const result = sampler.sample(0).pose!; result.rect.x = .7; result.quad![0].x = .8;
    expect(sampler.sample(0).pose!.rect.x).toBe(.2);
    expect(sampler.sample(0).pose!.quad![0].x).toBe(.1);
  });
  it("rejects folded interpolated quads and missing surface evidence", () => {
    const shifted = [quad[2], quad[3], quad[0], quad[1]] as typeof quad;
    const sampler = createMotionTrackSamplerV2(track([point(0, { quad }), point(.2, { quad: shifted })]), { requireQuad: true });
    expect(sampler.sample(.1).reason).toBe("invalid_quad");
    expect(() => createMotionTrackSamplerV2(track([point(0)]), { requireQuad: true })).toThrow("QUAD_REQUIRED");
    const mixed = createMotionTrackSamplerV2(track([point(0, { quad }), point(.2)]));
    expect(mixed.sample(.1).pose!.quad).toBeUndefined();
  });
  it("rejects malformed clocks, geometry, confidence, quads, policy and budgets", () => {
    for (const points of [[point(0), point(0)], [point(.2), point(.1)], [point(NaN)], [point(0, { confidence: Infinity })],
      [point(0, { rect: { x: .9, y: .2, width: .2, height: .2 } })], [point(0, { quad: [quad[0], quad[2], quad[1], quad[3]] })]]) {
      expect(() => createMotionTrackSamplerV2(track(points))).toThrow();
    }
    expect(() => createMotionTrackSamplerV2(track([point(0)]), { maxHoldSeconds: Infinity })).toThrow("POLICY");
    expect(() => createMotionTrackSamplerV2(track(new Array(600_001)))).toThrow("BUDGET");
  });
  it("bounds random and long-timeline queries logarithmically", () => {
    const points = Array.from({ length: 36_001 }, (_, i) => point(i));
    const sampler = createMotionTrackSamplerV2(track(points), { maxInterpolationGapSeconds: 1.1 });
    for (const seconds of [0, .5, 3600.25, 18_000.5, 35_999.75, 36_000]) {
      const result = sampler.sample(seconds);
      expect(result.pose).toBeDefined();
      expect(result.comparisons).toBeLessThanOrEqual(Math.ceil(Math.log2(points.length)) + 1);
    }
    expect(sampler.snapshotBytes).toBeLessThan(5_000_000);
    expect(sampler.sample(36_000.5).pose).toBeUndefined();
  });
});
