import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { tint } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { heartbeatGlow, heartbeatLayout, heartbeatScale, T46_LOOP_SECONDS } from "./T46_heartbeatZoom";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T46";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: the beat starts with the last dub ring fading (0), the lub peak (0.08), the dub
 * (0.26), the rings spreading (0.5), still (0.9). */
const TIMES = [0, 0.08, 0.26, 0.5, 0.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "2e9c5f0abf496b73c5bca89a8c255ddb94efe761f979053584532a944bc75ea5",
    "8ae2c27b975a44f127a85e102ff3ba1026fbc0ef8ec8bd7150224ff43202c229",
    "e6c9277232f295bcdb7549cff68cf88689254e9144f7f0c396841ccab8a1fd1b",
    "4938b8c311be7d080522b0ad833a89dd121a63d8f6e96b8d3592698842e038fa",
    "d08e9d85b39dac4037e312659cdd6712ae57f807bb3905c253fbde59101ccd4a",
  ],
  landscape: [
    "519c4f9dda76d210dcc84c61b572817ffd3832234e5c2cab4c2d45d491ba8253",
    "6c90f2523fbbb4a5ada8f5a3e5ad72daa48fd8168e6b913081d54533318edf30",
    "de2490b41f41b632a9ae5292cf260ec8aae2484245b9898e90d47fb8831f4f54",
    "26b3d5200416c4aae0563b9279da13d1d4abea14d6fcc3f6311c9d8f3c7fb2bb",
    "15cdad418c9e3d0c44dc1392c4c53f35795e74389f2d2757caea53cd8e912cb0",
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

describe("T46 Heartbeat Zoom", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.08, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 3, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.26, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.26, PORTRAIT)).toBe(first);
  });

  it("loops seamlessly at the 1 s loopSeconds (60 BPM), on every plate and energy", () => {
    expect(item.loopSeconds).toBe(T46_LOOP_SECONDS);
    for (const input of [undefined, { plate: "accent" }, { energy: "calm" }, { energy: "hype" }, { lines: ["怦然心動"] }]) {
      for (const size of [PORTRAIT, LANDSCAPE]) {
        const start = frameText(0, size, input);
        expect(frameText(1, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2, size, input)).toBe(start);
      }
    }
  });

  it("beats lub-dub: 1.10 then 1.06 with backOut up-strokes, two pulses a second (≤ 3 per second), still from 0.45 s", () => {
    expect(heartbeatScale(0, 1)).toBe(1);
    expect(heartbeatScale(0.08 - 1e-9, 1)).toBeCloseTo(1.1, 3);
    expect(heartbeatScale(0.2, 1)).toBeCloseTo(1, 6);
    expect(heartbeatScale(0.3 - 1e-9, 1)).toBeCloseTo(1.06, 3);
    expect(heartbeatScale(0.45, 1)).toBe(1);
    expect(heartbeatScale(0.7, 1)).toBe(1);
    // Count the pulses (local maxima above 1.02) over 3 s at 240 fps, for every energy.
    for (const depth of [0.5, 1, 1.3, 1.6]) {
      const samples = Array.from({ length: 721 }, (_, index) => heartbeatScale((index / 240) % 1, depth));
      let peaks = 0;
      for (let index = 1; index < samples.length - 1; index += 1) {
        if (samples[index] > 1 + 0.02 * depth && samples[index] >= samples[index - 1] && samples[index] > samples[index + 1]) peaks += 1;
      }
      expect(peaks, `depth ${depth}`).toBe(6);
    }
  });

  it("spawns a crisp ring on each lub (from 90%) and dub (from 55%), and a light glow on each beat that expands as it fades", () => {
    expect(rings(frameText(0.1, PORTRAIT))).toBe(1); // the lub ring (the last dub ring is spent)
    expect(rings(frameText(0.5, PORTRAIT))).toBe(2); // lub and dub rings spreading
    expect(rings(frameText(0.95, PORTRAIT))).toBe(1); // the dub ring still fading into the next beat
    const lub = frameText(0.08, PORTRAIT);
    expect(lub).toContain("<radialGradient");
    expect(lub).not.toContain("<filter"); // a gradient, not a blur
    // Each glow peaks at its beat's up-stroke, expands while it fades and is spent 0.5 s after its beat: 2 a second.
    expect(heartbeatGlow(0.08, "lub")!.strength).toBeCloseTo(1, 6);
    expect(heartbeatGlow(0.3, "dub")!.strength).toBeCloseTo(1, 6);
    const early = heartbeatGlow(0.12, "lub")!, late = heartbeatGlow(0.35, "lub")!;
    expect(late.growth).toBeGreaterThan(early.growth);
    expect(late.strength).toBeLessThan(early.strength);
    expect(heartbeatGlow(0.5, "lub")).toBeNull();
    expect(heartbeatGlow(0.701, "dub")).toBeNull(); // 0.5 s after the dub (0.7 - 0.2 rounds just below 0.5 in floating point)
    expect(heartbeatGlow(0.1, "dub")).toBeNull(); // the previous dub's glow is spent before the next lub
    expect(frameText(0.75, PORTRAIT)).not.toContain("<radialGradient");
    const opacity = (t: number) => Number(/<circle [^>]*fill="none"[^>]*opacity="([\d.]+)"/.exec(frameText(t, PORTRAIT))![1]);
    expect(opacity(0.001)).toBeCloseTo(0.9, 2);
  });

  it("keeps the word inside the 5% title-safe box at the lub peak, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["怦然心動"] }]) {
        const safe = titleSafeBox(size), layout = heartbeatLayout(params(input), size);
        const peak = Math.max(...Array.from({ length: 1000 }, (_, index) => heartbeatScale(index / 1000, layout.depth)));
        const halfW = ((layout.box.x1 - layout.box.x0) / 2) * peak, halfH = ((layout.box.y1 - layout.box.y0) / 2) * peak;
        expect(layout.cx - halfW).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.cx + halfW).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.cy - halfH).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.cy + halfH).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(layout.box.y1 - layout.box.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("colours: ink word, a paper tint of the accent glowing and accent2 rings on the accent plate; paper word, accent glow and rings on the dark card", () => {
    const palette = item.defaultParams.palette;
    const onAccent = frameText(0.08, PORTRAIT, { plate: "accent" }).replace(plateRect(PORTRAIT, palette.accent), "");
    expect(onAccent).toContain(`fill="${palette.ink}"`);
    expect(onAccent).toContain(`stroke="${palette.accent2}"`);
    expect(onAccent).toContain(`stop-color="${tint(palette.accent, 0.6, palette.paper)}"`);
    expect(onAccent).not.toContain(`stop-color="${palette.ink}"`); // a light glow, never a dark shadow
    const dark = frameText(0.08, PORTRAIT);
    expect(dark).toContain(`fill="${palette.paper}"`);
    expect(dark).toContain(`stroke="${palette.accent}"`);
    expect(dark).toContain(`stop-color="${palette.accent}"`);
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("accent");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain(plateRect(PORTRAIT, palette.bg));
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onAccent = frameText(t, PORTRAIT, { plate: "accent" });
      const first = onAccent.includes("</defs>") ? onAccent.indexOf("</defs>") + 7 : onAccent.indexOf(">") + 1;
      expect(onAccent.indexOf(plateRect(PORTRAIT, palette.accent))).toBe(first);
      expect(maskColors(onAccent.replace(plateRect(PORTRAIT, palette.accent), ""))).toBe(maskColors(none));
    }
  });
});
