import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { resolveCameraPrevisLensV1 as resolve, applyCameraPrevisLensV1 as apply, frameCameraPrevisLensV1 as frame } from "./cameraPrevisLensV1";
import { previsCornersV1 } from "./cameraPrevisFramingV1";
import { createEmptyProject } from "../domain/editGraph";
import { assembleCameraPrevisObjectV1 } from "./cameraPrevisObjectsV1";
import { prepareCameraPrevisFrameV1 } from "../render/cameraPrevisFrameV1";
import { renderMesh3dProjectFrameV1 } from "../motion/mesh3dProjectFrameV1";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { mesh3dProjection } from "../motion/mesh3dRasterizer";
import type { Mesh3dCamera } from "../motion/mesh3dScene";

const sensor = { sensorWidthMm: 36, sensorHeightMm: 24 };
const camera: Mesh3dCamera = { position: [4, 2.5, 8], target: [0, 1, 0], verticalFovDegrees: 42, near: .1, far: 100 };
const bounds = { min: [-.7, 0, -.4] as [number, number, number], max: [.7, 2, .4] as [number, number, number] };
type Optics = ReturnType<typeof resolve>;

// Physical rays land on actual centered sensor corners; no renderer or converter formula is copied.
function assertSensorRays(o: Optics) {
  const { lens, activeGate: g, aspect } = o;
  expect(g.widthMm).toBeLessThanOrEqual(lens.sensorWidthMm);
  expect(g.heightMm).toBeLessThanOrEqual(lens.sensorHeightMm);
  expect(g.widthMm === lens.sensorWidthMm || g.heightMm === lens.sensorHeightMm).toBe(true);
  expect(g.widthMm / g.heightMm).toBeCloseTo(aspect, 12);
  const pinhole = new PerspectiveCamera(o.verticalFovDegrees, aspect, .01, 2000);
  for (const x of [-1, 1]) for (const y of [-1, 1]) {
    const p = new Vector3(x * g.widthMm / 2, y * g.heightMm / 2, -lens.focalLengthMm).project(pinhole);
    expect(Math.abs(p.x - x)).toBeLessThan(1e-10);
    expect(Math.abs(p.y - y)).toBeLessThan(1e-10);
  }
  const horizontal = new PerspectiveCamera(o.horizontalFovDegrees, 1, .01, 2000);
  expect(new Vector3(0, g.widthMm / 2, -lens.focalLengthMm).project(horizontal).y).toBeCloseTo(1, 12);
}

