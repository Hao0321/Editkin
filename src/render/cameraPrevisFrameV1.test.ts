import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { createEmptyProject } from "../domain/editGraph";
import { assembleCameraPrevisObjectV1 } from "../application/cameraPrevisObjectsV1";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { mesh3dObjectMatrixAtV1 } from "../motion/mesh3dRasterizer";
import { renderMesh3dProjectFrameV1 } from "../motion/mesh3dProjectFrameV1";
import { cameraPrevisObjectBoundsV1 } from "../motion/cameraPrevisBoundsV1";
import { prepareCameraPrevisFrameV1 as prepare } from "./cameraPrevisFrameV1";
function fixture() {
  const project = createEmptyProject("Previs test");
  project.scene3d = { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#EFF0F2", gridColor: "#FFFFFF", grid: false, spacing: 72 }, light: { direction: [1, 1, 1], intensity: .5, ambient: .5 },
    segments: [{ id: "s", name: "s", timelineStart: 0, duration: 5, camera: { position: [0, 2, 5], target: [0, 1, 0], verticalFovDegrees: 42, near: .1, far: 50 }, cameraKeyframes: [],
      objects: assembleCameraPrevisObjectV1({ id: "hero", name: "Hero", kind: "person", position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: 1 }).objects }] };
  return project;
}
const binding = { segmentId: "s", motion: { kind: "orbit" as const, degrees: 65, easing: "smooth" as const }, floorY: 0, radius: .15 };
describe("prepared previs frame adapter with canonical real renderer", () => {
  it("matches manual camera overrides exactly and changes pixels during a real orbit", () => {
    const p = fixture(), original = structuredClone(p), adapter = prepare(p, [binding]), hashes: string[] = [];
    for (const frame of [0, 23, 75, 127, 149, 23]) {
      const manual = structuredClone(p.scene3d!); manual.segments[0].camera = adapter.cameraAt(frame)!; manual.segments[0].cameraKeyframes = [];
      const actual = adapter.renderFrame(frame, 160, 90), expected = renderMesh3dProjectFrameV1(manual, { timelineFrame: frame, fps: p.fps }, 160, 90, new Mesh3dGeometryCache());
      expect(actual.rgba).toEqual(expected.rgba); expect(actual.depth).toEqual(expected.depth);
      hashes.push(Buffer.from(actual.rgba).toString("base64"));
    }
    expect(new Set(hashes).size).toBe(5); expect(p).toEqual(original);
    p.scene3d!.segments[0].objects[0].pose.position[0] = 90;
    expect(Buffer.from(adapter.renderFrame(23, 160, 90).rgba).toString("base64")).toBe(hashes[1]);
  });
  it("follows actual smooth legacy translation of every grouped part", () => {
    const p = fixture(), objects = p.scene3d!.segments[0].objects;
    for (const o of objects) o.keyframes = [{ time: 5, easing: "smooth", pose: { ...structuredClone(o.pose), position: [o.pose.position[0] + 2, o.pose.position[1], o.pose.position[2]] } }];
    const adapter = prepare(p, [{ ...binding, motion: { kind: "follow", objectId: objects[0].id }, followGroupIds: objects.map(o => o.id) }]);
    expect(adapter.cameraAt(75)!.position[0]).toBe(1); expect(adapter.cameraAt(75)!.target[0]).toBe(1);
    objects[1].keyframes[0].pose.position[0] += .1;
    expect(() => prepare(p, [{ ...binding, motion: { kind: "follow", objectId: objects[0].id }, followGroupIds: objects.map(o => o.id) }])).toThrow("TRACK_MISMATCH");
  });
  it("bounds rotated/scaled/translated animation throughout its intervals", () => {
    const object = fixture().scene3d!.segments[0].objects[0];
    object.keyframes = [{ time: 5, easing: "smooth", pose: { position: [2, 3, 1], rotationDegrees: [70, 130, -90], scale: [2, .5, 1.2] } }];
    const cache = new Mesh3dGeometryCache(), bounds = cameraPrevisObjectBoundsV1(object, cache), mesh = cache.get(object.geometry);
    for (let t = 0; t <= 5; t += .25) for (let i = 0; i < mesh.positions.length; i += 3) {
      const v = new Vector3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyMatrix4(mesh3dObjectMatrixAtV1(object, t));
      for (let j = 0; j < 3; j++) { expect(v.getComponent(j)).toBeGreaterThanOrEqual(bounds.min[j] - 1e-6); expect(v.getComponent(j)).toBeLessThanOrEqual(bounds.max[j] + 1e-6); }
    }
  });
  it("preserves real project admission and rejects invalid clocks and missing bindings", () => {
    const p = fixture(), a = prepare(p, [binding]);
    for (const frame of [-1, .5, NaN, 150]) expect(() => a.renderFrame(frame, 96, 54)).toThrow();
    expect(() => prepare(p, [{ ...binding, segmentId: "absent" }])).toThrow("SEGMENT_MISSING");
    expect(() => prepare(p, [binding, binding])).toThrow("DUPLICATE");
    p.colorManagement = { mode: "aces2" } as typeof p.colorManagement;
    expect(() => prepare(p, [binding])).toThrow("ACES");
  });
});
