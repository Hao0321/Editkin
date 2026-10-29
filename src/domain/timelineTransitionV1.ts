import * as z from "zod/v4";
import { timelineTransitionMotionLibraryV1Schema } from "./motionLibraryFieldsV1";

const id = z.string().min(1).max(160).refine(value => value.trim().length > 0, "TIMELINE_TRANSITION_FIELDS_INVALID");
/** An authored cut owns a half-open transition window in project frames. */
export const timelineTransitionSchemaV1 = z.strictObject({
  schema: z.literal("editkin.timeline-transition/v1"),
  id, trackId: id, fromClipId: id, toClipId: id,
  beforeFrames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  afterFrames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** "matte" (Motion Library Phase 3): per-pixel mix(A, B, matte) ⊕ overlay from a rendered motion library transition. */
  kernel: z.enum(["dissolve", "dip", "matte"]),
  /** Required exactly when kernel is "matte"; names the rendered matte (and optional overlay) assets. */
  motionLibrary: timelineTransitionMotionLibraryV1Schema.optional(),
}).refine(t => t.fromClipId !== t.toClipId && Number.isSafeInteger(t.beforeFrames + t.afterFrames)
  && t.beforeFrames + t.afterFrames >= 2, "TIMELINE_TRANSITION_FIELDS_INVALID")
  .refine(t => (t.kernel === "matte") === (t.motionLibrary !== undefined), "TIMELINE_TRANSITION_FIELDS_INVALID");

export type TimelineTransition = z.infer<typeof timelineTransitionSchemaV1>;

/** New visual families have no certification or automatic selection authority. */
export const TIMELINE_TRANSITION_FAMILIES_V1 = Object.freeze([
  { id: "dissolve", implemented: false, certification: "ART_PENDING_CLAUDE", defaultEnabled: false },
  { id: "dip", implemented: false, certification: "ART_PENDING_CLAUDE", defaultEnabled: false },
  { id: "push", implemented: false, certification: "ART_PENDING_CLAUDE", defaultEnabled: false },
  { id: "whip", implemented: false, certification: "ART_PENDING_CLAUDE", defaultEnabled: false },
] as const);
