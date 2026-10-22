import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commands";
import { applyCommand } from "../domain/commands";
import { canonicalJson } from "../shared/canonicalJson";
import { referenceMotionRequestedIndexesCompatible as referenceMotionRequestedIndexes, type ReferenceMotionCompatiblePlan as ReferenceMotionPlan } from "../application/referenceMotionSourcePlanV2";
import { prepareReferenceMotionTemplateSourceReplacement, referenceMotionSourceReplacementCommandContext } from "../application/referenceMotionSourceTransaction";
import { containsReferenceMotionSourceRebind } from "../domain/referenceMotionSourceRebind";
import { issueReferenceMotionSourceOwnerProof } from "../domain/referenceMotionSourceOwnerProof";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision,
  inspectReferenceMotionTemplateInstance, referenceMotionTemplateRevisionCommandContext } from "../application/referenceMotionTemplateInstances";
import { issueNativePaintOwnerRevisionProof } from "../domain/nativePaintOwnerRevision";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { prepareReferenceMotionTemplateReuse } from "../application/referenceMotionTemplateReuse";
import { isNativeReferenceMotionPresentation } from "../motion/referenceMotionTemplates";

export const REFERENCE_MOTION_PLAN_TIMEOUT_MS = 10_000;

/** Called independently by current v4 audit and apply. A prepare response is never authority. */
export async function verifyReferenceMotionPlan(declaration: ReferenceMotionPlan | undefined,
  project: EditProject, commands: readonly EditorCommand[], environment: NodeJS.ProcessEnv = process.env) {
  const requested = referenceMotionRequestedIndexes(declaration, commands);
  if (!declaration) return { indexes: new Set<number>(), instanceCount: 0 };
  const signature = canonicalJson(project), planSignature = canonicalJson([declaration, commands]);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), REFERENCE_MOTION_PLAN_TIMEOUT_MS);
  const stepAt = new Map(declaration.instances.map(step => [step.commandIndexes[0], step]));
  const check = () => {
    if (controller.signal.aborted) throw new Error("Reference plan exceeded its single ten-second verification deadline");
    if (canonicalJson(project) !== signature || canonicalJson([declaration, commands]) !== planSignature) throw new Error("Reference plan or source changed during trusted recompile");
  };
  try {
    return await withReferenceMotionPhysicalFonts(async dependencies => {
      let current = structuredClone(project);
      const nativeRevisionInstanceIds: string[] = [], sourceRevisionInstanceIds: string[] = [];
      for (let index = 0; index < commands.length; index++) {
        check();
        const step = stepAt.get(index);
        if (!step) {
          if (requested.has(index)) throw new Error("Reference plan has an unprocessed owned command");
          current = applyCommand(current, structuredClone(commands[index]));
          continue;
        }
        const metadata = commands[step.commandIndexes.at(-1)!];
        if (metadata.type !== "upsert_reference_motion_instance") throw new Error("Reference plan metadata missing");
        const roleIds = new Map(metadata.instance.roles.map(role => [role.key, role.id]));
        const idFactory = (_prefix: string, roleKey?: string) => {
          if (roleKey === "instance") return step.instanceId;
          const id = roleKey ? roleIds.get(roleKey) : undefined;
          if (!id) throw new Error("Reference plan did not supply an exact semantic identity for a compiled role");
          return id;
        };
        const compiled = step.mode === "replace_source"
          ? await prepareReferenceMotionTemplateSourceReplacement(current, { ...step.replacement, instanceId: step.instanceId,
              expectedInstanceRevision: step.expectedInstanceRevision, expectedProjectRevision: current.revision }, idFactory, dependencies)
          : step.mode === "create"
          ? step.reuseOrigin
            ? await prepareReferenceMotionTemplateReuse(current, {
                sourceInstanceId: step.reuseOrigin.sourceInstanceId, expectedInstanceRevision: step.reuseOrigin.expectedInstanceRevision,
                expectedProjectRevision: current.revision, targetClipId: metadata.instance.input.clipId,
                purpose: metadata.instance.input.purpose, evidenceRefs: metadata.instance.input.evidenceRefs,
                sources: metadata.instance.input.sources,
                ...(metadata.instance.input.focusRegion === undefined ? {} : { focusRegion: metadata.instance.input.focusRegion }),
              }, idFactory, dependencies).then(prepared => {
                if (prepared.planDeclaration.instances[0].reuseOrigin.sourceScopeSha256 !== step.reuseOrigin!.sourceScopeSha256) {
                  throw new Error("Saved reuse source scope differs from its declared current origin");
                }
                return prepared;
              })
            : await prepareReferenceMotionTemplateInstance(current, metadata.instance.input, idFactory, dependencies)
          : await prepareReferenceMotionTemplateRevision(current, step.instanceId, step.patch,
            { ...dependencies, expectedInstanceRevision: step.expectedInstanceRevision, idFactory });
        check();
        if (compiled.status === "UNCHANGED") throw new Error("Unchanged reference metadata earns no automated revision");
        const actual = step.commandIndexes.map(commandIndex => commands[commandIndex]);
        if (canonicalJson(compiled.commands) !== canonicalJson(actual)) throw new Error("Reference commands differ from independently recompiled physical template");
        const context = "binding" in compiled ? referenceMotionSourceReplacementCommandContext(current, compiled) : referenceMotionTemplateRevisionCommandContext(compiled);
        current = applyCommand(current, { type: "batch", commands: structuredClone(actual) }, context);
        if (step.mode === "replace_source" && actual.some(containsReferenceMotionSourceRebind)) sourceRevisionInstanceIds.push(step.instanceId);
        if (step.mode !== "create" && isNativeReferenceMotionPresentation(metadata.instance.input.graphicPresentation)) nativeRevisionInstanceIds.push(step.instanceId);
        index = step.commandIndexes.at(-1)!;
      }
      for (const step of declaration.instances) {
        check();
        const inspected = await inspectReferenceMotionTemplateInstance(current, step.instanceId);
        if (inspected.status !== "CURRENT") throw new Error("Later plan commands changed a trusted reference instance");
      }
      check();
      return { indexes: requested, instanceCount: declaration.instances.length,
        ...(sourceRevisionInstanceIds.length ? { referenceMotionSourceOwnerProof: issueReferenceMotionSourceOwnerProof(project,
          { type: "batch", commands: structuredClone([...commands]) }, sourceRevisionInstanceIds) } : {}),
        ...(nativeRevisionInstanceIds.length ? { nativePaintOwnerRevisionProof: issueNativePaintOwnerRevisionProof(project,
          { type: "batch", commands: structuredClone([...commands]) }, nativeRevisionInstanceIds) } : {}) };
    }, environment, controller.signal);
  } finally { clearTimeout(timer); controller.abort(); }
}
