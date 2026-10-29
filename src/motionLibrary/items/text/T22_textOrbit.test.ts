import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T22_BACK_OPACITY, T22_BACK_SCALE, T22_FRONT_SCALE, T22_LOOP_SECONDS, orbitPlan, orbitPose } from "./T22_textOrbit";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T22";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.6, 1.1, 1.7, 2.4] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "6f239dd2a8d1f5b205f78fe2c1669296cacd0c607ead6ce31d442515e6503b3e",
    "1193d651c49566921190df2dbf3b89591baa7a281b8213eb4cbdd77bf7a911c1",
    "333988ef2d67a6b6333b10a97a2f36ebc453bdb88b55efe4536f41589bd4ad64",
    "d0c0aea19d93356b1f8d9c26a6c0164d026731a0c6364b502c5a89ead665295b",
    "5b4653378db5c25511a6f2341451a8075cdcbc245fcf0c53e937a83903aab0a8",
  ],
  landscape: [
    "6eebdf91193f547e8c5da65042b2c3684f7aeafa0f76b0c4dc422701ed142e4a",
    "90becae8da2282ae4d41c00249eb930988a6cac9fdb46b436ccff54b0e9fcc21",
    "797fe2d74e2acccc2452d01d6744086da39c609d22158e12af7eb9e3a46160f4",
    "7eb4f118edc1b0f4f2f6fbd944cad248daabde5fbe114d6eb5daf6cf745a46fb",
    "3ba5a9fac23188f5e04910811dac988ee568a754ea26dccc237c533fcd6cfe00",
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

describe("T22 Text Orbit", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T22_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }]) {
        const start = frameText(0, size, input);
        expect(frameText(T22_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T22_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T22_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(90 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T22_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.1, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.1, PORTRAIT)).toBe(first);
  });

  it("orbits once per loop: 1.15× and opaque in front, 0.7× and 45% at the back, left to right in front", () => {
    expect([T22_FRONT_SCALE, T22_BACK_SCALE, T22_BACK_OPACITY]).toEqual([1.15, 0.7, 0.45]);
    const plan = orbitPlan(params(), LANDSCAPE);
    const front = orbitPose(plan, 0), back = orbitPose(plan, 0.5);
    expect(front.scale).toBeCloseTo(1.15, 9);
    expect(front.opacity).toBe(1);
    expect(back.scale).toBeCloseTo(0.7, 9);
    expect(back.opacity).toBeCloseTo(0.45, 9);
    // In front the word moves toward +x; behind, toward −x.
    expect(orbitPose(plan, 0.02).x).toBeGreaterThan(front.x);
    expect(orbitPose(plan, 0.52).x).toBeLessThan(back.x);
    // The front is lower than the back (the orbit tips toward the camera).
    expect(front.y).toBeGreaterThan(back.y);
    // Energy scales the depth contrast.
    const hype = orbitPlan(params({ energy: "hype" }), LANDSCAPE);
    expect(hype.frontScale).toBeGreaterThan(plan.frontScale);
    expect(hype.backScale).toBeLessThan(plan.backScale);
  });

  it("paints by depth: the near half of the dashed orbit passes over the word when it is behind, under it in front", () => {
    const svgFront = frameText(0, LANDSCAPE), svgBack = frameText(T22_LOOP_SECONDS / 2, LANDSCAPE);
    const order = (svg: string) => [...svg.matchAll(/<(path|circle)[^>]*>/g)].map(match => (match[0].includes("stroke-dasharray") ? "dash" : match[1] === "circle" ? "body" : "word"));
    expect(order(svgFront)).toEqual(["dash", "body", "dash", "word"]);
    expect(order(svgBack)).toEqual(["dash", "word", "body", "dash"]);
  });

  it("keeps the word inside the 5% title-safe box at every phase and at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["軌"] }, { lines: ["沿著軌道前進"] }]) {
        const plan = orbitPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const w = plan.ink.x1 - plan.ink.x0, h = plan.ink.y1 - plan.ink.y0;
        for (let step = 0; step < 120; step += 1) {
          const pose = orbitPose(plan, step / 120);
          const label = `${size.width}x${size.height} ${JSON.stringify(input)} step ${step}`;
          expect(pose.x - (pose.scale * w) / 2, label).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(pose.x + (pose.scale * w) / 2, label).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(pose.y - (pose.scale * h) / 2, label).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(pose.y + (pose.scale * h) / 2, label).toBeLessThanOrEqual(safe.y1 + 1e-6);
          if (input === undefined) expect(pose.scale * h, label).toBeGreaterThanOrEqual(0.09 * short);
        }
      }
    }
  });

  it("colours: ink word and orbit on the aqua card with a deep-shade body; paper on the dark card", () => {
    const palette = item.defaultParams.palette;
    const onAccent = orbitPlan(params({ plate: "accent" }), PORTRAIT);
    expect([onAccent.color, onAccent.bodyColor]).toEqual([palette.ink, palette.accent2]);
    const onDark = orbitPlan(params(), PORTRAIT);
    expect([onDark.color, onDark.bodyColor]).toEqual([palette.paper, palette.accent]);
  });

  it("draws palette roles only: two unrelated palettes share no colour", () => {
    for (const t of TIMES) {
      const a = colours(frameText(t, PORTRAIT, { palette: PALETTE_A, plate: "accent" }));
      const b = colours(frameText(t, PORTRAIT, { palette: PALETTE_B, plate: "accent" }));
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
