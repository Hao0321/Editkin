import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { letterRainPlan } from "./T51_letterRain";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T51";
const LOOP = 4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.7, 1.55, 2.5, 3.4] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "41fe0d735657b33673aba91757838cfc81739dd3271cec731690590098d5c691",
    "c0f192005eb2afde4b98ff220dbcb93ee0f9b7a440abb7479118896f955922bf",
    "ee97dd21a45560392d0f33d2b98d74465133510b68ccaf7f1daa20b89b0bb204",
    "d53001058704b34ac003922a02e9e62af8188e2f4e0f0d094ec4d9fc38a80c51",
    "ee73b0a053dee8ba9d91cdea190b5d47ba4820fbd75e9eeff1ad59db6b51c992",
  ],
  landscape: [
    "5282470f9745b6ecd105b180010a4be47a4ce371b80fc4a9f311f463c3def321",
    "300cfe352baf117d0b2154952e8fca7d755acecf55bddf7989d36e13bf38b8f2",
    "2ef39141882bd0a1f4ba555388738530affc47ca981729fc1ecf2232bbdb38dc",
    "e36f162f28f080bc405498849779675485b551622832856c79851385712ae9c1",
    "df7ef09d08d24284ec94a0e44e12c2560e6b5accfcfc572cd9322786dcfcef0e",
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

describe("T51 Letter Rain", () => {
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
    const first = frameText(0.7, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.7, PORTRAIT)).toBe(first);
    expect(frameText(0.7, PORTRAIT, { seed: 2 })).not.toBe(first);
  });

  it("10–14 tategaki columns (10 portrait, 14 landscape) of display-700 characters at 4.5–6% of the short side, inside the safe width", () => {
    for (const [size, count] of [[PORTRAIT, 10], [LANDSCAPE, 14], [SQUARE, 11]] as const) {
      const plan = letterRainPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      expect(plan.columns).toHaveLength(count);
      for (const column of plan.columns) {
        expect(column.unit.size / short).toBeGreaterThanOrEqual(0.045 - 1e-6);
        expect(column.unit.size / short).toBeLessThanOrEqual(0.06 + 1e-6);
        expect(column.x + column.unit.ink.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(column.x + column.unit.ink.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        // Each column falls a whole number of repeats per loop, at its own speed.
        expect(Number.isInteger(column.repeatsPerLoop) && column.repeatsPerLoop >= 1).toBe(true);
        expect(column.unit.text.startsWith("雨落下來風吹過去雲散開了光透出來")).toBe(true);
      }
      expect(new Set(plan.columns.map(column => column.repeatsPerLoop * column.unit.period)).size).toBeGreaterThan(3);
    }
  });

  it("falls downward: a column's content moves toward +y over time", () => {
    const plan = letterRainPlan(params(), PORTRAIT);
    const firstY = (t: number) => {
      const svg = frameText(t, PORTRAIT);
      const x = plan.columns[0].x;
      const ys = [...svg.matchAll(/<g transform="translate\(([\d.-]+) ([\d.-]+)\)">/g)]
        .filter(match => Math.abs(Number(match[1]) - x) < 0.01).map(match => Number(match[2]));
      return Math.min(...ys);
    };
    const dt = 1 / 30, speed = (plan.columns[0].repeatsPerLoop * plan.columns[0].unit.period) / LOOP;
    const shift = firstY(0.5 + dt) - firstY(0.5);
    // Either the same repeat moved down by one frame of travel, or a new repeat entered at the top.
    expect(Math.abs(shift - speed * dt) < 0.05 || shift < 0).toBe(true);
  });

  it("line 2 lists the highlight characters (the accent at full opacity, coral on cream as in the reference); the rest is the text colour at 75% or 40%", () => {
    const palette = item.defaultParams.palette;
    const plan = letterRainPlan(params({ plate: "paper" }), PORTRAIT);
    expect(plan.textColor).toBe(palette.ink);
    // The reference wins over the 3:1 rule for decorative rain (ART_DIRECTION §0, Claude r2 ruling): the accent on cream too;
    // only the accent plate, where the accent would vanish, takes the deep shade.
    expect(plan.highlightColor).toBe(palette.accent);
    expect(letterRainPlan(params({ plate: "accent" }), PORTRAIT).highlightColor).toBe(palette.accent2);
    expect(item.revision).toBe(2);
    for (const column of plan.columns) {
      expect(column.highlightPathD).not.toBe("");
      expect(column.strongPathD).not.toBe("");
      expect(column.faintPathD).not.toBe("");
    }
    const svg = frameText(1, PORTRAIT, { plate: "paper" });
    expect(svg).toContain(`fill="${plan.highlightColor}"`);
    expect(svg).toContain(`fill="${palette.ink}" fill-opacity="0.75"`);
    expect(svg).toContain(`fill="${palette.ink}" fill-opacity="0.4"`);
    // Without line 2 nothing is highlighted.
    expect(letterRainPlan(params({ lines: ["雨落下來"] }), PORTRAIT).columns.every(column => column.highlightPathD === "")).toBe(true);
    // Over footage (dark card): paper text, accent highlights.
    const footage = letterRainPlan(params(), PORTRAIT);
    expect([footage.textColor, footage.highlightColor]).toEqual([palette.paper, palette.accent]);
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
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size) + plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onPaper = frameText(t, size, { plate: "paper" });
        expect(onPaper.startsWith(header(size) + plateRect(size, palette.paper))).toBe(true);
        expect(maskColors(onPaper.replace(plateRect(size, palette.paper), ""))).toBe(maskColors(none));
      }
    }
  });
});
