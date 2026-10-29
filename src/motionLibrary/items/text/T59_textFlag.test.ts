import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { contrastRatio } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { flagPose, flagTones, T59_AMPLITUDE, T59_NARROW, T59_TILT, textFlagPlan } from "./T59_textFlag";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T59";
const LOOP = 1.6;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.2, 0.45, 0.8, 1.2] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "65c06e083bf7f4b28e9b5676d126be253d99b8131c08ac9360ab7db93dfd88d3",
    "88e187b367e030fc282a322b7e76996fd0f4aa05b16071fc543635f47adecd50",
    "70bc4bb31c3602baeee68d09de86fc1a41dba69edd2aef577b8fe16190860b6e",
    "d7bcc61837ea2fbefe14fe21ef038878ac07c97e5919531675b175cb594a1b47",
    "c6cebf5a8ef85af928c6c58b898479253bea19806a0b024ea140b90af2d632fa",
  ],
  landscape: [
    "bd604f02797db185ad15694f150faf18539932d1933baeef352e056693afaf3e",
    "9ab0d629008d46104002b71bf06a60a2a3c85cabdd69fdf415a53d9a4b9808cb",
    "4bbb1bb24186c6facdc3b7bcc6949cadd18d153752dee81cc9645507bc451cf5",
    "6638ec6e56ef7dbb09d2a6ddc9388bdd17386eb41990ddcabf793b53b8e82dff",
    "7b7d41ca3b7776bb471ecb8e7591aecc83ad1fed68722f68e1ef509004ef985a",
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

describe("T59 Text Flag", () => {
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
    const first = frameText(0.45, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.45, PORTRAIT)).toBe(first);
  });

  it("rides y = A(x)·sin(2πt/1.6 − k·x): still at the pole, 22% of the glyph height at the free end, a wave travelling outward", () => {
    expect([T59_AMPLITUDE, T59_TILT, T59_NARROW]).toEqual([0.22, 0.8, 0.08]);
    const plan = textFlagPlan(params(), PORTRAIT);
    expect(plan.amplitude).toBeCloseTo(0.22 * plan.glyphHeight, 9);
    for (let step = 0; step < 16; step += 1) {
      const u = step / 16;
      expect(flagPose(plan, 0, u).dy).toBeCloseTo(0, 9);
      // The free end swings with the full amplitude: y = A·sin(2πu − kL).
      expect(flagPose(plan, plan.length, u).dy).toBeCloseTo(plan.amplitude * Math.sin(2 * Math.PI * u - plan.k * plan.length), 9);
    }
    // The amplitude grows from the pole outward.
    const peak = (x: number) => Math.max(...Array.from({ length: 64 }, (_, step) => Math.abs(flagPose(plan, x, step / 64).dy)));
    expect(peak(plan.length * 0.25)).toBeLessThan(peak(plan.length * 0.6));
    expect(peak(plan.length * 0.6)).toBeLessThan(peak(plan.length));
    // Travelling outward: a crest at x appears at x + Δ a little later.
    const x = plan.length * 0.7, dx = 0.05 * plan.length, du = (plan.k * dx) / (2 * Math.PI);
    const phase = (along: number, u: number) => 2 * Math.PI * u - plan.k * along;
    expect(phase(x + dx, 0.3 + du)).toBeCloseTo(phase(x, 0.3), 9);
    // Tilt follows the slope (×0.8) and the cloth narrows with it.
    for (const u of [0.1, 0.4, 0.75]) {
      const pose = flagPose(plan, x, u), h = 1e-3;
      const slope = (flagPose(plan, x + h, u).dy - flagPose(plan, x - h, u).dy) / (2 * h);
      expect(pose.rotation).toBeCloseTo((0.8 * Math.atan(slope) * 180) / Math.PI, 3);
      expect(pose.scaleX).toBeCloseTo(1 - 0.08 * Math.abs(slope), 4);
    }
  });

  it("the flag fills 80–90% of the safe width with its pole, and the pole, finial and every swinging glyph stay inside the safe box", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["旗"] }, { lines: ["迎風", "飄揚"] }, { lines: ["迎風飄揚不停息"] }]) {
        const plan = textFlagPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined) {
          const fill = (plan.box.x1 - (plan.poleX - plan.poleWidth / 2)) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        expect(plan.poleX - plan.poleWidth / 2).toBeGreaterThanOrEqual(safe.x0);
        expect(plan.poleTop - plan.finial * 1.6).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.poleBottom + plan.poleWidth / 2).toBeLessThanOrEqual(safe.y1 + 1e-6);
        for (let step = 0; step < 48; step += 1) {
          for (const glyph of plan.glyphs) {
            const pose = flagPose(plan, glyph.along, step / 48), radians = (pose.rotation * Math.PI) / 180;
            for (const [bx, by] of [[glyph.box.x0, glyph.box.y0], [glyph.box.x1, glyph.box.y0], [glyph.box.x0, glyph.box.y1], [glyph.box.x1, glyph.box.y1]]) {
              const lx = (bx - glyph.cx) * pose.scaleX, ly = by - glyph.cy;
              const x = glyph.cx + lx * Math.cos(radians) - ly * Math.sin(radians);
              const y = glyph.cy + pose.dy + lx * Math.sin(radians) + ly * Math.cos(radians);
              expect(x, `${size.width}x${size.height} ${JSON.stringify(input)}`).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
              expect(x).toBeLessThanOrEqual(safe.x1 + 1e-6);
              expect(y).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
              expect(y).toBeLessThanOrEqual(safe.y1 + 1e-6);
            }
          }
        }
      }
    }
  });

  it("colours: ink and violet alternate on the cream card (the reference, ≥ 2.5:1); cream and violet on the dark card", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("paper");
    expect(contrastRatio(palette.accent, palette.paper)).toBeGreaterThanOrEqual(2.5);
    const onPaper = textFlagPlan(params({ plate: "paper" }), PORTRAIT);
    expect(onPaper.glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent, palette.ink, palette.accent]);
    expect([onPaper.poleColor, onPaper.finialColor]).toEqual([palette.ink, palette.accent]);
    expect(textFlagPlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
    expect(textFlagPlan(params({ plate: "accent" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
    // An accent that fails 2.5:1 on cream falls back to the deep shade.
    const pale = { ...palette, accent: "#E8E0FF" };
    expect(flagTones(pale, palette.paper)).toEqual([palette.ink, palette.accent2]);
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
