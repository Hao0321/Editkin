import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { defineBackgroundMotion, type BackgroundMotionItem, type MotionFrameSize } from "../../types";
import { B01_LOOP_CYCLES, B01_LOOP_SECONDS, B01_halftoneExpand } from "./B01_halftoneExpand";
import { B02_LOOP_CYCLES, B02_LOOP_SECONDS, B02_halftoneWave } from "./B02_halftoneWave";
import { B03_LOOP_CYCLES, B03_LOOP_SECONDS, B03_comicDots } from "./B03_comicDots";
import { B04_LOOP_CYCLES, B04_LOOP_SECONDS, B04_halftoneSweep } from "./B04_halftoneSweep";
import { B05_LOOP_CYCLES, B05_LOOP_SECONDS, B05_spiralDots } from "./B05_spiralDots";
import { B06_LOOP_CYCLES, B06_LOOP_SECONDS, B06_halftoneRings } from "./B06_halftoneRings";
import { B07_LOOP_CYCLES, B07_LOOP_SECONDS, B07_halftoneChecker } from "./B07_halftoneChecker";
import { B08_LOOP_CYCLES, B08_LOOP_SECONDS, B08_halftoneSun } from "./B08_halftoneSun";
import { B09_LOOP_CYCLES, B09_LOOP_SECONDS, B09_perspectiveGrid } from "./B09_perspectiveGrid";
import { B10_LOOP_CYCLES, B10_LOOP_SECONDS, B10_gridZoom } from "./B10_gridZoom";
import { B11_LOOP_CYCLES, B11_LOOP_SECONDS, B11_gridWave } from "./B11_gridWave";
import { B12_LOOP_CYCLES, B12_LOOP_SECONDS, B12_rotatingGrid } from "./B12_rotatingGrid";
import { B13_LOOP_CYCLES, B13_LOOP_SECONDS, B13_isometricGrid } from "./B13_isometricGrid";
import { B14_LOOP_CYCLES, B14_LOOP_SECONDS, B14_hexGrid } from "./B14_hexGrid";
import { B15_LOOP_CYCLES, B15_LOOP_SECONDS, B15_truchetTiles } from "./B15_truchetTiles";
import { B16_LOOP_CYCLES, B16_LOOP_SECONDS, B16_weaveGrid } from "./B16_weaveGrid";
import { B17_LOOP_CYCLES, B17_LOOP_SECONDS, B17_speedLines } from "./B17_speedLines";
import { B18_LOOP_CYCLES, B18_LOOP_SECONDS, B18_horizontalLines } from "./B18_horizontalLines";
import { B19_LOOP_CYCLES, B19_LOOP_SECONDS, B19_lineBurst } from "./B19_lineBurst";
import { B20_LOOP_CYCLES, B20_LOOP_SECONDS, B20_waveLines } from "./B20_waveLines";
import { B21_LOOP_CYCLES, B21_LOOP_SECONDS, B21_rippleRings } from "./B21_rippleRings";
import { B22_LOOP_CYCLES, B22_LOOP_SECONDS, B22_stripeTwist } from "./B22_stripeTwist";
import { B23_LOOP_CYCLES, B23_LOOP_SECONDS, B23_lineTunnel } from "./B23_lineTunnel";
import { B24_LOOP_CYCLES, B24_LOOP_SECONDS, B24_crosshatch } from "./B24_crosshatch";
import { B25_LOOP_CYCLES, B25_LOOP_SECONDS, B25_circlePop } from "./B25_circlePop";
import { B26_LOOP_CYCLES, B26_LOOP_SECONDS, B26_floatingShapes } from "./B26_floatingShapes";
import { B27_LOOP_CYCLES, B27_LOOP_SECONDS, B27_shapeTunnel } from "./B27_shapeTunnel";
import { B28_LOOP_CYCLES, B28_LOOP_SECONDS, B28_orbitShapes } from "./B28_orbitShapes";
import { B29_LOOP_CYCLES, B29_LOOP_SECONDS, B29_kaleidoscope } from "./B29_kaleidoscope";
import { B30_LOOP_CYCLES, B30_LOOP_SECONDS, B30_confettiFall } from "./B30_confettiFall";
import { B31_LOOP_CYCLES, B31_LOOP_SECONDS, B31_blobShapes } from "./B31_blobShapes";
import { B32_LOOP_CYCLES, B32_LOOP_SECONDS, B32_pinwheels } from "./B32_pinwheels";
import { B33_LOOP_CYCLES, B33_LOOP_SECONDS, B33_minimalBlocks } from "./B33_minimalBlocks";
import { B34_LOOP_CYCLES, B34_LOOP_SECONDS, B34_minimalCircle } from "./B34_minimalCircle";
import { B35_LOOP_CYCLES, B35_LOOP_SECONDS, B35_bauhausShapes } from "./B35_bauhausShapes";
import { B36_LOOP_CYCLES, B36_LOOP_SECONDS, B36_minimalArcs } from "./B36_minimalArcs";
import { B37_LOOP_CYCLES, B37_LOOP_SECONDS, B37_minimalStripes } from "./B37_minimalStripes";
import { B38_LOOP_CYCLES, B38_LOOP_SECONDS, B38_minimalSquare } from "./B38_minimalSquare";
import { B39_LOOP_CYCLES, B39_LOOP_SECONDS, B39_minimalWave } from "./B39_minimalWave";
import { B40_LOOP_CYCLES, B40_LOOP_SECONDS, B40_nestedSquares } from "./B40_nestedSquares";
import { backgroundLoop, backgroundSpeedQuarters } from "./backgroundLoop";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };

