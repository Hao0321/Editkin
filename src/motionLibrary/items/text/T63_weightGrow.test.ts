import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache, motionAvailableWeights } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T63_CROSSFADE, T63_HOLD, T63_RAMP, weightAt, weightBlock, weightGrowPlan } from "./T63_weightGrow";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T63";
const LOOP = 1.8;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: 200, mid ramp, near 900, the hold, the way down. */
const TIMES = [0, 0.3, 0.6, 0.9, 1.4] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "3f58db03d5214c49278b917a7d3abe4646c684dd6357ce2dd4ac049c369b22b2",
    "e2b767310baa2cf25cc2727dfbc1fe4c22771065283e3c83e1a7c3fe2c2f28b7",
    "66407153fa9fa8a0a819416914eeb0e65f097757e24a15b6017f8bd44eabfa7b",
    "66407153fa9fa8a0a819416914eeb0e65f097757e24a15b6017f8bd44eabfa7b",
    "d757d84eba6cc205194ad4eef452057ce885bee17be6b23b3c9480f9772470ee",
  ],
  landscape: [
    "82cbe106202dbbf32b93692d3c941a8d755bf56fbd47ab3bf3aa54c5d904ab72",
    "bff9b0a4ca1d98bdd03a06a9b3911cd35bd4b6407b67b6271d4c8f9a09aff10f",
    "adb26413099b539e8aab404082b98e2263fc8549a7065759f4f9b5d4ad8a29fe",
    "adb26413099b539e8aab404082b98e2263fc8549a7065759f4f9b5d4ad8a29fe",
    "aec307668149ec0675282e522ff0781088a4960dc0b5c598ac975c5d3de0ad5c",
  ],
};

const item = getMotionLibraryItem(ID) as TextMotionItem;
const params = (input?: unknown): TextMotionParams => resolveMotionLibraryParams(item, input);
function frameText(t: number, size: MotionFrameSize, input?: unknown): string {
  const frame = generateAnyMotionFrame(item, params(input), t, size);
  return "svg" in frame ? frame.svg : frame.matte;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const header = (size: MotionFrameSize) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`;
const plateRect = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T63 Weight Grow", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format and plate)", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { plate: item.showcasePlate }, { font: "display" }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(54 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    for (let index = 0; index < 54; index += 1) frameText(index / 30, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.3, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.3, PORTRAIT)).toBe(first);
  });

  it("ramps 200 → 900 in 0.75 s, holds 0.3 s, ramps back, through the real serif weights only (100 steps, two-frame crossfades)", () => {
    expect([T63_RAMP, T63_HOLD, T63_CROSSFADE]).toEqual([0.75, 0.3, 2 / 30]);
    expect(weightAt("serif", 0)).toMatchObject({ lighter: 200, heavier: 200, heavierOpacity: 1 });
    expect(weightAt("serif", T63_RAMP + T63_HOLD / 2)).toMatchObject({ lighter: 900, heavier: 900 });
    expect(weightAt("serif", LOOP - 1e-6).lighter).toBe(200);
    const real = new Set(motionAvailableWeights("serif"));
    const seen = new Set<number>();
    let crossfadeFrames = 0;
    for (let frame = 0; frame < 54 * 4; frame += 1) {
      const u = frame / 120;
      const rung = weightAt("serif", u);
      expect(real.has(rung.lighter) && real.has(rung.heavier), `u=${u}`).toBe(true);
      // Never more than one step apart, and every rung is a multiple of 100.
      expect(rung.heavier - rung.lighter).toBeLessThanOrEqual(100);
      expect(rung.lighter % 100).toBe(0);
      seen.add(rung.lighter).add(rung.heavier);
      if (rung.heavier !== rung.lighter) crossfadeFrames += 1;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([200, 300, 400, 500, 600, 700, 800, 900]);
    // 14 steps (7 up, 7 down), each a 2/30 s crossfade (8 frames at 120 fps) where the steps are far apart; in the fast
    // middle of the cubicInOut ramp the steps come quicker than that and the crossfades abut.
    expect(crossfadeFrames).toBeGreaterThanOrEqual(14 * 4);
    expect(crossfadeFrames).toBeLessThanOrEqual(14 * 8 + 2);
    // Bold is never faked: no stroke anywhere.
    for (const t of TIMES) expect(frameText(t, PORTRAIT)).not.toContain("stroke");
  });

  it("every weight is set at one size on the same pen grid: the word thickens in place", () => {
    const plan = weightGrowPlan(params(), PORTRAIT);
    const light = weightBlock(plan, 200), heavy = weightBlock(plan, 900);
    expect(light.block.size).toBe(heavy.block.size);
    expect([light.x, light.y]).toEqual([heavy.x, heavy.y]);
    const centre = (block: typeof light) => [block.x + (block.block.inkBox!.x0 + block.block.inkBox!.x1) / 2, block.y + (block.block.inkBox!.y0 + block.block.inkBox!.y1) / 2];
    const [lx, ly] = centre(light), [hx, hy] = centre(heavy);
    expect(Math.abs(lx - hx)).toBeLessThan(0.03 * plan.fontSize);
    expect(Math.abs(ly - hy)).toBeLessThan(0.03 * plan.fontSize);
  });

  it("the heaviest word fills 80–90% of the safe width and stays inside the safe box", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["粗"] }, { lines: ["越來", "越粗"] }, { font: "display" }]) {
        const plan = weightGrowPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.box.y1 - plan.box.y0, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        expect(plan.box.x0).toBeGreaterThanOrEqual(safe.x0);
        expect(plan.box.x1).toBeLessThanOrEqual(safe.x1);
        expect(plan.box.y0).toBeGreaterThanOrEqual(safe.y0);
        expect(plan.box.y1).toBeLessThanOrEqual(safe.y1);
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
      }
    }
  });

  it("one colour: ink on the cream card, cream on the dark card; a single-weight face stays still", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("paper");
    expect(item.defaultParams.font).toBe("serif");
    expect(weightGrowPlan(params({ plate: "paper" }), PORTRAIT).color).toBe(palette.ink);
    expect(weightGrowPlan(params(), PORTRAIT).color).toBe(palette.paper);
    expect(frameText(0.3, PORTRAIT, { font: "hand" })).toBe(frameText(0.9, PORTRAIT, { font: "hand" }));
  });

  it("draws palette roles only: two unrelated palettes share no colour", () => {
    for (const t of TIMES) {
      const a = colours(frameText(t, PORTRAIT, { palette: PALETTE_A, plate: "bg" }));
      const b = colours(frameText(t, PORTRAIT, { palette: PALETTE_B, plate: "bg" }));
      expect([...a].filter(colour => b.has(colour)), `t=${t}`).toEqual([]);
    }
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size) + plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        for (const plate of ["accent", "paper"] as const) {
          const onPlate = frameText(t, size, { plate });
          expect(onPlate.startsWith(header(size) + plateRect(size, palette[plate]))).toBe(true);
          expect(maskColors(onPlate.replace(plateRect(size, palette[plate]), ""))).toBe(maskColors(none));
        }
      }
    }
  });
});
