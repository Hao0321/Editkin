import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../catalog";
import { generateAnyMotionFrame } from "../frames";
import { resolveMotionLibraryParams } from "../params";
import { mixHex, tint } from "../svg/color";
import { clearMotionLibraryLayoutCache } from "../svg/glyphs";
import type { BackgroundMotionItem, MotionFrameSize, TextMotionItem, TransitionMotionItem } from "../types";
import { displayTracking, heroTextBox, layoutFittedText } from "./shared";
import { wordBurstTracking } from "./text/T01_wordBurst";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change,
 * and bump that item's revision so cached clips re-render (MOTION_LIBRARY_ENGINE_VERSION is for shared-code changes).
 * T01 r3: ART_DIRECTION §0 overhaul (hero size, tight tracking, §0 two-tone); X01 and B01 re-pinned for their reference
 * palettes (ref_pink, ref_red: a default-palette change, so their revisions stay 1). */
const TIMES: Record<"T01" | "X01" | "B01", readonly number[]> = { T01: [0.1, 0.27, 1.12, 1.9, 2.85], X01: [0, 0.125, 0.25, 0.375, 0.5], B01: [0, 0.5, 1.3, 2.75, 3.9] };
const GOLDEN: Record<string, readonly string[]> = {
  "T01/portrait": [
    "f03272acd03a1a567f411102e05e5d680b5ec8ce29e1b33d418d78faf0756e78",
    "579e195e2042bf7593ede83dfe4d052283917c1cee78e2f76877a66461bbddca",
    "601e4e8aab2e279f05333908de39cb1740b771d80e2d1646c6dc05c52bbcb542",
    "46fcb1ed9703045cfb81c09bb4e1628f98c0224f62dd36d3dd1fc0f7727314f1",
    "640afca388f5c74bf65608c4062696765dae1b489c1caded2073c67aa9626cc5",
  ],
  "T01/landscape": [
    "cb1984008a2d1363d0affa640d693a365fbc6add8bb61ea8fa93dff80bd431e4",
    "14a9560fbbc75038ea881b2dd93eb0645d7b8bcd72fb274e54bbbf0a48e6579e",
    "9e1976d47b28fbc57f18555e89de4e350678c49941d906785fa7a868d8cbc9c7",
    "806e4ffe98fd215fcf38e4aa610e4caf222062c1e0c1a40a4d2ce4a056ee773c",
    "55a8565b3363982bd7064146a749ab2fe5a410f12d7929beb3acf84cffba2813",
  ],
  "X01/portrait": [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "b3aeae608e9ced58e8c70bbf9e01f54a88e6adbb9b458bedfe69033d197d394a",
    "ec1733f1f0c8e48a3e642be1859ebe525006872397d7eacff37d5b25e985e72b",
    "44f95f2b565fa4a38561e70e34fbc981a6b731362b710392139ac2305c80c8b1",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  "X01/landscape": [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "17c7ab5f4ef11d7cb501bedd35a82b20559a4bb38971322ccaa3ad40a4be3b85",
    "c68fc58cff62f9bf990855ec1310c1ff1afed84599c748e7c22245f32ee6e4ba",
    "f4cefbcf72fa2e7bebb13971db3fb9d91f37f5f175046b071f6b59abcd952811",
    "6f39a25128cdf1861a213a57b8b3e7d9f711059518cdd30caaac7d2e618b4b9a",
  ],
  // B01 r4 (p2h-bg1): travelling fronts on a square screen (the pink disc fills the frame, then becomes a ring expanding out of it).
  "B01/portrait": [
    "609476816f787fdf04ce35260413d031d832bfd43eeb8694db13903f81040bcb",
    "695106b9a90cfd9bf596f47718f6246a8426cda915adb1f98d67d8c9b9437b71",
    "c18020e03564fd7905c2a17aefcc7577684b7da80ce0985723257140473b6ced",
    "b3162a70745dd8bfff5b41cbe5803ad35654eeff39d991c4833bfe97f0668422",
    "74a03c1237f54b72350043e9af2949b722179ff787fc546af84c55010449bfd6",
  ],
  "B01/landscape": [
    "e0216de4bcdbc19fa1867f2e57d1a5137ab9d173f1d565a7db954f257babd2aa",
    "786f38871b155f4bdff50fcb5ba0c16bed20387c43b452717b0a0e557b6e7f17",
    "415ac43e8dcadc14321a7b168d52e26d5a4421c0def56a57a786252d418a2bea",
    "74940be6de1b330fa091920aaf2c89530875b7a857861596d9f18896e10a189e",
    "057a8aa5758c8296f914e33ac2fe7e37e3641a8b678f8f09ab3adcdcf9116d7e",
  ],
};

function frameText(id: string, t: number, size: MotionFrameSize, input?: unknown): string {
  const item = getMotionLibraryItem(id);
  const frame = generateAnyMotionFrame(item, resolveMotionLibraryParams(item, input), t, size);
  return "svg" in frame ? frame.svg : `${frame.matte}\n--overlay--\n${frame.overlay ?? ""}`;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("golden SVG frames", () => {
  for (const id of ["T01", "X01", "B01"] as const) {
    for (const [format, size] of Object.entries(FORMATS)) {
      it(`${id} ${format} matches its golden hashes at ${TIMES[id].join(", ")} s`, () => {
        expect(TIMES[id].map(t => sha256(frameText(id, t, size)))).toEqual(GOLDEN[`${id}/${format}`]);
      });
    }
  }
  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    for (const id of ["T01", "X01", "B01"]) {
      frameText(id, 0, PORTRAIT); // warm: font parse and layout caches
      const started = performance.now();
      for (let index = 0; index < 30; index += 1) frameText(id, (index / 30) * 0.45, PORTRAIT);
      expect((performance.now() - started) / 30, id).toBeLessThan(60);
    }
  });
  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    for (const id of ["T01", "X01", "B01"]) {
      const first = frameText(id, 0.3, PORTRAIT);
      clearMotionLibraryLayoutCache();
      expect(frameText(id, 0.3, PORTRAIT)).toBe(first);
    }
  });
});

