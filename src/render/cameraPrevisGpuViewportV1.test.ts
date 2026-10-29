import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { assembleCameraPrevisObjectV1 } from "../application/cameraPrevisObjectsV1";
import { createCameraPrevisGpuViewportV1 } from "./cameraPrevisGpuViewportV1";
import { cameraPrevisGpuRefusalV1 } from "./cameraPrevisGpuProgramV1";
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
  it.each([
    ["text_extrude", (p: ReturnType<typeof fixture>) => { p.scene3d!.segments[0].objects[0].geometry = { kind: "text_extrude", text: "YOU", font: "display", weight: 900, size: .8, depth: .2, bevelSize: .02, bevelThickness: .03, bevelSegments: 2, tracking: 0 }; }],
    ["band_text", (p: ReturnType<typeof fixture>) => { p.scene3d!.segments[0].objects[0].geometry = { kind: "band_text", text: "SOMEONE", font: "latin", weight: 400, form: "cylinder", facing: "outside", radius: .9, height: .25, segments: 48, repeat: 2, tracking: .05 }; }],
    ["an extended material", (p: ReturnType<typeof fixture>) => { p.scene3d!.segments[0].objects[0].material.wireframe = { color: "#00FFAA", width: 1, divisions: [4, 4], fill: false }; }],
    ["an extended scene", (p: ReturnType<typeof fixture>) => { p.scene3d!.light.hemisphere = { sky: "#FFFFFF", ground: "#202020", intensity: .5 }; }],
    ["scene post", (p: ReturnType<typeof fixture>) => { p.scene3d!.post = { vignette: { strength: .3, softness: .5 } }; }],
  ] as const)("refuses %s instead of drawing it flat", (_kind, mutate) => {
    const p = fixture(); mutate(p);
    expect(() => createCameraPrevisGpuViewportV1(null as unknown as HTMLCanvasElement, p, [binding])).toThrow("UNSUPPORTED_LAYER");
  });
  type P = ReturnType<typeof fixture>;
  const first = (p: P) => p.scene3d!.segments[0].objects[0];
  it.each([
    ["light.shadow", (p: P) => { p.scene3d!.light.shadow = { strength: .7, softness: 2 }; }, "light.shadow"],
    ["light.size", (p: P) => { p.scene3d!.light.size = 6; }, "light.size"],
    ["light.distance", (p: P) => { p.scene3d!.light.distance = 8; }, "light.distance"],
    ["post.ao", (p: P) => { p.scene3d!.post = { ao: { strength: .6, radius: .3 } }; }, "post.ao"],
    ["material.roughness", (p: P) => { first(p).material.roughness = .3; }, "material.roughness"],
    ["a texture with alpha and mipmaps", (p: P) => { first(p).material.clipId = "clip"; first(p).material.texture = { filter: "mipmap", alpha: true }; }, "material.clipId"],
    ["material.gridStyle", (p: P) => { first(p).material.grid = true; first(p).material.gridStyle = { cells: 8, lineWidthPx: 1 }; }, "material.grid"],
    ["material.castShadow", (p: P) => { first(p).material.castShadow = false; }, "material.castShadow"],
    ["material.receiveShadow", (p: P) => { first(p).material.receiveShadow = true; }, "material.receiveShadow"],
    ["camera.roll", (p: P) => { p.scene3d!.segments[0].camera.roll = 5; }, "camera.roll"],
    ["camera.roll on a keyframe", (p: P) => { const s = p.scene3d!.segments[0]; s.cameraKeyframes = [{ time: 2, camera: { ...s.camera, roll: -8 }, easing: "smooth" }]; }, "camera.roll"],
    ["box uvMode front", (p: P) => { first(p).geometry = { kind: "box", width: .5, height: .5, depth: .5, uvMode: "front" }; }, "geometry.uvMode"],
    ["box uvMode atlas", (p: P) => { first(p).geometry = { kind: "box", width: .5, height: .5, depth: .5, uvMode: "atlas" }; }, "geometry.uvMode"],
    ["rounded_box uvMode front", (p: P) => { first(p).geometry = { kind: "rounded_box", width: .5, height: .5, depth: .5, radius: .05, segments: 2, uvMode: "front" }; }, "geometry.uvMode"],
    ["torus tubeSegments 16", (p: P) => { first(p).geometry = { kind: "torus", radius: .5, tube: .1, segments: 24, tubeSegments: 16 }; }, "geometry.tubeSegments"],
    // tube_set (2026-10-29): growth, reveal windows and tips change its mesh per frame; the GPU program uploads one mesh per spec.
    ["tube_set", (p: P) => { first(p).geometry = { kind: "tube_set", polylines: [{ points: [[0, 0, 0], [0, 1, 0], [.4, 1.4, 0]], radius: .05 }] }; }, "geometry.tube_set"],
  ] as const)("refuses polish field %s before acquiring WebGL", (_field, mutate, reason) => {
    const p = fixture(); mutate(p);
    expect(() => createCameraPrevisGpuViewportV1(null as unknown as HTMLCanvasElement, p, [binding])).toThrow(`PREVIS_GPU_UNSUPPORTED_LAYER_REQUIRES_CPU: ${reason}`);
  });
  it("refuses a rolled previs binding camera and a rolled drawn camera", () => {
    const p = fixture(), camera = { ...p.scene3d!.segments[0].camera, roll: 3 };
    expect(() => createCameraPrevisGpuViewportV1(null as unknown as HTMLCanvasElement, p, [{ ...binding, camera }])).toThrow("UNSUPPORTED_LAYER_REQUIRES_CPU: camera.roll");
    expect(cameraPrevisGpuRefusalV1(p.scene3d!)).toBeUndefined();
    expect(cameraPrevisGpuRefusalV1(p.scene3d!, [camera])).toBe("camera.roll");
  });
  it.each([
    ["tubeSegments 8", (p: P) => { first(p).geometry = { kind: "torus", radius: .5, tube: .1, segments: 24, tubeSegments: 8 }; }],
    ["roll 0", (p: P) => { p.scene3d!.segments[0].camera.roll = 0; }],
    ["box uvMode repeat", (p: P) => { first(p).geometry = { kind: "box", width: .5, height: .5, depth: .5, uvMode: "repeat" }; }],
    ["rounded_box uvMode planar", (p: P) => { first(p).geometry = { kind: "rounded_box", width: .5, height: .5, depth: .5, radius: .05, segments: 2, uvMode: "planar" }; }],
  ] as const)("admits %s (drawn exactly as the default)", (_field, mutate) => {
    const p = fixture(); mutate(p);
    expect(cameraPrevisGpuRefusalV1(p.scene3d!)).toBeUndefined();
    expect(() => createCameraPrevisGpuViewportV1({ getContext: () => null } as unknown as HTMLCanvasElement, p, [binding])).toThrow("GPU_UNAVAILABLE");
  });
  it("still admits plain lit solids of the new kinds (same per-vertex path as the CPU)", () => {
    const p = fixture(); p.scene3d!.segments[0].objects[0].geometry = { kind: "cone", radius: .4, height: 1, segments: 24 };
    expect(() => createCameraPrevisGpuViewportV1({ getContext: () => null } as unknown as HTMLCanvasElement, p, [binding])).toThrow("GPU_UNAVAILABLE");
  });
  it("enforces dimensions before acquiring WebGL or allocating targets", () => {
    expect(() => createCameraPrevisGpuViewportV1(null as unknown as HTMLCanvasElement, fixture(), [binding], 4000, 4000)).toThrow("SIZE_INVALID");
  });
});
