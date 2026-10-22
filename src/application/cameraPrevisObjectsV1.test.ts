import { describe, expect, it } from "vitest";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { assembleCameraPrevisObjectV1 as assemble, CAMERA_PREVIS_OBJECT_CATALOG_V1, type CameraPrevisObjectDescriptorV1 } from "./cameraPrevisObjectsV1";
import { mesh3dObjectMatrixAtV1 } from "../motion/mesh3dRasterizer";
const descriptor: CameraPrevisObjectDescriptorV1 = { id: "a", name: "Authored subject", kind: "house", position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: 1 };
describe("offline semantic 3D blockouts", () => {
  it.each(["house", "car", "person", "dog", "cat"] as const)("assembles %s from actual 3D geometry", kind => {
    const a = assemble({ ...descriptor, kind });
    expect(a.objects.length).toBe(kind === "dog" || kind === "cat" ? 10 : 6);
    expect(new Set(a.partIds).size).toBe(a.objects.length);
    expect(a.objects.every(o => !o.material.clipId && o.geometry.kind !== "text")).toBe(true);
    expect(assemble({ ...descriptor, kind })).toEqual(a);
  });
  it("has four wheels, roof panels, limbs and ears rather than identical boxes", () => {
    expect(assemble({ ...descriptor, kind: "car" }).objects.filter(o => o.geometry.kind === "torus")).toHaveLength(4);
    expect(assemble(descriptor).objects.filter(o => o.pose.rotationDegrees[2] !== 0)).toHaveLength(2);
    expect(assemble({ ...descriptor, kind: "person" }).objects[1].geometry.kind).toBe("sphere");
    expect(assemble({ ...descriptor, kind: "dog" }).objects).not.toEqual(assemble({ ...descriptor, kind: "cat" }).objects);
    expect(CAMERA_PREVIS_OBJECT_CATALOG_V1.defaultAvailable).toBe(false);
  });
  it("composes group XYZ rotation, scale and translation as a true matrix", () => {
    const local = assemble(descriptor), placed = assemble({ ...descriptor, position: [4, 2, -3], rotationDegrees: [23, 47, -19], scale: 1.7 });
    const group = new Matrix4().compose(new Vector3(4, 2, -3), new Quaternion().setFromEuler(new Euler(23 * Math.PI / 180, 47 * Math.PI / 180, -19 * Math.PI / 180, "XYZ")), new Vector3(1.7, 1.7, 1.7));
    local.objects.forEach((o, i) => {
      const expected = group.clone().multiply(mesh3dObjectMatrixAtV1(o, 0)), actual = mesh3dObjectMatrixAtV1(placed.objects[i], 0);
      actual.elements.forEach((v, j) => expect(v).toBeCloseTo(expected.elements[j], 11));
    });
  });
  it("rejects unknown kinds, excessive scales and out-of-world transformed parts", () => {
    for (const patch of [{ kind: "download-anything" }, { scale: 0 }, { scale: [1, 2, 1] }, { position: [100, 100, 100] }]) expect(() => assemble({ ...descriptor, ...patch })).toThrow();
  });
});
