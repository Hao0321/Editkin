import { describe, expect, it } from "vitest";
import { layoutOnPath } from "./glyphs";
import { circlePath, ellipsePath, lemniscatePath, placeAlongPath, spiralPath, type FollowPath } from "./pathFollow";

/** Lemniscate constant ϖ: the whole figure-8 with tips at ±a is 2ϖa long. */
const LEMNISCATE_PI = 2.62205755429212;
const near = (a: number, b: number, tolerance: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tolerance);
/** Unit speed: points 0.5 px apart along the path are 0.5 px apart in the plane (arc-length parameterisation). */
function expectUnitSpeed(path: FollowPath, samples = 97): void {
  for (let index = 0; index < samples; index += 1) {
    const d = (path.totalLength * index) / samples, a = path(d), b = path(d + 0.5);
    near(Math.hypot(b.x - a.x, b.y - a.y), 0.5, 0.01);
  }
}

describe("circlePath", () => {
  it("is exact, starts at the top and heads clockwise by default", () => {
    const path = circlePath(500, 400, 100);
    expect(path.totalLength).toBeCloseTo(2 * Math.PI * 100, 9);
    expect(path.closed).toBe(true);
    const top = path(0), right = path(path.totalLength / 4);
    near(top.x, 500, 1e-9); near(top.y, 300, 1e-9); near(top.angle, 0, 1e-9);
    near(right.x, 600, 1e-9); near(right.y, 400, 1e-9); near(right.angle, 90, 1e-9);
    const ccw = circlePath(500, 400, 100, { clockwise: false, startDegrees: 0 });
    near(ccw(0).x, 600, 1e-9); near(ccw(0).angle, -90, 1e-9);
    near(ccw(ccw.totalLength / 4).y, 300, 1e-9);
    expect(() => circlePath(0, 0, 0)).toThrow(/radius/);
  });
});

describe("ellipsePath", () => {
  it("has the ellipse's arc length and unit speed despite a 3:1 aspect", () => {
    const rx = 300, ry = 100, h = ((rx - ry) / (rx + ry)) ** 2;
    const ramanujan = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    const path = ellipsePath(0, 0, rx, ry);
    near(path.totalLength / ramanujan, 1, 1e-4);
    expectUnitSpeed(path);
    near(path(0).x, 0, 1e-9); near(path(0).y, -ry, 1e-9);
    // Wraps: a closed path repeats every totalLength.
    near(path(path.totalLength + 10).x, path(10).x, 1e-9);
  });
  it("rotates about its centre", () => {
    const path = ellipsePath(50, 60, 300, 100, { rotationDegrees: 90 });
    near(path(0).x, 150, 1e-9); near(path(0).y, 60, 1e-9);
    expect(() => ellipsePath(0, 0, 0, 10)).toThrow(/radii/);
    expect(() => ellipsePath(0, 0, 10, 10, { steps: 4 })).toThrow(/steps/);
  });
});

describe("lemniscatePath", () => {
  it("spans ±halfWidth, crosses the centre at a quarter and three quarters, and is 2ϖa long", () => {
    const a = 300, path = lemniscatePath(540, 960, a);
    near(path.totalLength / (2 * LEMNISCATE_PI * a), 1, 1e-4);
    near(path(0).x, 540 + a, 1e-9); near(path(0).y, 960, 1e-9);
    expect(Math.abs(path(0).angle - 90)).toBeLessThan(1.5); // heading down into the right loop
    for (const fraction of [0.25, 0.75]) {
      const crossing = path(fraction * path.totalLength);
      near(crossing.x, 540, 0.5); near(crossing.y, 960, 0.5);
    }
    near(path(path.totalLength / 2).x, 540 - a, 0.5);
    let maxX = 0;
    for (let d = 0; d < path.totalLength; d += 2) maxX = Math.max(maxX, Math.abs(path(d).x - 540));
    near(maxX, a, 1e-6);
    expectUnitSpeed(path);
  });
  it("can start at the crossing, heading up-right", () => {
    const path = lemniscatePath(0, 0, 200, { start: "center" });
    near(path(0).x, 0, 1e-9); near(path(0).y, 0, 1e-9);
    near(path(0).angle, -45, 0.5);
    const tilted = lemniscatePath(0, 0, 200, { rotationDegrees: 90 });
    near(tilted(0).x, 0, 1e-9); near(tilted(0).y, 200, 1e-9);
  });
});

