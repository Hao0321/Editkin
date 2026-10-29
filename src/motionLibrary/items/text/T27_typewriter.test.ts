import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { typewriterCaret, typewriterLayout } from "./T27_typewriter";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T27";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: the caret alone (0.1), typing line 1 (0.4), the hold with the caret on (1.5),
 * deleting (3.4), blank (3.95). */
const TIMES = [0.1, 0.4, 1.5, 3.4, 3.95] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "bbbd4d1ff47fb8281e6b762f22950ea65be7dc303304ebac7a6caee727ac05a2",
    "fd777a95067ead83721e1d36c0d5382b12f08e6a99b4e15f44664a12c6a92b1d",
    "416ed3d9453b486c54161f33b25bc6d8f9bbfd3cfd293208e561dd66c6ef63d6",
    "e476965fca46a1b310f2d04269f5a61aa18ddf06db76039939e4f141b113a5a3",
    "6dd797c940e8a36b0204c4ed319a6dab5061438bad86ebadb1f923876da86852",
  ],
  landscape: [
    "cc51884a2cc1556fb3e80e470dff67a4c582fe1a8f2dfeb96b1d3a7e697baba3",
    "66e1d48a907e4b767329fdc9c24711ef830555f702e3229838f4c52951bdc9a4",
    "816d919ab7b1e8256c724aa023020dcfb6896ec2dde836543bd61dbdb29747a9",
    "a64038ac049a9bd18262fc51594480b48399cbedecc68170168bc01b5da32ad8",
    "76ac3162fc2bc04abc5e07264a36b7ab91d8e505160b96fdf5eebc40218b9b8c",
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
const glyphCount = (svg: string) => (svg.match(/<path /g) ?? []).length;

describe("T27 Typewriter", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(1.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 4, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.4, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.4, PORTRAIT)).toBe(first);
  });

  it("types a character every 0.07 s (line 2 after a 0.22 s line break) and deletes backwards at 0.045 s, ending blank", () => {
    const layout = typewriterLayout(params(), LANDSCAPE);
    const typed = layout.lines.flatMap(line => line.glyphs.map(glyph => Number(glyph.typedAt.toFixed(6))));
    expect(typed).toEqual([0.18, 0.25, 0.32, 0.39, 0.46, 0.75, 0.82]);
    const deleted = layout.lines.flatMap(line => line.glyphs.map(glyph => glyph.deletedAt));
    for (let index = 1; index < deleted.length; index += 1) expect(deleted[index - 1] - deleted[index]).toBeCloseTo(0.045, 9);
    expect(layout.deleteEnd).toBeCloseTo(3.6, 9);
    expect([0.4, 1.5, 3.4].map(t => glyphCount(frameText(t, LANDSCAPE)))).toEqual([4, 7, 4]); // 見再前 deleted by 3.4 s
    expect(frameText(3.95, LANDSCAPE)).not.toMatch(/<(path|rect) /);
    // A fresh character strikes in: larger and partly transparent in its first frame.
    expect(frameText(0.19, LANDSCAPE)).toMatch(/opacity="0\.\d+" transform="translate\([^)]+\) scale\(1\.\d+\)/);
  });

  it("caret: solid while typing or deleting, blinking once a second while idle (never more than 3 flashes a second)", () => {
    const layout = typewriterLayout(params(), LANDSCAPE);
    for (const t of [0.2, 0.5, 0.8, 3.3, 3.5]) expect(typewriterCaret(layout, t).visible, `t=${t}`).toBe(true);
    const onsets: number[] = [];
    let previous = true;
    for (let frame = 0; frame <= 4 * 120; frame += 1) {
      const t = frame / 120, visible = typewriterCaret(layout, t).visible;
      if (visible && !previous) onsets.push(t);
      previous = visible;
    }
    expect(onsets.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < onsets.length; index += 1) expect(onsets[index] - onsets[index - 1]).toBeGreaterThanOrEqual(0.99);
    expect(typewriterCaret(layout, 3.93).visible).toBe(false);
    // The caret follows the text: after 前 on line 1, then at the start of line 2, then back up while deleting.
    const afterLine1 = typewriterCaret(layout, 0.6), line2Start = typewriterCaret(layout, 0.76), deletingUp = typewriterCaret(layout, 3.4);
    expect(line2Start.y).toBeGreaterThan(afterLine1.y);
    expect(line2Start.x).toBeLessThan(afterLine1.x);
    expect(deletingUp.y).toBeCloseTo(afterLine1.y, 6);
  });

  it("sets mostly-CJK text vertically in portrait (columns right to left) and horizontally in landscape or for Latin text", () => {
    const portrait = typewriterLayout(params(), PORTRAIT), landscape = typewriterLayout(params(), LANDSCAPE);
    expect(portrait.vertical).toBe(true);
    expect(landscape.vertical).toBe(false);
    expect(portrait.lines[1].glyphs[0].x).toBeLessThan(portrait.lines[0].glyphs[0].x); // line 2 is the column to the left
    expect(portrait.lines[0].glyphs[1].y).toBeGreaterThan(portrait.lines[0].glyphs[0].y); // typed downwards
    expect(portrait.fontSize).toBeGreaterThan(0.22 * PORTRAIT.width); // a tall column, not a thin band
    expect(typewriterLayout(params({ lines: ["See you", "tomorrow"] }), PORTRAIT).vertical).toBe(false);
  });

  it("keeps the typed block and its caret inside the 5% title-safe box, glyphs at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["今天也辛苦了", "晚安"] }, { lines: ["See you", "tomorrow"] }]) {
        const safe = titleSafeBox(size), layout = typewriterLayout(params(input), size);
        expect(layout.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        for (const t of [0.3, layout.typedEnd + 0.1, layout.deleteStart + 0.05]) {
          const caret = typewriterCaret(layout, t);
          expect(caret.x).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(caret.x + layout.caretWidth).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(caret.y).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(caret.y + layout.caretHeight).toBeLessThanOrEqual(safe.y1 + 1e-6);
        }
        if (input === undefined) expect(0.9 * layout.fontSize).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("colours line 1 in the text role and line 2 in the accent (accent2 on a cream plate); the caret in the accent", () => {
    const palette = item.defaultParams.palette;
    const layout = typewriterLayout(params(), LANDSCAPE);
    expect(layout.lines.map(line => line.color)).toEqual([palette.paper, palette.accent]);
    expect(typewriterLayout(params({ plate: "paper" }), LANDSCAPE).lines.map(line => line.color)).toEqual([palette.ink, palette.accent2]);
    expect(frameText(0.3, LANDSCAPE)).toMatch(new RegExp(`<rect [^>]*fill="${palette.accent}"/>`));
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("bg");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain(plateRect(PORTRAIT, palette.bg));
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onPaper = frameText(t, PORTRAIT, { plate: "paper" });
      expect(onPaper.indexOf(plateRect(PORTRAIT, palette.paper))).toBe(onPaper.indexOf(">") + 1);
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
  });
});
