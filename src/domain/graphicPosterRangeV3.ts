import { z } from "zod";

/** The authored first reveal supplies the range; no new layout or motion values are selected. */
export const graphicPosterRangeV3Schema = z.strictObject({ schema: z.literal("editkin.graphic-poster-range/v3") });
export type GraphicPosterRangeV3 = z.infer<typeof graphicPosterRangeV3Schema>;
export const GRAPHIC_POSTER_RANGE_V3_CONTRACT = {
  schema: "editkin.graphic-poster-range/v3", certification: "ART_PENDING_CLAUDE", defaultSelection: false,
  range: "original_first_held_card_or_first_reveal", poster: "complete_original_card_at_project_frame_zero",
  laterScenes: "original_choreography", sourceClocks: "unchanged", typography: "original_physical_glyphs",
  visibleSettleAndExit: "original_authored_motion_retained",
} as const;
