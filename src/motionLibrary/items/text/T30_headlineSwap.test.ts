import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { headlineSwapLayout } from "./T30_headlineSwap";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T30";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: the rules and band wiping in (0.15), the first headline rising in (0.4), the first
 * swap (1.64) and the second (2.87) mid-slide, the band wiping off (4.3). */
const TIMES = [0.15, 0.4, 1.64, 2.87, 4.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "36c33738b25a2cae9b9f99de1675d9b2df987c2d392115a8a6d30714233d77ba",
    "b031a479cf7ba14c53ce231bd0daede82a740b6ad9829dcaa2b263ae426c5e43",
    "49d58831931303b3e5c3b3862ba5c79ab25c86ec820d48aab7b557c368ee20ce",
    "6eb5fdea7626dc33ebbf793f7b87cab1fedba8558c3b302a865cc5ce44429b35",
    "868429d8704be431dbf781e4b4d551e30940d553d7b0c9796b6111f1e1e06cd8",
  ],
  landscape: [
    "31facd976bd7b83ec68f317a49f703dc08df9c43401d4a4fc5f07423288efa90",
    "c8f2b34f835924219de5eccad12d840d0bffbf84cfff72c8b4e9df373e2e3987",
    "7997f12f40b1f5121dfbb7dd91e4805a98461c6567e9a537a67b68ac46eb0643",
    "60dc58d7e3e542fc82b1f12455b19c0b2ed8a9314c1ab9ce7808a48caca08714",
    "8c14066e1a293b4ca253ac289b312a37570716eea673a4606de5fb5a2cf6d76e",
  ],
};
/** The single-headline case (the catalog default before the p2d review). */
const ONE = { lines: ["快報", "正式發表"] };

const item = getMotionLibraryItem(ID) as TextMotionItem;
const params = (input?: unknown): TextMotionParams => resolveMotionLibraryParams(item, input);
function frameText(t: number, size: MotionFrameSize, input?: unknown): string {
  const frame = generateAnyMotionFrame(item, params(input), t, size);
  return "svg" in frame ? frame.svg : frame.matte;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const plateRect = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");

describe("T30 Headline Swap", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(2, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 4.5, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.4, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.4, PORTRAIT)).toBe(first);
  });

  it("builds the bar (rules, band, label block), slides the headline in, holds, slides it out, wipes off and ends blank", () => {
    const layout = headlineSwapLayout(params(ONE), LANDSCAPE);
    expect(layout.label?.layout.text).toBe("快報");
    expect(layout.headlines.map(headline => headline.layout.text)).toEqual(["正式發表"]);
    expect(layout.swaps).toHaveLength(1);
    expect(layout.swaps[0]).toBeCloseTo(3.84, 6); // one headline: a long hold, then out (gone with the band by 4.42 s)
    expect(frameText(0.01, LANDSCAPE, ONE)).not.toContain("<path"); // only the rules have started
    const hold = frameText(2, LANDSCAPE, ONE);
    expect(hold.match(/<path /g)).toHaveLength(2); // label + headline
    expect(hold.match(/<rect /g)!.length).toBeGreaterThanOrEqual(4); // band, block, two rules (+ clips)
    expect(frameText(4.49, LANDSCAPE, ONE)).not.toMatch(/<(path|rect) [^>]*fill/);
  });

  it("swaps the default three headlines by sliding them up through the band, evenly spaced (about 1.2 s in 4.5 s)", () => {
    expect(params().lines).toEqual(["快報", "正式發表", "明天上線", "敬請期待"]);
    const layout = headlineSwapLayout(params(), LANDSCAPE);
    expect(layout.headlines.map(headline => headline.layout.text)).toEqual(["正式發表", "明天上線", "敬請期待"]);
    expect(layout.swaps).toHaveLength(3);
    const spacing = layout.swaps[1] - layout.swaps[0];
    expect(spacing).toBeGreaterThan(1.1);
    expect(spacing).toBeLessThan(1.7);
    expect(layout.swaps[2] - layout.swaps[1]).toBeCloseTo(spacing, 9);
    // Mid-swap both headlines show, clipped to the band; between swaps only one.
    const mid = frameText(layout.swaps[0] + 0.22, LANDSCAPE);
    expect(mid.match(/<path /g)).toHaveLength(3);
    expect(mid).toMatch(/<g clip-path="url\(#[^)]+\)"><path [^>]+><path /);
    expect(frameText(layout.swaps[0] - 0.1, LANDSCAPE).match(/<path /g)).toHaveLength(2);
    expect(frameText(0.01, LANDSCAPE)).not.toContain("<path");
    expect(frameText(4.49, LANDSCAPE)).not.toMatch(/<(path|rect) [^>]*fill/); // ends blank
  });

  it("sets the label inline in landscape and as a tab on the band in portrait", () => {
    const landscape = headlineSwapLayout(params(), LANDSCAPE), portrait = headlineSwapLayout(params(), PORTRAIT);
    expect(landscape.mode).toBe("inline");
    expect(portrait.mode).toBe("tab");
    expect(landscape.label!.block.y0).toBeCloseTo(landscape.band.y0, 6);
    expect(portrait.label!.block.y1).toBeLessThanOrEqual(portrait.ruleTop.y0 + 1e-6);
    const single = headlineSwapLayout(params({ lines: ["今日頭條"] }), LANDSCAPE);
    expect(single.label).toBeUndefined();
    expect(single.headlines.map(headline => headline.layout.text)).toEqual(["今日頭條"]);
  });

  it("keeps the bar inside the 5% title-safe box: headline at least 9% and label 4.5% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, ONE, { lines: ["LIVE", "今晚八點直播"] }]) {
        const safe = titleSafeBox(size), layout = headlineSwapLayout(params(input), size), short = Math.min(size.width, size.height);
        expect(layout.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        for (const headline of layout.headlines) {
          const ink = headline.layout.inkBox!;
          expect(ink.y1 - ink.y0).toBeGreaterThanOrEqual(0.09 * short);
          expect(headline.x + ink.x1).toBeLessThanOrEqual(layout.band.x1 + 1e-6);
        }
        const label = layout.label!.layout.inkBox!;
        expect(label.y1 - label.y0).toBeGreaterThanOrEqual(0.045 * short);
      }
    }
  });

  it("colours: cream band, ink headline, accent rules; the label block is ink where that reads and the accent on the dark card", () => {
    const palette = item.defaultParams.palette;
    const dark = frameText(2, LANDSCAPE);
    expect(dark).toContain(`fill="${palette.paper}"`);
    expect(dark).toContain(`fill="${palette.ink}"`);
    expect(dark.match(new RegExp(`fill="${palette.accent}"`, "g"))!.length).toBeGreaterThanOrEqual(3); // block + two rules
    const onPaper = frameText(2, LANDSCAPE, { plate: "paper" }).replace(plateRect(LANDSCAPE, palette.paper), "");
    expect(onPaper).toContain(`fill="${palette.bg}"`); // the band turns dark on a cream plate
    const onAccent = frameText(2, LANDSCAPE, { plate: "accent" }).replace(plateRect(LANDSCAPE, palette.accent), "");
    expect(onAccent).toMatch(new RegExp(`<rect [^>]*fill="${palette.ink}"`)); // the reference's ink block
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
