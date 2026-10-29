import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache, layoutLine } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { numberSlamLayout } from "./T48_numberSlam";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T48";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: 3 slamming in (0.05), 3 with its ring (0.3), 2 with its ring (0.7), the final word
 * with its ring (1.55), the blank (2.2). */
const TIMES = [0.05, 0.3, 0.7, 1.55, 2.2] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "469e0a7f6dc6233b02f16b6b13bde9638bb140a036337b4da7f64fec9b1553e7",
    "120ca0f423e1b1088372a0553898b128d69f71fd4b54a30e7cfc7d17a16be4a4",
    "a2abc444d59c22b61cd478ff5099c9a1ee4aeaa029a6fbb14ee2a3cae4af79fe",
    "d305fb2cdbd4bf4f7c891957e7661ba90d28f89fafea5ea4bb482c78a4b796d9",
    "6dd797c940e8a36b0204c4ed319a6dab5061438bad86ebadb1f923876da86852",
  ],
  landscape: [
    "4487e742f5f662bba75cd64f8b36164a290fb2313fa9e461b8baf1a36ad52bae",
    "9ae5b4d08cd0d5d8b7d7a0519a09d36b3b75ef508ddcf6339c650b38b9f8f1a8",
    "a378d023393cae6c94b0a648de232f22e0e083ef37dd5a91568761774d61221b",
    "c4f18eaa9a59f597b50af748b276ad4e8029a0dfd8f87e3e233586dbeb3a3a5f",
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
const plateRect = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const rings = (svg: string) => (svg.match(/<circle [^>]*fill="none"/g) ?? []).length;

/** Cut-ins (blank or another item → a new item) per second, sampled at 60 fps; returns the worst 1 s window. */
function maxCutInsPerSecond(input: unknown, duration: number): number {
  const ins: number[] = [];
  let previous = "";
  for (let frame = 0; frame <= Math.round(duration * 60); frame += 1) {
    const t = frame / 60, beat = numberSlamLayout(params(input), { width: 270, height: 480 }).beats.find(candidate => t >= candidate.start && t < candidate.cut);
    const now = beat ? `${beat.text}@${beat.start}` : "";
    if (now && now !== previous) ins.push(t);
    previous = now;
  }
  return Math.max(0, ...ins.map(start => ins.filter(t => t >= start && t < start + 1).length));
}

describe("T48 Number Slam", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.3, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.3, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.3, PORTRAIT)).toBe(first);
  });

  it("slams 3, 2, 1 (0.45 s each) and the final word (0.7 s) from 2.6× in 0.12 s, each cut by the next, then a 0.25 s blank", () => {
    const layout = numberSlamLayout(params(), PORTRAIT);
    expect(layout.beats.map(beat => beat.text)).toEqual(["3", "2", "1", "出發！"]);
    expect(layout.beats.map(beat => Number(beat.start.toFixed(6)))).toEqual([0, 0.45, 0.9, 1.35]);
    expect(layout.beats.map(beat => Number(beat.cut.toFixed(6)))).toEqual([0.45, 0.9, 1.35, 2.05]);
    expect(layout.slamScale).toBeCloseTo(2.6, 6);
    expect(layout.beats.map(beat => beat.digits)).toEqual([true, true, true, false]);
    const scaleAt = (t: number) => Number(/scale\(([\d.]+)\)/.exec(frameText(t, PORTRAIT))?.[1] ?? 1);
    expect(scaleAt(0.02)).toBeGreaterThan(1.5);
    expect(scaleAt(0.13)).toBe(1); // landed, no overshoot
    expect(frameText(0, PORTRAIT)).not.toContain("<path"); // 0 opacity at the very start of a slot
    expect(frameText(2.1, PORTRAIT)).not.toMatch(/<(path|circle) /);
  });

  it("sets pure-digit lines in Bebas Neue and the word in the display face, digits sharing one size", () => {
    const layout = numberSlamLayout(params(), LANDSCAPE);
    const bebas3 = layoutLine("3", { font: "latin", size: layout.beats[0].layout.size }).pathD;
    expect(layout.beats[0].layout.pathD).toBe(bebas3);
    expect(new Set(layout.beats.slice(0, 3).map(beat => beat.layout.size)).size).toBe(1);
    // Full-width punctuation is set by its ink: 「！」 sits close after 發 instead of in the middle of a full em.
    const word = layout.beats[3].layout, glyphs = layoutLine("出發！", { font: "display", weight: 900, size: word.size, tracking: -0.04 }).inkBox!;
    expect(word.inkBox!.x1 - word.inkBox!.x0).toBeLessThan(glyphs.x1 - glyphs.x0 - 0.2 * word.size);
  });

  it("draws exactly one accent ring per slam, growing from the item's size to 1.6× while it fades", () => {
    const palette = item.defaultParams.palette;
    for (const t of [0.2, 0.65, 1.1, 1.6]) {
      const svg = frameText(t, PORTRAIT);
      expect(rings(svg), `t=${t}`).toBe(1);
      expect(svg).toContain(`stroke="${palette.accent}"`);
    }
    expect(rings(frameText(0.05, PORTRAIT))).toBe(0); // the ring comes at the landing
    const radius = (t: number) => Number(/<circle [^>]* r="([\d.]+)"/.exec(frameText(t, PORTRAIT))![1]);
    expect(radius(0.4) / radius(0.15)).toBeGreaterThan(1.3);
  });

  it("never cuts in more than 3 times per second, dropping the earliest numbers when the clip is short", () => {
    expect(maxCutInsPerSecond(undefined, 2.3)).toBeLessThanOrEqual(3);
    expect(maxCutInsPerSecond({ energy: "hype" }, 2.3)).toBeLessThanOrEqual(3);
    const short = { durationSeconds: 1.2 };
    expect(maxCutInsPerSecond(short, 1.2)).toBeLessThanOrEqual(3);
    const layout = numberSlamLayout(params(short), PORTRAIT);
    expect(layout.beats[layout.beats.length - 1].text).toBe("出發！");
    expect(layout.beats.length).toBeLessThan(4);
    for (let index = 1; index < layout.beats.length; index += 1) expect(layout.beats[index].start - layout.beats[index - 1].start).toBeGreaterThanOrEqual(1 / 3 - 1e-9);
    // A longer clip gives the spare time to the final word.
    const long = numberSlamLayout(params({ durationSeconds: 4 }), PORTRAIT);
    expect(long.beats[3].cut - long.beats[3].start).toBeGreaterThan(2);
  });

  it("keeps every item inside the 5% title-safe box at its hold, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["10", "9", "8", "開始"] }, { lines: ["3", "2", "1", "GO!"] }]) {
        const safe = titleSafeBox(size), layout = numberSlamLayout(params(input), size);
        for (const beat of layout.beats) {
          expect(beat.box.x0, beat.text).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(beat.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(beat.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(beat.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
          expect(beat.box.y1 - beat.box.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        }
      }
    }
  });

  it("colours: paper numbers and an accent final word on the dark card; ink and accent2 on cream", () => {
    const palette = item.defaultParams.palette;
    const layout = numberSlamLayout(params(), PORTRAIT);
    expect(layout.beats.map(beat => beat.color)).toEqual([palette.paper, palette.paper, palette.paper, palette.accent]);
    const onPaper = numberSlamLayout(params({ plate: "paper" }), PORTRAIT);
    expect(onPaper.beats.map(beat => beat.color)).toEqual([palette.ink, palette.ink, palette.ink, palette.accent2]);
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
