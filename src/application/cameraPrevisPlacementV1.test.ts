import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { mesh3dProjection } from "../motion/mesh3dRasterizer";
import type { Mesh3dScene } from "../motion/mesh3dScene";
import { assembleCameraPrevisObjectV1, type CameraPrevisObjectDescriptorV1 } from "./cameraPrevisObjectsV1";
import { prepareCameraPrevisPlacementV1 as prepare } from "./cameraPrevisPlacementV1";
import type { CameraPrevisObjectDraftV1 } from "./cameraPrevisObjectEditingV1";
function fixture() {
  const descriptor: CameraPrevisObjectDescriptorV1 = { id: "hero", name: "Hero", kind: "person", position: [0, 0, 0], rotationDegrees: [0, 20, 0], scale: 1 };
  const draft: CameraPrevisObjectDraftV1 = { schema: "editkin.previs-object-draft/v1", segmentId: "s", objects: [descriptor] };
  const camera = { position: [3, 3, 6] as [number, number, number], target: [0, 1, 0] as [number, number, number], verticalFovDegrees: 45, near: .1, far: 50 };
  const scene: Mesh3dScene = { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#FFFFFF", gridColor: "#FFFFFF", grid: false, spacing: 72 }, light: { direction: [1, 1, 1], ambient: .5, intensity: .5 },
    segments: [{ id: "s", name: "s", timelineStart: 0, duration: 5, camera, cameraKeyframes: [], objects: assembleCameraPrevisObjectV1(descriptor).objects }] };
  return { scene, draft, camera };
}
function screen(point: [number, number, number], camera: ReturnType<typeof fixture>["camera"], aspect: number) {
  const p = new Vector3(...point).applyMatrix4(mesh3dProjection(camera, aspect)); return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
}
describe("semantic object placement using canonical projection/rays", () => {
  it.each([16 / 9, 9 / 16, 1])("recovers projected ground at aspect %f", aspect => {
    const f = fixture(), placement = prepare(f.scene, f.draft, f.camera, aspect, 0);
    for (const p of [[0, 0, 0], [.5, 0, .5], [-.5, 0, -.2]] as [number, number, number][]) {
      placement.ground(screen(p, f.camera, aspect)).forEach((n, i) => expect(n).toBeCloseTo(p[i], 10));
    }
  });
  it("picks the visible grouped body and blocks selection through an unowned occluder", () => {
    const f = fixture(), p = screen([0, 1.05, 0], f.camera, 16 / 9);
    expect(prepare(f.scene, f.draft, f.camera, 16 / 9, 0).pick(p)).toBe("hero");
    const wall = structuredClone(f.scene.segments[0].objects[0]); wall.id = "wall"; wall.geometry = { kind: "box", width: 3, height: 3, depth: .2 }; wall.pose.position = [0, 1.5, 1]; wall.pose.rotationDegrees = [0, 0, 0]; f.scene.segments[0].objects.push(wall);
    expect(prepare(f.scene, f.draft, f.camera, 16 / 9, 0).pick(p)).toBe(null);
  });
  it("retains grab offset and places all parts without accumulating deltas", () => {
    const f = fixture(), before = structuredClone(f), placement = prepare(f.scene, f.draft, f.camera, 16 / 9, 0);
    const start = screen([.2, 0, .1], f.camera, 16 / 9), to = screen([1.2, 0, -.4], f.camera, 16 / 9);
    placement.move("hero", start, screen([.7, 0, 0], f.camera, 16 / 9));
    const plan = placement.move("hero", start, to), d = plan.draft.objects[0];
    expect(d.position[0]).toBeCloseTo(1, 10); expect(d.position[2]).toBeCloseTo(-.5, 10);
    expect(d.rotationDegrees).toEqual(f.draft.objects[0].rotationDegrees); expect(plan.scene.segments[0].objects).toEqual(assembleCameraPrevisObjectV1(d).objects); expect(f).toEqual(before);
  });
  it("samples an animated unowned occluder at the supplied local clock", () => {
    const f = fixture(), wall = structuredClone(f.scene.segments[0].objects[0]), p = screen([0, 1.05, 0], f.camera, 16 / 9);
    wall.id = "moving-wall"; wall.geometry = { kind: "box", width: 3, height: 3, depth: .2 }; wall.pose.position = [6, 1.5, 1]; wall.pose.rotationDegrees = [0, 0, 0];
    wall.keyframes = [{ time: 5, easing: "linear", pose: { ...structuredClone(wall.pose), position: [0, 1.5, 1] } }]; f.scene.segments[0].objects.push(wall);
    expect(prepare(f.scene, f.draft, f.camera, 16 / 9, 0, 0).pick(p)).toBe("hero");
    expect(prepare(f.scene, f.draft, f.camera, 16 / 9, 0, 5).pick(p)).toBe(null);
  });
  it("refuses stale groups, missing objects, invalid pointers and sky rays", () => {
    const f = fixture(), p = prepare(f.scene, f.draft, f.camera, 16 / 9, 0);
    expect(() => p.pick({ x: NaN, y: .5 })).toThrow("POINTER_INVALID");
    expect(() => p.move("missing", { x: .5, y: .5 }, { x: .6, y: .5 })).toThrow("OBJECT_MISSING");
    expect(() => p.ground({ x: .5, y: 0 })).toThrow("GROUND_NOT_VISIBLE");
    f.scene.segments[0].objects[0].pose.position[0] = 2;
    expect(() => prepare(f.scene, f.draft, f.camera, 16 / 9, 0)).toThrow("GROUP_DETACHED");
  });
});
