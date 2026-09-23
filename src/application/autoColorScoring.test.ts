import { describe, expect, it } from "vitest";
import { analyzeShotColor } from "../color/shotColorAnalysis";
import { selectAutoColorCandidate, type AutoColorCandidate } from "./autoColorScoring";

function candidate(exposure: number, levels = [.08, .1, .12], tint = [1, 1, 1]): AutoColorCandidate {
  return { exposure, measurements: analyzeShotColor(levels.map((level, i) => ({
    sampleId: `s${i}`, timeSeconds: i, width: 100, height: 1, format: "rgb32f" as const,
    primaries: "bt709" as const, transfer: "linear" as const, range: "full" as const,
    pixels: new Float32Array(Array.from({ length: 100 }, (_, p) => tint.map(t => Math.min(1, level * (.5 + p / 100) * t))).flat()),
  }))) };
}
describe("measured exposure candidate technical proxy", () => {
  it("selects a real measured improvement and leaves WB/art unmeasured", () => {
    const result = selectAutoColorCandidate([candidate(0), candidate(1, [.16, .2, .24])], 0, .2);
    expect(result.selectedIndex).toBe(1);
    // Representative frame .16 is still > .25 stop from target: improvement is review-only.
    expect(result.status).toBe("target_unreachable");
    expect(result.whiteBalance).toBe("unmeasured"); expect(result.aestheticQuality).toBe("unmeasured");
  });
  it("accepts a reachable target and preserves an already-good baseline", () => {
    expect(selectAutoColorCandidate([candidate(0, [.1]), candidate(1, [.2])], 0, .2).status).toBe("candidate");
    expect(selectAutoColorCandidate([candidate(0, [.2]), candidate(.01, [.201])], 0, .2).status).toBe("unchanged");
  });
  it("rejects new clipping and increased temporal spread", () => {
    const clipped = selectAutoColorCandidate([candidate(0, [.5]), candidate(1, [1])], 0, .9);
    expect(clipped.candidates[1].accepted).toBe(false);
    expect(clipped.candidates[1].reasons.some(r => r.includes("white") || r.includes("endpoint"))).toBe(true);
    const spread = selectAutoColorCandidate([candidate(0, [.1, .1]), candidate(.5, [.1, .2])], 0, .15);
    expect(spread.candidates[1].reasons).toContain("representative-temporal-spread-increase");
  });
  it("does not repair all-black, white or quantized flat fields by assertion", () => {
    for (const value of [0, 1, .2]) {
      const c = candidate(0, [value]);
      c.measurements = analyzeShotColor([{ sampleId: "s0", timeSeconds: 0, width: 10, height: 1,
        format: "rgb32f", transfer: "linear", primaries: "bt709", range: "full", pixels: new Float32Array(30).fill(value) }]);
      expect(selectAutoColorCandidate([c], 0, .2).status).toBe("target_unreachable");
    }
  });
  it("requires explicit night-scene target and never interprets color cast as WB", () => {
    expect(() => selectAutoColorCandidate([candidate(0)], 0, undefined as unknown as number)).toThrow();
    const night = candidate(0, [.025]);
    expect(selectAutoColorCandidate([night], 0, .025).status).toBe("unchanged");
    expect(selectAutoColorCandidate([candidate(0, [.2], [1, .5, .3])], 0, .2).whiteBalance).toBe("unmeasured");
  });
  it("prefers the smaller exposure change among technically equivalent improvements", () => {
    const result = selectAutoColorCandidate([candidate(0, [.1]), candidate(.5, [.2]), candidate(1, [.2])], 0, .2);
    expect(result.selectedIndex).toBe(1);
  });
  it("rejects malformed values, mismatched samples, duplicate baseline and excessive search", () => {
    for (const mutate of [
      (c: AutoColorCandidate) => { c.measurements.frames[0].linearRelativeY.p50 = NaN; },
      (c: AutoColorCandidate) => { c.measurements.frames[0].nearWhite.fraction = .8; },
      (c: AutoColorCandidate) => { c.measurements.frames[0].sampleId = "other"; },
      (c: AutoColorCandidate) => { c.measurements.frames[0].timeSeconds = .1; },
      (c: AutoColorCandidate) => { c.exposure = 2; },
    ]) { const other = candidate(.5); mutate(other); expect(() => selectAutoColorCandidate([candidate(0), other], 0, .2)).toThrow(); }
    expect(() => selectAutoColorCandidate([candidate(0), candidate(0)], 0, .2)).toThrow();
    expect(() => selectAutoColorCandidate([candidate(1)], 0, .2)).toThrow();
    expect(() => selectAutoColorCandidate(Array.from({ length: 10 }, (_, i) => candidate(i / 10)), 0, .2)).toThrow();
  });
});
