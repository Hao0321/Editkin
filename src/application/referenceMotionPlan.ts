import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commands";
import type { MotionGraphic } from "../domain/types";
import { editorCommandSchema } from "../domain/schema";
import { referenceMotionTemplateRevisionPatchSchema } from "../domain/referenceMotionInstance";

const instanceId = z.string().trim().min(1).max(160);
const indexes = z.array(z.number().int().nonnegative().max(99)).min(1).max(100);
const stepBase = { instanceId, commandIndexes: indexes };
export const referenceMotionReuseOriginSchema = z.strictObject({
  sourceInstanceId: instanceId, expectedInstanceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceScopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const referenceMotionPlanSchema = z.strictObject({
  schema: z.literal("editkin.reference-motion-plan/v1"),
  instances: z.array(z.discriminatedUnion("mode", [
    z.strictObject({ ...stepBase, mode: z.literal("create"), reuseOrigin: referenceMotionReuseOriginSchema.optional() }),
    z.strictObject({ ...stepBase, mode: z.literal("revise"), expectedInstanceRevision: z.number().int().positive(),
      patch: referenceMotionTemplateRevisionPatchSchema }),
  ])).min(1).max(8),
});
export type ReferenceMotionPlan = z.infer<typeof referenceMotionPlanSchema>;

/** Syntax only. These indexes never authorize execution or provide a trusted compilation. */
export function referenceMotionRequestedIndexes(declaration: ReferenceMotionPlan | undefined, commands: readonly EditorCommand[]): Set<number> {
  const claimed = new Set<number>(), seen = new Set<string>();
  if (declaration) {
    referenceMotionPlanSchema.parse(declaration);
    for (const step of declaration.instances) {
      if (seen.has(step.instanceId)) throw new Error("A reference instance can only be compiled once per current plan");
      seen.add(step.instanceId);
      let previous = -1;
      for (const index of step.commandIndexes) {
        if (index <= previous || (previous >= 0 && index !== previous + 1) || claimed.has(index)
          || !commands[index] || commands[index].type === "batch") throw new Error("Reference compilation requires disjoint ordered contiguous flat commands");
        previous = index; claimed.add(index);
      }
      const metadata = commands[step.commandIndexes.at(-1)!];
      if (metadata.type !== "upsert_reference_motion_instance" || metadata.instance.id !== step.instanceId
        || metadata.expectedInstanceRevision !== (step.mode === "revise" ? step.expectedInstanceRevision : undefined)
        || metadata.instance.instanceRevision !== (step.mode === "revise" ? step.expectedInstanceRevision + 1 : 1)) {
        throw new Error("Reference compilation metadata differs from its declared instance revision");
      }
      if (step.commandIndexes.slice(0, -1).some(index => commands[index].type === "upsert_reference_motion_instance"
        || commands[index].type === "remove_reference_motion_instance")) throw new Error("Reference compilation has extra metadata mutations");
    }
  }
  commands.forEach((command, index) => {
    if (command.type === "upsert_reference_motion_instance" && !claimed.has(index)) throw new Error("Reference metadata requires exact current compiler declaration");
    if (command.type === "remove_reference_motion_instance") throw new Error("Detach is a manual metadata edit, not an automated visual treatment");
    if (command.type === "batch" && containsReferenceMetadata(command.commands)) throw new Error("Reference compilation must use explicit flat plan indexes");
  });
  return claimed;
}
function containsReferenceMetadata(commands: readonly EditorCommand[]): boolean {
  return commands.some(command => command.type === "upsert_reference_motion_instance" || command.type === "remove_reference_motion_instance"
    || command.type === "batch" && containsReferenceMetadata(command.commands));
}

/** A complete target is required even provisionally; partial caller patches earn no design credit. */
export function referenceMotionRequestedGraphics(declaration: ReferenceMotionPlan | undefined, commands: readonly EditorCommand[]): Map<number, MotionGraphic> {
  const claimed = referenceMotionRequestedIndexes(declaration, commands), graphics = new Map<number, MotionGraphic>();
  for (const index of claimed) {
    const command = commands[index];
    if (command.type !== "update_motion_graphic") continue;
    const parsed = editorCommandSchema.parse({ type: "add_motion_graphic", graphic: { ...command.patch, id: command.graphicId } });
    if (parsed.type !== "add_motion_graphic") throw new Error("Reference revision requires an entire physical-compiler target");
    graphics.set(index, parsed.graphic);
  }
  return graphics;
}

/** Reporting projection only. Metadata, deletes and unrelated updates cannot earn visible credit. */
export function referenceMotionVisibleProjection(declaration: ReferenceMotionPlan | undefined, commands: readonly EditorCommand[]): EditorCommand[] {
  const graphics = referenceMotionRequestedGraphics(declaration, commands);
  return commands.map<EditorCommand>((command, index) => graphics.has(index) ? { type: "add_motion_graphic", graphic: graphics.get(index)! } : command);
}
