import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache, layoutLine } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { textFace, titleSafeBox } from "../shared";
import { stampLayout } from "./T03_textStamp";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T03";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: first stamp pressing (0.25), first ghost (0.33), second landing (0.58), all three
 * held (1.5), cleared (1.95). */
const TIMES = [0.25, 0.33, 0.58, 1.5, 1.95] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "9eee80405ec788dad7ad2ba22668c40bc3e7ef799ff3dc374d943988e88f37c3",
    "fa9db0409e3b53089bf64173e0f71f3a57ace36dc884c88d93e1b4e5321515d3",
    "086dd8d22126d8fbe3f5b21de8043eb93306dbbe55c3b1400138a93b33ab999e",
    "747ca04eaca68fbd9ba2e19ba53bf84366990f92426e36fb572f9f696e29faa0",
    "6dd797c940e8a36b0204c4ed319a6dab5061438bad86ebadb1f923876da86852",
  ],
  landscape: [
    "fb68533ca781ea7bd250b509fb735a2f90a0cd06d6c97082cb8e5bd243add92d",
    "344c3d04b8b854d67c0b34730872b5b93c83ea4d7e663f003c64e4440225179d",
    "ca6b26bff6c59c03ec9e19a6859095b559af3ddebe41e9f4f4cd42e5fc892158",
    "a28388e1dc2bd1445c61ac2a8663440e7b78507686fd7132e1bd790ec2e2f449",
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
/** Stamps drawn in a frame: one masked group each. */
const stampsIn = (svg: string) => svg.match(/<g mask="url\(#/g)?.length ?? 0;

describe("T03 Text Stamp", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(1.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.5, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.5, PORTRAIT)).toBe(first);
  });

  it("presses the stamps down one after another (0.3, 0.55, 1.05 s), holds them together and clears by cut", () => {
    const layout = stampLayout(params(), PORTRAIT);
    expect(layout.stamps.map(stamp => stamp.text)).toEqual(["確定", "通過", "完成"]);
    expect(layout.stamps.map(stamp => Number(stamp.land.toFixed(6)))).toEqual([0.3, 0.55, 1.05]);
    expect(layout.startScale).toBeCloseTo(1.6, 6);
    // Tilts follow the reference (−10°, +5°, −3°) within the ±1.5° seeded jitter.
    layout.stamps.forEach((stamp, index) => expect(Math.abs(stamp.rotation - [-10, 5, -3][index])).toBeLessThanOrEqual(1.5));
    expect(stampsIn(frameText(0.1, PORTRAIT))).toBe(0);
    expect(stampsIn(frameText(0.25, PORTRAIT))).toBe(1);
    expect(stampsIn(frameText(0.6, PORTRAIT))).toBe(2);
    expect(stampsIn(frameText(1.5, PORTRAIT))).toBe(3);
    expect(stampsIn(frameText(1.95, PORTRAIT))).toBe(0); // cleared 0.1 s before the end
    // Pressing: bigger and fading in; landed: a 0.97 dip; held: no scale.
    const stampScale = (svg: string) => Number(/scale\(([\d.]+)\)"><g mask=/.exec(svg)![1]);
    expect(stampScale(frameText(0.25, PORTRAIT))).toBeGreaterThan(1.2);
    expect(stampScale(frameText(0.35, PORTRAIT))).toBeLessThan(1);
    expect(frameText(1.5, PORTRAIT)).not.toContain("scale(");
    // The ghost: a faint border outline that spreads after each landing.
    expect(frameText(0.33, PORTRAIT)).toMatch(/fill="none" stroke="#[0-9A-F]{6}"[^>]*opacity="0\.\d+"/);
    expect(frameText(1.5, PORTRAIT)).not.toContain(`fill="none"`);
  });

  it("gives every stamp a rough border, roughened glyphs and an ink-texture mask of voids", () => {
    const held = frameText(1.5, PORTRAIT);
    expect(held.match(/<mask /g)).toHaveLength(3);
    expect(held.match(/fill-rule="evenodd"/g)).toHaveLength(3); // the border rings
    // Roughened outlines are dense polygons (L segments only), not the font's curves.
    const ring = /<path d="(M[^"]+)" fill="#[0-9A-F]{6}" fill-rule="evenodd"/.exec(held)![1];
    expect(ring).not.toMatch(/[QC]/);
    expect(ring.split("L").length).toBeGreaterThan(200);
  });

  it("keeps the pile inside the 5% title-safe box with stamp text at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["OK"] }, { lines: ["已確認", "審核通過", "上線", "完成"] }]) {
        const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        const layout = stampLayout(params(input), size);
        for (const stamp of layout.stamps) {
          for (const [x, y] of stamp.corners) {
            expect(x, `${stamp.text} ${size.width}x${size.height}`).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
            expect(x).toBeLessThanOrEqual(safe.x1 + 1e-6);
            expect(y).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
            expect(y).toBeLessThanOrEqual(safe.y1 + 1e-6);
          }
          if (/\p{Script=Han}/u.test(stamp.text)) {
            const ink = layoutLine(stamp.text, { ...textFace("display", 900), size: layout.fontSize }).inkBox!;
            expect(ink.y1 - ink.y0, stamp.text).toBeGreaterThanOrEqual(0.09 * short);
          }
        }
      }
    }
  });

  it("alternates secondaryTone and the text role (ART_DIRECTION §0) and stays readable on every plate", () => {
    const palette = item.defaultParams.palette;
    // On cream the red accent reads below 3:1, so the second tone is its deep shade (accent2), as in the reference.
    expect(stampLayout(params({ plate: "paper" }), PORTRAIT).stamps.map(stamp => stamp.color)).toEqual([palette.accent2, palette.ink, palette.accent2]);
    expect(stampLayout(params(), PORTRAIT).stamps.map(stamp => stamp.color)).toEqual([palette.accent, palette.paper, palette.accent]);
    // On the accent plate the accent cannot be read: the stamps fall back to a readable colour.
    const onAccent = stampLayout(params({ plate: "accent" }), PORTRAIT).stamps.map(stamp => stamp.color);
    expect(onAccent).not.toContain(palette.accent);
    expect(frameText(1.5, PORTRAIT, { palette: { accent: "#00AA55" } })).toContain(`fill="#00AA55"`);
  });

  it("seed and text change the pile; the plate changes nothing but the plate and colours (ART_DIRECTION §9)", () => {
    expect(frameText(1.5, PORTRAIT, { seed: 2 })).not.toBe(frameText(1.5, PORTRAIT));
    expect(stampLayout(params({ lines: ["好"] }), PORTRAIT).stamps).toHaveLength(1);
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("paper");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain(plateRect(PORTRAIT, palette.bg));
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onPaper = frameText(t, PORTRAIT, { plate: "paper" });
      expect(onPaper).toContain(plateRect(PORTRAIT, palette.paper));
      // The plate is the first thing drawn (right after the defs).
      const drawn = onPaper.includes("</defs>") ? onPaper.indexOf("</defs>") + 7 : onPaper.indexOf(">") + 1;
      expect(onPaper.indexOf(plateRect(PORTRAIT, palette.paper))).toBe(drawn);
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
  });
});