describe("physical previs lens, without changing frozen camera semantics", () => {
  it("has the exact known 90 degree pinhole control", () => {
    const o = resolve({ ...sensor, focalLengthMm: 12 }, 1);
    expect(o.activeGate).toEqual({ widthMm: 24, heightMm: 24 });
    expect(o.verticalFovDegrees).toBe(90); expect(o.horizontalFovDegrees).toBe(90);
    assertSensorRays(o);
  });
  it.each([.25, 9 / 16, .69741, 1, 1.42167, 16 / 9, 4].flatMap(aspect => [24, 35, 50, 85].map(focal => ({ aspect, focal }))))(
    "projects physical rays for $focal mm at aspect $aspect", ({ aspect, focal }) => {
      const o = resolve({ ...sensor, focalLengthMm: focal }, aspect); assertSensorRays(o);
      if (o.compatibleWithMeshSceneV1) {
        const c = apply(camera, o.lens, aspect);
        expect(c.verticalFovDegrees).toBe(o.verticalFovDegrees);
      } else expect(() => apply(camera, o.lens, aspect)).toThrow("PREVIS_LENS_FOV_UNSUPPORTED");
    });
  it("rejects the fixed-FOV, uncropped sensor, stretched gate and silently clamped controls", () => {
    const o = resolve({ ...sensor, focalLengthMm: 50 }, 16 / 9);
    expect(() => assertSensorRays({ ...o, verticalFovDegrees: 42 })).toThrow();
    expect(() => assertSensorRays({ ...o, verticalFovDegrees: 26.991466561591622 })).toThrow();
    expect(() => assertSensorRays({ ...o, activeGate: { widthMm: 36, heightMm: 24 } })).toThrow();
    const tele = resolve({ ...sensor, focalLengthMm: 85 }, 16 / 9);
    expect(() => assertSensorRays({ ...tele, verticalFovDegrees: 15 })).toThrow();
  });
  it("distinguishes sensor orientation and never stretches a full frame to match output", () => {
    const landscapeSensor = resolve({ ...sensor, focalLengthMm: 50 }, 9 / 16);
    const portraitSensor = resolve({ sensorWidthMm: 24, sensorHeightMm: 36, focalLengthMm: 50 }, 9 / 16);
    expect(landscapeSensor.activeGate).toEqual({ widthMm: 13.5, heightMm: 24 });
    expect(portraitSensor.activeGate).toEqual({ widthMm: 20.25, heightMm: 36 });
    expect(portraitSensor.verticalFovDegrees).toBeGreaterThan(landscapeSensor.verticalFovDegrees);
    assertSensorRays(landscapeSensor); assertSensorRays(portraitSensor);
  });
  it("reports real 85mm landscape limitations instead of pretending to enable them", () => {
    const lens = { ...sensor, focalLengthMm: 85 }, old = structuredClone(camera);
    expect(resolve(lens, 16 / 9).verticalFovDegrees).toBeCloseTo(13.585861564471855, 10);
    expect(resolve(lens, 16 / 9).compatibleWithMeshSceneV1).toBe(false);
    expect(() => frame(bounds, camera, lens, 16 / 9)).toThrow("PREVIS_LENS_FOV_UNSUPPORTED");
    expect(resolve(lens, 9 / 16).compatibleWithMeshSceneV1).toBe(true);
    expect(camera).toEqual(old);
  });
  it.each([0, -1, NaN, Infinity, .2, 4.1])("refuses bad aspect %f", aspect => {
    expect(() => resolve({ ...sensor, focalLengthMm: 35 }, aspect)).toThrow("PREVIS_LENS_ASPECT_INVALID");
  });
  it.each([
    { ...sensor, focalLengthMm: 0 }, { ...sensor, focalLengthMm: NaN }, { ...sensor, focalLengthMm: Infinity },
    { ...sensor, focalLengthMm: 1001 }, { ...sensor, focalLengthMm: 35, sensorWidthMm: -1 },
    { ...sensor, focalLengthMm: 35, sensorHeightMm: 101 }, { focalLengthMm: 35 },
    { ...sensor, focalLengthMm: 35, distortion: 2 },
  ])("refuses invalid or unsupported optical input %#", lens => { expect(() => resolve(lens, 16 / 9)).toThrow(); });
  it("preserves camera, lens, and framing inputs, and retains canonical admission", () => {
    const lens = { ...sensor, focalLengthMm: 35 }, source = { camera, lens, bounds }, before = structuredClone(source);
    const a = apply(camera, lens, 16 / 9), b = apply(camera, lens, 16 / 9);
    expect(a).toEqual(b); a.position[0] = 99; a.target[0] = 99;
    frame(bounds, camera, lens, 16 / 9);
    expect(source).toEqual(before);
    expect(() => apply({ ...camera, near: 2, far: 2 }, lens, 16 / 9)).toThrow("PREVIS_CAMERA_INVALID");
  });
  it.each([16 / 9, 9 / 16, 1, 4])("fits all subject corners with a physical 24mm lens at aspect %f", aspect => {
    const lens = { ...sensor, focalLengthMm: 24 }, c = frame(bounds, camera, lens, aspect, { x: -.3, y: -.05, safe: .85 });
    expect(c.verticalFovDegrees).toBe(resolve(lens, aspect).verticalFovDegrees);
    const matrix = mesh3dProjection(c, aspect);
    for (const corner of previsCornersV1(bounds)) {
      const p = new Vector3(...corner).applyMatrix4(matrix);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(.85); expect(Math.abs(p.y)).toBeLessThanOrEqual(.85);
      expect(Math.abs(p.z)).toBeLessThan(1);
    }
    const center = new Vector3(0, 1, 0).applyMatrix4(matrix);
    expect(center.x).toBeCloseTo(-.3, 12); expect(center.y).toBeCloseTo(-.05, 12);
  });
  it("feeds the existing prepared frame sampler and canonical CPU renderer without a second lens path", () => {
    const p = createEmptyProject("Lens source test", { width: 160, height: 90, fps: 30 });
    p.scene3d = { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#EFF0F2", gridColor: "#FFFFFF", grid: false, spacing: 72 },
      light: { direction: [1, 1, 1], intensity: .5, ambient: .5 }, segments: [{ id: "s", name: "s", timelineStart: 0, duration: 5,
        camera: structuredClone(camera), cameraKeyframes: [], objects: assembleCameraPrevisObjectV1({ id: "hero", name: "Hero", kind: "person", position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: 1 }).objects }] };
    const before = structuredClone(p), c = apply(camera, { ...sensor, focalLengthMm: 35 }, 16 / 9);
    const binding = { segmentId: "s", camera: c, motion: { kind: "locked" as const }, floorY: 0, radius: .15 };
    const adapter = prepareCameraPrevisFrameV1(p, [binding]);
    const manual = structuredClone(p.scene3d); manual.segments[0].camera = c;
    const expected = renderMesh3dProjectFrameV1(manual, { timelineFrame: 37, fps: 30 }, 160, 90, new Mesh3dGeometryCache());
    const actual = adapter.renderFrame(37, 160, 90);
    expect(actual.rgba).toEqual(expected.rgba); expect(actual.depth).toEqual(expected.depth);
    expect(adapter.cameraAt(37)).toEqual(c); expect(p).toEqual(before);
    const old = renderMesh3dProjectFrameV1(p.scene3d, { timelineFrame: 37, fps: 30 }, 160, 90, new Mesh3dGeometryCache());
    expect(actual.rgba).not.toEqual(old.rgba);
  });
});
