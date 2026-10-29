import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T49_AMPLITUDE, T49_PHASE_STEP, T49_TILT, waveLettersPlan, wavePose } from "./T49_waveLetters";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T49";
const LOOP = 1.2;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.2, 0.45, 0.7, 1] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "ea07fb6c387126f17c08f90441b506352f6b3899be7668747de23caba20705fa",
    "cf9cd677c873bc0b9b4a26ee945a35ba784686ad406edc3d6806b1d8f5561f60",
    "1aa6cbaed578338715240acb565bd0289f38df7dbf2d9c5dbc88f39b8323218a",
    "3f50e19d08ef7e428e151a5403b9ba33aff00fa99c0ddf85f977fd515f3d7ada",
    "f34c0f65fd74eba89d136ef9afec21d31c2e2dda3688bafdb1675d0b9f2fa184",
  ],
  landscape: [
    "7596f3dde0435f7c5df5076c5854c4ad37283c92bc8e511985d60a38cde5f0c5",
    "1e1428cc26ef99be06cdbc1f01f188c851a3ab336e1e7d84ba0fd1c2d7f96d4f",
    "95682f2f72e823b00878efc633b2efe6fd88051a644f198613b6934579a4b63e",
    "ba0609ed8dcf56a144cc2d036d0ec6f241a204231be2295dca65a3b797c45f11",
    "cd5914bced2834230bc68811c8b4e73bf1985f3281a12d4c5a43816f2fc210f2",
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

describe("T49 Wave Letters", () => {
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
    // The renderer samples t = i / fps: frames 36 and 72 at 30 fps are frame 0 again.
    expect(frameText(36 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
    expect(frameText(72 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
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

  it("every character rides y = 18% of the glyph height × sin(2πt/1.2 − 0.9·i) and tilts with the slope (±8°)", () => {
    expect([T49_AMPLITUDE, T49_PHASE_STEP, T49_TILT]).toEqual([0.18, 0.9, 8]);
    const plan = waveLettersPlan(params(), PORTRAIT);
    expect(plan.glyphs).toHaveLength(4);
    expect(plan.amplitude).toBeCloseTo(0.18 * plan.glyphHeight, 9);
    expect(plan.tilt).toBe(8);
    for (const index of [0, 1, 3]) {
      for (const t of [0, 0.25, 0.6, 1.05]) {
        const pose = wavePose(plan, index, t / LOOP);
        expect(pose.dy).toBeCloseTo(plan.amplitude * Math.sin((2 * Math.PI * t) / LOOP - 0.9 * index), 9);
        expect(Math.abs(pose.rotation)).toBeLessThanOrEqual(8 + 1e-9);
      }
    }
    // The tilt follows the slope: zero at a crest, steepest where the wave crosses its rest line.
    const crest = (Math.PI / 2) / (2 * Math.PI);
    expect(Math.abs(wavePose(plan, 0, crest).rotation)).toBeLessThan(1e-9);
    expect(Math.abs(wavePose(plan, 0, 0).rotation)).toBeCloseTo(8, 9);
    // Energy scales the amplitude and tilt, never the period.
    expect(waveLettersPlan(params({ energy: "hype" }), PORTRAIT).tilt).toBeGreaterThan(8);
  });

  it("the word fills 80–90% of the title-safe width in both formats and stays inside the safe box at every phase", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["浪"] }, { lines: ["海浪", "起伏"] }, { lines: ["海浪起伏不停息"] }]) {
        const plan = waveLettersPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(plan.glyphHeight, JSON.stringify(input)).toBeGreaterThanOrEqual(0.09 * short);
        if (input === undefined) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
        for (let step = 0; step < 48; step += 1) {
          for (const glyph of plan.glyphs) {
            const pose = wavePose(plan, glyph.index, step / 48), radians = (pose.rotation * Math.PI) / 180;
            const corners = [[glyph.box.x0, glyph.box.y0], [glyph.box.x1, glyph.box.y0], [glyph.box.x0, glyph.box.y1], [glyph.box.x1, glyph.box.y1]]
              .map(([x, y]) => [glyph.cx + (x - glyph.cx) * Math.cos(radians) - (y - glyph.cy) * Math.sin(radians),
                glyph.cy + pose.dy + (x - glyph.cx) * Math.sin(radians) + (y - glyph.cy) * Math.cos(radians)]);
            for (const [x, y] of corners) {
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

  it("colours alternate per ART_DIRECTION §0: paper and accent on the dark card, ink and the deep shade on the accent card", () => {
    const palette = item.defaultParams.palette;
    expect(waveLettersPlan(params(), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
    expect(waveLettersPlan(params({ plate: "accent" }), PORTRAIT).glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
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
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size) + plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(onAccent.startsWith(header(size) + plateRect(size, palette.accent))).toBe(true);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
