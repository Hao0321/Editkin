import { describe, expect, it } from "vitest";
import { mesh3dSceneSchema, type Mesh3dScene } from "../motion/mesh3dScene";
import { assembleCameraPrevisObjectV1, type CameraPrevisObjectDescriptorV1 } from "./cameraPrevisObjectsV1";
import { planCameraPrevisObjectEditV1 as edit, type CameraPrevisObjectDraftV1 } from "./cameraPrevisObjectEditingV1";
const object: CameraPrevisObjectDescriptorV1 = { id: "hero", name: "Hero", kind: "person", position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: 1 };
function fixture() {
  const scene: Mesh3dScene = { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#FFFFFF", gridColor: "#FFFFFF", grid: false, spacing: 72 }, light: { direction: [1, 1, 1], intensity: .5, ambient: .5 },
    segments: [{ id: "s", name: "s", timelineStart: 0, duration: 5, camera: { position: [0, 2, 6], target: [0, 1, 0], verticalFovDegrees: 45, near: .1, far: 50 }, cameraKeyframes: [],
      objects: [{ ...assembleCameraPrevisObjectV1({ ...object, id: "foreign" }).objects[0], id: "unowned" }] }] };
  const draft: CameraPrevisObjectDraftV1 = { schema: "editkin.previs-object-draft/v1", segmentId: "s", objects: [] };
  return { scene, draft };
}
describe("atomic semantic object edit plans", () => {
  it("adds, moves/rotates/scales, duplicates and deletes whole groups without touching input", () => {
    const f = fixture(), original = structuredClone(f), a = edit(f.scene, f.draft, { kind: "add", descriptor: object });
    const b = edit(a.scene, a.draft, { kind: "transform", id: "hero", position: [3, 0, 1], rotationDegrees: [0, 40, 0], scale: .8 });
    expect(b.scene.segments[0].objects.slice(1)).toEqual(assembleCameraPrevisObjectV1(b.draft.objects[0]).objects);
    const c = edit(b.scene, b.draft, { kind: "duplicate", id: "hero", newId: "copy", name: "Second", position: [-2, 0, 0] });
    expect(c.scene.segments[0].objects).toHaveLength(13); expect(c.selectedId).toBe("copy");
    const d = edit(c.scene, c.draft, { kind: "delete", id: "hero" });
    expect(d.scene.segments[0].objects).toHaveLength(7); expect(d.scene.segments[0].objects[0]).toEqual(f.scene.segments[0].objects[0]);
    expect(f).toEqual(original); expect(mesh3dSceneSchema.safeParse(d.scene).success).toBe(true);
  });
  it("refuses stale/individually modified or animated group parts", () => {
    const f = fixture(), a = edit(f.scene, f.draft, { kind: "add", descriptor: object });
    a.scene.segments[0].objects[1].pose.position[0] += 1;
    expect(() => edit(a.scene, a.draft, { kind: "delete", id: "hero" })).toThrow("GROUP_DETACHED");
    expect(() => edit(f.scene, f.draft, { kind: "delete", id: "unowned" })).toThrow("OBJECT_MISSING");
  });
  it("refuses ID collisions and over-budget groups atomically", () => {
    const f = fixture(); let a = edit(f.scene, f.draft, { kind: "add", descriptor: object });
    expect(() => edit(a.scene, a.draft, { kind: "add", descriptor: object })).toThrow("ID_CONFLICT");
    for (let i = 0; i < 4; i++) a = edit(a.scene, a.draft, { kind: "add", descriptor: { ...object, id: `p${i}` } });
    const before = structuredClone(a);
    expect(() => edit(a.scene, a.draft, { kind: "add", descriptor: { ...object, id: "overflow" } })).toThrow("OBJECT_BUDGET");
    expect(a).toEqual(before);
  });
});