/** Every implemented background: the generator, and the base loop and cycles its module declares. */
const BACKGROUNDS = {
  B01: { implementation: B01_halftoneExpand, loopSeconds: B01_LOOP_SECONDS, loopCycles: B01_LOOP_CYCLES },
  B02: { implementation: B02_halftoneWave, loopSeconds: B02_LOOP_SECONDS, loopCycles: B02_LOOP_CYCLES },
  B03: { implementation: B03_comicDots, loopSeconds: B03_LOOP_SECONDS, loopCycles: B03_LOOP_CYCLES },
  B04: { implementation: B04_halftoneSweep, loopSeconds: B04_LOOP_SECONDS, loopCycles: B04_LOOP_CYCLES },
  B05: { implementation: B05_spiralDots, loopSeconds: B05_LOOP_SECONDS, loopCycles: B05_LOOP_CYCLES },
  B06: { implementation: B06_halftoneRings, loopSeconds: B06_LOOP_SECONDS, loopCycles: B06_LOOP_CYCLES },
  B07: { implementation: B07_halftoneChecker, loopSeconds: B07_LOOP_SECONDS, loopCycles: B07_LOOP_CYCLES },
  B08: { implementation: B08_halftoneSun, loopSeconds: B08_LOOP_SECONDS, loopCycles: B08_LOOP_CYCLES },
  B09: { implementation: B09_perspectiveGrid, loopSeconds: B09_LOOP_SECONDS, loopCycles: B09_LOOP_CYCLES },
  B10: { implementation: B10_gridZoom, loopSeconds: B10_LOOP_SECONDS, loopCycles: B10_LOOP_CYCLES },
  B11: { implementation: B11_gridWave, loopSeconds: B11_LOOP_SECONDS, loopCycles: B11_LOOP_CYCLES },
  B12: { implementation: B12_rotatingGrid, loopSeconds: B12_LOOP_SECONDS, loopCycles: B12_LOOP_CYCLES },
  B13: { implementation: B13_isometricGrid, loopSeconds: B13_LOOP_SECONDS, loopCycles: B13_LOOP_CYCLES },
  B14: { implementation: B14_hexGrid, loopSeconds: B14_LOOP_SECONDS, loopCycles: B14_LOOP_CYCLES },
  B15: { implementation: B15_truchetTiles, loopSeconds: B15_LOOP_SECONDS, loopCycles: B15_LOOP_CYCLES },
  B16: { implementation: B16_weaveGrid, loopSeconds: B16_LOOP_SECONDS, loopCycles: B16_LOOP_CYCLES },
  B17: { implementation: B17_speedLines, loopSeconds: B17_LOOP_SECONDS, loopCycles: B17_LOOP_CYCLES },
  B18: { implementation: B18_horizontalLines, loopSeconds: B18_LOOP_SECONDS, loopCycles: B18_LOOP_CYCLES },
  B19: { implementation: B19_lineBurst, loopSeconds: B19_LOOP_SECONDS, loopCycles: B19_LOOP_CYCLES },
  B20: { implementation: B20_waveLines, loopSeconds: B20_LOOP_SECONDS, loopCycles: B20_LOOP_CYCLES },
  B21: { implementation: B21_rippleRings, loopSeconds: B21_LOOP_SECONDS, loopCycles: B21_LOOP_CYCLES },
  B22: { implementation: B22_stripeTwist, loopSeconds: B22_LOOP_SECONDS, loopCycles: B22_LOOP_CYCLES },
  B23: { implementation: B23_lineTunnel, loopSeconds: B23_LOOP_SECONDS, loopCycles: B23_LOOP_CYCLES },
  B24: { implementation: B24_crosshatch, loopSeconds: B24_LOOP_SECONDS, loopCycles: B24_LOOP_CYCLES },
  B25: { implementation: B25_circlePop, loopSeconds: B25_LOOP_SECONDS, loopCycles: B25_LOOP_CYCLES },
  B26: { implementation: B26_floatingShapes, loopSeconds: B26_LOOP_SECONDS, loopCycles: B26_LOOP_CYCLES },
  B27: { implementation: B27_shapeTunnel, loopSeconds: B27_LOOP_SECONDS, loopCycles: B27_LOOP_CYCLES },
  B28: { implementation: B28_orbitShapes, loopSeconds: B28_LOOP_SECONDS, loopCycles: B28_LOOP_CYCLES },
  B29: { implementation: B29_kaleidoscope, loopSeconds: B29_LOOP_SECONDS, loopCycles: B29_LOOP_CYCLES },
  B30: { implementation: B30_confettiFall, loopSeconds: B30_LOOP_SECONDS, loopCycles: B30_LOOP_CYCLES },
  B31: { implementation: B31_blobShapes, loopSeconds: B31_LOOP_SECONDS, loopCycles: B31_LOOP_CYCLES },
  B32: { implementation: B32_pinwheels, loopSeconds: B32_LOOP_SECONDS, loopCycles: B32_LOOP_CYCLES },
  B33: { implementation: B33_minimalBlocks, loopSeconds: B33_LOOP_SECONDS, loopCycles: B33_LOOP_CYCLES },
  B34: { implementation: B34_minimalCircle, loopSeconds: B34_LOOP_SECONDS, loopCycles: B34_LOOP_CYCLES },
  B35: { implementation: B35_bauhausShapes, loopSeconds: B35_LOOP_SECONDS, loopCycles: B35_LOOP_CYCLES },
  B36: { implementation: B36_minimalArcs, loopSeconds: B36_LOOP_SECONDS, loopCycles: B36_LOOP_CYCLES },
  B37: { implementation: B37_minimalStripes, loopSeconds: B37_LOOP_SECONDS, loopCycles: B37_LOOP_CYCLES },
  B38: { implementation: B38_minimalSquare, loopSeconds: B38_LOOP_SECONDS, loopCycles: B38_LOOP_CYCLES },
  B39: { implementation: B39_minimalWave, loopSeconds: B39_LOOP_SECONDS, loopCycles: B39_LOOP_CYCLES },
  B40: { implementation: B40_nestedSquares, loopSeconds: B40_LOOP_SECONDS, loopCycles: B40_LOOP_CYCLES },
} as const;
const QUARTER_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
/** The seam matrix (DESIGN §8): every speed that needs a stretch or a multiple, and both density extremes. */
const SEAM_VARIANTS = [{ speed: 0.25 }, { speed: 0.5 }, { speed: 0.75 }, { speed: 1.5 }, { speed: 2 }, { density: 0.5 }, { density: 2 }] as const;

