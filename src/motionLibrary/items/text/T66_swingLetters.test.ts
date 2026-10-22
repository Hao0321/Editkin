import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { swingAngle, swingLettersPlan, T66_PHASE_STEP, T66_PIVOT, T66_SPREAD, T66_SWING } from "./T66_swingLetters";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T66";
const LOOP = 1.6;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.3, 0.6, 1, 1.4] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "2e697b05bf240efc3adc86ed8e3cf14883ec402915891f51a0145f1d74ad21ca",
    "4feef29b6c9149f52a9071d7c805a4d3dd361bd07fd8a1e139333ae08cdb856b",
    "1cd4e714693fd869c6346ba5812294fca7e9789b55537dc9b0cb5c03b848d008",
    "8b831db163825c80157ce6a3b5fd97b6f2b3c477430564e55022ad5271061dbc",
    "83cbd9877cee3339660a6c07cdd481b0be59b7035f368e84b60fa7a9f6aac1e3",
  ],
  landscape: [
    "6d851ce97f0d4d7b24e14c9065fa962570b2e49aedbdc8a48ae33c1f52593226",
    "2abc6cf6dd9cc3bba5e901158a218b2b773a0de83738901efcfdd04e74bd4e0b",
    "fc865762b3c2d79febb838d45d4b6aac6c17ea15b57b203a6d38030495a5f654",
    "4750c5304b8f543388270fcfd20f4f2b83cfc3d235ff014a0324faa8a6bfeb3d",
    "d86ca39b0eb5253bfa950ac70fb4012b53bbb61ccdd4df0164866561bf241d24",
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

/** Corners of a glyph's ink box after its swing (rotation about the pivot). */
function swungCorners(glyph: ReturnType<typeof swingLettersPlan>["glyphs"][number], degrees: number): Array<[number, number]> {
  const radians = (degrees * Math.PI) / 180, c = Math.cos(radians), s = Math.sin(radians);
  return [[glyph.box.x0, glyph.box.y0], [glyph.box.x1, glyph.box.y0], [glyph.box.x0, glyph.box.y1], [glyph.box.x1, glyph.box.y1]]
    .map(([x, y]) => [glyph.pivotX + (x - glyph.pivotX) * c - (y - glyph.pivotY) * s, glyph.pivotY + (x - glyph.pivotX) * s + (y - glyph.pivotY) * c]);
}

describe("T66 Swing Letters", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(48 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("each character swings 14°·sin(2πt/1.6 + 0.7·i) (±20% seeded) about a pivot 0.35 glyph heights above its line's top", () => {
    expect([T66_SWING, T66_PHASE_STEP, T66_SPREAD, T66_PIVOT]).toEqual([14, 0.7, 0.2, 0.35]);
    const plan = swingLettersPlan(params(), PORTRAIT);
    const top = Math.min(...plan.glyphs.map(glyph => glyph.box.y0));
    for (const glyph of plan.glyphs) {
      expect(glyph.pivotY).toBeCloseTo(top - 0.35 * plan.glyphHeight, 9);
      expect(glyph.pivotX).toBeCloseTo(glyph.cx, 9);
      expect(glyph.swing).toBeGreaterThanOrEqual(14 * 0.8 - 1e-9);
      expect(glyph.swing).toBeLessThanOrEqual(14 * 1.2 + 1e-9);
      for (const t of [0, 0.2, 0.9, 1.35]) {
        expect(swingAngle(glyph, t / LOOP)).toBeCloseTo(glyph.swing * Math.sin((2 * Math.PI * t) / LOOP + 0.7 * glyph.index), 9);
      }
    }
    // The seed changes the per-character amplitudes, not the period.
    const other = swingLettersPlan(params({ seed: 7 }), PORTRAIT);
    expect(other.glyphs.map(glyph => glyph.swing)).not.toEqual(plan.glyphs.map(glyph => glyph.swing));
    // Energy scales the swing.
    expect(swingLettersPlan(params({ energy: "calm" }), PORTRAIT).glyphs[0].swing).toBeLessThan(plan.glyphs[0].swing);
  });

  it("the rail, pins and every swinging glyph stay inside the safe box; neighbours never collide at the default spacing", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["搖"] }, { lines: ["搖搖", "晃晃"] }, { lines: ["搖搖晃晃不停"] }]) {
        const plan = swingLettersPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        for (const rail of plan.rails) {
          expect(rail.x0 - plan.railWidth / 2).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(rail.x1 + plan.railWidth / 2).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(rail.y - plan.pin).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        }
        for (let step = 0; step < 48; step += 1) {
          for (const glyph of plan.glyphs) {
            for (const [x, y] of swungCorners(glyph, swingAngle(glyph, step / 48))) {
              expect(x, `${size.width}x${size.height} ${JSON.stringify(input)}`).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
              expect(x).toBeLessThanOrEqual(safe.x1 + 1e-6);
              expect(y).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
              expect(y).toBeLessThanOrEqual(safe.y1 + 1e-6);
            }
          }
        }
      }
    }
    // Rest fill: the swinging word takes 80–90% of the safe width.
    const plan = swingLettersPlan(params(), PORTRAIT), safe = titleSafeBox(PORTRAIT);
    const fill = (plan.box.x1 - plan.box.x0) / safe.width;
    expect(fill).toBeGreaterThanOrEqual(0.8);
    expect(fill).toBeLessThanOrEqual(0.9);
    // Neighbouring ink boxes, swung, keep apart at their facing bottom corners.
    for (let step = 0; step < 96; step += 1) {
      for (let index = 0; index + 1 < plan.glyphs.length; index += 1) {
        const left = swungCorners(plan.glyphs[index], swingAngle(plan.glyphs[index], step / 96));
        const right = swungCorners(plan.glyphs[index + 1], swingAngle(plan.glyphs[index + 1], step / 96));
        expect(Math.min(right[2][0], right[0][0]), `step ${step}`).toBeGreaterThan(Math.max(left[3][0], left[1][0]) - 0.02 * plan.glyphHeight);
      }
    }
  });

  it("colours: ink and deep teal on the teal card (the measured reference); cream and teal on the dark card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("accent");
    const onAccent = swingLettersPlan(params({ plate: "accent" }), PORTRAIT);
    expect(onAccent.glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
    expect(onAccent.lineColor).toBe(palette.ink);
    expect(swingLettersPlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
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
