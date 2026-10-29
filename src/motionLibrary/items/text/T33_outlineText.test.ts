import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import {
  outlinePlan, rowFill, T33_ANGLE, T33_FILL_END, T33_FILL_START, T33_LOOP_SECONDS, T33_RESET, T33_RESET_AT, T33_WIPE,
} from "./T33_outlineText";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T33";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: all outline, first rows filling, half the wall solid, all solid, the reset wipe. */
const TIMES = [0, 0.6, 1.5, 2.9, 3.4] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "146c95937146379990c7711b42b59e9a5c7ba1d65d7e91b6af2fb4d2bdc6f794",
    "cc474e83e5503aed15da0f1a53f8d40ed909238bd78247f8bd9f9d77635f3269",
    "9b5424f2e9b50a4807b019a7f4540e192bebf0c2d2d91e02b04341efdaba5112",
    "42af56004aef0c2e35b7daae9c2b603ac9a997724c20e491f46cf5bac2a880ef",
    "b86182e216ad8a75f2834366daf22fa3ae325f3632e4ffb49add8338b742e75b",
  ],
  landscape: [
    "8d27483c021c34ab416f0e88d84a8fb46460c7fb2d6850be72b0ca51bdd36a7a",
    "b8eb6e4b0bcb3cbaca5658106778aeaaec193f25324ffcf4804d11934e11bd72",
    "23278b6a751427d0d4dface05c6d418f13e609084627b53e4081cedd15e6f421",
    "01db9d54183a38401fc207fcefc1eb8074df467ddb2c26d3f3f80d1de29a0a9d",
    "dda11b36239e73097ba5e2087e6953d0a7ba6e695697c3293e374d631c191330",
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

describe("T33 Outline Text", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: rows move whole repeats and the fill program is empty at the seam", () => {
    expect(item.loopSeconds).toBe(T33_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "accent" }]) {
        const start = frameText(0, size, input);
        expect(frameText(T33_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T33_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T33_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
    const plan = outlinePlan(params(), PORTRAIT);
    for (const row of plan.rows) {
      expect(Number.isInteger(row.repeatsPerLoop) && row.repeatsPerLoop !== 0).toBe(true);
      expect(rowFill(plan, row, 0)).toEqual({ from: 0, to: 0 });
      expect(rowFill(plan, row, T33_LOOP_SECONDS - 1e-6).to).toBe(0);
    }
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T33_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.5, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.5, PORTRAIT)).toBe(first);
  });

  it("diagonal rows (−8°) fill the frame, alternate scroll direction and fill one at a time top to bottom, then reset together", () => {
    expect(T33_ANGLE).toBe(-8);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = outlinePlan(params(), size);
      expect(plan.rows.length).toBeGreaterThanOrEqual(size === PORTRAIT ? 7 : 4);
      expect(plan.visibleRows).toBe(plan.rows.length);
      const short = Math.min(size.width, size.height);
      expect(plan.unit.ink.y1 - plan.unit.ink.y0).toBeGreaterThanOrEqual(0.09 * short);
      // Rows are ordered top to bottom and alternate direction.
      for (let index = 1; index < plan.rows.length; index += 1) {
        expect(plan.rows[index].cy).toBeGreaterThan(plan.rows[index - 1].cy);
        expect(Math.sign(plan.rows[index].repeatsPerLoop)).toBe(-Math.sign(plan.rows[index - 1].repeatsPerLoop));
      }
      // One row at a time: each starts its 0.4 s wipe after the previous one; the last ends by T33_FILL_END.
      const starts = plan.rows.map(row => {
        let u = 0;
        while (rowFill(plan, row, u).to <= 0) u += 0.005;
        return u;
      });
      for (let index = 1; index < starts.length; index += 1) expect(starts[index]).toBeGreaterThan(starts[index - 1]);
      expect(starts[0]).toBeCloseTo(T33_FILL_START, 1);
      for (const row of plan.rows) {
        expect(rowFill(plan, row, T33_FILL_END + 0.01)).toEqual({ from: 0, to: 1 });
        expect(rowFill(plan, row, T33_RESET_AT + T33_RESET / 2).from).toBeGreaterThan(0);
        expect(rowFill(plan, row, T33_RESET_AT + T33_RESET + 0.01)).toEqual({ from: 0, to: 0 });
      }
      expect(T33_WIPE).toBe(0.4);
    }
    // Outline: a masked ring stroke (no hollow glyph shows the font's inner contours); fills are fill + same-width stroke.
    const palette = item.defaultParams.palette;
    const outlineOnly = frameText(0, PORTRAIT);
    expect(outlineOnly).toMatch(/<mask [^>]+><rect x="0" y="0" width="1080" height="1920" fill="#FFFFFF"\/>/);
    expect(outlineOnly).toContain(`fill="none" stroke="${palette.paper}"`);
    const solid = frameText(2.9, PORTRAIT);
    expect(solid).not.toContain("<mask");
    expect(solid).toContain(`fill="${palette.accent}" stroke="${palette.accent}"`);
  });

  it("colours follow ART_DIRECTION §0: cream outlines and orange fills on dark, ink and accent2 on the accent card", () => {
    const palette = item.defaultParams.palette;
    const onAccent = frameText(1.5, PORTRAIT, { plate: "accent" });
    expect(onAccent).toContain(`stroke="${palette.ink}"`);
    expect(onAccent).toContain(`fill="${palette.accent2}" stroke="${palette.accent2}"`);
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