/** A frame's numbers (colours stripped), sorted: its geometry as a multiset, independent of drawing order. */
const numbers = (svg: string) => (svg.replace(/#[0-9A-Fa-f]{6}/g, "").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).sort((a, b) => a - b);
function maxDifference(a: readonly number[], b: readonly number[]): number {
  let worst = 0;
  for (let index = 0; index < a.length; index += 1) worst = Math.max(worst, Math.abs(a[index] - b[index]));
  return worst;
}

describe("backgroundLoop", () => {
  it("stretches the loop by the smallest m in {1, 2, 4} that makes the cycle count whole", () => {
    const loop = (base: number, cycles: number, speed: number) => ({ ...backgroundLoop(base, cycles, speed) });
    expect(loop(4, 1, 1)).toEqual({ loopSeconds: 4, cycles: 1, stretch: 1 });
    expect(loop(4, 1, 0.5)).toEqual({ loopSeconds: 8, cycles: 1, stretch: 2 });
    expect(loop(4, 1, 0.25)).toEqual({ loopSeconds: 16, cycles: 1, stretch: 4 });
    expect(loop(4, 1, 0.75)).toEqual({ loopSeconds: 16, cycles: 3, stretch: 4 });
    expect(loop(4, 1, 1.25)).toEqual({ loopSeconds: 16, cycles: 5, stretch: 4 });
    expect(loop(4, 1, 1.5)).toEqual({ loopSeconds: 8, cycles: 3, stretch: 2 });
    expect(loop(4, 1, 2)).toEqual({ loopSeconds: 4, cycles: 2, stretch: 1 });
    expect(loop(4, 2, 0.5)).toEqual({ loopSeconds: 4, cycles: 1, stretch: 1 });
    expect(loop(4, 2, 0.25)).toEqual({ loopSeconds: 8, cycles: 1, stretch: 2 });
    expect(loop(4, 2, 0.75)).toEqual({ loopSeconds: 8, cycles: 3, stretch: 2 });
    expect(loop(6, 3, 0.75)).toEqual({ loopSeconds: 24, cycles: 9, stretch: 4 });
    expect(Object.isFrozen(backgroundLoop(4, 1, 1))).toBe(true);
  });

  it("never rounds: the motion rate is exactly speed × the base rate, the cycle count whole, and no smaller stretch would do", () => {
    for (const base of [2, 4, 6, 8, 12]) {
      for (const cycles of [1, 2, 3]) {
        for (const speed of QUARTER_SPEEDS) {
          const result = backgroundLoop(base, cycles, speed);
          expect(Number.isInteger(result.cycles) && result.cycles >= 1).toBe(true);
          expect(result.cycles / result.loopSeconds).toBeCloseTo((cycles * speed) / base, 12);
          expect(result.loopSeconds).toBe(base * result.stretch);
          for (const smaller of [1, 2, 4].filter(m => m < result.stretch)) expect(Number.isInteger(cycles * speed * smaller)).toBe(false);
        }
      }
    }
  });

  it("guards its inputs (speed is snapped to quarters; the schema already does that for real params)", () => {
    expect([backgroundSpeedQuarters(1), backgroundSpeedQuarters(0.3), backgroundSpeedQuarters(0.01)]).toEqual([4, 1, 1]);
    for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => backgroundLoop(4, 1, speed)).toThrow(/speed/);
    for (const cycles of [0, 1.5, -2]) expect(() => backgroundLoop(4, cycles, 1)).toThrow(/cycles/);
    for (const base of [0, -4, Number.NaN]) expect(() => backgroundLoop(base, 1, 1)).toThrow(/loop/);
    const generate = () => "";
    expect(defineBackgroundMotion("B99", generate, { loopSeconds: 4, loopCycles: 2 })).toMatchObject({ loopSeconds: 4, loopCycles: 2 });
    expect(() => defineBackgroundMotion("B99", generate, { loopSeconds: 0 })).toThrow(/loopSeconds/);
    expect(() => defineBackgroundMotion("B99", generate, { loopCycles: 0.5 })).toThrow(/loopCycles/);
  });
});

describe("background loop periods (B01–B40)", () => {
  it("every generator declares its base loop and cycles, and the catalog item and its period agree with them", () => {
    for (const [id, declared] of Object.entries(BACKGROUNDS)) {
      const item = getMotionLibraryItem(id) as BackgroundMotionItem;
      expect(item.implemented, id).toBe(true);
      expect(declared.implementation, id).toMatchObject({ id, kind: "background", loopSeconds: declared.loopSeconds, loopCycles: declared.loopCycles });
      expect([item.loopSeconds, item.loopCycles, item.defaultDurationSeconds], id).toEqual([declared.loopSeconds, declared.loopCycles, declared.loopSeconds]);
      expect(item.defaultParams.speed, id).toBe(1);
      expect(motionBackgroundLoopSeconds(item, item.defaultParams), id).toBe(item.loopSeconds);
      for (const speed of QUARTER_SPEEDS) {
        const period = motionBackgroundLoopSeconds(item, { speed });
        expect(period, `${id} ×${speed}`).toBe(backgroundLoop(declared.loopSeconds, declared.loopCycles, speed).loopSeconds);
        // Every period fits one clip (the schema allows up to 120 s).
        expect(period, `${id} ×${speed}`).toBeLessThanOrEqual(48);
      }
    }
  });

  for (const id of Object.keys(BACKGROUNDS)) {
    it(`${id} loops seamlessly at its computed period: ×0.25 to ×2 speed and ×0.5 and ×2 density, in both formats`, () => {
      const item = getMotionLibraryItem(id) as BackgroundMotionItem;
      for (const size of [PORTRAIT, LANDSCAPE]) {
        for (const input of SEAM_VARIANTS) {
          const params = resolveMotionLibraryParams(item, input);
          const period = motionBackgroundLoopSeconds(item, params), label = `${id} ${size.width}x${size.height} ${JSON.stringify(input)} period ${period}s`;
          const frame = (t: number) => generateMotionFrame(item, params, t, size);
          const start = frame(0);
          expect(frame(period), label).toBe(start);
          // Continuous across the seam: the instant before the period matches t = 0 to a fraction of a pixel.
          const before = numbers(frame(period - 1e-5)), at = numbers(start);
          expect(before.length, label).toBe(at.length);
          expect(maxDifference(before, at), label).toBeLessThan(0.25);
          // Where the loop stretched, the base loop alone is not a seam: the speed really changed the rate.
          if (backgroundLoop(item.loopSeconds, item.loopCycles, params.speed).stretch > 1) expect(frame(item.loopSeconds), label).not.toBe(start);
        }
      }
    }, 30_000);
  }

  for (const id of Object.keys(BACKGROUNDS)) {
    it(`${id}: speed is a true rate, byte for byte (×2 at t/2, ×0.5 at 2t and ×0.25 at 4t all show ×1 at t)`, () => {
      const item = getMotionLibraryItem(id) as BackgroundMotionItem;
      for (const size of [PORTRAIT, LANDSCAPE]) {
        const frame = (t: number, speed: number) => generateMotionFrame(item, resolveMotionLibraryParams(item, { speed }), t, size);
        const reference = frame(0.4, 1);
        expect(frame(0.2, 2), `${id} ×2`).toBe(reference);
        expect(frame(0.8, 0.5), `${id} ×0.5`).toBe(reference);
        expect(frame(1.6, 0.25), `${id} ×0.25`).toBe(reference);
      }
    }, 30_000);
  }
});
