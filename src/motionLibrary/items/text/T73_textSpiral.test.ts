import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { slotPlacement, spiralDistance, T73_ARMS, T73_SPIN, T73_TURNS, textSpiralPlan } from "./T73_textSpiral";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T73";
const LOOP = 3;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.4, 1.1, 1.9, 2.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "b1f6de9c938d314f74e48f6872f4118e5b54841a91c06fc533438eb227362e74",
    "d414fe22d164b290a23ca081d9a40dae42cb4fcb531d5748039e5f2f13ef820f",
    "db778db97ef5ead02dcea029fbf67a596b9cb03831f5f902963e2ccc89940069",
    "79f2db560b61dcd4f2f532937ad1ff57468220dfad305c3a3db975f3dab4a7e2",
    "a4654c027e18afd6c0543687e5e00e120b2779c9df50a32fb7e39cde1e2cfdc5",
  ],
  landscape: [
    "62acf730778019b85077a233681a18cf3014525a733c25cef6331a188ccd964e",
    "af5b3237d930f31ccdd4c8d19e9b9cb5dab3cafa86c0fce8133c5912e6d42e0f",
    "906858125c7de818d3862ea2fd5539f4133470bd85c7df0dc8413f53956f975d",
    "adb851ab91c6fd8c09d10617d1d20fe769db9d2b3af529f949dac70204eaba06",
    "05c82be85bad20dc6fa58b41e5e7c3aff68047dc4dcafb0adc552b21695f0899",
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
const paths = (svg: string) => (svg.match(/<path /g) ?? []).length;
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T73 Text Spiral", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: one turn and one text repeat per arm per loop; frame 0 equals the frame at 3 s", () => {
    expect(item.loopSeconds).toBe(LOOP);
    expect(T73_SPIN * LOOP).toBe(360);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { plate: item.showcasePlate }, { lines: ["旋轉"] }, { lines: ["時間・"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(90 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.1, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.1, PORTRAIT)).toBe(first);
  });

  it("40–70 characters on two arms of an Archimedean spiral (1.25 turns), shrinking with the radius, drawn inward", () => {
    expect([T73_ARMS, T73_TURNS]).toEqual([2, 1.25]);
    const plan = textSpiralPlan(params(), PORTRAIT);
    expect(plan.unit.map(glyph => glyph.char).join("")).toBe("時間在這裡旋轉・");
    for (const t of [0, 0.7, 1.6]) {
      const drawn = paths(frameText(t, PORTRAIT));
      expect(drawn).toBeGreaterThanOrEqual(40);
      expect(drawn).toBeLessThanOrEqual(70);
    }
    // Radius falls linearly with the angle; the scale is r / outer; the path-follow point sits at that radius.
    for (const position of [0.5, 5, 12, 20]) {
      const place = slotPlacement(plan, 0, position)!;
      const theta = position * plan.step, radius = plan.outer - ((plan.outer - plan.inner) * theta) / plan.sweep;
      expect(place.scale).toBeCloseTo(radius / plan.outer, 9);
      expect(Math.hypot(place.x - plan.cx, place.y - plan.cy)).toBeCloseTo(radius, 0);
    }
    // Moving inward: later slots are nearer the centre; the arc-length formula is monotone.
    expect(slotPlacement(plan, 1, 3)!.scale).toBeGreaterThan(slotPlacement(plan, 1, 9)!.scale);
    expect(spiralDistance(plan, 1)).toBeLessThan(spiralDistance(plan, 2));
    // The two arms are half a turn apart.
    const a = slotPlacement(plan, 0, 2)!, b = slotPlacement(plan, 1, 2)!;
    expect(a.x + b.x).toBeCloseTo(2 * plan.cx, 0);
    expect(a.y + b.y).toBeCloseTo(2 * plan.cy, 0);
    // Fade in at the rim, out near the centre.
    expect(slotPlacement(plan, 0, 0.25)!.opacity).toBeCloseTo(0.25, 9);
    expect(slotPlacement(plan, 0, plan.slots - 0.01)!.opacity).toBe(0);
  });

  it("everything stays inside the safe box and the outer characters are at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const plan = textSpiralPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      expect(plan.em * 0.9).toBeGreaterThanOrEqual(0.09 * short);
      // The outermost character at any angle: its em box corners stay inside the safe box.
      const reach = plan.outer + plan.em * Math.SQRT1_2;
      expect(plan.cx - reach).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
      expect(plan.cx + reach).toBeLessThanOrEqual(safe.x1 + 1e-6);
      expect(plan.cy - reach).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
      expect(plan.cy + reach).toBeLessThanOrEqual(safe.y1 + 1e-6);
      // Arms never touch: the glyph at the rim is under the radial gap between arms.
      expect(plan.em).toBeLessThan((plan.outer - plan.inner) / (T73_ARMS * T73_TURNS));
    }
  });

  it("colours alternate cream and gold along the text, separators gold, on the dark card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("bg");
    const plan = textSpiralPlan(params(), PORTRAIT);
    expect(plan.unit.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent, palette.paper, palette.accent, palette.paper, palette.accent]);
    expect(textSpiralPlan(params({ plate: "accent" }), PORTRAIT).unit[1].color).toBe(palette.accent2);
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
