import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { liquidFillPlan, liquidLevel, T37_DRAIN, T37_FULL, T37_LOOP_SECONDS, T37_RISE, T37_RISE_AT } from "./T37_textLiquidFill";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T37";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: empty, rising, near the top, brimful, draining. */
const TIMES = [0.1, 1, 1.8, 2.5, 3.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "309798c73f3fe05147ed3737c44698e8f835fa6dc615f0edb99f1e5e1ab65f04",
    "4f7566218ba5636ecd646e4d0b05470745f2396986f966819ba95b7aaeb144ca",
    "59ffe88581b51d0bec990abbf2fa6fa211ad3080aac06b1f7647b04cf62349f0",
    "17dfea2024e1d3b9f64e48623ee968393c7700bed1f1a2fdba9153e2290639a3",
    "fa8ff45225bde9407a478bdb11c732f547dba68e10e1285ed514322d27375f44",
  ],
  landscape: [
    "03ed33197d2a65da84fed04724274c8068c04a3232a17400a017e9faae0de6b4",
    "62b999175945dfca664e9afab9943f78ba0bc814377607cfd6b432eda5ea72aa",
    "1fdebac60128d9dd542996154cb7cd124a33049c358f4ce1677a2c18e7b9fc5e",
    "eb79d26fa0836543b1100b9cd83af5f7a799bfa6a3e6cae9f614148f3180f347",
    "1aed486a114401b47a1e3208fb9398d903c050f3dbf86465f2ded08af5a2f19c",
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
/** Colours actually painted: luminance mask contents (pure white / black) are not palette paint. */
const colours = (svg: string) => new Set(svg.replace(/<mask [^>]*>.*?<\/mask>/g, "").match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T37 Text Liquid Fill", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: both waves run whole cycles and the level is empty at the seam", () => {
    expect(item.loopSeconds).toBe(T37_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "paper" }]) {
        const start = frameText(0, size, input);
        expect(frameText(T37_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T37_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T37_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
    // Wave phases at the brimful hold: the full-cycle waves make the surface at u and u + loop identical.
    expect(frameText(2.45, PORTRAIT)).toBe(frameText(2.45 + T37_LOOP_SECONDS, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(1, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T37_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.8, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.8, PORTRAIT)).toBe(first);
  });

  it("the liquid rises in 2 s, stays brimful, drains, and rests empty; it is masked to the glyphs under a clean outside outline", () => {
    expect([T37_RISE_AT, T37_RISE, T37_FULL, T37_DRAIN]).toEqual([0.2, 2, 0.6, 1]);
    expect(liquidLevel(0)).toBe(0);
    expect(liquidLevel(0.2)).toBeCloseTo(0, 9);
    expect(liquidLevel(1.2)).toBeCloseTo(0.5, 6);
    expect(liquidLevel(2.2)).toBe(1);
    expect(liquidLevel(2.79)).toBe(1);
    expect(liquidLevel(3.3)).toBeCloseTo(0.5, 6);
    expect(liquidLevel(3.85)).toBe(0);
    for (let u = 0.2; u < 2.2; u += 0.1) expect(liquidLevel(u + 0.05)).toBeGreaterThanOrEqual(liquidLevel(u));
    const palette = item.defaultParams.palette;
    const empty = frameText(0.1, PORTRAIT);
    expect(empty.match(/<mask /g)).toHaveLength(1);
    expect(empty).toContain(`fill="none" stroke="${palette.paper}"`);
    const rising = frameText(1, PORTRAIT);
    expect(rising.match(/<mask /g)).toHaveLength(2);
    expect(rising).toContain(`fill="${palette.accent}"`);
    expect(rising).toContain(`fill="${palette.accent2}"`);
  });

  it("the glyph and its outline stay inside the 5% title-safe box; the main word is at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["滿載"] }, { lines: ["充滿", "能量"] }]) {
        const plan = liquidFillPlan(params(input), size), safe = titleSafeBox(size);
        const ring = 0.014 * plan.fontSize;
        expect(plan.box.x0 - ring).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.box.x1 + ring).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.box.y0 - ring).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.box.y1 + ring).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("colours follow the contrast rule: cream outline on dark, ink outline and accent2 liquid on the accent card", () => {
    const palette = item.defaultParams.palette;
    const onAccent = frameText(1, PORTRAIT, { plate: "accent" });
    expect(onAccent).toContain(`stroke="${palette.ink}"`);
    expect(onAccent).toContain(`fill="${palette.accent2}"`);
    const onPaper = frameText(1, PORTRAIT, { plate: "paper" });
    expect(onPaper).toContain(`stroke="${palette.ink}"`);
    expect(onPaper).toContain(`fill="${palette.accent}"`);
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
        expect(frameText(t, size, { plate: "bg" }).replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
