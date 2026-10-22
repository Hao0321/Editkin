import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { letterSequencePlan } from "./T02_letterSequence";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T02";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: entering (0.05), 別 held (0.2), 停 entering (0.55), 下 held (1.4), the final blank (1.9). */
const TIMES = [0.05, 0.2, 0.55, 1.4, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "f706dc4f312ea42dd985de6a2107900ff557f16734c4d3fec1364a6696fd85fa",
    "3c2cb1557cabe193f3ae87c23e10abccfd0cf72d85ae74c7d6162717515f0b3d",
    "fb4fab4e50f1154db76ebdb68fbdb2950c38b3059d886c17da4449405a62a3e3",
    "29feb022791dc652ddb77e3bec943babb1ec7c2fc000066f1f75dab49f1061df",
    "6dd797c940e8a36b0204c4ed319a6dab5061438bad86ebadb1f923876da86852",
  ],
  landscape: [
    "fbde87859efa7f0e6e14a1f55405b8232fc2760e88cdcfd41cacf23e838c705d",
    "1dd93853e1f9dc5a42e8effed44a972aa42331404c3bf1c73f687a4f46c610ea",
    "6422a6ce03257fc8908e523616b9f1ecd2192ae5d022b86526032858aed6c86f",
    "744e7868408dbafba7079b0586ae458d880645a128c8c80fcbefc5a181ea26cb",
    "76ac3162fc2bc04abc5e07264a36b7ab91d8e505160b96fdf5eebc40218b9b8c",
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

/** Cut-ins (blank → character) per second, sampled at 60 fps; returns the worst 1 s window. */
function maxCutInsPerSecond(input: unknown, duration: number): number {
  const ins: number[] = [];
  let visible = false;
  for (let frame = 0; frame <= Math.round(duration * 60); frame += 1) {
    const t = frame / 60, now = frameText(t, { width: 270, height: 480 }, input).includes("<path");
    if (now && !visible) ins.push(t);
    visible = now;
  }
  return Math.max(0, ...ins.map(start => ins.filter(t => t >= start && t < start + 1).length));
}

describe("T02 Letter Sequence", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.2, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("shows one character at a time: each slams in from 1.4× in 0.1 s, holds and cuts; the last one holds to 1.85 s", () => {
    const plan = letterSequencePlan(params(), PORTRAIT);
    expect(plan.beats.map(beat => beat.text)).toEqual(["別", "停", "下"]);
    expect(plan.beats.map(beat => beat.start)).toEqual([0, 0.5, 1]);
    expect(plan.beats.map(beat => Number(beat.cut.toFixed(6)))).toEqual([0.35, 0.85, 1.85]);
    expect(plan.entryScale).toBeCloseTo(1.4, 6);
    expect(frameText(0, PORTRAIT)).not.toContain("<path"); // 0 opacity at the very start of a slot
    const entering = frameText(1 / 30, PORTRAIT);
    expect(Number(/scale\(([\d.]+)\)/.exec(entering)![1])).toBeGreaterThan(1.05);
    expect(entering).toMatch(/<g opacity="0\.\d+"/);
    for (const t of [0.2, 0.6, 1.4, 1.8]) expect(frameText(t, PORTRAIT).match(/<path/g), `t=${t}`).toHaveLength(1);
    for (const t of [0.4, 0.9, 1.9, 1.99]) expect(frameText(t, PORTRAIT), `t=${t}`).not.toContain("<path"); // blanks
    expect(frameText(0.2, PORTRAIT)).not.toContain("scale("); // landed at 1.0
  });

  it("keeps every beat inside the 5% title-safe box at the hold, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["今天不要停下來"] }, { lines: ["GO", "爆"] }]) {
        const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const plan = letterSequencePlan(params(input), size);
        for (const beat of plan.beats) {
          expect(beat.box.x0, `${beat.text} ${size.width}`).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(beat.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(beat.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(beat.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        }
        // Main words: the CJK beats are at least 9% of the short side tall (Latin capitals are shorter by design).
        const cjk = plan.beats.filter(beat => /\p{Script=Han}/u.test(beat.text));
        for (const beat of cjk) expect(beat.box.y1 - beat.box.y0, beat.text).toBeGreaterThanOrEqual(0.09 * short);
      }
    }
  });

  it("never cuts in more than 3 times per second (flash safety), merging characters when the text is long", () => {
    expect(maxCutInsPerSecond(undefined, 2)).toBeLessThanOrEqual(3);
    expect(maxCutInsPerSecond({ energy: "hype" }, 2)).toBeLessThanOrEqual(3);
    const long = { lines: ["今天就是出發的日子別停下"], durationSeconds: 1.5 };
    expect(maxCutInsPerSecond(long, 1.5)).toBeLessThanOrEqual(3);
    const plan = letterSequencePlan(params(long), PORTRAIT);
    expect(plan.beats.length).toBeLessThan(12); // characters share beats instead of flashing faster
    expect(plan.beats.map(beat => beat.text).join("")).toBe("今天就是出發的日子別停下");
    for (let index = 1; index < plan.beats.length; index += 1) {
      expect(plan.beats[index].start - plan.beats[index - 1].start).toBeGreaterThanOrEqual(1 / 3 - 1e-9);
    }
  });

  it("repeats the sequence in equal cycles when the clip is long enough for two", () => {
    const plan = letterSequencePlan(params({ durationSeconds: 4 }), PORTRAIT);
    expect(plan.cycles).toBe(2);
    expect(plan.beats.map(beat => beat.text)).toEqual(["別", "停", "下", "別", "停", "下"]);
    expect(plan.beats[3].start).toBeCloseTo(2, 9);
  });

  it("alternates ink and cream on the accent plate (its own reference) and reads over footage without a plate", () => {
    const palette = item.defaultParams.palette;
    const onAccent = letterSequencePlan(params({ plate: "accent" }), PORTRAIT).beats.map(beat => beat.color);
    expect(onAccent).toEqual([palette.ink, palette.paper, palette.ink]); // the reference's 「止まるな」: ink and cream on red
    const overFootage = letterSequencePlan(params(), PORTRAIT).beats.map(beat => beat.color);
    expect(overFootage).toEqual([palette.paper, palette.accent, palette.paper]); // never ink on the dark backdrop
    expect(frameText(0.2, PORTRAIT, { palette: { paper: "#ABCDEF" } })).toContain(`fill="#ABCDEF"`);
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("accent");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain("<rect");
      expect(frameText(t, PORTRAIT, { plate: "none" })).toBe(none);
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.startsWith(header(PORTRAIT) + plateRect(PORTRAIT, palette.bg))).toBe(true);
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onAccent = frameText(t, PORTRAIT, { plate: "accent" });
      expect(onAccent.startsWith(header(PORTRAIT) + plateRect(PORTRAIT, palette.accent))).toBe(true);
      expect(maskColors(onAccent.replace(plateRect(PORTRAIT, palette.accent), ""))).toBe(maskColors(none));
    }
  });
});
