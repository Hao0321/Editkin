import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { drawStretchWord, STRETCH_Y, stretchTiming, stretchWordLayout } from "./T06_stretchText";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T06";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: popping up (0.12), first pass, 伸 stretched (0.5), second pass, 展 stretched
 * (1.55), rest (1.2), squashing out (2.2). */
const TIMES = [0.12, 0.5, 1.2, 1.55, 2.2] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "7b2f807243f372ad02af5cf0c32877f36cb58d60e7b32d1cba3c3136a88dd514",
    "4ceed86c267051dd038906fe0a140ea0c3a86400c2f6c9d483b26aff8d8046f1",
    "f487ff5a18d8cb3ff3282989bb996254cc0052a6b59f84309b45c5ddb03da72d",
    "62b05527e32b90b09116c7737847c7b60aa06a3dff48b5980becb077852a0d5e",
    "883fc5ce56325573f38a7646aa3e072c4ed45039c3b4f584f27e6f90ad0623bb",
  ],
  landscape: [
    "6fc4f5f35150975bd06b86b827e47916ed66591d28b80d2218dbe7674668722d",
    "20967a15ef9b25be7f85382aed67cd042a5670c523a0ca3c277a0ccd38adf2f5",
    "5f8be90d426c72c00f91f8ff9340848c59f020f57a1216623d5cb14bd9be39f9",
    "86fee259905c1089c358b980e6744f02c31d8a3cff26f462a4882d9157375cb1",
    "60350abef3be21190906f87e31fb43a803fe4bc9e4c8c2eded8260449703492d",
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
/** Per-glyph [scaleX, scaleY] in draw order (1, 1 for glyphs drawn at rest). */
function poses(svg: string): Array<[number, number]> {
  return [...svg.matchAll(/<path d="[^"]+" fill="#[0-9A-F]{6}" transform="([^"]+)"/g)].map(match => {
    const scale = /scale\(([\d.]+)(?: ([\d.]+))?\)/.exec(match[1]);
    return scale ? [Number(scale[1]), Number(scale[2] ?? scale[1])] : [1, 1];
  });
}

describe("T06 Stretch Text", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.4, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.5, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.5, PORTRAIT)).toBe(first);
  });

  it("pops the characters up from the floor, then runs whole wave passes evenly through the hold", () => {
    const timing = stretchTiming(params(), 2);
    expect(timing.waveCycles).toBe(2);
    expect(timing.waveStart).toBeCloseTo(0.34, 9);
    // The last pass ends at least 0.1 s before the exit.
    expect(timing.waveStart + (timing.waveCycles - 1) * timing.cycleSeconds + timing.passSeconds).toBeLessThanOrEqual(timing.exitAt - 0.1 + 1e-9);
    expect(frameText(0, PORTRAIT)).not.toContain("<path"); // nothing above the floor yet
    const popping = poses(frameText(0.04, PORTRAIT));
    expect(popping).toHaveLength(1);
    expect(popping[0][1]).toBeLessThan(1);
    // Wave: character i peaks 0.175 s into its pulse, characters 0.25 s apart.
    const peak = (cycle: number, index: number) => timing.waveStart + cycle * timing.cycleSeconds + 0.25 * index + 0.175;
    for (const cycle of [0, 1]) {
      const first = poses(frameText(peak(cycle, 0), PORTRAIT)), second = poses(frameText(peak(cycle, 1), PORTRAIT));
      expect(first[0][1], `cycle ${cycle}`).toBeCloseTo(1 + STRETCH_Y, 2);
      expect(first[0][0]).toBeCloseTo(0.85, 2);
      expect(second[1][1]).toBeCloseTo(1 + STRETCH_Y, 2);
      expect(first[1]).toEqual([1, 1]);
    }
    expect(poses(frameText(timing.waveStart + timing.passSeconds + 0.03, PORTRAIT))).toEqual([[1, 1], [1, 1]]); // rest between passes
    expect(frameText(2.37, PORTRAIT)).not.toContain("<path"); // squashed back into the floor
  });

  it("anchors every stretch on the floor line: the glyph bottoms stay put", () => {
    const layout = stretchWordLayout(params(), PORTRAIT, STRETCH_Y);
    const floors = new Set(layout.glyphs.map(glyph => glyph.floorY.toFixed(3)));
    expect(floors.size).toBe(1);
    const stretched = frameText(stretchTiming(params(), 2).waveStart + 0.175, PORTRAIT);
    const anchor = /translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+) ([\d.]+)\)/.exec(stretched)!;
    expect(Number(anchor[2])).toBeCloseTo(layout.glyphs[0].floorY, 2);
  });

  it("keeps the rest word and its full stretch inside the 5% title-safe box, at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const energy of ["calm", "standard", "hype"] as const) {
        for (const input of [{ energy }, { energy, lines: ["伸展開"] }, { energy, lines: ["一起伸展吧"] }]) {
          const safe = titleSafeBox(size);
          const stretch = STRETCH_Y * ({ calm: 0.5, standard: 1, hype: 1.6 } as const)[energy];
          const layout = stretchWordLayout(params(input), size, stretch);
          expect(layout.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(layout.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(layout.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
          const height = layout.box.y1 - layout.box.y0;
          expect(layout.box.y1 - height * (1 + stretch), `${energy} ${size.width}`).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(height).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        }
      }
    }
  });

  it("alternates ink and accent2 on the accent plate, paper and accent over footage (ART_DIRECTION §0)", () => {
    const palette = item.defaultParams.palette;
    expect(stretchWordLayout(params({ plate: "accent" }), PORTRAIT, STRETCH_Y).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2]);
    expect(stretchWordLayout(params(), PORTRAIT, STRETCH_Y).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent]);
  });

  it("exports the stretch layout and drawing for T75 (any per-character pose; collapsed glyphs are skipped)", () => {
    const layout = stretchWordLayout(params({ lines: ["伸縮自如"] }), PORTRAIT, 0.3, false);
    expect(layout.glyphs).toHaveLength(4);
    expect(new Set(layout.glyphs.map(glyph => glyph.color)).size).toBe(1); // alternate = false
    const parts = drawStretchWord(layout, glyph => ({ scaleX: 1, scaleY: 1 + 0.3 * Math.sin(glyph.index) }));
    expect(parts).toHaveLength(4);
    expect(drawStretchWord(layout, glyph => (glyph.index === 0 ? { scaleX: 1, scaleY: 0.001 } : null))).toHaveLength(0);
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("accent");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain("<rect");
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.startsWith(header(PORTRAIT) + plateRect(PORTRAIT, palette.bg))).toBe(true);
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onAccent = frameText(t, PORTRAIT, { plate: "accent" });
      expect(onAccent.startsWith(header(PORTRAIT) + plateRect(PORTRAIT, palette.accent))).toBe(true);
      expect(maskColors(onAccent.replace(plateRect(PORTRAIT, palette.accent), ""))).toBe(maskColors(none));
    }
  });
});
