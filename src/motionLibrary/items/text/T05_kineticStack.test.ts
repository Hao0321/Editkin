import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { kineticHeroIndex, kineticStackLayout } from "./T05_kineticStack";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T05";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: first line slamming (0.12), hero slamming (0.38), the full stack (0.9), the
 * drifting hold (1.6), the bottom-first fall (2.1). */
const TIMES = [0.12, 0.38, 0.9, 1.6, 2.1] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "50f3502d3036bb9c5ea59fd97555dac91fc4b6042ca38db233b3290f8838b826",
    "35d300d0ffe59aac5303fc1c5588d60a5a31a7c7592a8ea00abb1e0e239e0541",
    "029971a295ed28bcff3d42c9cfbd15c9cde9f9bd6cca553e19af8ef51779129e",
    "7a03f61bfba8b08f412fe1fe2850f9320cbe180bf672660cb3c490824d6d26aa",
    "6e0144059cc1e98a868305e8771a5e67596ba427d4390158a1f078033c92c103",
  ],
  landscape: [
    "9490e5e92f85d61bce1aac543cf598e895342c59a196e3b811c41cf4cf15b620",
    "75ee6f5c4c2a4b8b52d7f3de7ef6549a5e749698536edc61f8e3bc4b5fc6c6b4",
    "04a46c0e758ac2e0202d50a4fd203861c80ae7e0f7e1cfe05b69a308ff2d8844",
    "f182eb0600d5bdbb1324601fdf293a0e04fbe9561c4290e7db4afe95205b50be",
    "010df8096ea40fa44b9b747cea20ed31dc8e71b4fb5c209185be00b141872fe7",
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
const lineCount = (svg: string) => svg.match(/<path/g)?.length ?? 0;

describe("T05 Kinetic Stack", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.9, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.4, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.9, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.9, PORTRAIT)).toBe(first);
  });

  it("stacks small / BIG accent / small and slams the lines in 0.25 s apart from 1.4×", () => {
    const palette = item.defaultParams.palette;
    const layout = kineticStackLayout(params(), PORTRAIT);
    expect([kineticHeroIndex(1), kineticHeroIndex(2), kineticHeroIndex(3), kineticHeroIndex(4)]).toEqual([0, 1, 1, 2]);
    expect(layout.lines.map(line => line.hero)).toEqual([false, true, false]);
    expect(layout.lines.map(line => line.layout.size)).toEqual([layout.heroSize * 0.62, layout.heroSize, layout.heroSize * 0.62].map(size => Number(size.toFixed(3))));
    expect(layout.lines.map(line => line.color)).toEqual([palette.paper, palette.accent, palette.paper]);
    expect(layout.lines.map(line => Number(line.land.toFixed(6)))).toEqual([0.2, 0.45, 0.7]);
    expect(layout.slamScale).toBeCloseTo(1.4, 6);
    // Lines stack top to bottom without overlapping.
    for (let index = 1; index < layout.lines.length; index += 1) expect(layout.lines[index].box.y0).toBeGreaterThan(layout.lines[index - 1].box.y1);
    expect(lineCount(frameText(0.03, PORTRAIT))).toBe(0);
    expect(lineCount(frameText(0.12, PORTRAIT))).toBe(1);
    expect(lineCount(frameText(0.38, PORTRAIT))).toBe(2);
    expect(lineCount(frameText(0.9, PORTRAIT))).toBe(3);
    expect(Number(/scale\(([\d.]+)\)/.exec(frameText(0.08, PORTRAIT))![1])).toBeGreaterThan(1.2); // slamming in oversized
    expect(frameText(2.35, PORTRAIT)).not.toContain("<path"); // gone 0.1 s before the end
  });

  it("drifts the whole stack 3% larger through the hold, then drops the lines bottom first so none crosses another", () => {
    const layout = kineticStackLayout(params(), PORTRAIT);
    const exits = layout.lines.map(line => line.exitAt);
    expect(exits[2]).toBeLessThan(exits[1]);
    expect(exits[1]).toBeLessThan(exits[0]);
    const drift = (t: number) => Number(/^<svg[^>]*><g transform="translate\([\d. ]+\) scale\(([\d.]+)\)/.exec(frameText(t, PORTRAIT))?.[1] ?? 1);
    expect(drift(0.5)).toBe(1);
    expect(drift(1.3)).toBeGreaterThan(1);
    expect(drift(1.3)).toBeLessThan(drift(1.8));
    expect(drift(1.8)).toBeLessThanOrEqual(1.03);
    // During the fall the bottom line leads: at every sampled time it has dropped at least as far as the line above.
    const offsets = (t: number) => [...frameText(t, PORTRAIT).matchAll(/<g(?: opacity="[\d.]+")? transform="translate\(([\d.]+) ([\d.]+)\)/g)].map(match => Number(match[2]));
    const rest = offsets(1.7);
    for (const t of [2.0, 2.05, 2.1, 2.15]) {
      const now = offsets(t);
      if (now.length !== rest.length) continue;
      const drops = now.map((y, index) => y - rest[index]);
      for (let index = 1; index < drops.length; index += 1) expect(drops[index] + 1e-6, `t=${t}`).toBeGreaterThanOrEqual(drops[index - 1]);
    }
  });

  it("keeps the stack inside the 5% title-safe box; hero ≥ 9% and secondary lines ≥ 4.5% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["今", "這是主標題啊", "完"] }, { lines: ["今晚", "出發", "別等了", "現在"] }, { lines: ["出發"] }]) {
        const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const layout = kineticStackLayout(params(input), size);
        for (const line of layout.lines) {
          expect(line.box.x0, line.layout.text).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(line.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(line.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(line.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
          expect(line.box.y1 - line.box.y0, line.layout.text).toBeGreaterThanOrEqual((line.hero ? 0.09 : 0.045) * short);
        }
      }
    }
  });

  it("falls back to a readable hero colour when the accent matches the plate", () => {
    const palette = item.defaultParams.palette;
    const onAccent = kineticStackLayout(params({ plate: "accent" }), PORTRAIT).lines.map(line => line.color);
    expect(onAccent[1]).not.toBe(palette.accent);
    expect(new Set(onAccent).size).toBe(2); // still two-tone
    expect(frameText(0.9, PORTRAIT, { palette: { accent: "#22BBFF" } })).toContain(`fill="#22BBFF"`);
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("bg");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain("<rect");
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.startsWith(header(PORTRAIT) + plateRect(PORTRAIT, palette.bg))).toBe(true);
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onPaper = frameText(t, PORTRAIT, { plate: "paper" });
      expect(onPaper.startsWith(header(PORTRAIT) + plateRect(PORTRAIT, palette.paper))).toBe(true);
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
  });
});
