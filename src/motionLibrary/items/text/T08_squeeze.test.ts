import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { squeezeLayout, squeezeSpring, T08_LOOP_SECONDS } from "./T08_squeeze";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T08";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: 彈力 held (0.1), squeezing (0.38), 反彈 overshooting (0.55), 反彈 held (1.0), 彈力
 * springing back (1.55). */
const TIMES = [0.1, 0.38, 0.55, 1.0, 1.55] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "00c5d85d09cc8c8257f6a74d6d6df54a483c0021ae12fd493c7cba462ccef80b",
    "ce860598ef11467b96af386462d727d74be1f815f2d3a0a46869ce0fe86c5114",
    "dfa8e350a35f6d41048097df7c0af28f4337d824312e64a0f1a98f920887e509",
    "654657018dc38a5a33b8c8cf8ea601a0d72c554864c96d9c99ff51ff7317229b",
    "239f8fccadbc0239a2741ba4a410eb9d857c2563eb6612d8d5e4d2829a1126de",
  ],
  landscape: [
    "33d7bb3428951b9d069b59f802f5908d3cb4d5684af220d8a1ff30c777fcff4b",
    "67ddddf0bd1368ea7f29e829f9afbacb30d7e402ea79da26ec04d0926e10d1f0",
    "3306d59d65730e85656206f8ab0b9955fbca533c9b0159a3d71b08fb6768facb",
    "b15408109917f9e0733d386e3a7552cdc08590daace6b8f1ead8396979631299",
    "3f8069bf2819d3b101b7fb1ebfc4cc05dee9a75b591e115ad9c790143910c5c6",
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
/** [scaleX, scaleY, fill] of the word in a frame (1, 1 at rest). */
function pose(svg: string): [number, number, string] {
  const scale = /scale\(([\d.]+) ([\d.]+)\)/.exec(svg);
  const fill = /fill="(#[0-9A-F]{6})"/.exec(svg)![1];
  return scale ? [Number(scale[1]), Number(scale[2]), fill] : [1, 1, fill];
}

describe("T08 Squeeze", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.38, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.38, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.38, PORTRAIT)).toBe(first);
  });

  it("loops seamlessly at the 2.0 s loopSeconds for every energy and line count", () => {
    expect(item.loopSeconds).toBe(T08_LOOP_SECONDS);
    for (const input of [undefined, { energy: "calm" }, { energy: "hype" }, { lines: ["一", "二", "三"] }, { durationSeconds: 6 }]) {
      for (const size of [PORTRAIT, LANDSCAPE]) {
        const start = frameText(0, size, input);
        expect(frameText(2, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(4, size, input)).toBe(start);
      }
    }
    expect(frameText(1, PORTRAIT)).not.toBe(frameText(0, PORTRAIT));
  });

  it("squeezes to 0.35 × 1.15, swaps to the accent word at full squeeze and springs out through 1.12", () => {
    const palette = item.defaultParams.palette;
    const layout = squeezeLayout(params(), PORTRAIT);
    expect(layout.squeezedX).toBeCloseTo(0.35, 6);
    expect(layout.words.map(word => word.layout.text)).toEqual(["彈力", "反彈"]);
    expect(layout.words.map(word => word.color)).toEqual([palette.paper, palette.accent]);
    // The first swap happens at 0.425 s (the squeeze runs 0.225–0.425 s).
    const before = pose(frameText(0.42, PORTRAIT)), after = pose(frameText(0.43, PORTRAIT));
    expect(before[2]).toBe(palette.paper);
    expect(after[2]).toBe(palette.accent);
    expect(before[0]).toBeLessThan(0.4);
    expect(before[1]).toBeGreaterThan(1.13);
    expect(after[0]).toBeLessThan(0.45);
    let peak = 0;
    for (let frame = 0; frame <= 60; frame += 1) peak = Math.max(peak, pose(frameText(0.425 + frame * 0.006, PORTRAIT))[0]);
    expect(peak).toBeGreaterThan(1.09);
    expect(peak).toBeLessThan(1.15);
    expect(pose(frameText(1.0, PORTRAIT))).toEqual([1, 1, palette.accent]); // held
    // The spring settles exactly: E(0) = 0, E(1) = 1, one overshoot of about 18%.
    expect(squeezeSpring(0)).toBe(0);
    expect(squeezeSpring(1)).toBe(1);
    expect(Math.max(...Array.from({ length: 101 }, (_, index) => squeezeSpring(index / 100)))).toBeCloseTo(1.18, 1);
  });

  it("keeps both words inside the 5% title-safe box at rest (and at the 1.12 overshoot), at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["彈力十足", "反彈"] }, { lines: ["春", "夏", "秋"] }]) {
        const safe = titleSafeBox(size);
        for (const word of squeezeLayout(params(input), size).words) {
          const cx = (word.box.x0 + word.box.x1) / 2, half = ((word.box.x1 - word.box.x0) / 2) * 1.12;
          expect(word.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(cx + half).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(cx - half).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(word.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(word.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
          expect(word.box.y1 - word.box.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        }
      }
    }
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
      const onAccent = frameText(t, PORTRAIT, { plate: "accent" });
      expect(onAccent.startsWith(header(PORTRAIT) + plateRect(PORTRAIT, palette.accent))).toBe(true);
      expect(maskColors(onAccent.replace(plateRect(PORTRAIT, palette.accent), ""))).toBe(maskColors(none));
    }
  });
});
