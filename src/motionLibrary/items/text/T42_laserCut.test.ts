import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { laserCutLayout, laserSplitAmount, T42_LOOP_SECONDS } from "./T42_laserCut";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T42";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: whole (0.1), the laser mid-sweep (0.4), the halves springing apart (0.62), split with
 * the faint line (1.2), rejoining (1.6). */
const TIMES = [0.1, 0.4, 0.62, 1.2, 1.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "2a443c3223ad5fdcf739c5095f3b0e8c19aa33dd4d055fd0c482bfd9295898c5",
    "b0a2852522ff978f992a2def458c2a4c0cad4ec3d03bcad0c52ed7169c268ac0",
    "e31aa52fde243d83279cf417f7a229c697428565ee17887874a3fe109edd67e8",
    "4e48d28849c63a955e4c297616398d03ef34833800a0f8e2d50124fd33155aef",
    "775b8fdf70fba9991a6ce94c97fd159712101f7bd7d1ec0d8039df51328e9e48",
  ],
  landscape: [
    "320118abca18141e45e9d64b7634756f81e009f137b66d5f669fe2cf4720c782",
    "f3f5c4fa3d696ed2c4e66c103a8ff8a35513096f09938f363025e8517f9cda76",
    "fff916e23e43ecd95a61b25130cfbc46d34776232a43806f8ce19c5ef15e2a18",
    "d2ec8103e2284a1fe7edddecf4d46c6e84c56f223a94ead0e79185464c64badc",
    "0efaa9358d1efc529b9ab857724591c7d917603833131d4c741ce0c30a9d2814",
  ],
};

const item = getMotionLibraryItem(ID) as TextMotionItem;
const params = (input?: unknown): TextMotionParams => resolveMotionLibraryParams(item, input);
function frameText(t: number, size: MotionFrameSize, input?: unknown): string {
  const frame = generateAnyMotionFrame(item, params(input), t, size);
  return "svg" in frame ? frame.svg : frame.matte;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const plateRect = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
/** Offsets of the clipped halves, in draw order (bottom, top). */
function halves(svg: string): Array<[number, number]> {
  return [...svg.matchAll(/<g transform="translate\(([\d.-]+) ([\d.-]+)\)"><g clip-path=/g)].map(match => [Number(match[1]), Number(match[2])]);
}

describe("T42 Laser Cut", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.4, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 1.8, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.62, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.62, PORTRAIT)).toBe(first);
  });

  it("loops seamlessly at the 1.8 s loopSeconds for every energy", () => {
    expect(item.loopSeconds).toBe(T42_LOOP_SECONDS);
    for (const energy of ["calm", "standard", "punchy", "hype"] as const) {
      for (const size of [PORTRAIT, LANDSCAPE]) {
        const start = frameText(0, size, { energy });
        expect(frameText(1.8, size, { energy }), energy).toBe(start);
        expect(frameText(3.6, size, { energy })).toBe(start);
        // Nothing is mid-motion at the seam: whole word, no beam.
        expect(start.match(/<path/g)).toHaveLength(1);
        expect(start).not.toContain("<rect");
      }
    }
  });

  it("sweeps a laser along the word's middle, cuts it into clipPath halves that slide 6% / 3% apart, holds and rejoins", () => {
    const layout = laserCutLayout(params(), PORTRAIT);
    const width = layout.box.x1 - layout.box.x0;
    expect(layout.cutY).toBeCloseTo((layout.box.y0 + layout.box.y1) / 2, 6);
    expect(halves(frameText(0.1, PORTRAIT))).toHaveLength(0);
    // Mid-sweep: a beam from the left edge to the head, the head dot and its glow; the word still whole.
    const sweep = frameText(0.4, PORTRAIT);
    expect(sweep).toMatch(/<rect x="0" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="url\(#mlg\d+\)"\/>/);
    expect(sweep.match(/<circle /g)).toHaveLength(2);
    expect(sweep).toContain("<ellipse "); // the flare streak
    expect(halves(sweep)).toHaveLength(0);
    // Split: bottom half left and down, top half right and up, by 6% and 3% of the word width.
    const split = halves(frameText(1.2, PORTRAIT));
    expect(split).toHaveLength(2);
    expect(split[0][0]).toBeCloseTo(-0.06 * width, 0);
    expect(split[0][1]).toBeCloseTo(0.03 * width, 0);
    expect(split[1][0]).toBeCloseTo(0.06 * width, 0);
    expect(split[1][1]).toBeCloseTo(-0.03 * width, 0);
    expect(frameText(1.2, PORTRAIT).match(/<clipPath /g)).toHaveLength(2);
    // backOut: the halves overshoot a little while springing apart; expoInOut brings them back.
    expect(Math.max(...Array.from({ length: 40 }, (_, index) => laserSplitAmount(0.55 + index * 0.005, layout)))).toBeGreaterThan(1);
    expect(laserSplitAmount(1.6, layout)).toBeGreaterThan(0);
    expect(laserSplitAmount(1.72, layout)).toBe(0);
    // The beam lingers as a faint line during the split and is gone once the word is whole again.
    expect(frameText(1.2, PORTRAIT)).toMatch(/<g opacity="0\.\d+"><rect x="0"/);
    expect(frameText(1.75, PORTRAIT)).not.toContain("<rect");
  });

  it("keeps the word and both split halves inside the 5% title-safe box, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["一刀兩斷"] }]) {
        const safe = titleSafeBox(size), layout = laserCutLayout(params(input), size);
        const width = layout.box.x1 - layout.box.x0, shift = 0.06 * width * layout.amplitude * 1.1; // backOut overshoot ≈ 10%
        expect(layout.box.x0 - shift).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1 + shift).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0 - shift / 2).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1 + shift / 2).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(layout.box.y1 - layout.box.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("draws paper glyphs and a lime laser with a paper core on bg; ink glyphs and an accent2 laser on the accent plate", () => {
    const palette = item.defaultParams.palette;
    const onBg = frameText(0.4, PORTRAIT, { plate: "bg" });
    expect(onBg).toContain(`stop-color="${palette.accent}"`);
    expect(onBg).not.toContain(`stop-color="${palette.accent2}"`);
    expect(onBg).toContain(`fill="${palette.paper}"`);
    expect(frameText(0.1, PORTRAIT, { plate: "accent" })).toContain(`fill="${palette.ink}"`);
    expect(frameText(0.1, PORTRAIT)).toContain(`fill="${palette.paper}"`);
    expect(frameText(0.4, PORTRAIT, { plate: "accent" })).toContain(`stop-color="${palette.accent2}"`);
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("bg");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain(plateRect(PORTRAIT, palette.bg));
      expect(frameText(t, PORTRAIT, { plate: "bg" }).replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onAccent = frameText(t, PORTRAIT, { plate: "accent" });
      const first = onAccent.includes("</defs>") ? onAccent.indexOf("</defs>") + 7 : onAccent.indexOf(">") + 1;
      expect(onAccent.indexOf(plateRect(PORTRAIT, palette.accent))).toBe(first);
      expect(maskColors(onAccent.replace(plateRect(PORTRAIT, palette.accent), ""))).toBe(maskColors(none));
    }
  });
});
