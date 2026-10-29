import { describe, expect, it } from "vitest";
import type { PreparedGlyphPathCommand } from "../typography/preparedGlyphRun";
import { HINGE_SURFACE_LIMITS, prepareHingeSurface, projectHingeSurfacePoint, sampleHingeSurface,
  type HingeSurfaceDefinition, type HingeSurfacePoint } from "./hingeSurface";

function polygon(points: readonly (readonly [number, number])[]): PreparedGlyphPathCommand[] {
  return points.map(([x, y], index) => ({ type: index === 0 ? "M" : "L", x, y } as PreparedGlyphPathCommand)).concat({ type: "Z" });
}
const square = () => polygon([[0, 0], [100, 0], [100, 100], [0, 100]]);
function definition(commands = square(), overrides: Partial<HingeSurfaceDefinition> = {}): HingeSurfaceDefinition {
  return { id: "counter:digit:upper", commands, clip: { x: 0, y: 0, width: 100, height: 100 },
    hinge: { x: 0, y: 0 }, perspectivePixels: 500, maxScreenScale: 1, ...overrides };
}
function winding(contours: readonly (readonly HingeSurfacePoint[])[], x: number, y: number): number {
  let result = 0;
  for (const contour of contours) for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
    if (a.y <= y && b.y > y && side > 0) result++;
    if (a.y > y && b.y <= y && side < 0) result--;
  }
  return result;
}
function signedArea(contour: readonly HingeSurfacePoint[]): number {
  return contour.reduce((sum, a, i) => { const b = contour[(i + 1) % contour.length]; return sum + a.x * b.y - b.x * a.y; }, 0) / 2;
}
function contourDistance(p: HingeSurfacePoint, contours: readonly (readonly HingeSurfacePoint[])[]): number {
  let minimum = Infinity;
  for (const contour of contours) for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length], dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
    minimum = Math.min(minimum, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return minimum;
}
function independentProjection(x: number, y: number, angle: number, perspective: number): HingeSurfacePoint {
  const radians = angle * Math.PI / 180, depth = perspective - y * Math.sin(radians);
  return { x: x * perspective / depth, y: y * Math.cos(radians) * perspective / depth };
}
const cubic: PreparedGlyphPathCommand[] = [{ type: "M", x: 0, y: 0 },
  { type: "C", x1: 0, y1: 100, x2: 100, y2: 100, x: 100, y: 0 }, { type: "L", x: 0, y: 0 }, { type: "Z" }];

