import { describe, expect, it } from "vitest";
import {
  compileTimeRemapClockV1, timeRemapCfrBlendSampleV1, timeRemapFrameIntervalV1,
  timeRemapSourceBoundaryV1, timeRemapTimelineBoundaryV1, timeRemapVfrBlendSampleV1,
  type BezierSpeedSegmentV1, type TimeRemapClockRequestV1,
} from "./timeRemapClockV1";

function linear(from: number, to: number, a: number, b: number): BezierSpeedSegmentV1 {
  return { from: { time: from, speed: a }, control1: { time: from + (to - from) / 3, speed: a + (b - a) / 3 },
    control2: { time: from + 2 * (to - from) / 3, speed: a + 2 * (b - a) / 3 }, to: { time: to, speed: b } };
}
function input(patch: Partial<TimeRemapClockRequestV1> = {}): TimeRemapClockRequestV1 {
  return { timelineDurationSeconds: 4, sourceStartSeconds: 5, sourceDurationSeconds: 100,
    outputRate: { numerator: 30, denominator: 1 }, direction: "forward", segments: [linear(0, 1, 1, 1)], ...patch };
}
function lerp(a: number, b: number, u: number) { return a + (b - a) * u; }
function casteljau(p: number[], u: number) {
  const a = lerp(p[0], p[1], u), b = lerp(p[1], p[2], u), c = lerp(p[2], p[3], u);
  return lerp(lerp(a, b, u), lerp(b, c, u), u);
}
// Independent composite Simpson quadrature, rather than the production polynomial primitive.
function numericArea(segment: BezierSpeedSegmentV1, endU: number) {
  const points = [segment.from, segment.control1, segment.control2, segment.to], x = points.map(p => p.time), y = points.map(p => p.speed);
  const f = (u: number) => casteljau(y, u) * 3 * ((1 - u) ** 2 * (x[1] - x[0])
    + 2 * (1 - u) * u * (x[2] - x[1]) + u ** 2 * (x[3] - x[2]));
  const n = 8192, h = endU / n;
  let sum = f(0) + f(endU);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(i * h);
  return sum * h / 3;
}
describe("W2-3 shared Bezier source clock candidate, no native/export parity claim", () => {
  it.each([0, .25, 1, 3])("constant speed %s uses actual source seconds and no duration-sized table", speed => {
    const clock = compileTimeRemapClockV1(input({ segments: [linear(0, 1, speed, speed)] }));
    expect(clock.consumedSourceSeconds).toBeCloseTo(4 * speed, 12);
    expect(timeRemapSourceBoundaryV1(clock, 2)).toBeCloseTo(5 + 2 * speed, 12);
    expect(timeRemapSourceBoundaryV1(clock, 4)).toBeCloseTo(5 + 4 * speed, 12);
    expect(clock.segments).toHaveLength(1);
  });
  it("100→25→100 curve preserves timeline length and integrates a smaller source window", () => {
    const clock = compileTimeRemapClockV1(input({ segments: [linear(0, .5, 1, .25), linear(.5, 1, .25, 1)] }));
    expect(clock.timelineDurationSeconds).toBe(4); expect(clock.consumedSourceSeconds).toBeCloseTo(2.5, 12);
    expect(timeRemapSourceBoundaryV1(clock, 2)).toBeCloseTo(6.25, 12);
    expect(clock.totalOutputFrames).toBe(120);
  });
  it("100→300→100 ramp integrates the authentic 8-second handle, refusing a shorter source", () => {
    const segments = [linear(0, .5, 1, 3), linear(.5, 1, 3, 1)];
    const clock = compileTimeRemapClockV1(input({ segments, sourceDurationSeconds: 13 }));
    expect(clock.consumedSourceSeconds).toBeCloseTo(8, 12);
    expect(() => compileTimeRemapClockV1(input({ segments, sourceDurationSeconds: 12.999 }))).toThrow("SOURCE_HANDLES_INSUFFICIENT");
  });
  it("nonlinear Bezier time handles agree with independent quadrature for24h", () => {
    const segment = { from: { time: 0, speed: 1 }, control1: { time: .08, speed: .25 },
      control2: { time: .71, speed: 3 }, to: { time: 1, speed: 1 } };
    const clock = compileTimeRemapClockV1(input({ timelineDurationSeconds: 86_400, sourceStartSeconds: 0, sourceDurationSeconds: 1_000_000, segments: [segment] }));
    expect(Math.abs(clock.consumedSourceSeconds - numericArea(segment, 1) * 86_400)).toBeLessThan(1e-7);
    for (const u of [.137, .42, .79]) {
      const t = casteljau([0, .08, .71, 1], u) * 86_400;
      const actual = timeRemapSourceBoundaryV1(clock, t), reference = numericArea(segment, u) * 86_400;
      expect(Math.abs(actual - reference)).toBeLessThan(1e-7);
      expect(Math.abs(timeRemapTimelineBoundaryV1(clock, actual, "first") - t)).toBeLessThan(1e-6);
    }
  });
  it("reverse has exclusive out boundaries and samples genuine reversed CFR frames", () => {
    const clock = compileTimeRemapClockV1(input({ timelineDurationSeconds: 1, sourceStartSeconds: 0, sourceDurationSeconds: 1,
      outputRate: { numerator: 4, denominator: 1 }, direction: "reverse" }));
    expect(timeRemapSourceBoundaryV1(clock, 0)).toBe(1); expect(timeRemapSourceBoundaryV1(clock, 1)).toBe(0);
    const source = { timing: "cfr" as const, frameRate: { numerator: 4, denominator: 1 }, decodedFrameCount: 4 };
    expect([0, 1, 2, 3].map(i => timeRemapCfrBlendSampleV1(clock, i, source).lowerFrame)).toEqual([3, 2, 1, 0]);
    expect(timeRemapTimelineBoundaryV1(clock, .25, "first")).toBeCloseTo(.75, 12);
  });
  it("a genuine freeze holds a valid source frame and makes inverse edges explicit", () => {
    const clock = compileTimeRemapClockV1(input({ timelineDurationSeconds: 43_200, segments: [linear(0, 1, 0, 0)] }));
    expect(clock.consumedSourceSeconds).toBe(0); expect(timeRemapFrameIntervalV1(clock, 1_200_000).frozen).toBe(true);
    expect(timeRemapTimelineBoundaryV1(clock, 5, "first")).toBe(0); expect(timeRemapTimelineBoundaryV1(clock, 5, "last")).toBe(43_200);
    expect(timeRemapCfrBlendSampleV1(clock, 1_200_000, { timing: "cfr", frameRate: { numerator: 30, denominator: 1 }, decodedFrameCount: 3000 }).lowerFrame).toBe(150);
  });
  it("inverse around a zero-speed plateau returns both plateau edges", () => {
    const clock = compileTimeRemapClockV1(input({ segments: [linear(0, .25, 1, 0), linear(.25, .75, 0, 0), linear(.75, 1, 0, 1)] }));
    const boundary = timeRemapSourceBoundaryV1(clock, 2);
    expect(timeRemapTimelineBoundaryV1(clock, boundary, "first")).toBeCloseTo(1, 6);
    expect(timeRemapTimelineBoundaryV1(clock, boundary, "last")).toBeCloseTo(3, 6);
  });
  it.each([43_200, 86_400])("late rational 30000/1001 clock at%s seconds retains safe intervals and small descriptor", seconds => {
    const clock = compileTimeRemapClockV1(input({ timelineDurationSeconds: seconds, sourceStartSeconds: 36_000, sourceDurationSeconds: 100_000,
      outputRate: { numerator: 30_000, denominator: 1001 }, segments: [linear(0, 1, .25, .25)] }));
    const last = timeRemapFrameIntervalV1(clock, clock.totalOutputFrames - 1);
    expect(last.timelineEnd).toBe(seconds); expect(last.timelineStart).toBeLessThan(seconds);
    expect(timeRemapSourceBoundaryV1(clock, seconds)).toBeCloseTo(36_000 + seconds / 4, 10);
    expect(JSON.stringify(clock).length).toBeLessThan(1024); expect(clock.segments).toHaveLength(1);
    const target = timeRemapSourceBoundaryV1(clock, seconds / 2);
    expect(Math.abs(timeRemapTimelineBoundaryV1(clock, target, "first") - seconds / 2)).toBeLessThan(1e-6);
  });
  it("synthetic frame indices over2^32 never wrap; this is arithmetic, not product FPS support", () => {
    const clock = compileTimeRemapClockV1(input({ timelineDurationSeconds: 86_400, sourceStartSeconds: 0, sourceDurationSeconds: 100_000,
      outputRate: { numerator: 65_536, denominator: 1 } }));
    const index = 4_294_967_298, frame = timeRemapFrameIntervalV1(clock, index);
    expect(frame.frameIndex).toBe(index); expect(frame.timelineStart).toBe(index / 65_536);
    const sample = timeRemapCfrBlendSampleV1(clock, index, { timing: "cfr", frameRate: { numerator: 65_536, denominator: 1 }, decodedFrameCount: 6_553_600_000 });
    expect(sample.lowerFrame).toBe(index); expect(sample.mix).toBe(0);
  });
  it("frame blending uses subframe source positions and authentic decoded frame EOF", () => {
    const clock = compileTimeRemapClockV1(input({ timelineDurationSeconds: 2, sourceStartSeconds: 0, sourceDurationSeconds: 2,
      outputRate: { numerator: 30, denominator: 1 }, segments: [linear(0, 1, .25, .25)] }));
    const sample = timeRemapCfrBlendSampleV1(clock, 1, { timing: "cfr", frameRate: { numerator: 30, denominator: 1 }, decodedFrameCount: 60 });
    expect(sample.lowerFrame).toBe(0); expect(sample.upperFrame).toBe(1); expect(sample.mix).toBeCloseTo(.25, 12);
    expect(() => timeRemapCfrBlendSampleV1(clock, 1, { timing: "cfr", frameRate: { numerator: 30, denominator: 1 }, decodedFrameCount: 2 })).toThrow("ACTUAL_VIDEO_EOF");
    expect(() => timeRemapCfrBlendSampleV1(clock, 0, { timing: "vfr" as "cfr", frameRate: { numerator: 30, denominator: 1 }, decodedFrameCount: 60 })).toThrow("AUTHENTIC_CFR_CLOCK_REQUIRED");
  });
  it("request mutation cannot change a compiled clock; serialized or forged clocks are not accepted", () => {
    const request = input(), clock = compileTimeRemapClockV1(request);
    request.segments[0].from.speed = 63; expect(timeRemapSourceBoundaryV1(clock, 1)).toBe(6);
    expect(Object.isFrozen(clock.segments[0].primitive)).toBe(true);
    expect(() => timeRemapSourceBoundaryV1(JSON.parse(JSON.stringify(clock)), 0)).toThrow("COMPILED_IDENTITY_REQUIRED");
  });
  it("rejects invalid curves, nonfinite values, discontinuous controls, indices and clocks", () => {
    for (const speed of [-1, NaN, Infinity, 65]) expect(() => compileTimeRemapClockV1(input({ segments: [linear(0, 1, speed, speed)] }))).toThrow();
    expect(() => compileTimeRemapClockV1(input({ segments: [] }))).toThrow("SEGMENT_COUNT_INVALID");
    const crossed = linear(0, 1, 1, 1); crossed.control1.time = .9; crossed.control2.time = .1;
    expect(() => compileTimeRemapClockV1(input({ segments: [crossed] }))).toThrow("NON_MONOTONE");
    expect(() => compileTimeRemapClockV1(input({ segments: [linear(0, .4, 1, 1), linear(.5, 1, 1, 1)] }))).toThrow("CONTINUITY");
    expect(() => compileTimeRemapClockV1(input({ segments: [linear(0, .5, 1, 1), linear(.5, 1, 2, 2)] }))).toThrow("CONTINUITY");
    expect(() => compileTimeRemapClockV1(input({ sourceStartSeconds: 100 }))).toThrow("SOURCE_START_AT_EOF");
    expect(() => compileTimeRemapClockV1(input({ outputRate: { numerator: 30.5, denominator: 1 } }))).toThrow("RATE_INVALID");
    const clock = compileTimeRemapClockV1(input());
    for (const index of [-1, .5, NaN, clock.totalOutputFrames, Number.MAX_SAFE_INTEGER + 1]) expect(() => timeRemapFrameIntervalV1(clock, index)).toThrow("FRAME_INDEX_INVALID");
    expect(() => timeRemapSourceBoundaryV1(clock, 4.01)).toThrow("TIMELINE_OUT_OF_RANGE");
    expect(() => timeRemapTimelineBoundaryV1(clock, 4.99, "first")).toThrow("SOURCE_OUT_OF_RANGE");
  });
  it("VFR interpolation brackets actual irregular PTS instead of assuming nominal FPS", () => {
    const clock = compileTimeRemapClockV1(input({ sourceStartSeconds: .5, timelineDurationSeconds: 1, sourceDurationSeconds: 2 }));
    const pts = [0, 300, 900, 1500];
    const sample = timeRemapVfrBlendSampleV1(clock, 0, { timing: "vfr", timeBase: { numerator: 1, denominator: 1000 },
      clockOrigin: { pts: 0, sourceSeconds: 0 }, decodedFrameCount: pts.length, lastFrameEndPts: 2000, ptsAt: index => pts[index] });
    expect(sample.lowerFrame).toBe(1); expect(sample.upperFrame).toBe(2); expect(sample.mix).toBeCloseTo(1 / 3, 12);
    expect(sample.lowerPts).toBe(300); expect(sample.upperPts).toBe(900);
  });
  it("VFR signed PTS and canonical source origin remain separate coordinates", () => {
    const clock = compileTimeRemapClockV1(input({ sourceStartSeconds: 10.5, timelineDurationSeconds: 1, sourceDurationSeconds: 20 }));
    const pts = [-1000, -700, -100, 500];
    const sample = timeRemapVfrBlendSampleV1(clock, 0, { timing: "vfr", timeBase: { numerator: 1, denominator: 1000 },
      clockOrigin: { pts: -1000, sourceSeconds: 10 }, decodedFrameCount: pts.length, lastFrameEndPts: 1000, ptsAt: index => pts[index] });
    expect(sample.lowerFrame).toBe(1); expect(sample.upperFrame).toBe(2); expect(sample.mix).toBeCloseTo(1 / 3, 12);
  });
  it("lazy VFR indices and ticks over2^32 inspect logarithmic points, no multi-billion frame table", () => {
    const index = 4_294_967_298, count = 5_000_000_000;
    const clock = compileTimeRemapClockV1(input({ sourceStartSeconds: index / 65_536, timelineDurationSeconds: 1, sourceDurationSeconds: 76_000 }));
    let reads = 0;
    const sample = timeRemapVfrBlendSampleV1(clock, 0, { timing: "vfr", timeBase: { numerator: 1, denominator: 65_536 },
      clockOrigin: { pts: 0, sourceSeconds: 0 }, decodedFrameCount: count, lastFrameEndPts: count, ptsAt: i => { reads++; return i; } });
    expect(sample.lowerFrame).toBe(index); expect(sample.upperFrame).toBe(index + 1); expect(sample.mix).toBe(0);
    expect(sample.lowerPts).toBe(index); expect(reads).toBeLessThanOrEqual(40); expect(reads).toBe(sample.inspectedPoints);
  });
  it("VFR last frame holds only inside its authentic duration; short video and pre-first-frame holes reject", () => {
    const clock = compileTimeRemapClockV1(input({ sourceStartSeconds: 1.75, timelineDurationSeconds: .1, sourceDurationSeconds: 4 }));
    const pts = [0, 300, 900, 1500];
    const source = { timing: "vfr" as const, timeBase: { numerator: 1, denominator: 1000 }, clockOrigin: { pts: 0, sourceSeconds: 0 },
      decodedFrameCount: pts.length, lastFrameEndPts: 2000, ptsAt: (i: number) => pts[i] };
    const sample = timeRemapVfrBlendSampleV1(clock, 0, source);
    expect(sample.lowerFrame).toBe(3); expect(sample.upperFrame).toBe(3); expect(sample.mix).toBe(0);
    expect(() => timeRemapVfrBlendSampleV1(clock, 0, { ...source, lastFrameEndPts: 1600 })).toThrow("ACTUAL_VIDEO_EOF");
    const early = compileTimeRemapClockV1(input({ sourceStartSeconds: 0, timelineDurationSeconds: 1 }));
    expect(() => timeRemapVfrBlendSampleV1(early, 0, { ...source, ptsAt: i => pts[i] + 100 })).toThrow("SOURCE_SAMPLE_OUTSIDE_PRESENTATION");
  });
  it("unsafe/unordered VFR points and missing authentic end metadata are rejected", () => {
    const clock = compileTimeRemapClockV1(input({ sourceStartSeconds: .5, timelineDurationSeconds: 1, sourceDurationSeconds: 2 }));
    const source = { timing: "vfr" as const, timeBase: { numerator: 1, denominator: 1000 }, clockOrigin: { pts: 0, sourceSeconds: 0 },
      decodedFrameCount: 4, lastFrameEndPts: 2000, ptsAt: (i: number) => [0, 300, 900, 1500][i] };
    expect(() => timeRemapVfrBlendSampleV1(clock, 0, { ...source, ptsAt: i => i === 1 ? NaN : source.ptsAt(i) })).toThrow("PRESENTATION_TICK_UNSAFE");
    expect(() => timeRemapVfrBlendSampleV1(clock, 0, { ...source, ptsAt: i => i === 1 ? 1600 : source.ptsAt(i) })).toThrow("PRESENTATION_ORDER_INVALID");
    expect(() => timeRemapVfrBlendSampleV1(clock, 0, { ...source, decodedFrameCount: Number.MAX_SAFE_INTEGER + 1 })).toThrow("PRESENTATION_INDEX_INVALID");
    expect(() => timeRemapVfrBlendSampleV1(clock, 0, { ...source, lastFrameEndPts: 1500 })).toThrow("PRESENTATION_INDEX_INVALID");
  });
});
