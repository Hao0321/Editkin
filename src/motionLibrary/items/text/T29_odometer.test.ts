import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { odometerLayout, odometerReel } from "./T29_odometer";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T29";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: rolling into view (0.05), rolling with motion blur (0.6), the low digits landing (1.6),
 * the hold (2.2), rolling out (2.85). */
const TIMES = [0.05, 0.6, 1.6, 2.2, 2.85] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "1c0980d50e725ec892d82bb206dda732dd80bf5d15fcf23df50cef46f8162624",
    "9335ac6ab9472b22ebc6a5b8e7504c8844d2e846ce7822a40f411c0bd44f8d77",
    "007a910eb6979ba7c588919c37c14f0b4799afe5024187b73100becd9bb4dafc",
    "afe309fc8c383f760754b9b0441a54824e22d7a554f6036fd81266bbb274c31c",
    "23b6424f347e7059cffca3a0972a224a788f1b7cdfa9ae2104c13789ed09bcdd",
  ],
  landscape: [
    "4e10e10d28a5c3c348fc7f742b458cf6cfbeeec0c988f4aad97cdb2f68a48014",
    "a7d1a7ae9bb3290dda6e94ea08ad069803e43a30a982aa30b0f2eef7b52970c4",
    "1eb410635dcc7208b5ab31e4d8cde22ece585f535573036c2f5782db31b33a5a",
    "9d4cad5b364b53bd457ffea5e7c1adca24b9ff9dc3196da4deb937d50197200c",
    "259c2dcd38a38bc8e91c186ef0b7d6efaa13253400afb0d7992f406e4f25bb79",
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

describe("T29 Odometer", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.6, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 3, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("rolls one reel per digit to 12,480: lower digits travel further and spin faster, landing left to right, the ones last", () => {
    const layout = odometerLayout(params(), LANDSCAPE);
    expect(layout.digitFace).toEqual({ font: "latin" }); // Bebas Neue digits
    expect(layout.reels.map(reel => reel.digit)).toEqual([1, 2, 4, 8, 0]);
    expect(layout.reels.map(reel => reel.place)).toEqual([4, 3, 2, 1, 0]);
    const distances = layout.reels.map(reel => reel.distance);
    for (let index = 1; index < distances.length; index += 1) expect(distances[index]).toBeGreaterThan(distances[index - 1]);
    // Every reel stops showing its digit: cell (distance − 1) mod 10.
    for (const reel of layout.reels) expect((reel.distance - 1) % 10).toBe(reel.digit);
    const lands = layout.reels.map(reel => reel.land);
    for (let index = 1; index < lands.length; index += 1) expect(lands[index] - lands[index - 1]).toBeCloseTo(0.05 * layout.timeScale, 9);
    const speeds = layout.reels.map(reel => odometerReel(reel, 0.4, layout.timeScale).speed);
    for (let index = 1; index < speeds.length; index += 1) expect(speeds[index]).toBeGreaterThan(speeds[index - 1]);
    for (const reel of layout.reels) {
      expect(odometerReel(reel, 0, layout.timeScale).position).toBe(0); // blank below 0
      expect(odometerReel(reel, reel.land, layout.timeScale)).toEqual({ position: reel.distance, speed: 0 });
      expect(odometerReel(reel, 2.99, layout.timeScale).position).toBeCloseTo(reel.distance + 1, 3); // rolled out
    }
  });

  it("blurs fast reels only, holds sharp, and ends blank", () => {
    expect(frameText(0.6, LANDSCAPE)).toMatch(/<filter [^>]*><feGaussianBlur [^>]*stdDeviation="0 [\d.]+"/);
    expect(frameText(2.2, LANDSCAPE)).not.toContain("<filter");
    expect(frameText(0, LANDSCAPE)).not.toMatch(/<path d="M/);
    expect(frameText(2.99, LANDSCAPE)).not.toMatch(/<path d="M/);
  });

  it("sets one row in landscape and stacks the label above the number in portrait", () => {
    const landscape = odometerLayout(params(), LANDSCAPE), portrait = odometerLayout(params(), PORTRAIT);
    expect(landscape.mode).toBe("row");
    expect(portrait.mode).toBe("stack");
    expect(landscape.label!.x).toBeLessThan(landscape.numberX);
    expect(landscape.unit!.x).toBeGreaterThan(landscape.reels[landscape.reels.length - 1].cx);
    expect(portrait.label!.y).toBeLessThan(portrait.baseline - portrait.digitHeight);
    // A single number line works without words.
    const bare = odometerLayout(params({ lines: ["2026"] }), LANDSCAPE);
    expect(bare.label).toBeUndefined();
    expect(bare.reels.map(reel => reel.digit)).toEqual([2, 0, 2, 6]);
  });

  it("keeps the lockup inside the 5% title-safe box: digits at least 9% and the words 4.5% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["已售出", "1,234,567", "件"] }, { lines: ["99"] }]) {
        const safe = titleSafeBox(size), layout = odometerLayout(params(input), size), short = Math.min(size.width, size.height);
        expect(layout.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(layout.digitHeight).toBeGreaterThanOrEqual(0.09 * short);
        for (const word of [layout.label, layout.unit]) {
          if (word?.layout.inkBox) expect(word.layout.inkBox.y1 - word.layout.inkBox.y0).toBeGreaterThanOrEqual(0.045 * short);
        }
      }
    }
  });

  it("colours: paper digits and accent words on the dark card; ink digits and accent2 words on a cream plate", () => {
    const palette = item.defaultParams.palette;
    const hold = frameText(2.2, LANDSCAPE);
    expect(hold).toContain(`fill="${palette.paper}"`);
    expect(hold).toContain(`fill="${palette.accent}"`);
    const onPaper = frameText(2.2, LANDSCAPE, { plate: "paper" }).replace(plateRect(LANDSCAPE, palette.paper), "");
    expect(onPaper).toContain(`fill="${palette.ink}"`);
    expect(onPaper).toContain(`fill="${palette.accent2}"`);
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
      const first = onPaper.includes("</defs>") ? onPaper.indexOf("</defs>") + 7 : onPaper.indexOf(">") + 1;
      expect(onPaper.indexOf(plateRect(PORTRAIT, palette.paper))).toBe(first);
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
  });
});
