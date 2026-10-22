import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { marqueeBoardPlan, T14_ROWS } from "./T14_marqueeBoard";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T14";
const LOOP = 4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.55, 1.45, 2.4, 3.35] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "0662bdd863199723c1a7d732a2fe710038272aad1907b09cdf99dbf1fe872e58",
    "15756eae71d90842a76e1994847e8fc4be472e1d3c0b9b9b72067fe66e4e8ddf",
    "2472f6fad36d5787015b2a368ddf4185bdb30558b50aeb522fc098f14e5bbeeb",
    "8f6332db99409196fbaef206970668edf8a05a4515b4b23844a832dc356f8e5c",
    "b78cb5926c193de21e58741b8ce74996d9b519f9bb55e2943474c583eb066c36",
  ],
  landscape: [
    "e2eca483226bccafc2a6186e07b33576d3330d146ef5c9e06f1793874b35bf54",
    "e05057f6a2e310f39ed50e57f5eace12c2efc4a760639121aaf383147f714623",
    "3d4a00ba9bdfa09825fc43874ce0ea30e1e7a83e87f9ff0efd6c09a987f4157e",
    "c8748080cdacb5a67bbad315f887998761dbd4ea9c42e9797d08cdea4a51bd0e",
    "7c829db4ac08bb424485b85c18ed26a06db6e446a033ba1faae791b1e7a7f4bb",
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

describe("T14 Marquee Board", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
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
    const first = frameText(0.55, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.55, PORTRAIT)).toBe(first);
  });

  it("five ticker rows cycle the (at most four) lines, each with its own weight, size and speed, alternating direction", () => {
    expect(T14_ROWS).toBe(5);
    const plan = marqueeBoardPlan(params(), PORTRAIT);
    expect(plan.rows.map(row => row.unit.text)).toEqual(["本日限定・", "搶先公開・", "新發售・", "預約受理中・", "本日限定・"]);
    expect(new Set(plan.rows.map(row => row.weight)).size).toBe(5);
    expect(new Set(plan.rows.map(row => row.unit.size)).size).toBeGreaterThanOrEqual(4);
    plan.rows.forEach((row, index) => {
      expect(Number.isInteger(row.repeatsPerLoop) && row.repeatsPerLoop !== 0).toBe(true);
      expect(Math.sign(row.repeatsPerLoop)).toBe(index % 2 === 0 ? 1 : -1);
      expect(row.unit.separatorPathD).not.toBe(""); // repeated with bullets
    });
    expect(new Set(plan.rows.map(row => Math.abs(row.repeatsPerLoop) * row.unit.period)).size).toBeGreaterThan(2); // different speeds
    expect(marqueeBoardPlan(params({ lines: ["最終日"] }), PORTRAIT).rows.map(row => row.unit.text)).toEqual(Array(5).fill("最終日・"));
  });

  it("rows fill the title-safe box vertically; big rows are at least 9% of the short side, small rows at least 4.5%", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const plan = marqueeBoardPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      plan.rows.forEach((row, index) => {
        expect(row.y0).toBeGreaterThanOrEqual(safe.y0);
        expect(row.y1).toBeLessThanOrEqual(safe.y1);
        expect(row.y1 - row.y0).toBeGreaterThanOrEqual((index === 0 ? 0.09 : 0.045) * short);
        expect(row.y0).toBeGreaterThan(plan.rules[index]);
        expect(row.y1).toBeLessThan(plan.rules[index + 1]);
      });
      expect(plan.rules[0]).toBeCloseTo(safe.y0, 6);
      expect(plan.rules[T14_ROWS]).toBeCloseTo(safe.y1, 6);
    }
  });

  it("colours follow ART_DIRECTION §0: ink text with deep-shade bullets on the accent card, cream and accent over footage", () => {
    const palette = item.defaultParams.palette;
    const accent = marqueeBoardPlan(params({ plate: "accent" }), PORTRAIT);
    expect([accent.textColor, accent.bulletColor]).toEqual([palette.ink, palette.accent2]);
    const footage = marqueeBoardPlan(params(), PORTRAIT);
    expect([footage.textColor, footage.bulletColor]).toEqual([palette.paper, palette.accent]);
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
    expect(item.showcasePlate).toBe("accent");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size) + plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(onAccent.startsWith(header(size) + plateRect(size, palette.accent))).toBe(true);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
