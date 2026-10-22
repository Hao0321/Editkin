import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { shuffleLayout, shufflePoses } from "./T72_shuffleLetters";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T72";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: scrambled (0), the first swap (0.45), the last swap (1.1), solved (1.6), the
 * re-scramble hop (2.22). */
const TIMES = [0, 0.45, 1.1, 1.6, 2.22] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "a53f9d75ad3e18627e45ec88e3f06c44465605ebf06b546e07b5608e47380b72",
    "a53f024b632269aadb42697cbc07b18e109b6463c97ca89d5eca005e43ce2448",
    "7a3a540c390d3477a79044b05251bd0b1c8cbce5234afe028754f0f91b1defd3",
    "540e88337483990fbc91fd30bc6090ab472ce90e9fb844c2abc8980d1334a4f9",
    "29537490f8d31cb0aea84674c62d04a936e6861f03c9e1ea80e002e27e8fe5a7",
  ],
  landscape: [
    "36f135986f8fc20a47cdea42b38f5225bf74a8d32ed85292016ecb253349d343",
    "7031152929849edbb928f4ac7d8cbe353e6bdd07975c8cd067574e6f5471e86b",
    "97afc1327efc3a979cf08bccc11860267552cf62766dfdc4e65920278793b5cb",
    "0c50e8d800b7d636f02b5444ca16a3f09b130fb38e270bf0df2456fcb2e9dcf1",
    "94d663c79406b854367b456750fc5e3fac99367e8536a4160c10eb955313266c",
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
/** Reading order of the target indices at time t (glyphs sorted by x). */
function order(layout: ReturnType<typeof shuffleLayout>, t: number): number[] {
  const poses = shufflePoses(layout, t);
  return layout.glyphs.map(glyph => glyph.index).sort((a, b) => poses[a].x - poses[b].x);
}

describe("T72 Shuffle Letters", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.45, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.4, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.45, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.45, PORTRAIT)).toBe(first);
  });

  it("starts from a seeded scramble that never reads correctly and keeps no pair of the word intact", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const layout = shuffleLayout(params({ seed }), LANDSCAPE);
      expect(layout.scramble).not.toEqual([0, 1, 2, 3]);
      const kept = layout.scramble.slice(1).filter((target, slot) => target === layout.scramble[slot] + 1).length;
      expect(kept, `seed ${seed}`).toBe(0);
      // Applying the swaps in order solves the word in the fewest swaps (n - 1 for one cycle), neighbours trading places.
      const state = [...layout.scramble];
      for (const [a, b] of layout.swaps) [state[a], state[b]] = [state[b], state[a]];
      expect(state).toEqual([0, 1, 2, 3]);
      expect(layout.swaps).toHaveLength(3);
      for (const [a, b] of layout.swaps) expect(Math.abs(a - b), `seed ${seed}`).toBe(1);
    }
    const repeated = shuffleLayout(params({ lines: ["哈哈哈"] }), LANDSCAPE);
    expect(repeated.swaps.length).toBeGreaterThanOrEqual(1);
    expect(shuffleLayout(params({ lines: ["一二三四五六七八九十"] }), LANDSCAPE).swaps.length).toBeLessThanOrEqual(5);
  });

  it("swaps a pair every 0.35 s along arcs (one over and larger, one under and dimmer), then holds the solved word 0.8 s", () => {
    const layout = shuffleLayout(params(), LANDSCAPE);
    expect(layout.cycles).toBe(1);
    expect(order(layout, 0)).toEqual([...layout.scramble]);
    for (let k = 0; k < layout.swaps.length; k += 1) {
      const middle = (0.3 + 0.35 * k + 0.15) * layout.timeScale, poses = shufflePoses(layout, middle);
      const over = poses.find(pose => pose.layer === 2)!, under = poses.find(pose => pose.layer === -1)!;
      expect(over.lift).toBeCloseTo(0.45 * layout.glyphHeight, 3);
      expect(under.lift).toBeCloseTo(-0.45 * layout.glyphHeight, 3);
      expect(over.scale).toBeGreaterThan(1.07);
      expect(under.scale).toBeLessThan(0.93);
      expect(under.dim).toBeGreaterThan(0.2);
    }
    const solved = (0.3 + 0.35 * (layout.swaps.length - 1) + 0.3) * layout.timeScale;
    expect(order(layout, solved + 0.3)).toEqual([0, 1, 2, 3]);
    expect(order(layout, solved + 0.79)).toEqual([0, 1, 2, 3]);
    expect(shufflePoses(layout, solved + 0.11)[0].scale).toBeGreaterThan(1.02); // the solved pop
  });

  it("re-scrambles in one hop (right movers over, left movers under) and loops seamlessly across whole cycles", () => {
    for (const input of [undefined, { durationSeconds: 4.8 }, { energy: "hype" }]) {
      const layout = shuffleLayout(params(input), PORTRAIT);
      for (const size of [PORTRAIT, LANDSCAPE]) {
        const start = frameText(0, size, input);
        expect(frameText(layout.cycleSeconds, size, input), JSON.stringify(input)).toBe(start);
      }
    }
    expect(shuffleLayout(params({ durationSeconds: 4.8 }), PORTRAIT).cycles).toBe(2);
    const layout = shuffleLayout(params(), LANDSCAPE);
    const hop = shufflePoses(layout, 2.22);
    for (const pose of hop) {
      if (pose.layer > 0) expect(pose.lift).toBeGreaterThan(0);
      if (pose.layer < 0) expect(pose.lift).toBeLessThan(0);
    }
  });

  it("keeps the line and its arcs inside the 5% title-safe box, glyphs at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["排列組合"] }, { lines: ["ABCDE"] }]) {
        const safe = titleSafeBox(size), layout = shuffleLayout(params(input), size);
        expect(layout.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0 - 0.45 * layout.glyphHeight - 0.04 * layout.glyphHeight).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1 + 0.45 * layout.glyphHeight).toBeLessThanOrEqual(safe.y1 + 1e-6);
        if (input === undefined) expect(layout.glyphHeight).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("colours alternate the text role and the accent per character of the word, travelling with the characters", () => {
    const palette = item.defaultParams.palette;
    const layout = shuffleLayout(params(), LANDSCAPE);
    expect(layout.glyphs.map(glyph => glyph.color)).toEqual([palette.paper, palette.accent, palette.paper, palette.accent]);
    const onPaper = shuffleLayout(params({ plate: "paper" }), LANDSCAPE);
    expect(onPaper.glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
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
      expect(onPaper.indexOf(plateRect(PORTRAIT, palette.paper))).toBe(onPaper.indexOf(">") + 1);
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
  });
});