describe("spiralPath", () => {
  const numericLength = (inner: number, outer: number, turns: number) => {
    const sweep = 2 * Math.PI * turns, k = (outer - inner) / sweep, steps = 200_000;
    let length = 0;
    for (let index = 0; index < steps; index += 1) {
      const theta = ((index + 0.5) / steps) * sweep;
      length += Math.hypot(inner + k * theta, k) * (sweep / steps);
    }
    return length;
  };
  it("runs from the outer end inward by default with the Archimedean arc length", () => {
    const path = spiralPath(0, 0, { innerRadius: 40, outerRadius: 400, turns: 3 });
    expect(path.closed).toBe(false);
    near(path.totalLength / numericLength(40, 400, 3), 1, 2e-4);
    near(path(0).x, 400, 1e-9); near(path(0).y, 0, 1e-9);
    const end = path(path.totalLength);
    near(Math.hypot(end.x, end.y), 40, 1e-6);
    expect(path(5).y).toBeLessThan(0); // clockwise outward means the angle falls going inward
    expectUnitSpeed(path, 41);
  });
  it("supports arms, the inner start and counter-clockwise winding", () => {
    const arm2 = spiralPath(0, 0, { innerRadius: 0, outerRadius: 100, turns: 1, arms: 4, arm: 1, startDegrees: 0 });
    near(arm2(0).x, 0, 1e-9); near(arm2(0).y, 100, 1e-9);
    const inward = spiralPath(0, 0, { innerRadius: 10, outerRadius: 100, turns: 2, from: "inner" });
    near(Math.hypot(inward(0).x, inward(0).y), 10, 1e-9);
    near(Math.hypot(inward(inward.totalLength).x, inward(inward.totalLength).y), 100, 1e-6);
    const ccw = spiralPath(0, 0, { innerRadius: 10, outerRadius: 100, turns: 2, clockwise: false });
    expect(ccw(5).y).toBeGreaterThan(0);
    expect(() => spiralPath(0, 0, { innerRadius: 50, outerRadius: 40, turns: 1 })).toThrow(/innerRadius/);
    expect(() => spiralPath(0, 0, { innerRadius: 0, outerRadius: 40, turns: 1, arms: 2, arm: 2 })).toThrow(/arm/);
  });
});

describe("placeAlongPath", () => {
  it("spaces items evenly over a closed path, with phase and train spacing", () => {
    const path = circlePath(0, 0, 100);
    const four = placeAlongPath(path, 4);
    [[0, -100], [100, 0], [0, 100], [-100, 0]].forEach(([x, y], index) => { near(four[index].x, x, 1e-9); near(four[index].y, y, 1e-9); });
    expect(four.map(item => item.index)).toEqual([0, 1, 2, 3]);
    const shifted = placeAlongPath(path, 4, { phase: 0.25 });
    near(shifted[0].x, 100, 1e-9);
    const train = placeAlongPath(path, 3, { spacing: -10, offset: 5 });
    expect(train.map(item => Number(item.distance.toFixed(6)))).toEqual([5, Number((path.totalLength - 5).toFixed(6)), Number((path.totalLength - 15).toFixed(6))]);
    expect(placeAlongPath(path, 0)).toEqual([]);
    expect(() => placeAlongPath(path, -1)).toThrow(/count/);
  });
  it("wraps open paths so items respawn at the start (and can extend instead)", () => {
    const path = spiralPath(0, 0, { innerRadius: 10, outerRadius: 100, turns: 1 });
    const [wrapped] = placeAlongPath(path, 1, { offset: path.totalLength + 5 });
    near(wrapped.distance, 5, 1e-9);
    const [extended] = placeAlongPath(path, 1, { offset: path.totalLength + 5, wrap: false });
    expect(extended.distance).toBeCloseTo(path.totalLength + 5, 9);
  });
  it("plugs into layoutOnPath as a sampler", () => {
    const path = circlePath(300, 300, 200);
    const laid = layoutOnPath("出發", { font: "display", size: 60, startOffset: 0, align: "center" }, path);
    expect(laid.glyphs).toHaveLength(2);
    for (const glyph of laid.glyphs) near(Math.hypot(glyph.x - 300, glyph.y - 300), 200, 1e-9);
  });
});
