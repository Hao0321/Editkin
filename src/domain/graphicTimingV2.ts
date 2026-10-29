import * as z from "zod/v4";

/** Explicit opt-in. Absence keeps the original certified recipe and its dependency identity. */
export const graphicTimingV2Schema = z.strictObject({
  schema: z.literal("editkin.graphic-timing/v2"),
  entranceSpeed: z.number().finite().min(.5).max(2),
  holdSeconds: z.number().finite().min(.5).max(8),
  exitSpeed: z.number().finite().min(.5).max(2),
});
export type GraphicTimingV2 = z.infer<typeof graphicTimingV2Schema>;
export const DEFAULT_GRAPHIC_TIMING_V2: Readonly<GraphicTimingV2> = Object.freeze({
  schema: "editkin.graphic-timing/v2", entranceSpeed: 1, holdSeconds: 1.5, exitSpeed: 1,
});
export const GRAPHIC_TIMING_V2_CONTRACT = Object.freeze({
  schema: "editkin.graphic-timing-compiler/v2", certification: "ART_PENDING_CLAUDE",
  clock: "integer_project_frames", sourcePolicy: "source_windows_playback_audio_unchanged",
  holdPolicy: "requested_hold_with_unscaled_reading_floor; reject_if_scene_does_not_fit",
  themeCadence: "profile_coefficients_relative_to_legacy; authored_theme_geometry_and_easing_retained",
  terminalPolicy: "explicit_graphic_exit_then_clean_source_tail", defaultSelection: false,
} as const);
