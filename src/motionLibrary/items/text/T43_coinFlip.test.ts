import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { coinFlipLayout, coinPose, T43_LOOP_SECONDS } from "./T43_coinFlip";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T43";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: rest (0), 正 showing its back face (0.15), two coins in the air (0.3), the last
 * landing squash (0.72), rest again (1.0). */
const TIMES = [0, 0.15, 0.3, 0.72, 1.0] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "7d90166ad81a188a9c32a1d35a696ac71de8d644056b101dc3012da8dad28ce6",
    "94286814472cd0b325f91e2fc955ac320d072eeb750b4d023ec7325e15dc7c15",
    "f483f2914f446d663b9fcbbd9df1f2f00edb2b114e25f4fe373cdf1efe247e91",
    "388470b80873229684d932bad8ed6b32709089fc4e0390d7ac057aa21134586f",
    "7d90166ad81a188a9c32a1d35a696ac71de8d644056b101dc3012da8dad28ce6",
  ],
  landscape: [
    "389ff5f3d69f2fe87714c6038e485efadad0b6ba4bf2f741eeed4eb9d2703ad8",
    "17284764af9f4953f95be46d1054271fcb5dc96bf82af389a53657b4c3f97ca5",
    "f47fac6ca98c28d7ced810ca0cc87156b48bc0d17634286d69a0f86515046e28",
    "b55d7f4d3beb06f38708027f08524719a454ce6b91225f0a74ff9229aa486f0a",
    "389ff5f3d69f2fe87714c6038e485efadad0b6ba4bf2f741eeed4eb9d2703ad8",
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

describe("T43 Coin Flip", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 1.2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.3, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.3, PORTRAIT)).toBe(first);
  });

  it("loops seamlessly at the 1.2 s loopSeconds, also for long lines and every energy", () => {
    expect(item.loopSeconds).toBe(T43_LOOP_SECONDS);
    for (const input of [undefined, { energy: "calm" }, { energy: "hype" }, { lines: ["一二三四五六七八九十"] }]) {
      for (const size of [PORTRAIT, LANDSCAPE]) {
        const start = frameText(0, size, input);
        expect(frameText(1.2, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2.4, size, input)).toBe(start);
      }
      // Every flip and landing squash finishes inside the loop.
      const layout = coinFlipLayout(params(input), PORTRAIT);
      const lastDone = (layout.glyphs.length - 1) * layout.staggerSeconds + layout.flipSeconds + layout.squashSeconds;
      expect(lastDone, JSON.stringify(input)).toBeLessThanOrEqual(T43_LOOP_SECONDS + 1e-9);
    }
  });

  it("flips each character once (scaleX = cos θ, back face mirrored and 15% darker) on a 35% hop, 0.12 s apart", () => {
    const palette = item.defaultParams.palette;
    const layout = coinFlipLayout(params(), PORTRAIT);
    expect(layout.glyphs).toHaveLength(4);
    expect(layout.staggerSeconds).toBeCloseTo(0.12, 9);
    expect(layout.flipSeconds).toBeCloseTo(0.36, 9);
    // Colours alternate ink and the readable accent (accent2 here: the esports green cannot be read on paper).
    const onPaper = coinFlipLayout(params({ plate: "paper" }), PORTRAIT);
    expect(onPaper.glyphs.map(glyph => glyph.color)).toEqual([palette.ink, palette.accent2, palette.ink, palette.accent2]);
    expect(onPaper.glyphs[1].backColor).toBe(mixHex(palette.accent2, palette.ink, 0.15));
    // Mid-flip (θ = 180° at the top of the hop): mirrored, darker, lifted by 35% of the glyph height.
    const top = coinPose(layout, 0, 0.18);
    expect(top.angle).toBeCloseTo(Math.PI, 6);
    expect(top.lift).toBeCloseTo(0.35 * layout.glyphs[0].height, 6);
    const mirrored = frameText(0.18, PORTRAIT, { plate: "paper" });
    expect(mirrored).toMatch(/scale\(-[\d.]+ 1\) translate\([^)]+\)"><path d="[^"]+" fill="#[0-9A-F]{6}"/);
    expect(mirrored).toContain(`fill="${onPaper.glyphs[0].backColor}"`);
    // Landing: a 0.92 squash on the floor, then rest.
    expect(coinPose(layout, 0, 0.37).scaleY).toBeCloseTo(0.92, 6);
    expect(coinPose(layout, 0, 0.5)).toEqual({ angle: 0, lift: 0, scaleY: 1 });
    // Edge-on frames skip the glyph instead of drawing a singular scale(0).
    expect(frameText(0.09, PORTRAIT)).not.toMatch(/scale\(0 /);
    expect(frameText(1.0, PORTRAIT)).not.toContain("scale(");
  });

  it("keeps the word and its hop inside the 5% title-safe box, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["正面", "反面"] }]) {
        const safe = titleSafeBox(size), layout = coinFlipLayout(params(input), size);
        expect(layout.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        for (const glyph of layout.glyphs) {
          expect(glyph.floorY - glyph.height * (1 + layout.hop)).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(glyph.height).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        }
      }
    }
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("paper");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain("<rect");
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.startsWith(header(PORTRAIT) + plateRect(PORTRAIT, palette.bg))).toBe(true);
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onPaper = frameText(t, PORTRAIT, { plate: "paper" });
      expect(onPaper.startsWith(header(PORTRAIT) + plateRect(PORTRAIT, palette.paper))).toBe(true);
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
  });
});
