import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T31_ACROSS, T31_BEZEL, T31_DOTS_PER_EM, T31_LOOP_SECONDS, T31_PAD, ledBoard, ledLitDots, ledOffset, ledOrientation, ledUnit } from "./T31_ledText";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T31";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.33, 2.2, 3.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "dfc9e25113a5e73176dea4d6da1cf73cc5525ea7e3c0fe7ce61ed8e473c6fe97",
    "8fb463acd87dbc5bbae923bb204749027b26e658e4108319e33d1d778aeb3130",
    "d9f9240880fc9775b570a3fd76b0463d3fb53880f62107dcd1587d2483e653f9",
    "59b5b460a2a19ee9c80d8efb9ed415f758ccd24aac9b39d4c255b502912ba2ec",
    "4498bf70c6969364636bfa9f846b64246e95734fb4bd452962347b8183ff25d6",
  ],
  landscape: [
    "a4ef9559b8a59981e87bf1e76a8ba266eb73143d8f9d3627f780d9ed9de6ecab",
    "6eaa048f43f54fab2b84659fd68f7df2b92147e37981bf4fce00d1c514ced431",
    "b8a4bff08b850702079350e0d57c2afcbfc74384f8594fd45dd67e991298ede4",
    "81ad8efa78fda1ae131b943a633b7249de7483aea097d0800e3b864f46dec4fd",
    "1f53e08796b91f872c96159d9c7d619e79eaf54b19557b5f5a8189035b4d6964",
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

describe("T31 LED Text", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T31_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { plate: item.showcasePlate }, { lines: ["NEWS", "最新消息"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T31_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T31_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T31_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T31_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.33, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.33, PORTRAIT)).toBe(first);
  });

  it("samples the text onto a 16-dots-per-em grid and scrolls it right to left in whole-dot steps, one repeat per loop", () => {
    expect(ledUnit(["最新消息"])).toBe("最新消息・");
    expect(ledUnit(["NEWS", "最新消息"])).toBe("NEWS・最新消息・");
    const board = ledBoard(params(), LANDSCAPE);
    expect(board.orientation).toBe("horizontal");
    expect([board.rows, board.columns]).toEqual([T31_ACROSS, board.along]);
    // 「最新消息・」: five full-width characters, 16 dots each plus a one-dot gap.
    expect(board.unitLength).toBe(5 * (T31_DOTS_PER_EM + 1));
    expect(board.lit.size).toBeGreaterThan(200);
    // Every lit dot lies inside the em (dots 1..16 across) of the 18-dot sign.
    for (const key of board.lit) {
      const [, across] = key.split(",").map(Number);
      expect(across).toBeGreaterThanOrEqual(1);
      expect(across).toBeLessThanOrEqual(T31_DOTS_PER_EM);
    }
    // Whole-dot steps: the offset is an integer that advances by at most one or two columns per 30 fps frame.
    let previous = ledOffset(board, 0);
    expect(previous).toBe(0);
    for (let frame = 1; frame < 120; frame += 1) {
      const offset = ledOffset(board, frame / 120);
      expect(Number.isInteger(offset)).toBe(true);
      expect(offset - previous).toBeGreaterThanOrEqual(0);
      expect(offset - previous).toBeLessThanOrEqual(2);
      previous = offset;
    }
    expect(previous).toBe(board.unitLength - 1);
    // Scrolling one column moves the lit pattern one dot to the left.
    const a = new Set(ledLitDots(board, 10).map(([column, row]) => `${column},${row}`));
    const b = ledLitDots(board, 11);
    for (const [column, row] of b) if (column + 1 < board.columns) expect(a.has(`${column + 1},${row}`)).toBe(true);
  });

  it("sets full-width text on a vertical sign in portrait (top to bottom, scrolling up); Latin text stays horizontal", () => {
    expect(ledOrientation(params(), PORTRAIT)).toBe("vertical");
    expect(ledOrientation(params(), SQUARE)).toBe("horizontal");
    expect(ledOrientation(params({ lines: ["NEWS"] }), PORTRAIT)).toBe("horizontal");
    const board = ledBoard(params(), PORTRAIT), horizontal = ledBoard(params(), LANDSCAPE);
    expect([board.columns, board.rows]).toEqual([T31_ACROSS, board.along]);
    expect(board.unitLength).toBe(5 * (T31_DOTS_PER_EM + 1));
    // The same characters, transposed: a vertical sign is a horizontal one turned so the text reads downward.
    expect(board.lit.size).toBeGreaterThan(200);
    // Scrolling one dot moves the pattern one dot up.
    const a = new Set(ledLitDots(board, 10).map(([column, row]) => `${column},${row}`));
    for (const [column, row] of ledLitDots(board, 11)) if (row + 1 < board.rows) expect(a.has(`${column},${row + 1}`)).toBe(true);
    // The vertical sign keeps the characters bigger than the horizontal sign could in the same frame.
    expect(board.pitch).toBeGreaterThan(horizontal.pitch * 0.9);
  });

  it("draws lit dots with a glow made of larger translucent dots (no blur filter) and keeps off dots visible but dim", () => {
    const svg = frameText(1.33, PORTRAIT);
    expect(svg).not.toContain("<filter");
    expect(svg).not.toContain("feGaussianBlur");
    const palette = item.defaultParams.palette;
    const board = ledBoard(params(), PORTRAIT);
    expect(board.colors.led).toBe(palette.accent);
    expect(svg).toContain(`fill="${board.colors.off}"`);
    // The glow paths are the LED colour at partial opacity.
    expect(svg.match(new RegExp(`fill="${palette.accent}" opacity="0\\.\\d+"`, "g"))?.length).toBe(2);
  });

  it("keeps the sign inside the 5% title-safe box with characters at least 9% of the short side, ≥ 3 characters along it", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const board = ledBoard(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      const padded = (board.columns + 2 * (T31_PAD + T31_BEZEL)) * board.pitch, tall = (board.rows + 2 * (T31_PAD + T31_BEZEL)) * board.pitch;
      expect(padded).toBeLessThanOrEqual(safe.width + 1e-6);
      expect(tall).toBeLessThanOrEqual(safe.height + 1e-6);
      expect(board.pitch * T31_DOTS_PER_EM * 0.9).toBeGreaterThanOrEqual(0.09 * short);
      expect(board.along / (T31_DOTS_PER_EM + 1)).toBeGreaterThanOrEqual(3);
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
