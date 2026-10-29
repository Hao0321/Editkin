import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commandTypes";
import type { ReferenceMotionEditorialBinding, ReferenceMotionPlan } from "./referenceMotionPlan";
import { referenceMotionPlanSchema, referenceMotionRequestedIndexes, referenceMotionRequestedGraphics,
  referenceMotionVisibleProjection, referenceMotionEditorialGraphic } from "./referenceMotionPlan";
import { referenceMotionSourceReplacementPatchSchema } from "./referenceMotionSourceReplacement";
import { containsReferenceMotionSourceRebind } from "../domain/referenceMotionSourceRebind";

const sourceStep = z.strictObject({ instanceId: z.string().trim().min(1).max(160), mode: z.literal("replace_source"),
  commandIndexes: z.array(z.number().int().nonnegative().max(99)).min(1).max(100),
  expectedInstanceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), replacement: referenceMotionSourceReplacementPatchSchema });
/** Optional Editkin-side declaration only. Existing v1 intent and its parser remain unchanged. */
export const referenceMotionSourcePlanV2Schema = z.strictObject({ schema: z.literal("editkin.reference-motion-plan/v2"),
  instances: z.array(z.discriminatedUnion("mode", [...referenceMotionPlanSchema.shape.instances.element.options, sourceStep])).min(1).max(8) });
export const referenceMotionCompatiblePlanSchema = z.union([referenceMotionPlanSchema, referenceMotionSourcePlanV2Schema]);
export type ReferenceMotionCompatiblePlan = z.infer<typeof referenceMotionCompatiblePlanSchema>;

export const REFERENCE_MOTION_SOURCE_REPLACEMENT_CAPABILITY = {
  schema: "editkin.reference-motion-source-replacement/v1",
  prepareTool: "prepare_reference_motion_template_source_replacement",
  planDeclaration: "editkin.reference-motion-plan/v2",
  mode: "replace_source",
  primaryAudio: ["keep_level", "mute", "unity"], extraAudio: "muted_fixed_v1",
  independentRecompileAt: ["audit", "apply"], opaqueExactProjectAndBatchAuthority: true,
  freshMaterialCoverageRequired: true, changedAssetRequiresFreshEvidenceAndExplicitRegions: true,
  changedExtraRequiresFreshLabel: true, topologyChangesRefused: true,
  stagingProtocol: "Import and analyze a staging clip covering the new window; remove staging in the final audited batch.",
  sourceFrameRate: "Measured receipt only; unknown stays unknown. Project timebase and media playback speed remain authoritative.",
  previousQaOrArtworkApprovalReusable: false, actualVaWorkflowContractEnabled: false, installedOrFullProductCertified: false,
} as const;

/** Provisional reporting adapter only. Real audit/apply use the original source intent and independently recompile it. */
function reportingDeclaration(declaration: ReferenceMotionCompatiblePlan | undefined, commands: readonly EditorCommand[]): ReferenceMotionPlan | undefined {
  if (!declaration || declaration.schema === "editkin.reference-motion-plan/v1") return declaration;
  referenceMotionSourcePlanV2Schema.parse(declaration);
  return { schema: "editkin.reference-motion-plan/v1", instances: declaration.instances.map(step => {
    if (step.mode !== "replace_source") return step;
    const metadata = commands[step.commandIndexes.at(-1)!];
    if (!metadata || metadata.type !== "upsert_reference_motion_instance") throw new Error("Source replacement metadata is missing");
    return { instanceId: step.instanceId, mode: "revise" as const, commandIndexes: step.commandIndexes,
      expectedInstanceRevision: step.expectedInstanceRevision, patch: { title: metadata.instance.input.title } };
  }) };
}
function checkRebindClaims(declaration: ReferenceMotionCompatiblePlan | undefined, commands: readonly EditorCommand[]): void {
  for (const [index, command] of commands.entries()) {
    if (!containsReferenceMotionSourceRebind(command)) continue;
    if (command.type !== "rebind_reference_motion_clip_source") throw new Error("Template source replacement must use flat plan indexes");
    const step = declaration?.instances.find(step => step.commandIndexes.includes(index));
    if (!step || step.mode !== "replace_source") throw new Error("Template source rebind requires its explicit replace_source declaration");
    const metadata = commands[step.commandIndexes.at(-1)!];
    if (metadata?.type !== "upsert_reference_motion_instance" || (command.clipId !== metadata.instance.input.clipId
      && !metadata.instance.roles.some(role => role.kind === "clip" && role.id === command.clipId))) {
      throw new Error("Template source rebind differs from its declared clip owner");
    }
  }
}
export function referenceMotionRequestedIndexesCompatible(declaration: ReferenceMotionCompatiblePlan | undefined, commands: readonly EditorCommand[]): Set<number> {
  checkRebindClaims(declaration, commands);
  return referenceMotionRequestedIndexes(reportingDeclaration(declaration, commands), commands);
}
export function referenceMotionRequestedGraphicsCompatible(declaration: ReferenceMotionCompatiblePlan | undefined, commands: readonly EditorCommand[]) {
  referenceMotionRequestedIndexesCompatible(declaration, commands);
  return referenceMotionRequestedGraphics(reportingDeclaration(declaration, commands), commands);
}
export function referenceMotionVisibleProjectionCompatible(declaration: ReferenceMotionCompatiblePlan | undefined, commands: readonly EditorCommand[]): EditorCommand[] {
  referenceMotionRequestedIndexesCompatible(declaration, commands);
  return referenceMotionVisibleProjection(reportingDeclaration(declaration, commands), commands);
}
export function referenceMotionEditorialGraphicCompatible(binding: ReferenceMotionEditorialBinding, declaration: ReferenceMotionCompatiblePlan | undefined,
  commands: readonly EditorCommand[], graphicId: string, presetId: string) {
  referenceMotionRequestedIndexesCompatible(declaration, commands);
  return referenceMotionEditorialGraphic(binding, reportingDeclaration(declaration, commands), commands, graphicId, presetId);
}
