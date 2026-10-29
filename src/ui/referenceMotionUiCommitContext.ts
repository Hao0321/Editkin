import type { EditProject } from "../domain/types";
import { referenceMotionTemplateRevisionCommandContext } from "../application/referenceMotionTemplateInstances";
import { referenceMotionSourceReplacementCommandContext, type ReferenceMotionSourceReplacementPreparation } from "../application/referenceMotionSourceTransaction";

export function referenceMotionUiCommitContext(project: EditProject, prepared: object & { status: string }) {
  return prepared.status === "PREPARED_NOT_APPLIED"
    ? referenceMotionSourceReplacementCommandContext(project, prepared as ReferenceMotionSourceReplacementPreparation)
    : referenceMotionTemplateRevisionCommandContext(prepared);
}
