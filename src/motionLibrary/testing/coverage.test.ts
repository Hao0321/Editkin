import { describe, expect, it } from "vitest";
import { circleBezierPathD, circlePathD, createSvgDocument, path, rect } from "../svg/document";
import { coverageGrid, coverageShapes, paintedFraction, valueAt } from "./coverage";

const SIZE = { width: 1920, height: 1080 };
const matte = (...children: string[]) => createSvgDocument(SIZE, { background: "#000000" }).render(...children);
const overlay = (...children: string[]) => createSvgDocument(SIZE).render(...children);

describe("coverage probe (test utility)", () => {
  it("reads a matte in painter's order: all A, all B, half B", () => {
    expect(paintedFraction(matte(), SIZE, "matte")).toBe(0);
    expect(paintedFraction(matte(rect(0, 0, 1920, 1080, { fill: "#FFFFFF" })), SIZE, "matte")).toBe(1);
    expect(paintedFraction(matte(rect(0, 0, 960, 1080, { fill: "#FFFFFF" })), SIZE, "matte")).toBe(0.5);
    // A later black shape paints A back over B.
    const punched = matte(rect(0, 0, 1920, 1080, { fill: "#FFFFFF" }), rect(0, 0, 480, 1080, { fill: "#000000" }));
    expect(paintedFraction(punched, SIZE, "matte")).toBe(0.75);
    expect([valueAt(punched, "matte", 100, 500), valueAt(punched, "matte", 1000, 500)]).toEqual([0, 1]);
  });
  it("measures overlay coverage of absolute cubic circles to within 1%", () => {
    const r = 300, svg = overlay(path(circleBezierPathD(960, 540, r), { fill: "#FF5252" }));
    expect(paintedFraction(svg, SIZE, "overlay", 384, 216) / ((Math.PI * r * r) / (1920 * 1080))).toBeCloseTo(1, 2);
    // Cell centres (240|720|1200|1680, 270|810): a radius-500 disc covers the middle two of each row.
    expect(coverageGrid(overlay(path(circleBezierPathD(960, 540, 500), { fill: "#FF5252" })), SIZE, "overlay", 4, 2))
      .toEqual(new Uint8Array([0, 1, 1, 0, 0, 1, 1, 0]));
    // Translucent or unfilled overlay shapes do not count.
    expect(paintedFraction(overlay(rect(0, 0, 1920, 1080, { fill: "#FFFFFF", opacity: 0.5 }), rect(0, 0, 10, 10, { fill: "none" })), SIZE, "overlay")).toBe(0);
  });
  it("honours fill-rule and refuses what it cannot read exactly", () => {
    const ring = `M0 0H1920V1080H0ZM480 270H1440V810H480Z`;
    expect(paintedFraction(overlay(path(ring, { fill: "#000000", "fill-rule": "evenodd" })), SIZE, "overlay")).toBe(0.75);
    expect(paintedFraction(overlay(path(ring, { fill: "#000000" })), SIZE, "overlay")).toBe(1);
    expect(coverageShapes(overlay(path(ring, { fill: "#000000" })), "overlay")).toHaveLength(1);
    expect(() => paintedFraction(matte(rect(0, 0, 10, 10, { fill: "#FF0000" })), SIZE, "matte")).toThrow(/matte may only paint/);
    expect(() => paintedFraction(overlay(rect(0, 0, 10, 10, { fill: "#FFFFFF", transform: "rotate(5)" })), SIZE, "overlay")).toThrow(/transform/);
    expect(() => paintedFraction(overlay(path(circlePathD(10, 10, 5), { fill: "#FFFFFF" })), SIZE, "overlay")).toThrow(/only absolute/);
  });
});
