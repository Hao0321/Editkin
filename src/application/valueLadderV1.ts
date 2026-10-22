import * as z from "zod/v4";
import { referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import { applyCommand } from "../domain/commands";
import { prepareReferenceMotionTemplateInstance, inspectReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import type { ReferenceMotionTemplatePreparationDependencies } from "./referenceMotionTemplates";
import { deriveCounterVisualTicksV1 } from "./counterVisualTicksV1";
import { editorialDecimalV1Schema, editorialUnitV1Schema, editorialEvidenceRefsV1Schema, compareEditorialDecimalsV1, formatEditorialValueV1 } from "./editorialNumericValueV1";
import { beginEditorialDataGraphicsV1, requireEditorialDataClipV1, prepareEditorialDataGraphicsV1, editorialDataSoundV1Schema, type EditorialDataRuntimeV1, type EditorialDataSoundLibraryV1 } from "./editorialDataGraphicsV1";
import type { ProjectSession } from "./projectSession";

export const valueLadderRequestV1Schema = z.strictObject({
  schema: z.literal("editkin.value-ladder/v1"), expectedRevision: z.number().int().nonnegative(), idPrefix: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/u),
  direction: z.enum(["increase", "decrease"]), unit: editorialUnitV1Schema,
  rungs: z.array(z.strictObject({ value: editorialDecimalV1Schema, detail: z.string().trim().max(40).optional(), evidenceRefs: editorialEvidenceRefsV1Schema })).min(2).max(4),
  template: z.record(z.string(), z.unknown()), sound: editorialDataSoundV1Schema.optional(),
});
/** Frozen stat_reveal remains the complete visual compiler. Data order is not a new step animation. */
export async function prepareValueLadderV1(session: ProjectSession, payload: unknown,
  dependencies: Pick<ReferenceMotionTemplatePreparationDependencies, "prepareText"> & { library?: EditorialDataSoundLibraryV1 }, runtime: EditorialDataRuntimeV1 = {}) {
  const request = valueLadderRequestV1Schema.parse(structuredClone(payload)), context = beginEditorialDataGraphicsV1(session, request.expectedRevision, runtime);
  for (const key of ["templateId", "items", "evidenceRefs"]) if (key in request.template) throw Error("VALUE_LADDER_DERIVED_TEMPLATE_FIELD");
  for (let i = 1; i < request.rungs.length; i++) {
    const order = compareEditorialDecimalsV1(request.rungs[i - 1].value, request.rungs[i].value);
    if (order !== (request.direction === "increase" ? -1 : 1)) throw Error("VALUE_LADDER_STRICT_ORDER_REQUIRED");
  }
  const items = request.rungs.map(r => ({ label: formatEditorialValueV1(r.value, request.unit), ...(r.detail === undefined ? {} : { detail: r.detail }) }));
  const evidenceRefs = [...new Set(request.rungs.flatMap(r => r.evidenceRefs))];
  const input = referenceMotionTemplateInputSchema.parse({ ...request.template, templateId: "stat_reveal", items, evidenceRefs });
  const clip = requireEditorialDataClipV1(context, input.clipId);
  if (input.startFrame < clip.start || input.startFrame + input.durationFrames > clip.end) throw Error("VALUE_LADDER_OUTSIDE_SOURCE_CLIP");
  let ordinal = 0;
  const packet = await context.wait(() => prepareReferenceMotionTemplateInstance(context.source, input, prefix => `${request.idPrefix}-${prefix}-${++ordinal}`,
    { prepareText: (face, text) => context.wait(() => dependencies.prepareText(face, text)), signal: context.settings.signal }));
  const draft = applyCommand(context.source, { type: "batch", commands: packet.commands });
  const inspection = await context.wait(() => inspectReferenceMotionTemplateInstance(draft, packet.instance.id));
  if (inspection.status !== "CURRENT") throw Error(`VALUE_LADDER_INSTANCE_${inspection.status}`);
  const durationFrames = input.startFrame + input.durationFrames;
  const visual = deriveCounterVisualTicksV1(draft, { enabled: true, durationFrames, trackId: request.sound?.trackId ?? "unused", idPrefix: request.idPrefix,
    bindings: [{ source: "reference_instance", instanceId: packet.instance.id }], sound: { variant: request.sound?.variant ?? 1, gain: request.sound?.gain ?? 1 } });
  return prepareEditorialDataGraphicsV1(context, "value_ladder", packet.commands, { schema: request.schema, direction: request.direction,
    unit: request.unit, rungs: request.rungs, labels: items.map(i => i.label), instanceId: packet.instance.id, templateInput: input,
    referenceState: inspection.status, evidenceAuthority: "caller_authored_unverified", appearance: "unchanged_frozen_stat_reveal", dataOrderIsAnimationOrder: false },
    visual.hooks, durationFrames, request.idPrefix, request.sound, dependencies.library);
}
