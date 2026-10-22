import { describe, expect, it } from "vitest";
import { cubicInOut } from "./easing";
import { MOTION_FONT_REGISTRY, MOTION_FONT_ROLES, motionAvailableWeights, weightLadderAt } from "./glyphs";

describe("motionAvailableWeights", () => {
  it("lists only the static weights each role really has", () => {
    for (const role of MOTION_FONT_ROLES) expect(motionAvailableWeights(role)).toEqual(MOTION_FONT_REGISTRY[role].weights);
    expect(motionAvailableWeights("serif")).toEqual([200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900]);
    expect(motionAvailableWeights("hand")).toEqual([700]);
    expect(() => motionAvailableWeights("comic" as never)).toThrow(/Unknown/);
  });
});

describe("weightLadderAt", () => {
  it("steps through real rungs with hard cuts by default", () => {
    const at = (p: number) => weightLadderAt("serif", 200, 900, p, { step: 100 });
    expect(at(0).rungs).toEqual([200, 300, 400, 500, 600, 700, 800, 900]);
    expect([at(0).weightA, at(1).weightA, at(-3).weightA, at(7).weightA]).toEqual([200, 900, 200, 900]);
    // Rung k holds while the linear weight is within ±50 of it: 200 + 700p crosses 250 at p = 1/14.
    expect(at(1 / 14 - 1e-9).weightA).toBe(200);
    expect(at(1 / 14).weightA).toBe(300);
    expect(at(0.5).weightA).toBe(600); // 550: exactly the 500 → 600 midpoint, where the step happens
    for (let p = 0; p <= 1; p += 0.01) {
      const sample = at(p);
      expect([sample.weightA === sample.weightB, sample.mix, sample.heavierOpacity]).toEqual([true, 0, 1]);
      expect(motionAvailableWeights("serif")).toContain(sample.weightA);
    }
    expect(weightLadderAt("serif", 200, 900, 0).rungs).toHaveLength(15); // default: every real weight
  });
  it("crossfades over the given width around each step, lighter solid under the heavier", () => {
    const crossfade = 0.04;
    const centre = 1 / 14; // the 200 → 300 step
    const before = weightLadderAt("serif", 200, 900, centre - 0.03, { step: 100, crossfade });
    expect([before.weightA, before.weightB, before.mix]).toEqual([200, 200, 0]);
    const inside = weightLadderAt("serif", 200, 900, centre + 0.01, { step: 100, crossfade });
    expect([inside.weightA, inside.weightB, inside.lighter, inside.heavier]).toEqual([200, 300, 200, 300]);
    expect(inside.mix).toBeCloseTo(0.75, 9);
    expect(inside.heavierOpacity).toBeCloseTo(0.75, 9);
    const down = weightLadderAt("serif", 900, 200, 1 - (centre + 0.01), { step: 100, crossfade });
    expect([down.weightA, down.weightB, down.lighter, down.heavier]).toEqual([300, 200, 200, 300]);
    expect(down.mix).toBeCloseTo(0.25, 9);
    expect(down.heavierOpacity).toBeCloseTo(0.75, 9); // same picture as the ascending ramp at the mirrored time
  });
  it("centres crossfades on the eased crossing times, so T63's 2-frame dissolves last 2 frames", () => {
    const fps = 30, ramp = 0.75, crossfade = 2 / (fps * ramp);
    const options = { step: 100, crossfade, ease: cubicInOut };
    // Boundary k sits where cubicInOut(u) reaches (k + 0.5) / 7.
    const first = Math.cbrt((0.5 / 7) / 4);
    expect(weightLadderAt("serif", 200, 900, first - crossfade / 2 + 1e-6, options).mix).toBeLessThan(1e-3);
    expect(weightLadderAt("serif", 200, 900, first, options).mix).toBeCloseTo(0.5, 6);
    expect(weightLadderAt("serif", 200, 900, first + crossfade / 2 - 1e-6, options).mix).toBeGreaterThan(0.999);
    // Frame by frame over the ramp: only neighbouring rungs mix, and the weight never goes backwards.
    let previous = 200;
    for (let frame = 0; frame <= Math.ceil(ramp * fps); frame += 1) {
      const sample = weightLadderAt("serif", 200, 900, Math.min(1, frame / (fps * ramp)), options);
      const index = sample.rungs.indexOf(sample.weightA);
      if (sample.mix > 0) expect(sample.rungs[index + 1]).toBe(sample.weightB);
      expect(sample.lighter).toBeGreaterThanOrEqual(previous);
      previous = sample.lighter;
    }
    expect(previous).toBe(900);
  });
  it("never synthesizes a weight the family lacks", () => {
    for (let p = 0; p <= 1; p += 0.125) {
      const hand = weightLadderAt("hand", 200, 900, p, { crossfade: 0.1 });
      expect([hand.weightA, hand.weightB, hand.mix]).toEqual([700, 700, 0]);
    }
    expect(weightLadderAt("display", 100, 1000, 1, { step: 100 }).weightA).toBe(900);
    expect(weightLadderAt("serif", 100, 900, 0, { step: 100 }).rungs[0]).toBe(200);
    expect(weightLadderAt("latin_round", 300, 900, 1).rungs).toEqual([300, 350, 400, 450, 500, 550, 600, 650, 700]);
  });
  it("validates its inputs", () => {
    expect(() => weightLadderAt("serif", 200, 900, Number.NaN)).toThrow(/finite/);
    expect(() => weightLadderAt("serif", 200, 900, 0.5, { step: 0 })).toThrow(/step/);
    expect(() => weightLadderAt("serif", 200, 900, 0.5, { step: 0.1 })).toThrow(/too small/);
    expect(() => weightLadderAt("serif", 200, 900, 0.5, { crossfade: 2 })).toThrow(/crossfade/);
  });
});
