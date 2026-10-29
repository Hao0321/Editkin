import { describe, expect, it } from "vitest";
import { flattenPathD, parseAbsolutePathD, placementMatrix, transformPathD, type FlatPoint } from "./pathOps";

const area = (points: readonly FlatPoint[]) => {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index], [x2, y2] = points[(index + 1) % points.length];
    twice += x1 * y2 - x2 * y1;
  }
  return twice / 2;
};

describe("parseAbsolutePathD", () => {
  it("parses M/L/H/V/Q/C/Z, turning H and V into L and implicit pairs after M into L", () => {
    expect(parseAbsolutePathD("M0 0H10V5L3 4 2 2Q1 1 0 2C0 3 1 4 2 5Z")).toEqual([
      { type: "M", x: 0, y: 0 }, { type: "L", x: 10, y: 0 }, { type: "L", x: 10, y: 5 }, { type: "L", x: 3, y: 4 }, { type: "L", x: 2, y: 2 },
      { type: "Q", x1: 1, y1: 1, x: 0, y: 2 }, { type: "C", x1: 0, y1: 3, x2: 1, y2: 4, x: 2, y: 5 }, { type: "Z" },
    ]);
    expect(parseAbsolutePathD("M1 2 3 4")).toEqual([{ type: "M", x: 1, y: 2 }, { type: "L", x: 3, y: 4 }]);
    expect(parseAbsolutePathD("M-1.5 .5L1e1 -2")).toEqual([{ type: "M", x: -1.5, y: 0.5 }, { type: "L", x: 10, y: -2 }]);
  });
  it("refuses relative commands, arcs and malformed data", () => {
    expect(() => parseAbsolutePathD("M0 0l1 1", "t")).toThrow(/t: only absolute/);
    expect(() => parseAbsolutePathD("M0 0A1 1 0 0 0 2 2")).toThrow(/only absolute/);
    expect(() => parseAbsolutePathD("1 2")).toThrow(/malformed/);
    expect(() => parseAbsolutePathD("M0")).toThrow(/malformed/);
    expect(() => parseAbsolutePathD("M0 0Z 1 1")).toThrow(/malformed/);
  });
});

describe("flattenPathD", () => {
  it("returns one polygon per contour without the duplicate closing point", () => {
    const contours = flattenPathD("M0 0H10V10H0V0ZM20 0L30 0L30 10Z");
    expect(contours).toEqual([[[0, 0], [10, 0], [10, 10], [0, 10]], [[20, 0], [30, 0], [30, 10]]]);
    expect(flattenPathD("M0 0L5 5Z")).toEqual([]); // fewer than 3 points
  });
  it("subdivides curves by length and keeps their area", () => {
    // Circle of radius 100 from four cubic quarter arcs (k = 0.5523).
    const k = 55.22847498;
    const circle = `M100 0C100 ${k} ${k} 100 0 100C${-k} 100 -100 ${k} -100 0C-100 ${-k} ${-k} -100 0 -100C${k} -100 100 ${-k} 100 0Z`;
    const [polygon] = flattenPathD(circle, { segmentLength: 4 });
    expect(Math.abs(area(polygon))).toBeCloseTo(Math.PI * 100 * 100, -2); // within ~50 px² of 31416
    const coarse = flattenPathD(circle, { segmentLength: 1000 })[0];
    expect(coarse.length).toBe(4 * 3); // the 3-step floor per cubic
    const quad = flattenPathD("M0 0Q50 100 100 0L50 -10Z", { segmentLength: 10 })[0];
    expect(quad.length).toBe(1 + 10 + 1); // ceil(chord 100 / 10) = 10 steps
  });
  it("needs a positive segment length", () => {
    expect(() => flattenPathD("M0 0L1 0L1 1Z", { segmentLength: 0 })).toThrow(/positive/);
  });
});

describe("transformPathD", () => {
  it("places outlines with translate · rotate · scale", () => {
    expect(transformPathD("M0 0L10 0L10 10Z", placementMatrix(5, 5, 90))).toBe("M5 5L5 15L-5 15Z");
    expect(transformPathD("M1 1Q2 2 3 3C4 4 5 5 6 6Z", placementMatrix(0, 0, 0, 2, 3))).toBe("M2 3Q4 6 6 9C8 12 10 15 12 18Z");
    expect(transformPathD("M0 0H10", placementMatrix(0, 0, 45), 3)).toBe("M0 0L7.071 7.071");
    expect(transformPathD("", placementMatrix(1, 1))).toBe("");
    expect(() => transformPathD("M0 0L1 1", [Number.NaN, 0, 0, 1, 0, 0])).toThrow(/finite/);
  });
});