describe("T01 Word Burst", () => {
  const t01 = getMotionLibraryItem("T01") as TextMotionItem;
  it("pops in from nothing, bursts 16–18 shards and 6–8 speed lines around 1 s, and holds the word", () => {
    expect(frameText("T01", 0, PORTRAIT)).not.toContain("<path");
    const burst = frameText("T01", 1.12, PORTRAIT);
    const shards = burst.match(/<polygon/g)?.length ?? 0;
    expect(shards).toBeGreaterThanOrEqual(16);
    expect(shards).toBeLessThanOrEqual(18);
    // Speed lines: paper at 70%, stroke 1.8% of the tallest glyph of the hero-sized word (headroom 1 + 0.02 + 0.08).
    const fitted = layoutFittedText(["爆發"], { font: "display", weight: 900 }, { ...heroTextBox(PORTRAIT, { headroom: 1.1 }), lineHeight: 1.04, tracking: displayTracking(["爆發"]) });
    const glyphHeight = Math.max(...fitted.block.lines[0].layout.glyphs.map(glyph => glyph.bbox!.y1 - glyph.bbox!.y0));
    expect((fitted.ink.x1 - fitted.ink.x0) / (0.9 * 1080)).toBeGreaterThan(0.8); // ART_DIRECTION §0: 80–90% of the title-safe width
    const lines = [...burst.matchAll(/<line [^>]*stroke="(#[0-9A-F]{6})" stroke-width="([\d.]+)" stroke-linecap="round" opacity="0\.7"\/>/g)];
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines.length).toBeLessThanOrEqual(8);
    for (const [, stroke, width] of lines) {
      expect(stroke).toBe(t01.defaultParams.palette.paper);
      expect(Number(width)).toBeCloseTo(0.018 * glyphHeight, 2);
    }
    expect(frameText("T01", 1.12, PORTRAIT, { palette: { theme: "swiss_blue" } })).toContain('stroke="#111316"'); // paper would vanish on a light bg
    expect(frameText("T01", 1.25, PORTRAIT)).not.toContain("<line"); // lines flash for 0.18 s only
    // Punch: 1.08× at the burst peak (on top of the ±2% breathe).
    const punched = Number(/<g transform="translate\(540 960\) scale\(([\d.]+)\)/.exec(frameText("T01", 1.05, PORTRAIT))![1]);
    expect(punched).toBeCloseTo(1.08 * (1 + 0.02 * Math.sin((2 * Math.PI * 0.55) / 1.6)), 2);
    const hold = frameText("T01", 1.9, PORTRAIT);
    expect(hold).not.toContain("<polygon");
    expect(hold).not.toContain("<line");
    expect(hold).toMatch(/<g transform="translate\(540 960\) scale\([\d.]+\) translate\([^)]+\)"><path d="M/);
    expect(hold).toContain(`fill="${t01.defaultParams.palette.paper}"`);
    expect(frameText("T01", 2.95, PORTRAIT)).toMatch(/<g opacity="0\.\d+"/);
  });
  it("follows palette overrides and picks the readable text role", () => {
    expect(frameText("T01", 1.9, PORTRAIT, { palette: { paper: "#ABCDEF" } })).toContain(`fill="#ABCDEF"`);
    expect(frameText("T01", 1.9, PORTRAIT, { palette: { theme: "swiss_blue" } })).toContain(`fill="#111316"`);
    expect(frameText("T01", 1.12, PORTRAIT, { palette: { accent: "#00FF00" } })).toContain(`fill="#00FF00"`);
  });
  it("re-exports the shared display tracking: −0.04 em for 3+ characters, −0.02 for 1–2 (ART_DIRECTION §0)", () => {
    expect(wordBurstTracking).toBe(displayTracking);
    expect(wordBurstTracking(["爆發"])).toBe(-0.02);
    expect(wordBurstTracking(["A B"])).toBe(-0.02);
    expect(wordBurstTracking(["開箱", "第一彈"])).toBe(-0.04);
    expect(wordBurstTracking(["累計 12,480 人"])).toBe(-0.04);
  });
  it("seed, energy, text and duration change the frames", () => {
    const base = frameText("T01", 1.12, PORTRAIT);
    expect(frameText("T01", 1.12, PORTRAIT, { seed: 2 })).not.toBe(base);
    expect(frameText("T01", 1.12, PORTRAIT, { energy: "hype" })).not.toBe(base);
    expect(frameText("T01", 1.12, PORTRAIT, { lines: ["開箱", "第一彈"] })).not.toBe(base);
    expect(frameText("T01", 0.4, PORTRAIT, { durationSeconds: 1 })).not.toBe(frameText("T01", 0.4, PORTRAIT));
  });
  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(t01.defaultParams.plate).toBe("none");
    expect(t01.showcasePlate).toBe("bg");
    const plateRect = (fill: string) => `<rect x="0" y="0" width="1080" height="1920" fill="${fill}"/>`;
    const p = t01.defaultParams.palette;
    const header = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">`;
    for (const t of [0, 0.27, 1.12, 1.9, 2.85]) {
      const none = frameText("T01", t, PORTRAIT);
      expect(frameText("T01", t, PORTRAIT, { plate: "none" })).toBe(none);
      expect(none).not.toContain(plateRect(p.bg));
      // On the bg plate the contrast backdrop is unchanged, so the frame is the transparent one plus the plate.
      const onBg = frameText("T01", t, PORTRAIT, { plate: "bg" });
      expect(onBg.startsWith(header + plateRect(p.bg))).toBe(true);
      expect(onBg.replace(plateRect(p.bg), "")).toBe(none);
    }
    // On the accent plate the text switches to the readable role (ink on red), geometry unchanged.
    const accent = frameText("T01", 1.9, PORTRAIT, { plate: "accent" });
    expect(accent.startsWith(header + plateRect(p.accent))).toBe(true);
    expect(accent).toContain(`fill="${p.ink}"`);
    const hold = frameText("T01", 1.9, PORTRAIT);
    expect(accent.replace(plateRect(p.accent), "").replace(new RegExp(`fill="${p.ink}"`, "g"), `fill="${p.paper}"`)).toBe(hold);
    expect(frameText("T01", 1.9, PORTRAIT, { plate: "paper" }).startsWith(header + plateRect(p.paper))).toBe(true);
    // ART_DIRECTION §0 two-tone: accent shards on the dark card, accent2 shards on the accent card.
    expect(frameText("T01", 1.12, PORTRAIT)).toContain(`fill="${p.accent}"`);
    const burstOnAccent = frameText("T01", 1.12, PORTRAIT, { plate: "accent" });
    expect(burstOnAccent.replace(plateRect(p.accent), "")).not.toContain(`fill="${p.accent}"`);
    expect(burstOnAccent).toContain(`fill="${p.accent2}"`);
  });
});

