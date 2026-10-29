import { z } from "zod";
import { Euler, Quaternion, Vector3 } from "three";
import { mesh3dObjectSchema, type Mesh3dGeometry, type Mesh3dObject } from "../motion/mesh3dScene";

const finite = z.number().finite();
export const cameraPrevisObjectDescriptorSchemaV1 = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), name: z.string().trim().min(1).max(60),
  kind: z.enum(["house", "car", "person", "dog", "cat"]),
  position: z.tuple([finite.min(-100).max(100), finite.min(-100).max(100), finite.min(-100).max(100)]),
  rotationDegrees: z.tuple([finite.min(-360).max(360), finite.min(-360).max(360), finite.min(-360).max(360)]),
  scale: finite.min(.1).max(4),
});
export type CameraPrevisObjectDescriptorV1 = z.infer<typeof cameraPrevisObjectDescriptorSchemaV1>;
type Part = { geometry: Mesh3dGeometry; position: [number, number, number]; color: string; rotation?: [number, number, number] };
const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string, rz = 0): Part =>
  ({ geometry: { kind: "box", width: w, height: h, depth: d }, position: [x, y, z], color, rotation: [0, 0, rz] });
const sphere = (radius: number, x: number, y: number, z: number, color: string): Part =>
  ({ geometry: { kind: "sphere", radius, segments: 12 }, position: [x, y, z], color });
function parts(kind: CameraPrevisObjectDescriptorV1["kind"]): Part[] {
  if (kind === "house") return [
    box(2, 1.6, 2, 0, .8, 0, "#E0D7C7"), box(1.4, .12, 2.4, -.57, 1.96, 0, "#304C70", 35),
    box(1.4, .12, 2.4, .57, 1.96, 0, "#304C70", -35), box(.4, .85, .08, 0, .425, 1.04, "#725139"),
    box(.45, .45, .08, -.65, 1.05, 1.04, "#4C9CBD"), box(.45, .45, .08, .65, 1.05, 1.04, "#4C9CBD"),
  ];
  if (kind === "car") return [box(2.4, .5, 1.2, 0, .6, 0, "#3D73CE"), box(1.2, .5, 1.05, 0, 1.05, 0, "#79ADBF"),
    ...[-.75, .75].flatMap(x => [-.65, .65].map(z => ({ geometry: { kind: "torus" as const, radius: .24, tube: .08, segments: 12 }, position: [x, .34, z] as [number, number, number], color: "#252A30" })))];
  if (kind === "person") return [box(.42, .55, .24, 0, 1.05, 0, "#486DAC"), sphere(.18, 0, 1.52, 0, "#D9B18E"),
    ...[-.12, .12].map(x => box(.16, .75, .2, x, .375, 0, "#30394A")),
    ...[-.32, .32].map(x => box(.14, .65, .18, x, 1, 0, "#486DAC"))];
  const cat = kind === "cat", fur = cat ? "#BFA782" : "#AF8152", height = cat ? .5 : .65, headX = cat ? .38 : .52;
  return [box(cat ? .7 : .95, .3, .3, 0, height, 0, fur), sphere(cat ? .17 : .21, headX, height + .16, 0, fur),
    box(.2, .12, .17, headX + .15, height + .1, 0, "#493D35"),
    ...[-.27, .27].flatMap(x => [-.11, .11].map(z => box(.09, height - .15, .09, x, (height - .15) / 2, z, fur))),
    box(.09, cat ? .5 : .36, .09, cat ? -.43 : -.57, height + .17, 0, fur, cat ? -20 : -45),
    ...[-.13, .13].map(z => box(.11, cat ? .2 : .27, .08, headX, height + .36, z, fur, cat ? 15 : -20))];
}
/** Technical blockouts only. No catalog/default/VA admission until art review. */
export const CAMERA_PREVIS_OBJECT_CATALOG_V1 = Object.freeze({ certification: "ART_PENDING_CLAUDE", defaultAvailable: false,
  kinds: Object.freeze(["house", "car", "person", "dog", "cat"] as const), source: "local-procedural-primitives" });
export function assembleCameraPrevisObjectV1(input: unknown): { descriptor: CameraPrevisObjectDescriptorV1; objects: Mesh3dObject[]; partIds: string[] } {
  const descriptor = cameraPrevisObjectDescriptorSchemaV1.parse(input), radians = Math.PI / 180;
  const rotation = new Quaternion().setFromEuler(new Euler(...descriptor.rotationDegrees.map(v => v * radians) as [number, number, number], "XYZ"));
  const objects = parts(descriptor.kind).map((part, i) => {
    const p = new Vector3(...part.position).multiplyScalar(descriptor.scale).applyQuaternion(rotation).add(new Vector3(...descriptor.position));
    const local = new Quaternion().setFromEuler(new Euler(...(part.rotation ?? [0, 0, 0]).map(v => v * radians) as [number, number, number], "XYZ"));
    const euler = new Euler().setFromQuaternion(rotation.clone().multiply(local), "XYZ");
    return mesh3dObjectSchema.parse({ id: `pobj:${descriptor.id}:${i}`, name: `${descriptor.name}/${i + 1}`, geometry: part.geometry,
      material: { color: part.color, unlit: false }, pose: { position: p.toArray(), rotationDegrees: [euler.x / radians, euler.y / radians, euler.z / radians], scale: [descriptor.scale, descriptor.scale, descriptor.scale] }, keyframes: [] });
  });
  return { descriptor, objects, partIds: objects.map(o => o.id) };
}
