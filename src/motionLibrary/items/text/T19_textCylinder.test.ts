import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T19_LOOP_SECONDS, cylinderLayout } from "./T19_textCylinder";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T19";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.7, 1.6, 2.5, 3.4] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "5b2c493412e90bffd1a9170b54575681016709691bee43aca59c46fd42a4cfe6",
    "f3467aa5ec796d81385c31941173ac829b75a63a530deeed716f29d14bd0462f",
    "584a890f6cd52057c8da3cefa28f2122adc7bed3999b0fbe6bf8e6c4fb8fdc57",
    "2b1c5de96d4692da80ecdf943f6c5cb909fcc74c8cd479153bf3b64bb7d3d3fa",
    "fd0a6079462d4ff5889538fd18a9293ed4d49b1cf8a8b009db159ea62335194f",
  ],
  landscape: [
    "351a59dfbb6cc59e1a568d084d152c02a4026affabd1ef7cf6114fe55e046fa1",
    "c965f7180363d6a6129b836dd0f38a405b7c931182417a6c8d519bc47394af55",
    "ffaa0d5a201e8b9a48925aa597692228ac8df64227a3f1aca288951c6bc7b527",
    "26a836685b0a57e7a4fb383e78280e00e43375b9138a73ac42ccd6fb456a4d45",
    "11a62a1a7e7be25fe2d8369c3b6b2c5638d4f780021f4233f4aad9411d65e62e",
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

/** Absolute points (end and control points) of compact relative m/l/q/c/z path data. */
function relativePoints(d: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let x = 0, y = 0, startX = 0, startY = 0;
  for (const [, command, body] of d.matchAll(/([mlqcz])([^mlqcz]*)/g)) {
    if (command === "z") { x = startX; y = startY; continue; }
    const values = (body.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
    for (let index = 0; index + 1 < values.length; index += 2) points.push([x + values[index], y + values[index + 1]]);
    x += values[values.length - 2]; y += values[values.length - 1];
    if (command === "m") { startX = x; startY = y; }
  }
  return points;
}

describe("T19 Text Cylinder", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T19_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "paper" }, { lines: ["一起", "加油"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T19_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T19_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T19_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T19_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.7, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.7, PORTRAIT)).toBe(first);
  });

  it("stacks three counter-rotating drums in tall frames and two otherwise, each turning whole repeats per loop", () => {
    const tall = cylinderLayout(params(), PORTRAIT), wide = cylinderLayout(params(), LANDSCAPE);
    expect(tall.drums).toHaveLength(3);
    expect(wide.drums).toHaveLength(2);
    expect(cylinderLayout(params(), SQUARE).drums).toHaveLength(2);
    for (const layout of [tall, wide]) {
      layout.drums.forEach((drum, index) => expect(drum.direction).toBe(index % 2 === 0 ? 1 : -1));
      // Ring: 繼續前進 plus the □ icon slot, repeated a whole number of times around the drum.
      expect(layout.slots.map(slot => slot.char).join("")).toBe("繼續前進□");
      expect(layout.slots.filter(slot => slot.icon)).toHaveLength(1);
      expect(Number.isInteger(layout.repeats) && layout.repeats >= 1).toBe(true);
      expect(layout.turnsPerLoop).toBe(1);
    }
    expect(cylinderLayout(params({ energy: "hype" }), PORTRAIT).turnsPerLoop).toBe(2);
  });

  it("wraps glyphs onto the drum: the far side shows mirrored and dimmed above the front row", () => {
    const palette = item.defaultParams.palette;
    // On the paper showcase plate: ink and deep aqua drums, their far sides mixed 24% over cream, icons in deep aqua.
    const onPaper = cylinderLayout(params({ plate: "paper" }), PORTRAIT);
    expect(onPaper.drums.map(drum => drum.color)).toEqual([palette.ink, palette.accent2, palette.ink]);
    expect(onPaper.drums[0].backColor).toBe(mixHex(palette.paper, palette.ink, 0.24));
    expect(onPaper.iconColor).toBe(palette.accent2);
    const svg = frameText(0.7, PORTRAIT, { plate: "paper" });
    expect(svg).toContain(`fill="${onPaper.drums[0].backColor}"`);
    expect(svg).toContain(`fill="${palette.ink}"`);
    // Far-side glyphs are drawn first (behind the front row), in their own group.
    expect(svg.indexOf(`fill="${onPaper.drums[0].backColor}"`)).toBeLessThan(svg.indexOf(`fill="${palette.ink}"`));
  });

  it("keeps every drum inside the 5% title-safe box with glyphs at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const safe = titleSafeBox(size), layout = cylinderLayout(params(), size);
      expect(layout.em * 0.86).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      for (const t of [0, 1.3, 2.9]) {
        const points = [...frameText(t, size).matchAll(/<path d="([^"]+)"/g)].flatMap(([, d]) => relativePoints(d));
        const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
        expect(Math.min(...xs), `${size.width}x${size.height} t=${t}`).toBeGreaterThanOrEqual(safe.x0 - 1);
        expect(Math.max(...xs)).toBeLessThanOrEqual(safe.x1 + 1);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(safe.y0 - 1);
        expect(Math.max(...ys)).toBeLessThanOrEqual(safe.y1 + 1);
      }
    }
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
    expect(item.showcasePlate).toBe("paper");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none).not.toContain("<rect");
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size) + plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        for (const plate of ["paper", "accent"] as const) {
          const plated = frameText(t, size, { plate });
          expect(plated.startsWith(header(size) + plateRect(size, palette[plate]))).toBe(true);
          expect(maskColors(plated.replace(plateRect(size, palette[plate]), ""))).toBe(maskColors(none));
        }
      }
    }
  });
});
