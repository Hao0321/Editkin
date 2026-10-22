import * as z from "zod/v4";
import { MAX_UNIFIED_LAYER_COUNT_V1 } from "./unifiedLayerOrderV1";

const id = z.string().min(1).max(512).refine(value => value.trim() === value && !value.includes("\0"), "UNIFIED_LAYER_IDENTITY_INVALID");
export const unifiedLayerOrderV1Schema = z.strictObject({
  schema: z.literal("editkin.unified-layer-order/v1"),
  layers: z.array(z.strictObject({ kind: z.enum(["clip", "caption", "graphic"]), id })).max(MAX_UNIFIED_LAYER_COUNT_V1)
    .refine(refs => new Set(refs.map(ref => `${ref.kind}\0${ref.id}`)).size === refs.length, "UNIFIED_LAYER_ORDER_DUPLICATE"),
});
export const unifiedLayerOrderExpectedV1Schema = z.strictObject({
  projectId: id, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), updatedAt: z.string().min(1).max(64),
});
