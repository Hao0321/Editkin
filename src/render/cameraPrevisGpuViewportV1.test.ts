import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { assembleCameraPrevisObjectV1 } from "../application/cameraPrevisObjectsV1";
import { createCameraPrevisGpuViewportV1 } from "./cameraPrevisGpuViewportV1";
function fixture() {
  const p = createEmptyProject("GPU", { width: 1280, height: 720 });
  p.scene3d = { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#FFFFFF", gridColor: "#AAAAAA", spacing: 72, grid: false }, light: { direction: [1, 1, 1], ambient: .5, intensity: .5 },
    segments: [{ id: "s", name: "s", timelineStart: 0, duration: 5, camera: { position: [0, 2, 6], target: [0, 1, 0], verticalFovDegrees: 45, near: .1, far: 50 }, cameraKeyframes: [],
      objects: assembleCameraPrevisObjectV1({ id: "hero", name: "Hero", kind: "person", position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: 1 }).objects }] };
  return p;
}
const binding = { segmentId: "s", motion: { kind: "locked" as const }, floorY: 0, radius: .15 };
describe("GPU preview admission preserves features", () => {
  it("reports unavailable WebGL explicitly instead of reporting a rendered frame", () => {
    expect(() => createCameraPrevisGpuViewportV1({ getContext: () => null } as unknown as HTMLCanvasElement, fixture(), [binding])).toThrow("GPU_UNAVAILABLE");
  });
  it.each(["background", "material"] as const)("refuses unsupported %s grids before context acquisition", kind => {
    const p = fixture(); if (kind === "background") p.scene3d!.background.grid = true; else p.scene3d!.segments[0].objects[0].material.grid = true;
    expect(() => createCameraPrevisGpuViewportV1(null as unknown as HTMLCanvasElement, p, [binding])).toThrow("UNSUPPORTED_LAYER");
  });
  it("enforces dimensions before acquiring WebGL or allocating targets", () => {
    expect(() => createCameraPrevisGpuViewportV1(null as unknown as HTMLCanvasElement, fixture(), [binding], 4000, 4000)).toThrow("SIZE_INVALID");
  });
});
