import type { EditProject } from "../domain/types";
import type { EditorialPlan } from "./editorialPlan";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { motionPresetSeedSha256 } from "./motionPresetVariant";
import { buildReferenceMotionTemplateCommands } from "./referenceMotionTemplateCommands";
import type { ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";

/** Agent packet reuses the exact desktop compiler and current seed identities. */
export function prepareReferenceMotionTemplate(project: EditProject, input: ReferenceMotionTemplateInput, idFactory: (prefix: string) => string) {
  const { bindings, ...compiled } = buildReferenceMotionTemplateCommands(project, input, idFactory);
  const editorialGraphics: EditorialPlan["graphics"] = bindings.map(({ graphic, presetId, overrides, startFrame, endFrame }) => ({
    id: graphic.id, presetId, range: { startFrame, endFrame },
    kind: graphic.vectorV2 ? "native_shape" : graphic.kind === "title" ? "title_card" : "context_card",
    purpose: "context", message: graphic.text, evidenceRefs: [...input.evidenceRefs],
    presetVariant: { schema: "editkin.motion-preset-variant/v1", basePresetSha256: motionPresetSeedSha256(findMotionGraphicPreset(presetId)),
      reason: input.purpose, overrides },
  }));
  return { ...compiled, editorialGraphics };
}
