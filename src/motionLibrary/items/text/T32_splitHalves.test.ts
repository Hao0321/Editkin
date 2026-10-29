import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { splitCutFraction, splitHalvesLayout, splitHalvesOpening, T32_LOOP_SECONDS } from "./T32_splitHalves";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T32";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: whole (0.2), opening with the overshoot (0.6), open (1.0), closing (1.6), whole (1.9). */
const TIMES = [0.2, 0.6, 1.0, 1.6, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "bff92d3e448b02bcbf5d54f50c792aa539ba3adaa58b5b1646069c333d040518",
    "80e5c7063789ee4732244b0543f1dca4fbff6bf2df56f82e14f10faa69b08b90",
    "60fd02f9bd217e3234c9b82e9bf118d78b08766accb59deb683482e6654bc4a5",
    "61ad289af057dde642684d82d506bbf1887fabf51969d7d66160d0befddf7b83",
    "bff92d3e448b02bcbf5d54f50c792aa539ba3adaa58b5b1646069c333d040518",
  ],
  landscape: [
    "d050a82e7ce1fff1dfb6e7eb5a44035118f5c2168dadef95e13feca7f6f854b7",
    "f9ebd1c44ecf832edf19a4634684b3e969fd798fd4b85088513ea8e9881ab1d6",
    "7bde33ba608fd19d75ac400e13ba93ea78be2727d6482d1ea62fb3685dc8b186",
    "a868f4d621bda71e935346663fcb312255e834becf54fd8eabc0146e0a2ad642",
    "d050a82e7ce1fff1dfb6e7eb5a44035118f5c2168dadef95e13feca7f6f854b7",
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

describe("T32 Split Halves", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(1, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1, PORTRAIT)).toBe(first);
  });

  it("loops seamlessly at the 2 s loopSeconds, for every energy and other text", () => {
    expect(item.loopSeconds).toBe(T32_LOOP_SECONDS);
    for (const input of [undefined, { energy: "calm" }, { energy: "hype" }, { lines: ["表面功夫", "其實很在乎"] }]) {
      for (const size of [PORTRAIT, LANDSCAPE]) {
        const start = frameText(0, size, input);
        expect(frameText(2, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(4, size, input)).toBe(start);
      }
      const layout = splitHalvesLayout(params(input), PORTRAIT);
      expect(layout.closeEnd).toBeLessThanOrEqual(T32_LOOP_SECONDS - 0.1); // whole again before the loop wraps
    }
  });

  it("splits the word, reveals the second word in the slot (clipped to it), holds, then shuts", () => {
    const layout = splitHalvesLayout(params(), PORTRAIT);
    expect(splitHalvesOpening(layout, 0.2)).toBe(0);
    expect(splitHalvesOpening(layout, 1.0)).toBe(1);
    expect(splitHalvesOpening(layout, 1.8)).toBe(0);
    const peak = Math.max(...Array.from({ length: 200 }, (_, index) => splitHalvesOpening(layout, (index / 200) * 2)));
    expect(peak).toBeGreaterThan(1.02); // backOut overshoot on the way out
    expect(frameText(0.2, PORTRAIT).match(/<path /g)).toHaveLength(1); // whole
    const open = frameText(1.0, PORTRAIT);
    expect(open.match(/<path /g)).toHaveLength(3); // inner word + two halves
    expect(open.match(/<clipPath /g)).toHaveLength(3); // slot + top + bottom
    // The slot is exactly the gap between the halves.
    const slot = /<clipPath [^>]*><rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"\/><\/clipPath>/.exec(open)!;
    expect(Number(slot[1])).toBeCloseTo(layout.cutY - layout.travel, 2);
    expect(Number(slot[2])).toBeCloseTo(2 * layout.travel, 2);
  });

  it("cuts between strokes: the least-inked row near the middle (never through 王's middle stroke)", () => {
    const face = { font: "display" as const, weight: 900 };
    for (const text of ["外表", "王", "正面"]) {
      const cut = splitCutFraction(text, face, -0.02);
      expect(cut).toBeGreaterThanOrEqual(0.36);
      expect(cut).toBeLessThanOrEqual(0.64);
    }
    expect(Math.abs(splitCutFraction("王", face, -0.02) - 0.5)).toBeGreaterThan(0.05);
  });

  it("keeps the open word inside the 5% title-safe box (overshoot included), at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { energy: "calm" }, { energy: "hype" }, { lines: ["表面功夫", "其實很在乎"] }]) {
        const safe = titleSafeBox(size), layout = splitHalvesLayout(params(input), size), short = Math.min(size.width, size.height);
        const peak = Math.max(...Array.from({ length: 400 }, (_, index) => splitHalvesOpening(layout, (index / 400) * 2)));
        expect(layout.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0 - layout.travel * peak).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1 + layout.travel * peak).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(layout.box.y1 - layout.box.y0).toBeGreaterThanOrEqual(0.09 * short);
        expect(layout.innerBox.y1 - layout.innerBox.y0).toBeGreaterThanOrEqual(0.045 * short);
        // The inner word fits the slot at full opening.
        expect(layout.innerBox.y0).toBeGreaterThanOrEqual(layout.cutY - layout.travel - 1e-6);
        expect(layout.innerBox.y1).toBeLessThanOrEqual(layout.cutY + layout.travel + 1e-6);
      }
    }
  });

  it("colours the halves in the text role and the revealed word in the second tone", () => {
    const palette = item.defaultParams.palette;
    const open = frameText(1.0, PORTRAIT);
    expect(open).toContain(`fill="${palette.paper}"`);
    expect(open).toContain(`fill="${palette.accent}"`);
    const onPaper = frameText(1.0, PORTRAIT, { plate: "paper" }).replace(plateRect(PORTRAIT, palette.paper), "");
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
