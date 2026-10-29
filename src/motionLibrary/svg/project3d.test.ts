import { describe, expect, it } from "vitest";
import { depthFade, depthSort, focalForFov, project, projectPolygon, rotateX, rotateY, rotateZ, signedArea, vec3 } from "./project3d";

describe("project3d", () => {
  const camera = { focal: 1000, cx: 540, cy: 960 };
  it("projects with a perspective divide from a camera at z=0 looking toward -z", () => {
    const point = project(vec3(100, -50, -1000), camera);
    expect(point).toMatchObject({ x: 640, y: 910, scale: 1, depth: 1000, visible: true });
    const far = project(vec3(100, 0, -2000), camera);
    expect(far.x).toBe(590);
    expect(far.scale).toBe(0.5);
    expect(project(vec3(0, 0, 0.5), camera).visible).toBe(false);
    expect(project(vec3(0, 0, -100), { ...camera, z: -200 }).visible).toBe(false);
    expect(focalForFov(90, 1000)).toBeCloseTo(500, 9);
  });
  it("rotates about each axis", () => {
    const right = vec3(1, 0, 0);
    const z = rotateZ(right, 90), y = rotateY(right, 90), x = rotateX(vec3(0, 1, 0), 90);
    expect([z.x, z.y, z.z].map(value => Number(value.toFixed(9)) + 0)).toEqual([0, 1, 0]);
    expect([y.x, y.y, y.z].map(value => Number(value.toFixed(9)) + 0)).toEqual([0, 0, -1]);
    expect([x.x, x.y, x.z].map(value => Number(value.toFixed(9)) + 0)).toEqual([0, 0, 1]);
  });
  it("painter-sorts far to near, stably", () => {
    const items = [{ id: "a", z: 5 }, { id: "b", z: 9 }, { id: "c", z: 5 }, { id: "d", z: 1 }];
    expect(depthSort(items, item => item.z).map(item => item.id)).toEqual(["b", "a", "c", "d"]);
  });
  it("clips polygons against the near plane", () => {
    const crossing = projectPolygon([vec3(-100, -100, -500), vec3(100, -100, -500), vec3(100, 100, 10), vec3(-100, 100, 10)], camera);
    expect(crossing.visible).toBe(true);
    expect(crossing.points.length).toBe(4);
    expect(projectPolygon([vec3(0, 0, 5), vec3(1, 0, 5), vec3(0, 1, 5)], camera).visible).toBe(false);
    expect(depthFade(5, 10, 20)).toBe(1);
    expect(depthFade(15, 10, 20)).toBe(0.5);
    expect(signedArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(100);
  });
});
