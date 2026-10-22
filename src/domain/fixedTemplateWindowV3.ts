import * as z from "zod/v4";

/** Explicit caller choice; the original recipes have no default camera change. */
export const fixedTemplateWindowV3Schema = z.strictObject({
  schema: z.literal("editkin.fixed-template-window/v3"),
  peakScale: z.number().finite().gt(1).max(1.25),
});
export const fixedTemplateWindowMaskV3Schema = z.strictObject({ schema: z.literal("editkin.fixed-template-window/v3"),
  fromFrame: z.number().int().nonnegative().max(1799).optional(), toFrame: z.number().int().nonnegative().max(1799).optional(),
}).refine(value => (value.fromFrame === undefined && value.toFrame === undefined)
  || (value.fromFrame !== undefined && value.toFrame !== undefined && value.fromFrame <= value.toFrame));
export type FixedTemplateWindowMaskV3 = z.infer<typeof fixedTemplateWindowMaskV3Schema>;
export const FIXED_TEMPLATE_WINDOW_V3_CONTRACT = Object.freeze({
  schema: "editkin.fixed-template-window/v3", certification: "ART_PENDING_CLAUDE", defaultSelection: false,
  boundary: "stationary_authored_viewport", clock: "every_integer_clip_local_project_frame",
  source: "original_source_window_and_audio", feather: "existing_authored_feather_retained",
  storage: "compact_inverse_transform; expand_only_at_alpha_consumers", cycle: "neutral_push_neutral_during_authored_hold",
  scope: "compensate_only_the_push_hold; preserve_authored_entrance",
} as const);
