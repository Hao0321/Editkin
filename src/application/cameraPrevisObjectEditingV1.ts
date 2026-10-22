import { z } from "zod";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { mesh3dSceneSchema, type Mesh3dScene } from "../motion/mesh3dScene";
import { assembleCameraPrevisObjectV1, cameraPrevisObjectDescriptorSchemaV1 } from "./cameraPrevisObjectsV1";

/** Explicit caller-owned draft. Persistence/ordinary Undo integration is not implicit. */
export const cameraPrevisObjectDraftSchemaV1 = z.strictObject({ schema: z.literal("editkin.previs-object-draft/v1"),
  segmentId: z.string().min(1).max(80), objects: z.array(cameraPrevisObjectDescriptorSchemaV1).max(32) });
export type CameraPrevisObjectDraftV1 = z.infer<typeof cameraPrevisObjectDraftSchemaV1>;
const fields = cameraPrevisObjectDescriptorSchemaV1.shape;
const editSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("add"), descriptor: cameraPrevisObjectDescriptorSchemaV1 }),
  z.strictObject({ kind: z.literal("transform"), id: fields.id, position: fields.position, rotationDegrees: fields.rotationDegrees, scale: fields.scale }),
  z.strictObject({ kind: z.literal("duplicate"), id: fields.id, newId: fields.id, name: fields.name, position: fields.position }),
  z.strictObject({ kind: z.literal("delete"), id: fields.id }),
]);
export type CameraPrevisObjectEditV1 = z.infer<typeof editSchema>;
export function planCameraPrevisObjectEditV1(sceneInput: Mesh3dScene, draftInput: CameraPrevisObjectDraftV1, inputEdit: CameraPrevisObjectEditV1) {
  const edit = editSchema.parse(inputEdit);
  const scene = mesh3dSceneSchema.parse(sceneInput), draft = cameraPrevisObjectDraftSchemaV1.parse(draftInput);
  const segment = scene.segments.find(s => s.id === draft.segmentId);
  if (!segment || new Set(draft.objects.map(o => o.id)).size !== draft.objects.length) throw Error("PREVIS_OBJECT_DRAFT_INVALID");
  // Only descriptors explicitly in this draft grant group ownership. Prefixes grant none.
  const previous = draft.objects.flatMap(d => assembleCameraPrevisObjectV1(d).objects), owned = new Set(previous.map(o => o.id));
  if (new Set(segment.objects.map(o => o.id)).size !== segment.objects.length
    || previous.some(o => JSON.stringify(segment.objects.find(live => live.id === o.id)) !== JSON.stringify(o))) throw Error("PREVIS_OBJECT_GROUP_DETACHED");
  let descriptors = draft.objects;
  const source = "id" in edit ? descriptors.find(o => o.id === edit.id) : undefined;
  if (edit.kind !== "add" && !source) throw Error("PREVIS_OBJECT_MISSING");
  if (edit.kind === "add") descriptors = [...descriptors, cameraPrevisObjectDescriptorSchemaV1.parse(edit.descriptor)];
  else if (edit.kind === "delete") descriptors = descriptors.filter(d => d.id !== edit.id);
  else if (edit.kind === "duplicate") descriptors = [...descriptors, cameraPrevisObjectDescriptorSchemaV1.parse({ ...source, id: edit.newId, name: edit.name, position: edit.position })];
  else descriptors = descriptors.map(d => d.id === edit.id ? cameraPrevisObjectDescriptorSchemaV1.parse({ ...d, position: edit.position, rotationDegrees: edit.rotationDegrees, scale: edit.scale }) : d);
  if (new Set(descriptors.map(d => d.id)).size !== descriptors.length) throw Error("PREVIS_OBJECT_ID_CONFLICT");
  const replacements = descriptors.flatMap(d => assembleCameraPrevisObjectV1(d).objects), foreign = segment.objects.filter(o => !owned.has(o.id));
  if (replacements.some(o => foreign.some(f => f.id === o.id))) throw Error("PREVIS_OBJECT_ID_CONFLICT");
  // A single immutable scene replacement; never return a partially applied group.
  segment.objects = [...foreign, ...replacements];
  if (segment.objects.length > 32 || !segment.objects.length) throw Error("PREVIS_OBJECT_BUDGET");
  const cache = new Mesh3dGeometryCache();
  if (segment.objects.reduce((n, o) => n + cache.get(o.geometry).indices.length / 3, 0) > 60_000) throw Error("PREVIS_TRIANGLE_BUDGET");
  return { scene: mesh3dSceneSchema.parse(scene), draft: cameraPrevisObjectDraftSchemaV1.parse({ ...draft, objects: descriptors }),
    selectedId: edit.kind === "delete" ? null : edit.kind === "add" ? edit.descriptor.id : edit.kind === "duplicate" ? edit.newId : edit.id };
}
