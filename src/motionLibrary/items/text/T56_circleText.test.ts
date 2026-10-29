import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T56_LOOP_SECONDS, T56_RADII, T56_SPINS, circleTextPlan } from "./T56_circleText";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T56";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 1.5, 3.3, 5.2, 7.1] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "85a7ba940cead3dd3bbfc3948b8a5dbdad0406b7dd372f07525660ca6372fc8a",
    "37d5cb17a1aebb1ed6893e753a7525be464940a7bea9d675a547daf7fe84fbbb",
    "4fb0b695edec934d61b5332c2d9ee19b43a26aa11e61e817edf9a5dee2e46142",
    "3df47d535775328589eddc1cfae8969d1a868447f5d0bc5b4bd7e80ccd1c18ab",
    "7bc6ca65e5760acc7e921dc097293d8ffb7b736a42ae1dff46ca400804ac9784",
  ],
  landscape: [
    "6ffe7d6c2e7993d9079299acd07d400fef725c8904e6cb25dc88d5eed856096f",
    "ec2a7f8d7647c0c3a5697ee9d623c1abb6d34cfd933a81fca7780f5bf76bfb81",
    "d685b6a4144b6db0fca110452cd617c52cc631179080a15cfe27a8db03e3bb43",
    "6bfc8d2f3255faa03dd83ffe742cbb9333c852d9edd1e56e31af9e458da2d977",
    "53831928145bed9a1f97c451f0b772c7241c96ddda40a55cc7119dc6378d8915",
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
/** The plate is painted first: right after the header and the (optional) <defs>. */
function paintsFirst(svg: string, size: MotionFrameSize, fill: string): boolean {
  const at = svg.indexOf(plateRect(size, fill));
  if (at < 0) return false;
  const prefix = svg.slice(0, at);
  return prefix === header(size) || (prefix.startsWith(`${header(size)}<defs>`) && prefix.endsWith("</defs>"));
}
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };
const rotations = (svg: string) => [...svg.matchAll(/rotate\(([-\d.]+)\)/g)].map(match => Number(match[1]));

describe("T56 Circle Text", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T56_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { plate: "accent" }, { lines: ["旋轉", "回轉", "圈"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T56_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T56_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T56_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(240 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T56_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(3.3, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(3.3, PORTRAIT)).toBe(first);
  });

  it("three rings at 42 : 30 : 18% of the short side turn +45°/s, −45°/s and +90°/s; coral, cream, coral", () => {
    expect([...T56_RADII]).toEqual([0.42, 0.3, 0.18]);
    expect([...T56_SPINS]).toEqual([45, -45, 90]);
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = circleTextPlan(params(), size), short = Math.min(size.width, size.height);
      expect(plan.fit).toBeGreaterThan(0.94);
      expect(plan.fit).toBeLessThanOrEqual(1);
      plan.rings.forEach((ring, index) => expect(ring.radius / short).toBeCloseTo(T56_RADII[index] * plan.fit, 9));
      expect(plan.rings.map(ring => ring.color)).toEqual([palette.accent, palette.paper, palette.accent]);
      // Every ring closes on whole repeats of 旋轉・ (upright glyphs, tops outward).
      for (const ring of plan.rings) {
        expect(ring.ring.layout.unit).toBe("旋轉・");
        expect(ring.ring.layout.glyphs.length % 3).toBe(0);
      }
    }
    // At t = 1 s the rings have turned 45°, 315° (−45°) and 90°.
    expect(rotations(frameText(1, PORTRAIT))).toEqual([45, 315, 90]);
    expect(rotations(frameText(3, PORTRAIT))).toEqual([135, 225, 270]);
  });

  it("keeps the outer ring's ink inside the 5% title-safe box; outer and middle glyph ink ≥ 9% of the short side, the inner ring's em ≥ 9%", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const plan = circleTextPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      const outer = plan.rings[0], label = `${size.width}x${size.height}`;
      expect(outer.radius + 0.46 * outer.size, label).toBeLessThanOrEqual(Math.min(safe.width, safe.height) / 2 + 1e-6);
      // CJK ink is about 0.88 em. The small inner ring (the catalog's "small characters") keeps a 9% em; its ink is about 7.9%.
      for (const ring of plan.rings.slice(0, 2)) expect(ring.size * 0.88, label).toBeGreaterThanOrEqual(0.09 * short);
      expect(plan.rings[2].size, label).toBeGreaterThanOrEqual(0.0899 * short);
    }
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
    expect(item.showcasePlate).toBe("bg");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.includes(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(paintsFirst(onBg, size, palette.bg)).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(paintsFirst(onAccent, size, palette.accent)).toBe(true);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
