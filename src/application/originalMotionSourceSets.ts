import * as z from "zod/v4";
import { originalMotionSourceSetSchema, originalMaterialEvidenceSchema, assertOriginalMotionSourcePlanBinding,
  type OriginalMotionSourceSet } from "./originalMotionSourceEvidence";
import { originalMotionSourceRevisionSetSchema, assertOriginalMotionSourceRevisionPlanBinding,
  originalMotionSourceRevisionVisibleProjection, type OriginalMotionSourceRevisionSet,
  originalPaintedMediaSourceRevisionSetSchema, assertOriginalPaintedMediaSourceRevisionPlanBinding,
  originalPaintedMediaSourceRevisionVisibleProjection, type OriginalPaintedMediaSourceRevisionSet } from "./originalMotionSourceRevision";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditorialPlan } from "./editorialPlan";

/** Creation v1 remains add-only. Existing-owner edits use a separately closed
 * v2 branch; no creation manifest or manual command is promoted into it. */
export const canonicalOriginalMotionSourceSetSchema = z.union([originalMotionSourceSetSchema, originalMotionSourceRevisionSetSchema, originalPaintedMediaSourceRevisionSetSchema]);
export const canonicalOriginalMaterialEvidenceSchema = z.union([originalMaterialEvidenceSchema,
  originalMotionSourceRevisionSetSchema.extend({ receipts: z.tuple([]) })]);
export type CanonicalOriginalMotionSourceSet = OriginalMotionSourceSet | OriginalMotionSourceRevisionSet | OriginalPaintedMediaSourceRevisionSet;
export const ORIGINAL_SOURCE_REVISION_CAPABILITY = {
  schema: "editkin.original-motion-source-revision-capability/v1",
  sourceSchema: "editkin.original-motion-source/v2",
  evidenceSchema: "editkin.original-motion-source-revision-evidence/v1",
  prepareReadOnly: "prepare_original_motion_source_revision",
  ownerScope: "one_existing_scene_same_geometry_clock_camera_cues",
  independentRecompile: ["audit", "apply", "precommit"],
  physicalGlyphs: true, sourceAdmissionOnly: true,
} as const;
/** Media stays in its real receipt-bearing route. This explicit branch does
 * not broaden standalone v1 or claim matching native output/installation. */
export const ORIGINAL_PAINTED_MEDIA_SOURCE_REVISION_CAPABILITY = {
  schema: "editkin.original-motion-source-revision-capability/v2",
  sourceSchema: "editkin.original-motion-source/v3",
  evidenceSchema: "editkin.original-motion-source-revision-evidence/v2",
  revisionScope: "painted_authored_overlay_preserve_media",
  prepareReadOnly: "prepare_original_motion_source_revision",
  ownerScope: "one_existing_scene_same_geometry_clock_camera_cues",
  independentRecompile: ["audit", "apply", "precommit"],
  physicalGlyphs: true, preservedContext: "literal_project_except_owner_revision_updatedAt_aestheticSystem",
  mediaReceiptsRequired: true, sourceAdmissionOnly: true,
} as const;
export function originalSourceRows(set: CanonicalOriginalMotionSourceSet) {
  return set.schema === "editkin.original-motion-source/v1" ? set.sources : set.sources.map(source => source.after);
}
export function assertCanonicalOriginalMotionSourcePlanBinding(set: CanonicalOriginalMotionSourceSet,
  commands: readonly EditorCommand[], editorial: Pick<EditorialPlan, "graphics" | "narrative">): void {
  if (set.schema === "editkin.original-motion-source/v1") assertOriginalMotionSourcePlanBinding(set, commands, editorial);
  else if (set.schema === "editkin.original-motion-source/v2") assertOriginalMotionSourceRevisionPlanBinding(set, commands, editorial);
  else assertOriginalPaintedMediaSourceRevisionPlanBinding(set, commands, editorial);
}
/** Projection changes neither sealed commands nor their physical indexes. */
export function canonicalOriginalVisibleProjection(set: CanonicalOriginalMotionSourceSet | undefined, commands: readonly EditorCommand[]): EditorCommand[] {
  if (set?.schema === "editkin.original-motion-source/v2") return originalMotionSourceRevisionVisibleProjection(set, commands);
  if (set?.schema === "editkin.original-motion-source/v3") return originalPaintedMediaSourceRevisionVisibleProjection(set, commands);
  return [...commands];
}
