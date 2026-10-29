import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { frameCameraPrevisSubjectV1 as frame, previsCornersV1 } from "./cameraPrevisFramingV1";
import { mesh3dProjection } from "../motion/mesh3dRasterizer";
import type { Mesh3dCamera } from "../motion/mesh3dScene";
const camera: Mesh3dCamera = { position: [3, 2, 6], target: [0, 1, 0], verticalFovDegrees: 42, near: .1, far: 100 };
const bounds = { min: [-.7, 0, -.4] as [number, number, number], max: [.7, 2, .4] as [number, number, number] };
describe("automatic perspective subject framing", () => {
  it.each([16 / 9, 9 / 16, 1, 4])("fits all true 3D corners at aspect %f", aspect => {
    const c = frame(bounds, camera, aspect, { x: -.3, y: -.05, safe: .85 }), matrix = mesh3dProjection(c, aspect);
    for (const point of previsCornersV1(bounds)) {
      const p = new Vector3(...point).applyMatrix4(matrix);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(.85); expect(Math.abs(p.y)).toBeLessThanOrEqual(.85); expect(Math.abs(p.z)).toBeLessThan(1);
    }
    const center = new Vector3(0, 1, 0).applyMatrix4(matrix);
    expect(center.x).toBeCloseTo(-.3, 12); expect(center.y).toBeCloseTo(-.05, 12);
  });
  it("backs the camera away for portrait while retaining FOV", () => {
    const a = frame(bounds, camera, 16 / 9), b = frame(bounds, camera, 9 / 16);
    expect(new Vector3(...b.position).distanceTo(new Vector3(...b.target))).toBeGreaterThan(new Vector3(...a.position).distanceTo(new Vector3(...a.target)));
    expect(b.verticalFovDegrees).toBe(camera.verticalFovDegrees);
  });
  it("refuses impossible far clips and bad aspects", () => {
    expect(() => frame(bounds, { ...camera, far: 2 }, 9 / 16)).toThrow("FAR_CLIP");
    expect(() => frame(bounds, camera, NaN)).toThrow("FRAMING_INVALID");
  });
});
