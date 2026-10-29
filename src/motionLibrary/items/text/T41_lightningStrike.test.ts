import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { lightningFlash, lightningLayout } from "./T41_lightningStrike";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T41";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: the 100% flash (0.03), the 55% flash with the slam and bolt (0.1), bolt + ring + glow
 * peak (0.3), the dimmed hold (1.5), after the cut (1.9). */
const TIMES = [0.03, 0.1, 0.3, 1.5, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "6b93744c6cc2af8cb92d911422931bc0cadd633e22aabc12447ec87d5e2be438",
    "aa6ff8323363a0d000e39c3e19fa02aab1f61678759c6e2561cb340ba73d248c",
    "f0b0af449dce33570e1267673252991551826e74c9f787810d56da727339db77",
    "c77d38ec4603da90d384ac4b33d0f724732e9a36750f73a41291b4b042658590",
    "6dd797c940e8a36b0204c4ed319a6dab5061438bad86ebadb1f923876da86852",
  ],
  landscape: [
    "540b10a39037b08e1300a641eccebb2c525420e59b9ae70bfbd64ab77919e4dd",
    "f71b1ea352c6a1443c7fc385daf3fc38642784399e4f2f7f45e92b7a54db74d6",
    "21c2feb8877a3015b4a4e923e33abf3a8225be4540659f20ed31f00e2751fcb8",
    "660155789badd6406098e5c7edd590add73fd9bb06db548d6720b8a7918173de",
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
/** Opacity of the full-frame paper flash in a frame (0 when there is none). */
function flashIn(svg: string, size: MotionFrameSize): number {
  const match = new RegExp(`<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="#[0-9A-F]{6}"(?: opacity="([\\d.]+)")?/></svg>$`).exec(svg);
  return match ? Number(match[1] ?? 1) : 0;
}

describe("T41 Lightning Strike", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.3, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.3, PORTRAIT)).toBe(first);
  });

  it("flashes exactly once: 100% for 2 frames, 55% for 2 frames, then never again (≤ 3 flashes per second)", () => {
    const palette = item.defaultParams.palette;
    expect([0, 1, 2, 3, 4, 5].map(frame => lightningFlash(frame / 30))).toEqual([1, 1, 0.55, 0.55, 0, 0]);
    expect(frameText(0, PORTRAIT)).toContain(`fill="${palette.paper}"/></svg>`);
    for (const duration of [2, 6]) {
      let flashes = 0, previous = 0;
      for (let frame = 0; frame < duration * 60; frame += 1) {
        const level = flashIn(frameText(frame / 60, { width: 108, height: 192 }, { durationSeconds: duration }), { width: 108, height: 192 });
        if (level > 0 && previous === 0) flashes += 1;
        previous = level;
      }
      expect(flashes, `${duration} s clip`).toBe(1);
    }
  });

  it("slams 2.4× → 0.97 → 1.0, strikes a jagged bolt with forks onto the word, rings, glows and cuts at 1.85 s", () => {
    const layout = lightningLayout(params(), PORTRAIT);
    expect(layout.slamScale).toBeCloseTo(2.4, 6);
    expect(layout.bolt.length).toBeGreaterThanOrEqual(8); // 7–9 segments
    expect(layout.bolt.length).toBeLessThanOrEqual(10);
    expect(layout.bolt[0][1]).toBeLessThan(0); // from above the frame
    expect(layout.bolt[layout.bolt.length - 1][1]).toBeGreaterThan(layout.box.y0); // onto the top of the word
    expect(layout.forks.length).toBeGreaterThanOrEqual(1);
    const scaleAt = (t: number) => Number(/<g transform="translate\([\d. ]+\) scale\(([\d.]+)\)/.exec(frameText(t, PORTRAIT))?.[1] ?? 1);
    expect(scaleAt(0.08)).toBeGreaterThan(1.5);
    expect(scaleAt(0.22)).toBeLessThan(1);
    expect(scaleAt(0.6)).toBe(1);
    const strike = frameText(0.15, PORTRAIT);
    expect(strike).toMatch(/<circle [^>]*fill="none" stroke="#[0-9A-F]{6}"/); // the shockwave
    expect(strike.match(/stroke-miterlimit/g)!.length).toBeGreaterThanOrEqual(4); // bolt and fork, glow and core
    expect(strike.match(/<filter /g)).toHaveLength(2); // bolt glow + word glow
    expect(frameText(0.5, PORTRAIT)).not.toContain("stroke-miterlimit"); // bolt gone by 0.45 s
    expect(frameText(0.7, PORTRAIT)).not.toContain("<circle"); // ring done after 0.62 s
    expect(frameText(1.5, PORTRAIT).match(/<filter /g)).toHaveLength(1); // the 25% glow holds
    expect(frameText(1.86, PORTRAIT)).not.toContain("<path");
  });

  it("keeps the word inside the 5% title-safe box, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["雷霆萬鈞"] }, { lines: ["轟", "雷"] }]) {
        const safe = titleSafeBox(size), box = lightningLayout(params(input), size).box;
        expect(box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(box.y1 - box.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("seeds the bolt and follows the palette", () => {
    expect(lightningLayout(params({ seed: 7 }), PORTRAIT).bolt).not.toEqual(lightningLayout(params(), PORTRAIT).bolt);
    expect(frameText(0.3, PORTRAIT, { palette: { accent: "#00CCFF" } })).toContain(`stroke="#00CCFF"`);
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
      const first = onPaper.includes("</defs>") ? onPaper.indexOf("</defs>") + 7 : onPaper.indexOf(">") + 1;
      expect(onPaper.indexOf(plateRect(PORTRAIT, palette.paper))).toBe(first);
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
  });
});
