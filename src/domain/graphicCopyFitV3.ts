import { z } from "zod";

export const graphicCopyFitV3Schema = z.strictObject({
  schema: z.literal("editkin.graphic-copy-fit/v3"),
  /** Caller supplies the permitted sizes; this engine chooses no new visual floor. */
  fontScales: z.array(z.number().finite().min(.25).max(1)).min(2).max(8)
    .refine(scales => scales[0] === 1 && scales.every((scale, index) => index === 0 || scale < scales[index - 1]), "字級倍率須從 1 開始且依序遞減。"),
  /** The caller declares both eligibility and omission order. Primary copy is never omitted. */
  secondaryFields: z.array(z.enum(["subtitle", "kicker", "item_details"])).max(3)
    .refine(fields => new Set(fields).size === fields.length, "次要文案欄位不能重複。"),
});
export type GraphicCopyFitV3 = z.infer<typeof graphicCopyFitV3Schema>;
export const GRAPHIC_COPY_FIT_V3_CONTRACT = {
  schema: "editkin.graphic-copy-fit/v3", certification: "ART_PENDING_CLAUDE", defaultSelection: false,
  order: "exhaust_caller_scales_then_omit_caller_secondary_fields", primaryCopy: "complete_unchanged",
  sourceClocks: "unchanged", readingFloors: "unchanged", physicalGlyphs: "required",
  failures: "font_source_generation_cancellation_and_non_copy_errors_propagate",
} as const;
