import type { EditProject } from "../domain/types";
import { referenceMotionTemplateReuseRequestSchema, type ReferenceMotionTemplateReuseRequest } from "../application/referenceMotionTemplateReuse";

/** Actual manual selection metadata. This does not assert source observation, legal rights, or artwork approval. */
export function referenceMotionManualReuseRequest(project: EditProject, input: Omit<ReferenceMotionTemplateReuseRequest, "evidenceRefs">): ReferenceMotionTemplateReuseRequest {
  if (project.revision !== input.expectedProjectRevision) throw new Error("模板已有新版本，請重新開啟後再套用。");
  return referenceMotionTemplateReuseRequestSchema.parse({ ...input,
    evidenceRefs: [`manual:template-reuse-choice:${project.revision}:${input.targetClipId.slice(0, 64)}`] });
}
