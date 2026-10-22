import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  T17_COPIES, T17_FOG_MAX, T17_FOG_PER_SLOT, T17_LOOP_SECONDS, T17_RATIO, T17_WHOOSH, tunnelCopies, tunnelDepth, tunnelFog, tunnelLayout,
} from "./T17_textTunnel";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T17";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision (r2: keyed solid copies in a depth ramp). Times: the front copy at the hero slot (0), mid-dive (0.2),
 * rest (0.55, 1.1), the next dive (1.9). */
const TIMES = [0, 0.2, 0.55, 1.1, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "90ccef7b679c4e5b434f0beba65764545fb2164bbbd5cb15fe4d9641009d2fc2",
    "2e73cad45f319a97593b8dfa4e1c2958170e9a58d5f596bb9b686edb51dc3f1d",
    "7f905f5ed4c267c2ac93ac0868106180d6dc74a450ce2da45a24a2b34910da2f",
    "cdfa6ce86b291b14d2c9d81598db8f317b4a2641631f7b331b5ab8cb0f7105c3",
    "4327e865f884ad466139420dd8ced7e4b1d9a34f4d3dba7db0f0472e6b63eaea",
  ],
  landscape: [
    "4900d021831a6384e4427111da1ad27443519eafea50090d5f19c2069720f9a7",
    "b84b09582931c909ee7d0bf28247936bc0603b4c38e2fd622fe78439eb0b9f88",
    "e56a9512fd56076b64861a363d846fc51d51a5d6e8517d924f2a7d98134c1156",
    "54b53f55788171d950ee559e64be2c240f630ee3dce9766bbe9dda38abaafae8",
    "d4dd2dff435d013740a93ea3db25e88f611c967b9dbc52e10b4f5d44cca4359d",
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

describe("T17 Text Tunnel", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T17_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "bg" }, { lines: ["宇宙", "旅行"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T17_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T17_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T17_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(75 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT)); // frame 75 at 30 fps
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T17_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.55, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.55, PORTRAIT)).toBe(first);
  });

  it("nests copies on geometric depth slots through a real projection and streams two slots per loop (four at punchy and hype)", () => {
    const layout = tunnelLayout(params(), PORTRAIT);
    expect(layout.slotsPerLoop).toBe(2);
    expect(tunnelLayout(params({ energy: "hype" }), PORTRAIT).slotsPerLoop).toBe(4);
    expect(tunnelLayout(params({ energy: "calm" }), PORTRAIT).slotsPerLoop).toBe(2);
    expect(tunnelDepth(0)).toBe(1);
    expect(tunnelDepth(3) / tunnelDepth(2)).toBeCloseTo(T17_RATIO, 12);
    const copies = tunnelCopies(layout, 0.22);
    // Far to near, scale = 1 / depth: each settled slot is RATIO times larger than the one behind it.
    for (let index = 1; index < copies.length; index += 1) expect(copies[index].scale).toBeGreaterThan(copies[index - 1].scale);
    const settled = copies.filter(copy => copy.slot >= 0);
    for (const copy of settled) expect(copy.scale).toBeCloseTo(1 / tunnelDepth(copy.slot), 9);
    expect(settled.length).toBeGreaterThanOrEqual(T17_COPIES - 2);
    // The dark-to-aqua depth ramp: the second tone (aqua on the dark card) fogged toward the backdrop by depth.
    const palette = item.defaultParams.palette;
    expect(layout.tone).toBe(palette.accent);
    for (const copy of settled) {
      expect(tunnelFog(copy.slot)).toBe(Math.min(T17_FOG_MAX, T17_FOG_PER_SLOT * copy.slot));
      expect(copy.fill, `copy ${copy.index}`).toBe(mixHex(palette.accent, palette.bg, tunnelFog(copy.slot)));
    }
    const atRest = tunnelCopies(layout, 0).find(copy => copy.slot === 0)!;
    expect(atRest.fill).toBe(palette.accent);
    // The core fades out at the back of the stack.
    expect(copies[0].opacity).toBeLessThan(0.5);
  });

  it("draws every copy as a solid word keyed by a backdrop rim (no outline-only copies), the front copy at full aqua; it dives tenfold and cuts out", () => {
    const layout = tunnelLayout(params(), PORTRAIT);
    const palette = item.defaultParams.palette;
    // At the loop start the front copy sits in the hero slot (scale 1) at full aqua, its rim in the backdrop colour under the fill.
    const front = tunnelCopies(layout, 0).find(copy => copy.slot === 0)!;
    expect(front.scale).toBeCloseTo(1, 9);
    expect(frameText(0, PORTRAIT)).toContain(`fill="${palette.accent}" stroke="${palette.bg}"`);
    for (const t of TIMES) {
      const svg = frameText(t, PORTRAIT);
      expect(svg, `t=${t}`).not.toContain('fill="none"');
      expect((svg.match(/paint-order="stroke"/g) ?? []).length, `t=${t}`).toBe((svg.match(/<path /g) ?? []).length);
    }
    // Mid-dive the passing copy is several times the hero size, still at full aqua; it is gone after WHOOSH slots.
    const dive = tunnelCopies(layout, 0.2 / T17_LOOP_SECONDS).find(copy => copy.slot < 0)!;
    expect(dive.fill).toBe(palette.accent);
    expect(dive.scale).toBeGreaterThan(2);
    const after = tunnelCopies(layout, (T17_WHOOSH + 0.01) / layout.slotsPerLoop);
    expect(after.some(copy => copy.slot <= -T17_WHOOSH)).toBe(false);
  });

  it("keeps the reading word legible in every frame: few copies, the nearest settled copy within one slot of the front and a full ramp step brighter than the next", () => {
    for (const energy of ["standard", "hype"] as const) {
      const layout = tunnelLayout(params({ energy }), PORTRAIT);
      for (let frame = 0; frame < 75; frame += 1) {
        const copies = tunnelCopies(layout, frame / 75);
        const settled = copies.filter(copy => copy.slot >= 0).sort((a, b) => a.slot - b.slot);
        expect(copies.filter(copy => copy.opacity > 0.05).length, `${energy} f${frame}`).toBeLessThanOrEqual(T17_COPIES);
        expect(settled[0].slot, `${energy} f${frame}`).toBeLessThanOrEqual(1);
        expect(tunnelFog(settled[1].slot) - tunnelFog(settled[0].slot), `${energy} f${frame}`).toBeGreaterThanOrEqual(T17_FOG_PER_SLOT - 1e-9);
      }
    }
  });

  it("keeps the reading copy whole inside the 5% title-safe box at hero size (80–90% of the safe width) and ≥ 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["宇宙", "旅行"] }, { lines: ["一二三四五六七八"] }]) {
        const safe = titleSafeBox(size), layout = tunnelLayout(params(input), size);
        expect(layout.ink.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.ink.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.ink.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.ink.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(layout.ink.y1 - layout.ink.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
      const hero = tunnelLayout(params(), size);
      const fill = (hero.ink.x1 - hero.ink.x0) / titleSafeBox(size).width;
      if (size === PORTRAIT) expect(fill).toBeGreaterThan(0.8);
      expect(fill).toBeLessThanOrEqual(0.9);
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
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
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
    // On the accent card the ramp runs from deep aqua (ART_DIRECTION §0), never accent on accent; on cream too (aqua reads under 3:1
    // on cream). The rim takes the plate colour.
    for (const plate of ["accent", "paper"] as const) expect(tunnelLayout(params({ plate }), PORTRAIT).tone, plate).toBe(palette.accent2);
    expect(frameText(0, PORTRAIT, { plate: "accent" })).toContain(`fill="${palette.accent2}" stroke="${palette.accent}"`);
    expect(frameText(0, PORTRAIT, { plate: "paper" })).toContain(`fill="${palette.accent2}" stroke="${palette.paper}"`);
  });
});
