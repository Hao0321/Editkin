import * as z from "zod/v4";
import { EDITKIN_MOTION } from "./identity";

const projectSchemas = z.array(z.union([z.literal(9), z.literal(10)])).min(1).max(2)
  .refine(values => new Set(values).size === values.length, "Project schemas must be unique")
  .refine(values => values.includes(9), "The established schema9 engine floor is required");
const motionSchemas = z.array(z.enum([
  "hao.motion-composition/v1", "hao.motion-composition/v2", "editkin.motion-scene-2d/v1",
])).min(2).max(3)
  .refine(values => new Set(values).size === values.length, "Motion schemas must be unique")
  .refine(values => values.includes("hao.motion-composition/v2") && values.includes("editkin.motion-scene-2d/v1"),
    "Physical composition v2 and shared scene camera schemas are required");

/** A compatibility declaration for new runs. It is not render, artwork or installation evidence. */
export const engineContinuitySchema = z.strictObject({
  schema: z.literal("editkin.engine-continuity/v1"),
  engineId: z.literal(EDITKIN_MOTION.id),
  commonBase: z.literal(EDITKIN_MOTION.commonBase),
  projectSchemas,
  motionSchemas,
  textPreparation: z.literal("physical-glyph-binary/v1"),
  templateAuthoring: z.literal("async-generation2"),
  floatingFrame: z.strictObject({
    schema: z.literal("editkin.floating-video-frame/v2"),
    mediaFit: z.literal("contain"),
    clock: z.literal("integer_project_frames"),
    geometry: z.literal("upright_display_aspect_ratio"),
  }),
  planSchema: z.literal("hao.video-autopilot.edit-plan/v4"),
  visualReviewPolicyBound: z.literal(true),
  originalSource: z.strictObject({
    schema: z.literal("editkin.original-motion-source/v1"),
    sameProcessCommit: z.literal(true),
  }),
});

type ParsedEngineContinuity = z.infer<typeof engineContinuitySchema>;
export type EngineContinuity = Readonly<Omit<ParsedEngineContinuity, "projectSchemas" | "motionSchemas" | "floatingFrame" | "originalSource"> & {
  projectSchemas: readonly ParsedEngineContinuity["projectSchemas"][number][];
  motionSchemas: readonly ParsedEngineContinuity["motionSchemas"][number][];
  floatingFrame: Readonly<ParsedEngineContinuity["floatingFrame"]>;
  originalSource: Readonly<ParsedEngineContinuity["originalSource"]>;
}>;

/** Parse into an owned frozen value; a caller's later mutation cannot alter a pinned declaration. */
export function parseEngineContinuity(value: unknown): EngineContinuity {
  const parsed = engineContinuitySchema.parse(value);
  Object.freeze(parsed.projectSchemas);
  Object.freeze(parsed.motionSchemas);
  Object.freeze(parsed.floatingFrame);
  Object.freeze(parsed.originalSource);
  return Object.freeze(parsed);
}

export const EDITKIN_ENGINE_CONTINUITY = parseEngineContinuity({
  schema: "editkin.engine-continuity/v1",
  engineId: EDITKIN_MOTION.id,
  commonBase: EDITKIN_MOTION.commonBase,
  projectSchemas: [9, 10],
  motionSchemas: [...EDITKIN_MOTION.schemas],
  textPreparation: "physical-glyph-binary/v1",
  templateAuthoring: "async-generation2",
  floatingFrame: {
    schema: "editkin.floating-video-frame/v2", mediaFit: "contain",
    clock: "integer_project_frames", geometry: "upright_display_aspect_ratio",
  },
  planSchema: "hao.video-autopilot.edit-plan/v4",
  visualReviewPolicyBound: true,
  originalSource: { schema: "editkin.original-motion-source/v1", sameProcessCommit: true },
});