describe("X01 Color Wipe", () => {
  const whiteRect = (svg: string) => /<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" fill="#FFFFFF"\/>/.exec(svg);
  const frame = (t: number, input?: unknown, size = LANDSCAPE) => {
    const item = getMotionLibraryItem("X01") as TransitionMotionItem;
    return item.generate(resolveMotionLibraryParams(item, input), t, size);
  };
  it("matte is strictly 0 at t = 0 and strictly 1 at t = duration, with no overlay at either end", () => {
    const empty = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"></svg>`;
    const start = frame(0);
    expect(start.matte).toBe(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect x="0" y="0" width="1920" height="1080" fill="#000000"/></svg>`);
    expect(whiteRect(start.matte)).toBeNull();
    expect(start.overlay).toBe(empty);
    for (const direction of ["left_to_right", "right_to_left", "top_to_bottom", "bottom_to_top"] as const) {
      const end = frame(0.5, { direction });
      expect(whiteRect(end.matte)!.slice(1).map(Number), direction).toEqual([0, 0, 1920, 1080]);
      expect(end.overlay).toBe(empty);
      expect(whiteRect(frame(0, { direction }).matte)).toBeNull();
    }
    expect(getMotionLibraryItem("X01").defaultDurationSeconds).toBe(0.5);
  });
  it("switches at 50% of the duration for every energy and duration (ART_DIRECTION §4: 45–55%)", () => {
    for (const energy of ["calm", "standard", "punchy", "hype"] as const) {
      for (const durationSeconds of [0.2, 0.5, 2]) {
        const half = whiteRect(frame(durationSeconds / 2, { energy, durationSeconds }).matte)!;
        expect(Number(half[3]), `${energy} ${durationSeconds}`).toBe(960);
      }
    }
  });
  it("draws the neutral and accent planes ahead of B and honours direction", () => {
    const middle = frame(0.2);
    const palette = getMotionLibraryItem("X01").defaultParams.palette;
    expect(middle.overlay).toContain(`fill="${tint(palette.accent, 0.5, palette.paper)}"`); // light tint of the accent
    expect(middle.overlay).toContain(`fill="${mixHex(palette.ink, palette.paper, 0.58)}"`); // neutral grey
    expect(middle.overlay).not.toContain(`fill="${palette.accent2}"`);
    expect(middle.overlay).not.toContain(`fill="${palette.accent}"`); // accent is B in the demo convention
    expect(middle.overlay!.match(/<rect/g)).toHaveLength(2);
    const ltr = whiteRect(middle.matte)!;
    expect(Number(ltr[1])).toBe(0);
    const rtl = whiteRect(frame(0.2, { direction: "right_to_left" }).matte)!;
    expect(Number(rtl[1]) + Number(rtl[3])).toBe(1920);
    expect(Number(rtl[1])).toBeGreaterThan(0);
    const ttb = whiteRect(frame(0.2, { direction: "top_to_bottom" }).matte)!;
    expect(Number(ttb[3])).toBe(1920);
    expect(Number(ttb[4])).toBeLessThan(1080);
    // Edges snap to whole pixels so matte and overlay meet without a seam.
    expect(middle.overlay).not.toMatch(/(?:x|width)="\d+\.\d+"/);
  });
});

describe("B01 Halftone Expand", () => {
  const b01 = getMotionLibraryItem("B01") as BackgroundMotionItem;
  it("loops seamlessly at loopSeconds", () => {
    expect(b01.loopSeconds).toBe(4);
    const start = frameText("B01", 0, PORTRAIT);
    expect(frameText("B01", 4, PORTRAIT)).toBe(start);
    expect(frameText("B01", 8, PORTRAIT)).toBe(start);
    expect(frameText("B01", 1, PORTRAIT)).not.toBe(start);
  });
  it("paints an opaque palette background and responds to speed and density", () => {
    const start = frameText("B01", 0, PORTRAIT);
    expect(start).toContain(`<rect x="0" y="0" width="1080" height="1920" fill="${b01.defaultParams.palette.bg}"/>`);
    expect(frameText("B01", 1, PORTRAIT, { speed: 2 })).not.toBe(frameText("B01", 1, PORTRAIT));
    const dots = (svg: string) => svg.match(/a[\d.]+ [\d.]+ 0 1 0 [\d.]+ 0/g)?.length ?? 0;
    expect(dots(frameText("B01", 1, PORTRAIT, { density: 2 }))).toBeGreaterThan(dots(frameText("B01", 1, PORTRAIT)) * 3);
    expect(frameText("B01", 1, PORTRAIT, { palette: { theme: "tech_spec" } })).toContain(`fill="#0E1116"`);
  });
});
