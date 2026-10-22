import { z } from "zod";

const id = z.string().trim().min(1).max(160);
const coordinate = z.number().finite().min(-100).max(100);
const offset = z.number().finite().min(-2).max(2);
const size = z.number().finite().min(.001).max(2);
const unit = z.number().finite().min(0).max(1);

/** Optional saved bindings. Pixels come from existing imported image/video clips. */
export const mesh3dOverlaysV1Schema = z.strictObject({
  schema: z.literal("editkin.mesh-overlays/v1"),
  anchors: z.array(z.strictObject({
    id, segmentId: id.max(80), objectId: id.max(80),
    localPoint: z.tuple([coordinate, coordinate, coordinate]),
  })).min(1).max(128),
  layers: z.array(z.strictObject({
    id, anchorId: id, clipId: id,
    size: z.tuple([size, size]), offset: z.tuple([offset, offset]), pivot: z.tuple([unit, unit]),
    opacity: unit,
    occlusion: z.enum(["depth_test", "hide_with_anchor", "always_front"]),
  })).min(1).max(128),
});
export type Mesh3dOverlaysV1 = z.infer<typeof mesh3dOverlaysV1Schema>;

export function mesh3dOverlayClipIdsV1(bindings: Mesh3dOverlaysV1 | undefined, segmentId: string): string[] {
  if (!bindings) return [];
  const anchors = new Set(bindings.anchors.filter(a => a.segmentId === segmentId).map(a => a.id));
  return [...new Set(bindings.layers.filter(l => anchors.has(l.anchorId)).map(l => l.clipId))];
}
