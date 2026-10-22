import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { punchZoomLayout, punchZoomShake } from "./T04_punchZoom";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T04";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: the rush with echoes (0.15), the overshoot (0.24), the shake (0.4), the hold (1.5),
 * the exit push (2.1). */
const TIMES = [0.15, 0.24, 0.4, 1.5, 2.1] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "4bcadeb423a6d7fa30b8c618e55af1e17993fc507088c2cc7bee9783cf853a7e",
    "b0405761561b981cd95f860931a775bf0eae64db176d41c06ff5a05f88b4f233",
    "f2e9046a92c3e37b010f5b0ddc3d73a39c66a43c9d054cc9e4bb754d2339ac81",
    "36e30be997b8a0b33bab5b747da734fb52f007b1235930c872b6dde94b314cd5",
    "1ca8299f7e733a10da833ecee2e44075bf286133104682820911483e2e686ec0",
  ],
  landscape: [
    "888f1ee5119966ef9130fc5a06a6956d89707db49b4c3a445e3c285f861c6cf4",
    "76a4c9ee9f0ea336ec86345328e3b24cb32da76f11846bd4046b55e89dbfde67",
    "e76c7b0b8556bac87a27438dcf81d6501afc684aee5f0c23602b3420540ca823",
    "e3cc6d437c2db64975fba269fd58890051e2f9431703da1613d5d614261eff94",
    "67576a0eaa611fa876c1deb7870f3b8cafd5d4a3b7908a0ece1e9140ef18b848",
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
/** Word groups in draw order: [translateX, translateY, scale, opacity]. */
function groups(svg: string): Array<[number, number, number, number]> {
  return [...svg.matchAll(/<g(?: opacity="([\d.]+)")? transform="translate\(([\d.-]+) ([\d.-]+)\) scale\(([\d.]+)\)/g)]
    .map(match => [Number(match[2]), Number(match[3]), Number(match[4]), match[1] === undefined ? 1 : Number(match[1])]);
}

describe("T04 Punch Zoom", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.2, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.4, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.2, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.2, PORTRAIT)).toBe(first);
  });

  it("flies in from 0.2× to 1.15× by 0.22 s and settles, trailed by three soft ghosts (35/20/10%, larger, blurred) — never an extrusion", () => {
    const palette = item.defaultParams.palette;
    expect(groups(frameText(0.005, PORTRAIT))[0]?.[2] ?? 0.2).toBeLessThan(0.25);
    const rush = frameText(0.2, PORTRAIT);
    const parts = groups(rush);
    expect(parts).toHaveLength(4); // three ghosts, then the word
    const word = parts[parts.length - 1], ghosts = parts.slice(0, -1);
    expect(word[3]).toBe(1);
    // Ghosts sit where the word was earlier (further back along the path: below right), are drawn LARGER than the
    // word (6/12/18%), and fade 10/20/35% from the oldest: soft afterimages, not smaller copies peeking out as side faces.
    expect(ghosts.map(ghost => ghost[3])).toEqual([0.1, 0.2, 0.35]);
    ghosts.forEach((ghost, index) => {
      expect(ghost[2] / word[2]).toBeCloseTo(1 + 0.06 * (3 - index), 2);
      expect(ghost[1]).toBeGreaterThan(word[1]);
    });
    expect(ghosts[0][1]).toBeGreaterThan(ghosts[2][1]); // the oldest is furthest back
    // Same-colour ghosts (ART_DIRECTION §0 restyle): three ghosts and the word, all in the text colour, no accent.
    expect(rush.match(new RegExp(`fill="${palette.paper}"`, "g"))).toHaveLength(4);
    expect(rush).not.toContain(`fill="${palette.accent}"`);
    // One small blur over the ghosts only (σ = 1.5% of the scaled ink height), with a tight filter region.
    expect(rush.match(/<filter /g)).toHaveLength(1);
    const sigma = Number(/stdDeviation="([\d.]+)"/.exec(rush)![1]);
    const layout = punchZoomLayout(params(), PORTRAIT);
    expect(sigma).toBeCloseTo(0.015 * (layout.text.ink.y1 - layout.text.ink.y0) * word[2], 0);
    // The blurred group holds exactly the three ghosts; the word itself is drawn sharp after it.
    const trail = /<g filter="url\(#mfx\d+\)">(.*?)<\/g><g transform=/.exec(rush)![1];
    expect(trail.match(/<path/g)).toHaveLength(3);
    expect(trail.match(new RegExp(`fill="${palette.paper}"`, "g"))).toHaveLength(3);
    expect(groups(frameText(0.22, PORTRAIT)).at(-1)![2]).toBeCloseTo(1.15, 2);
    expect(groups(frameText(0.6, PORTRAIT))).toHaveLength(1); // ghosts die out right after the peak
    expect(frameText(0.6, PORTRAIT)).not.toContain("<filter");
    // The hold keeps drifting toward the camera (+3% by the fade), then the exit pushes on.
    const holdScale = (t: number) => groups(frameText(t, PORTRAIT))[0][2];
    expect(holdScale(0.6)).toBeGreaterThan(1);
    expect(holdScale(1.5)).toBeGreaterThan(holdScale(0.6));
    expect(holdScale(1.9)).toBeLessThanOrEqual(1.03);
    expect(holdScale(2.2)).toBeGreaterThan(1.03);
    expect(frameText(2.3, PORTRAIT)).not.toContain("<path"); // gone 0.12 s before the end
  });

  it("shakes horizontally after the impact, decaying over 0.8 s, never beyond 2% of the frame", () => {
    for (const energy of ["calm", "standard", "punchy", "hype"] as const) {
      for (const size of [PORTRAIT, LANDSCAPE]) {
        const layout = punchZoomLayout(params({ energy }), size);
        expect(layout.shake, energy).toBeLessThan(0.02 * Math.min(size.width, size.height));
        let peak = 0;
        for (let frame = 0; frame <= 144; frame += 1) peak = Math.max(peak, Math.abs(punchZoomShake(frame / 60, layout, 0.3)));
        expect(peak).toBeLessThanOrEqual(layout.shake);
      }
    }
    const layout = punchZoomLayout(params(), PORTRAIT);
    expect(punchZoomShake(0.1, layout, 0)).toBe(0); // before the impact
    expect(punchZoomShake(1.1, layout, 0)).toBe(0); // decayed by 0.22 + 0.8 s
    const x = (t: number) => groups(frameText(t, PORTRAIT)).at(-1)![0];
    expect(Math.max(...[0.26, 0.28, 0.3, 0.32, 0.34].map(t => Math.abs(x(t) - 540)))).toBeGreaterThan(3);
    expect(x(1.5)).toBe(540);
  });

  it("holds inside the 5% title-safe box, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["全力突破"] }, { lines: ["第一", "突破"] }]) {
        const safe = titleSafeBox(size), box = punchZoomLayout(params(input), size).box;
        expect(box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(box.y1 - box.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("bg");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain("<rect");
      // The plate is the first thing drawn: right after the header, or after the defs when the ghosts' blur is defined.
      const first = (svg: string) => (svg.includes("</defs>") ? svg.indexOf("</defs>") + 7 : header(PORTRAIT).length);
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.startsWith(header(PORTRAIT))).toBe(true);
      expect(onBg.indexOf(plateRect(PORTRAIT, palette.bg))).toBe(first(onBg));
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onPaper = frameText(t, PORTRAIT, { plate: "paper" });
      expect(onPaper.indexOf(plateRect(PORTRAIT, palette.paper))).toBe(first(onPaper));
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
    expect(frameText(1.5, PORTRAIT, { plate: "paper" })).toContain(`fill="${palette.ink}"`);
  });
});
