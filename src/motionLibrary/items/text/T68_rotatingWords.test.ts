import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  centreState, centreWords, ringSource, rotatingWordsLoopSeconds, rotatingWordsPlan, T68_BEAT, T68_FLIP_IN, T68_FLIP_OUT, T68_RING_RADIUS, T68_RING_SPEED,
} from "./T68_rotatingWords";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T68";
const LOOP = 4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: 春 whole, mid beat, folding out, 夏 whole, 春 flipping back in before the seam. */
const TIMES = [0, 0.5, 0.86, 1.5, 3.95] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "6431d1a674846e17b9b5fa983adc27b7a1a0ab9f083e5b64f7c3d5797b75423f",
    "8d7bc28710ff9f182f9e991b71de245218a0731c4809a8eb7b4a8cfbca15abec",
    "b8977a529c901ec13c14e84b31245cd683dd2c4c0490bfa4636c6d2e1841ee6d",
    "d7dfd4545e46c12e797969405cf3eec41c15b66919ef4135bed3fc29f1ced403",
    "2d7fb6e8fd3667726fbe4d9448c77c8ad285c9cb1d80520e86754f035bb14bc0",
  ],
  landscape: [
    "933f9a5046103bc3a0a5d6982755ed957d84802b424b332ac8c44b5979da4b2c",
    "96fbba1cdd034fb4d2b6b27a025f22b413d43995b376f99dc0c0ec89497afcbc",
    "a9bf844e7f98633c06710f10d743fb8f39053d71da3d3a11ec282048f1a53f09",
    "bd73046085b1383876a2c125b207fea29a99f70f6699d9f5dfb164a9523fe02d",
    "e8f5c510dff996b9ce6f4f4e90daf74caf6bb3e6f9b8c8c6a642c6e19ac30785",
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

describe("T68 Rotating Words", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the loop is words × 1 s and the frame at the loop equals frame 0 (also for 3 and 5 words)", () => {
    expect(item.loopSeconds).toBe(LOOP);
    expect(rotatingWordsLoopSeconds(item.defaultParams.lines)).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { plate: item.showcasePlate }, { lines: ["早／午／晚", "一天三餐"] }, { lines: ["一／二／三／四／五", "數一數"] }]) {
        const loop = rotatingWordsLoopSeconds(params(input).lines);
        const start = frameText(0, size, input);
        expect(frameText(loop, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * loop, size, input)).toBe(start);
        expect(frameText(loop * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.86, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.86, PORTRAIT)).toBe(first);
  });

  it("line 1 splits on 「／」 into the centre words, line 2 is the ring; the ring turns clockwise at 90°/s (one turn per 4 s)", () => {
    expect(centreWords(["春／夏／秋／冬", "四季輪轉"])).toEqual(["春", "夏", "秋", "冬"]);
    expect(centreWords(["一年"])).toEqual(["一年"]);
    expect(ringSource(["春／夏", "四季輪轉"])).toBe("四季輪轉");
    expect(ringSource(["春／夏"])).toBe("春夏");
    const plan = rotatingWordsPlan(params(), PORTRAIT);
    expect(plan.loopSeconds).toBe(4);
    expect(plan.ringTurn).toBe(T68_RING_SPEED * 4);
    expect(plan.ring.radius).toBeCloseTo(T68_RING_RADIUS * plan.wordSize, 9);
    // Clockwise: the ring group's rotation grows with time.
    expect(frameText(1, PORTRAIT)).toContain(`rotate(90 ${plan.cx} ${plan.cy})`);
    // For 3 words the turn rounds to whole ring repeats, so the 3 s loop still closes.
    const three = rotatingWordsPlan(params({ lines: ["早／午／晚", "一天三餐"] }), PORTRAIT);
    expect((three.ringTurn / (360 / three.ring.repeats)) % 1).toBe(0);
  });

  it("the centre word flips every 1.0 s: scaleY 1 → 0 in 0.1 s, swap, 0 → 1 in 0.12 s landing exactly on the beat", () => {
    expect([T68_BEAT, T68_FLIP_OUT, T68_FLIP_IN]).toEqual([1, 0.1, 0.12]);
    const plan = rotatingWordsPlan(params(), PORTRAIT);
    for (let beat = 0; beat < 4; beat += 1) {
      expect(centreState(plan, beat)).toEqual({ word: beat, scaleY: 1 });
      expect(centreState(plan, beat + 0.5)).toEqual({ word: beat, scaleY: 1 });
      const out = centreState(plan, beat + 1 - T68_FLIP_IN - T68_FLIP_OUT / 2);
      expect(out.word).toBe(beat);
      expect(out.scaleY).toBeGreaterThan(0);
      expect(out.scaleY).toBeLessThan(1);
      const swapped = centreState(plan, beat + 1 - T68_FLIP_IN + 1e-6);
      expect(swapped.word).toBe((beat + 1) % 4);
      expect(swapped.scaleY).toBeLessThan(0.01);
    }
  });

  it("the composition fills the safe short side: the ring stays inside the safe box and each word inside the ring", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["春天／夏天", "四季輪轉"] }, { lines: ["早／午／晚", "一天三餐"] }]) {
        const plan = rotatingWordsPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const reach = plan.ring.radius + plan.ring.size / 2;
        expect(plan.cx - reach).toBeGreaterThanOrEqual(safe.x0);
        expect(plan.cx + reach).toBeLessThanOrEqual(safe.x1);
        expect(plan.cy - reach).toBeGreaterThanOrEqual(safe.y0);
        expect(plan.cy + reach).toBeLessThanOrEqual(safe.y1);
        // It fills: the ring reaches at least 90% of the safe short side.
        expect((2 * reach) / Math.min(safe.width, safe.height), JSON.stringify(input)).toBeGreaterThanOrEqual(0.9);
        const inner = plan.ring.radius - plan.ring.size / 2;
        for (const word of plan.words) {
          expect(word.box.y1 - word.box.y0).toBeGreaterThanOrEqual(0.09 * short);
          for (const [x, y] of [[word.box.x0, word.box.y0], [word.box.x1, word.box.y0], [word.box.x0, word.box.y1], [word.box.x1, word.box.y1]]) {
            expect(Math.hypot(x - plan.cx, y - plan.cy), word.text).toBeLessThan(inner);
          }
        }
        // Ring glyphs are secondary text: at least 4.5% of the short side.
        expect(plan.ring.size * 0.9).toBeGreaterThanOrEqual(0.045 * short);
      }
    }
  });

  it("colours: centre words alternate teal and cream, ring characters cream and teal, separators teal (dark card)", () => {
    const palette = item.defaultParams.palette;
    expect(item.showcasePlate).toBe("bg");
    const plan = rotatingWordsPlan(params(), PORTRAIT);
    expect(plan.words.map(word => word.color)).toEqual([palette.accent, palette.paper, palette.accent, palette.paper]);
    const letters = plan.ring.glyphs.map((glyph, index) => ({ glyph, color: plan.ringColors[index] })).filter(entry => !entry.glyph.isSeparator);
    expect(letters.slice(0, 4).map(entry => entry.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
    for (const [index, glyph] of plan.ring.glyphs.entries()) if (glyph.isSeparator) expect(plan.ringColors[index]).toBe(palette.accent);
    const onAccent = rotatingWordsPlan(params({ plate: "accent" }), PORTRAIT);
    expect(onAccent.words.map(word => word.color).slice(0, 2)).toEqual([palette.accent2, palette.ink]);
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
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size) + plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        for (const plate of ["accent", "paper"] as const) {
          const onPlate = frameText(t, size, { plate });
          expect(onPlate.startsWith(header(size) + plateRect(size, palette[plate]))).toBe(true);
          expect(maskColors(onPlate.replace(plateRect(size, palette[plate]), ""))).toBe(maskColors(none));
        }
      }
    }
  });
});
