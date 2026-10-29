import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache, layoutLine } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { reelMotion, slotLayout } from "./T28_slotText";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T28";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: popping in and spinning (0.1), all spinning (0.5), 大 landed and 吉 landing (0.95),
 * the hold (1.6), dropping out (2.3). */
const TIMES = [0.1, 0.5, 0.95, 1.6, 2.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "7a15c68b3fd40a8fc617178d9d45bfb33b176b68e6d6618ccea6a80ca943d953",
    "882689e4e5d91deb855c9d2e0b47fe9750d431e39c25476f0dd8e1ece1cdc8c5",
    "ac7b39bc072aaf8e25a814acbfcc4bdd722e6564354c0486400094dcd488d6af",
    "768305efcb09053868c20ef7eaef023d0ee37d4e85e0d1cf73fccc9c7a9dcaf8",
    "db616cc159d74a096a54ac1b747f72c013cebf50a2a80c994c9959ece933f9b4",
  ],
  landscape: [
    "63c8350ccb9b85efd7bf3101e85771fcd3b4228c36f54902c7142aa97802a676",
    "3cfcce0ee74de16d1f6ce8f28f95d8a2f04db35003e9b9e7db1693877bf00375",
    "b45b79902a5baa52380c26170f9faea9a513778795cf350e818dad3eeadcf077",
    "f6f4b43e929d42f0b0eccf50ba5607f9d9c5b377affaedbe8752bdf0821ba24a",
    "c1f0ba5a21f4cda1a8e43bef08bf143636f4fae87b6357c634c47065a435a6dd",
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

describe("T28 Slot Text", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.5, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.5, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.5, PORTRAIT)).toBe(first);
  });

  it("spins every reel, then stops them left to right 0.25 s apart, each landing on its character with a small bounce", () => {
    const layout = slotLayout(params(), LANDSCAPE);
    expect(layout.reels.map(reel => reel.char)).toEqual(["大", "吉", "！"]);
    for (let index = 1; index < layout.reels.length; index += 1) {
      expect(layout.reels[index].stop - layout.reels[index - 1].stop).toBeCloseTo(0.25 * layout.timeScale, 9);
    }
    for (const reel of layout.reels) {
      expect(reel.strip[reel.target]).toBe(reel.char);
      expect(reel.strip.slice(0, reel.target)).not.toContain(reel.char); // the target only shows at the landing
      expect(reelMotion(reel, 0.3, layout.timeScale).speed).toBe(15);
      expect(reelMotion(reel, reel.stop, layout.timeScale)).toEqual({ position: reel.target, speed: 0 });
      let overshoot = 0;
      for (let step = 0; step <= 100; step += 1) {
        overshoot = Math.max(overshoot, reelMotion(reel, reel.stop - 0.34 * layout.timeScale * (1 - step / 100), layout.timeScale).position - reel.target);
      }
      expect(overshoot).toBeGreaterThan(0.05); // the bounce past the target …
      expect(overshoot).toBeLessThan(0.3); // … is small
      expect(reelMotion(reel, 0, layout.timeScale).position).toBeGreaterThanOrEqual(0);
    }
  });

  it("blurs a reel only while it moves: three blurred reels while spinning, none in the hold", () => {
    expect(frameText(0.3, PORTRAIT).match(/<filter /g)).toHaveLength(3);
    expect(frameText(0.3, PORTRAIT)).toMatch(/stdDeviation="0 [\d.]+"/); // vertical only
    expect(frameText(1.6, PORTRAIT)).not.toContain("<filter");
  });

  it("pops the windows in, holds, drops them out and ends blank", () => {
    expect(frameText(0, PORTRAIT)).not.toMatch(/<(path|rect|polygon) /);
    const exiting = frameText(2.3, PORTRAIT);
    expect(exiting).toMatch(/opacity="0\.\d+"/);
    expect(frameText(2.49, PORTRAIT)).not.toMatch(/<(path|rect|polygon) /);
  });

  it("looks onto a drum: tall portrait windows show foreshortened neighbours around the payline; landscape shows one cell", () => {
    const portrait = slotLayout(params(), PORTRAIT), landscape = slotLayout(params(), LANDSCAPE);
    expect(portrait.windowHeight / portrait.windowWidth).toBeGreaterThan(1.9);
    expect(landscape.windowHeight / landscape.windowWidth).toBeCloseTo(1.3, 6);
    expect(frameText(1.6, PORTRAIT)).toMatch(/translate\(0 -?[\d.]+\) scale\(1 0\.\d+\)/);
    expect(frameText(1.6, LANDSCAPE)).not.toMatch(/scale\(1 0\.\d+\)/);
  });

  it("keeps the row and its payline markers inside the 5% title-safe box, glyphs at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["777"] }, { lines: ["恭喜發財"] }]) {
        const safe = titleSafeBox(size), layout = slotLayout(params(input), size);
        const marker = (0.16 + 0.08) * layout.windowWidth;
        expect(layout.box.x0 - marker).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1 + marker).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        const ink = layoutLine("吉", { font: "display", weight: 900, size: layout.fontSize }).inkBox!;
        expect(ink.y1 - ink.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("colours: cream windows, ink glyphs and an accent payline on the dark card; dark windows on a cream plate", () => {
    const palette = item.defaultParams.palette;
    const hold = frameText(1.6, LANDSCAPE);
    expect(hold).toContain(`fill="${palette.paper}"`);
    expect(hold).toContain(`fill="${palette.ink}"`);
    expect(hold).toMatch(new RegExp(`<polygon [^>]*fill="${palette.accent}"`));
    const onPaper = frameText(1.6, LANDSCAPE, { plate: "paper" }).replace(plateRect(LANDSCAPE, palette.paper), "");
    expect(onPaper).toContain(`fill="${palette.bg}"`);
    expect(onPaper).toMatch(new RegExp(`<polygon [^>]*fill="${palette.accent2}"`));
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