describe("original clipped projective hinge surface", () => {
  it("uses real depth-dependent perspective rather than a uniform affine squeeze", () => {
    const near = projectHingeSurfacePoint({ x: 100, y: 50 }, { x: 0, y: 0 }, 400, 30);
    const far = projectHingeSurfacePoint({ x: 100, y: -50 }, { x: 0, y: 0 }, 400, 30);
    expect(near.x).toBeCloseTo(106.6666666667, 8);
    expect(far.x).toBeCloseTo(94.1176470588, 8);
    expect(near.y).toBeCloseTo(46.1880215352, 8);
    expect(Math.abs(near.x - 100)).toBeGreaterThan(6);
    expect(projectHingeSurfacePoint({ x: 12, y: 7 }, { x: 12, y: 7 }, 400, 43)).toEqual({ x: 12, y: 7 });
  });

  it("clips the actual local contour and serializes identical numeric vertices for SVG and ASS", () => {
    const surface = prepareHingeSurface(definition(polygon([[-20, -20], [120, -20], [120, 120], [-20, 120]])));
    const output = sampleHingeSurface(surface, 0);
    expect(output.bounds).toEqual({ xMin: 0, yMin: 0, xMax: 100, yMax: 100 });
    expect(output.contours[0].map(p => `${p.x},${p.y}`).sort()).toEqual(["0,0", "0,100", "100,0", "100,100"]);
    const svgNumbers = output.svg.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    const assNumbers = output.ass.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    expect(assNumbers?.slice(0, -2)).toEqual(svgNumbers);
    expect(assNumbers?.slice(-2)).toEqual(svgNumbers?.slice(0, 2));
    expect(output.visibility).toBe("front");
    expect(output.id).toBe("counter:digit:upper");
  });

  it("preserves opposite hole winding when clipping opens the hole at a boundary", () => {
    const commands = [...square(), ...polygon([[20, 20], [20, 80], [80, 80], [80, 20]])];
    const output = sampleHingeSurface(prepareHingeSurface(definition(commands,
      { clip: { x: 0, y: 0, width: 60, height: 100 } })), 0);
    expect(output.contours).toHaveLength(2);
    expect(Math.sign(signedArea(output.contours[0]))).toBe(1);
    expect(Math.sign(signedArea(output.contours[1]))).toBe(-1);
    expect(winding(output.contours, 5, 50)).not.toBe(0);
    expect(winding(output.contours, 30, 50)).toBe(0);
    expect(winding(output.contours, 65, 50)).toBe(0);
  });

  it("keeps disconnected clipped concave lobes without filling the cancelling boundary bridge", () => {
    const commands = polygon([[10, 10], [90, 10], [90, 90], [70, 90], [70, 30], [30, 30], [30, 90], [10, 90]]);
    const output = sampleHingeSurface(prepareHingeSurface(definition(commands,
      { clip: { x: 0, y: 50, width: 100, height: 40 } })), 0);
    expect(winding(output.contours, 20, 70)).not.toBe(0);
    expect(winding(output.contours, 80, 70)).not.toBe(0);
    expect(winding(output.contours, 50, 70)).toBe(0);
    expect(winding(output.contours, 50, 49)).toBe(0);
    expect(signedArea(output.contours[0])).toBeCloseTo(1600, 6);
  });

  it("rejects retraced source topology whose opposite ink regions would cancel signed area after clipping", () => {
    const retraced: Array<[number, number]> = [[0, 0], [20, 0], [20, 30], [0, 30], [0, 0],
      [40, 0], [40, 20], [60, 20], [60, 0], [40, 0], [0, 0]];
    const raw = retraced.slice(0, -1).map(([x, y]) => ({ x, y }));
    expect(signedArea(raw)).toBe(200);
    expect(winding([raw], 10, 10)).toBe(1);
    expect(winding([raw], 50, 10)).toBe(-1);
    expect(() => prepareHingeSurface(definition(polygon(retraced),
      { clip: { x: 0, y: 0, width: 60, height: 20 } }))).toThrow(/source contour topology/);
    const adjacentRetrace = polygon([[0, 0], [100, 0], [50, 0], [100, 100], [0, 100]]);
    expect(() => prepareHingeSurface(definition(adjacentRetrace))).toThrow(/source contour topology/);
    const crossing = polygon([[0, 0], [100, 100], [0, 100], [100, 0], [100, 80], [0, 80]]);
    expect(() => prepareHingeSurface(definition(crossing))).toThrow(/source contour topology/);
    const monotone = polygon([[0, 0], [50, 0], [100, 0], [100, 100], [0, 100]]);
    expect(sampleHingeSurface(prepareHingeSurface(definition(monotone)), 0).bounds).toEqual({ xMin: 0, yMin: 0, xMax: 100, yMax: 100 });
    const separate = [...polygon([[0, 0], [20, 0], [20, 30], [0, 30]]), ...polygon([[40, 0], [40, 20], [60, 20], [60, 0]])];
    const output = sampleHingeSurface(prepareHingeSurface(definition(separate,
      { clip: { x: 0, y: 0, width: 60, height: 20 } })), 0);
    expect(output.contours).toHaveLength(2);
    expect(output.contours.reduce((sum, contour) => sum + signedArea(contour), 0)).toBe(0);
    expect(winding(output.contours, 10, 10)).toBe(1);
    expect(winding(output.contours, 50, 10)).toBe(-1);
  });

  it("bounds cubic and quadratic screen error at the declared maximum scale including lateral perspective", () => {
    const maximumScale = 20;
    const prepared = prepareHingeSurface(definition(cubic, { maxScreenScale: maximumScale }));
    const output = sampleHingeSurface(prepared, 60, maximumScale);
    let largest = 0, coarseNegative = 0;
    const flat = [[{ x: 0, y: 0 }, independentProjection(100, 0, 60, 500)]];
    for (let i = 0; i <= 200; i++) {
      const t = i / 200, x = 100 * (3 * (1 - t) * t * t + t * t * t), y = 300 * (1 - t) * t;
      const exact = independentProjection(x, y, 60, 500);
      largest = Math.max(largest, contourDistance(exact, output.contours) * maximumScale);
      coarseNegative = Math.max(coarseNegative, contourDistance(exact, flat) * maximumScale);
    }
    expect(largest).toBeLessThanOrEqual(.25);
    expect(output.errorBoundPixels).toBeLessThanOrEqual(.25);
    expect(output.vertices).toBeGreaterThan(4);
    expect(coarseNegative).toBeGreaterThan(100);
    const quadratic: PreparedGlyphPathCommand[] = [{ type: "M", x: 0, y: 0 },
      { type: "Q", x1: 100, y1: 100, x: 100, y: 0 }, { type: "L", x: 0, y: 0 }, { type: "Z" }];
    const qOutput = sampleHingeSurface(prepareHingeSurface(definition(quadratic, { maxScreenScale: maximumScale })), 60, maximumScale);
    for (let i = 0; i <= 200; i++) {
      const t = i / 200, exact = independentProjection(200 * (1 - t) * t + 100 * t * t, 200 * (1 - t) * t, 60, 500);
      expect(contourDistance(exact, qOutput.contours) * maximumScale).toBeLessThanOrEqual(.25);
    }
  });

  it("owns frozen source geometry and returns exact results for arbitrary seek order", () => {
    const commands = square(), input = definition(commands), surface = prepareHingeSurface(input);
    const before = sampleHingeSurface(surface, 43);
    for (const angle of [0, -30, 90, 180, 5]) sampleHingeSurface(surface, angle);
    expect(sampleHingeSurface(surface, 43)).toEqual(before);
    commands[0] = { type: "M", x: 99, y: 99 };
    (input.clip as { x: number }).x = 50;
    expect(sampleHingeSurface(surface, 43)).toEqual(before);
    expect(Object.isFrozen(surface.contours[0][0])).toBe(true);
    expect(Object.isFrozen(before.contours[0])).toBe(true);
    expect(() => sampleHingeSurface(structuredClone(surface), 43)).toThrow(/factory-owned/);
  });

  it("gives explicit stable empty edge-on and back poses with periodic 90 and 270 equivalence", () => {
    const surface = prepareHingeSurface(definition());
    const right = sampleHingeSurface(surface, 90), left = sampleHingeSurface(surface, 270);
    expect(right.visibility).toBe("edge-on");
    expect(left.visibility).toBe("edge-on");
    expect(right.contours).toEqual(left.contours);
    expect(right.svg).toBe("");
    expect(left.ass).toBe("");
    expect(right.bounds).toBeNull();
    expect(right.id).toBe(left.id);
    expect(sampleHingeSurface(surface, 270)).toEqual(sampleHingeSurface(surface, -90));
    expect(sampleHingeSurface(surface, 360)).toEqual(sampleHingeSurface(surface, 0));
    expect(sampleHingeSurface(surface, 180).visibility).toBe("back-face");
    const empty = prepareHingeSurface(definition(polygon([[110, 10], [120, 10], [120, 20], [110, 20]])));
    expect(sampleHingeSurface(empty, 30)).toMatchObject({ id: surface.id, visibility: "clipped-empty", contours: [], bounds: null });
  });

  it("rejects open malformed degenerate and non-finite contours and insufficient depth", () => {
    expect(() => prepareHingeSurface(definition(square().slice(0, -1)))).toThrow(/end with Z/);
    expect(() => prepareHingeSurface(definition([{ type: "L", x: 0, y: 0 }]))).toThrow(/start with M/);
    expect(() => prepareHingeSurface(definition(polygon([[0, 0], [10, 0], [20, 0]])))).toThrow(/nondegenerate/);
    expect(() => prepareHingeSurface(definition([{ type: "M", x: NaN, y: 0 }]))).toThrow(/non-finite/);
    expect(() => prepareHingeSurface(definition([{ type: "A" } as unknown as PreparedGlyphPathCommand]))).toThrow(/unsupported/);
    expect(() => prepareHingeSurface(definition(square(), { perspectivePixels: 399 }))).toThrow(/depth margin/);
    expect(() => projectHingeSurfacePoint({ x: 1, y: 20 }, { x: 0, y: 0 }, 10, 30)).toThrow(/singular/);
    expect(() => prepareHingeSurface({ ...definition(), extra: true } as HingeSurfaceDefinition)).toThrow(/unknown field/);
  });

  it("fails closed at lower command contour vertex subdivision and preparation work budgets", () => {
    expect(() => prepareHingeSurface(definition(square(), { limits: { sourceCommands: 4 } }))).toThrow(/command budget/);
    expect(() => prepareHingeSurface(definition([...square(), ...square()], { limits: { contours: 1 } }))).toThrow(/contour budget/);
    expect(() => prepareHingeSurface(definition(cubic, { limits: { vertices: 4 } }))).toThrow(/vertex budget/);
    expect(() => prepareHingeSurface(definition(cubic, { limits: { subdivisionDepth: 1 } }))).toThrow(/subdivision depth/);
    expect(() => prepareHingeSurface(definition(square(), { limits: { prepareWork: 1 } }))).toThrow(/work budget/);
    expect(() => prepareHingeSurface(definition(square(), { limits: { vertices: HINGE_SURFACE_LIMITS.vertices + 1 } }))).toThrow(/budget is invalid/);
  });

  it("rejects undeclared screen scale sampling work overflow and non-finite or huge sample inputs", () => {
    const surface = prepareHingeSurface(definition());
    expect(() => sampleHingeSurface(surface, 30, 1.01)).toThrow(/screen scale/);
    expect(() => sampleHingeSurface(surface, Infinity)).toThrow(/angle/);
    expect(() => sampleHingeSurface(surface, 1_000_001)).toThrow(/angle/);
    expect(() => sampleHingeSurface(surface, 30, NaN)).toThrow(/screen scale/);
    const limited = prepareHingeSurface(definition(square(), { limits: { sampleWork: 1 } }));
    expect(() => sampleHingeSurface(limited, 30)).toThrow(/sampling work/);
    expect(() => projectHingeSurfacePoint({ x: 100_001, y: 1 }, { x: 0, y: 0 }, 500, 0)).toThrow(/outside bounds/);
    expect(surface.preparation.work).toBeLessThanOrEqual(HINGE_SURFACE_LIMITS.prepareWork);
    expect(sampleHingeSurface(surface, 30).work).toBeLessThanOrEqual(HINGE_SURFACE_LIMITS.sampleWork);
  });
});
