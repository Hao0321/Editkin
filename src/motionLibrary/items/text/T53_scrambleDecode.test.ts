import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { assertMotionText, clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { textFace, titleSafeBox } from "../shared";
import { T53_CELLS_PER_GLYPH, T53_POOL, scramblePlan, scramblePool, scrambleState } from "./T53_scrambleDecode";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T53";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: all scrambling (0.1), locking (0.4, 0.7), decoded (1.4), re-scrambling (2.2). */
const TIMES = [0.1, 0.4, 0.7, 1.4, 2.2] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "a6878624fc4a1da0c10de8b08fe851e1997c1d318ae1475647ac1125d8a8c3fb",
    "ea969dfa20f924601cffe21f4664229a85ffe1da3d06a71141e0eb2fd8d90b68",
    "93c514bcc5f2779ba01b9aeeb4e37d6b4802094d44281848ca5cd52bc485ae42",
    "5b4d6639d7cf38ad3d8e9e0a2ee100676f27357740861510506c5747e032f0bb",
    "eaeaf871f9b039da9183fc667ff47aafbffd73f23ccf9200958907fc09ce0c5a",
  ],
  landscape: [
    "34dd7f1256b9df2300baf06d0c189cdf39c8e6698bae83039c53bedea169d71d",
    "0cf4830bb6d701c1549d78a2df10dcab0a129c83b3cb97656da71eb9453ca40e",
    "7763f5d02e3ba2b8450c853b642b1115191f7bafa03a533fea77358653892fb1",
    "586c92c25a5dd4c3b3641d71988ba49f171b023e2ca6b530545ca3b66da5065f",
    "6c521e7edee705bc8ec1a68a8bcacd72ee1952edf857bad058fea0ebaf1d47c7",
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
/** The plate is painted first: right after the header and the (optional) <defs>. */
function paintsFirst(svg: string, size: MotionFrameSize, fill: string): boolean {
  const at = svg.indexOf(plateRect(size, fill));
  if (at < 0) return false;
  const prefix = svg.slice(0, at);
  return prefix === header(size) || (prefix.startsWith(`${header(size)}<defs>`) && prefix.endsWith("</defs>"));
}
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T53 Scramble Decode", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.4, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.4, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.4, PORTRAIT)).toBe(first);
  });

  it("draws only glyphs the face really has (no tofu): the pool is filtered by coverage and every shown glyph is drawable", () => {
    const face = textFace("display", 500);
    const pool = scramblePool(face);
    expect(pool.length).toBeGreaterThan(40);
    for (const character of pool) expect(() => assertMotionText(character, face), character).not.toThrow();
    expect(pool.every(character => T53_POOL.includes(character))).toBe(true);
    expect(pool.some(character => /[0-9]/.test(character)) && pool.some(character => /[A-Z]/.test(character)) && pool.includes("#")).toBe(true);
    const plan = scramblePlan(params(), PORTRAIT);
    for (let step = 0; step < 72; step += 1) {
      for (const slot of plan.slots) {
        const state = scrambleState(plan, params(), slot, step / 30);
        expect(state.char === slot.target || pool.includes(state.char), `${state.char}`).toBe(true);
      }
    }
  });

  it("cycles random glyphs every 0.06 s in coral, locks left to right at 0.35 + 0.18·i s in cream, holds, and re-scrambles from the right", () => {
    const plan = scramblePlan(params(), PORTRAIT), p = params();
    expect(plan.slots.map(slot => slot.target).join("")).toBe("解碼完成");
    expect(plan.slots.map(slot => slot.lock)).toEqual([0.35, 0.53, 0.71, 0.89].map(value => expect.closeTo(value, 9)));
    expect(plan.stepSeconds).toBeCloseTo(0.06, 9);
    // Seeded and deterministic: the same step shows the same glyph; the next step changes it.
    const first = scrambleState(plan, p, plan.slots[3], 0.01), again = scrambleState(plan, p, plan.slots[3], 0.05);
    expect(again).toEqual(first);
    const changes = [0.07, 0.13, 0.19, 0.25].map(t => scrambleState(plan, p, plan.slots[3], t).char);
    expect(new Set([first.char, ...changes]).size).toBeGreaterThan(3);
    // The next character to lock flickers between its answer and one decoy.
    const flicker = [0.19, 0.25, 0.31].map(t => scrambleState(plan, p, plan.slots[0], t).char);
    expect(new Set(flicker)).toEqual(new Set([plan.slots[0].target, plan.slots[0].decoy]));
    // Locked: the answer in the text colour; the hold shows the whole word.
    for (const t of [0.9, 1.4, 1.89]) {
      for (const slot of plan.slots) expect(scrambleState(plan, p, slot, t)).toEqual({ char: slot.target, locked: true });
    }
    // Re-scramble from the right: the last character unlocks first.
    const unlocks = plan.slots.map(slot => slot.unlock);
    for (let index = 1; index < unlocks.length; index += 1) expect(unlocks[index]).toBeLessThan(unlocks[index - 1]);
    expect(Math.min(...unlocks)).toBeCloseTo(1.9, 9);
    expect(Math.max(...unlocks)).toBeLessThan(2.4);
    const palette = item.defaultParams.palette;
    expect([plan.scrambleColor, plan.lockedColor]).toEqual([palette.accent, palette.paper]);
    // The end of the 2.4 s cycle is its start: repeated, it loops without a seam.
    for (const size of [PORTRAIT, LANDSCAPE]) expect(frameText(2.4, size)).toBe(frameText(0, size));
  });

  it("draws every glyph as square pixels of 1/14 of the glyph height on one shared grid", () => {
    const plan = scramblePlan(params(), LANDSCAPE);
    expect(plan.cell).toBeCloseTo(plan.glyphHeight / T53_CELLS_PER_GLYPH, 1);
    // Every slot starts on the grid of its line.
    const originX = plan.slots[0].x;
    for (const slot of plan.slots) expect(Math.abs(((slot.x - originX) / plan.cell) - Math.round((slot.x - originX) / plan.cell))).toBeLessThan(1e-6);
    const svg = frameText(1.4, LANDSCAPE);
    expect(svg).not.toMatch(/<text/);
    // Square pixels only: horizontal and vertical edges (H/V commands), no curves.
    expect(svg).not.toMatch(/d="[^"]*[CQ]/);
  });

  it("keeps the word inside the 5% title-safe box, at least 9% of the short side tall, 80–90% of the safe width", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["解"] }, { lines: ["解碼", "完成"] }]) {
        const plan = scramblePlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        // Pixel snapping moves a glyph by at most half a cell; random glyphs are centred in their slot.
        const slack = plan.cell;
        expect(plan.box.x0 - slack, label).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.box.x1 + slack, label).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.box.y0, label).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.box.y1, label).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight, label).toBeGreaterThanOrEqual(0.09 * short);
      }
    }
    const plan = scramblePlan(params(), PORTRAIT), safe = titleSafeBox(PORTRAIT);
    const fill = (plan.box.x1 - plan.box.x0) / safe.width;
    expect(fill).toBeGreaterThanOrEqual(0.78);
    expect(fill).toBeLessThanOrEqual(0.9);
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
        expect(none.includes(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(paintsFirst(onBg, size, palette.bg)).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(paintsFirst(onAccent, size, palette.accent)).toBe(true);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
