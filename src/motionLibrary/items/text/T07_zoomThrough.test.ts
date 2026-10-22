import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { lineOutlines, sampleGlyphCells } from "../../svg/glyphCells";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { zoomThroughPlan, zoomThroughTarget } from "./T07_zoomThrough";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T07";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: the first approach (0.2), inside the first fly-through (0.8), 光 settling (0.95), the
 * second fly-through (1.5), the exit fly (2.25). */
const TIMES = [0.2, 0.8, 0.95, 1.5, 2.25] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "c4cecad0859b069cbfb2b53bfdff34ad8fc7b235b59a598c62db3033b28e64ad",
    "f4a76291b3af33e0505e80dbdf60fe4743ebe82f1d64a62da71db8a6abc76508",
    "a43ebd667b21cc22c0446331e01d0bdb6aed5d0c0152cd07185e2283d99bb605",
    "31eb3a425d6f112b236cf18132c1d819c7f643366b90ebd4a38767bb6dfc903b",
    "2deccaaa04a1ec279cf92a9cd2b1bbb6267919e40cec5bb503cc08c3e6b1c1af",
  ],
  landscape: [
    "647139fa6f5c2f61f8beb373c6ea4c5f615c0724bfc9e3a901c1b57c6e1fbdf2",
    "d571dc3bbcb5dbb0eef522bb1e6aa9f34df53d64ab35236d57931db136343d11",
    "8e6d93ac932f7e5df2e52dfad4ee03c88959e364445d41e8ee5910c576e87014",
    "d8fc4e2a93ea2a9bc02fa52f2465bc723c01189be95facc63c66428ceb52363c",
    "ed624255677d509453fa580a5862b66d549986c0d059069b8181bacfba1394be",
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
/** Word groups in draw order: [scale, fill]. */
function words(svg: string): Array<[number, string]> {
  return [...svg.matchAll(/scale\(([\d.]+)\)"><path d="[^"]+" fill="(#[0-9A-F]{6})"/g)].map(match => [Number(match[1]), match[2]]);
}

describe("T07 Zoom Through", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.8, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.4, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.8, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.8, PORTRAIT)).toBe(first);
  });

  it("chains the words: enter from far, hold, fly through into the next, and fly out of the last into empty space", () => {
    const plan = zoomThroughPlan(params(), PORTRAIT);
    expect(plan.words.map(word => word.layout.text)).toEqual(["未來", "光", "維度"]);
    expect(plan.segments.map(segment => `${segment.kind}${segment.word}`)).toEqual(["enter0", "hold0", "fly0", "hold1", "fly1", "hold2", "exit2"]);
    const last = plan.segments[plan.segments.length - 1];
    expect(last.end).toBeCloseTo(2.4 - 0.06 * plan.timeScale, 9); // a clean blank tail
    for (let index = 1; index < plan.segments.length; index += 1) expect(plan.segments[index].start).toBeCloseTo(plan.segments[index - 1].end, 9);
    const palette = item.defaultParams.palette;
    expect(plan.words.map(word => word.color)).toEqual([palette.paper, palette.accent, palette.paper]);
    // Enter: small and growing; hold: 1.0; fly: the outgoing word grows past the frame while the next one (behind it) grows slowly.
    const entering = words(frameText(0.1, PORTRAIT));
    expect(entering).toHaveLength(1);
    expect(entering[0][0]).toBeLessThan(0.6);
    const fly = plan.segments.find(segment => segment.kind === "fly")!;
    expect(words(frameText((fly.start + plan.segments[1].start) / 2, PORTRAIT))).toEqual([[1, palette.paper]]);
    const at = (u: number) => words(frameText(fly.start + u * (fly.end - fly.start), PORTRAIT));
    const early = at(0.3), late = at(0.5);
    expect(early.map(word => word[1])).toEqual([palette.accent, palette.paper]); // next word drawn behind the outgoing one
    expect(late[1][0]).toBeGreaterThan(early[1][0] * 2); // the strokes rush past
    expect(late[0][0] / early[0][0]).toBeLessThan(late[1][0] / early[1][0]); // parallax: the far word grows more slowly
    expect(at(0.8)).toHaveLength(1); // through: only the next word is left
    expect(at(0.8)[0][1]).toBe(palette.accent);
    expect(frameText(2.39, PORTRAIT)).not.toContain("<path");
  });

  it("aims every fly-through into clear space inside the word and clips the huge strokes to the frame", () => {
    const plan = zoomThroughPlan(params(), PORTRAIT);
    for (const word of plan.words) {
      const target = zoomThroughTarget(word.layout), ink = word.layout.inkBox!;
      expect(target.x).toBeGreaterThan(ink.x0);
      expect(target.x).toBeLessThan(ink.x1);
      expect(target.y).toBeGreaterThan(ink.y0);
      expect(target.y).toBeLessThan(ink.y1);
      // No stroke within the clearance, checked on an independent finer grid (tolerance: one target-grid cell).
      const cells = sampleGlyphCells(lineOutlines(word.layout), { cellSize: word.layout.size / 60 });
      const nearest = Math.min(...cells.map(cell => Math.hypot(cell.x + cell.size / 2 - target.x, cell.y + cell.size / 2 - target.y)));
      expect(nearest + word.layout.size / 36, word.layout.text).toBeGreaterThanOrEqual(target.clearance);
      expect(target.clearance).toBeGreaterThan(0.03 * word.layout.size);
    }
    const flying = frameText(0.8, PORTRAIT);
    expect(flying).toContain(`<clipPath id="mclip1" clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="1080" height="1920"/></clipPath>`);
    expect(flying).toContain(`<g clip-path="url(#mclip1)">`);
  });

  it("keeps every word inside the 5% title-safe box at its hold, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["我們的", "下一站", "是未來", "出發"] }, { lines: ["光"] }]) {
        const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        for (const word of zoomThroughPlan(params(input), size).words) {
          expect(word.box.x0, word.layout.text).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(word.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(word.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(word.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
          expect(word.box.y1 - word.box.y0, word.layout.text).toBeGreaterThanOrEqual(0.09 * short);
        }
      }
    }
  });

  it("spends spare clip time on the holds and squeezes short clips", () => {
    const long = zoomThroughPlan(params({ durationSeconds: 4 }), PORTRAIT);
    const holds = long.segments.filter(segment => segment.kind === "hold").map(segment => segment.end - segment.start);
    expect(Math.min(...holds)).toBeGreaterThan(0.6);
    const short = zoomThroughPlan(params({ durationSeconds: 1.5 }), PORTRAIT);
    expect(short.timeScale).toBeLessThan(1);
    expect(short.segments[short.segments.length - 1].end).toBeLessThanOrEqual(1.5);
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("paper");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain(plateRect(PORTRAIT, palette.bg));
      expect(frameText(t, PORTRAIT, { plate: "bg" }).replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onPaper = frameText(t, PORTRAIT, { plate: "paper" });
      expect(onPaper.indexOf(plateRect(PORTRAIT, palette.paper))).toBe(onPaper.indexOf("</defs>") + 7);
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
  });
});
