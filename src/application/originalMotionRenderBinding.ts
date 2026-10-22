import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import type { AutopilotProjectAuditIdentity } from "./autopilotInvocationIdentity";
import { canonicalJson } from "../shared/canonicalJson";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const projectIdentitySchema = z.strictObject({ id: z.string().min(1).max(256),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), pathSha256: digest, contentSha256: digest });
const bindingSchema = z.strictObject({ schema: z.literal("editkin.original-motion-render-binding/v1"),
  originalSourceEvidenceSha256: digest, sceneProjectSha256: digest, renderContentSha256: digest });
const committedProjectionSchema = z.object({ schema: z.literal("hao.video-autopilot.execution-receipt/v1"),
  state: z.literal("committed"), receiptId: z.string().min(1).max(256),
  planSchema: z.literal("hao.video-autopilot.edit-plan/v4"), planSha256: digest,
  projectRevisionBefore: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  projectRevisionAfter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  projectIdentityAfter: projectIdentitySchema, originalMotionBinding: bindingSchema,
  quality: z.object({ outputState: z.literal("review_required"), certified: z.literal(false) }),
  createdAt: z.string().min(1).max(128), committedAt: z.string().min(1).max(128),
});

export interface OriginalMotionRenderBindingExpected {
  planSha256: string;
  projectIdentity: AutopilotProjectAuditIdentity;
  project: EditProject;
  originalSourceEvidenceSha256: string;
}

/** Root-owned IO must authenticate the owned committed seal before returning
 * bytes parsed from its trusted committed file. This is not a caller payload. */
export interface OriginalMotionRenderBindingAuthority {
  readAuthenticatedCommittedReceipt(projectIdentity: AutopilotProjectAuditIdentity, planSha256: string): Promise<unknown>;
}

interface OriginalMotionRenderBindingCheckBase {
  executionReceiptId: string;
  planSha256: string;
  projectIdentity: Readonly<AutopilotProjectAuditIdentity>;
  originalMotionBinding: Readonly<z.infer<typeof bindingSchema>>;
  qualityCertified: false;
}

export type OriginalMotionRenderBindingCheck = OriginalMotionRenderBindingCheckBase & (
  { schema: "editkin.original-motion-render-binding-check/v1"; scope: "same-process-authenticated-commit" }
  | { schema: "editkin.original-motion-render-binding-check/v2"; scope: "protected-user-authenticated-commit";
    authority: Readonly<{ keyId: string; protection: "windows_dpapi_current_user" | "posix_owner_only" }> }
);

function sha(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function expectedFields(input: OriginalMotionRenderBindingExpected) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Original Motion render expected binding is missing");
  const keys = ["planSha256", "projectIdentity", "project", "originalSourceEvidenceSha256"];
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))
    || keys.some(key => { const descriptor = Object.getOwnPropertyDescriptor(input, key); return !descriptor || !("value" in descriptor); })) {
    throw new Error("Original Motion render expected binding cannot contain a caller receipt or unknown fields");
  }
  const project = input.project;
  if (!project || typeof project !== "object" || (project.schemaVersion !== 9 && project.schemaVersion !== 10)
    || !Array.isArray(project.motionScenes) || !project.motionScenes.length
    || !Array.isArray(project.motionGraphics) || !project.motionGraphics.length) {
    throw new Error("Original Motion render requires current saved scenes and graphics");
  }
  const identity = projectIdentitySchema.parse(input.projectIdentity);
  if (identity.id !== project.id || identity.revision !== project.revision || identity.contentSha256 !== sha(project)) {
    throw new Error("Original Motion render current project identity/revision/content is stale");
  }
  return { project, identity, planSha256: digest.parse(input.planSha256),
    originalSourceEvidenceSha256: digest.parse(input.originalSourceEvidenceSha256),
    sceneProjectSha256: sha({ motionScenes: project.motionScenes ?? [], motionGraphics: project.motionGraphics }) };
}

/** Structural/identity comparison after injected trusted authentication. This
 * neither issues an execution receipt nor observes output, art or native state.
 * There is intentionally no verify(receipt, ...) or caller-proof API. */
export function createOriginalMotionRenderBindingVerifier(authority: OriginalMotionRenderBindingAuthority) {
  if (!authority || typeof authority.readAuthenticatedCommittedReceipt !== "function") {
    throw new Error("Original Motion render requires an authenticated committed-receipt reader");
  }
  const read = authority.readAuthenticatedCommittedReceipt.bind(authority);
  return Object.freeze({ async verify(expected: OriginalMotionRenderBindingExpected): Promise<OriginalMotionRenderBindingCheck> {
    const before = expectedFields(expected), identity = Object.freeze({ ...before.identity });
    const receiptInput = await read(identity, before.planSha256);
    const after = expectedFields(expected);
    if (after.project !== before.project || canonicalJson(after.identity) !== canonicalJson(before.identity)
      || after.planSha256 !== before.planSha256 || after.originalSourceEvidenceSha256 !== before.originalSourceEvidenceSha256
      || after.sceneProjectSha256 !== before.sceneProjectSha256) {
      throw new Error("Original Motion render expected project/source changed during authenticated receipt read");
    }
    const receipt = committedProjectionSchema.parse(receiptInput);
    if (receipt.planSha256 !== before.planSha256) throw new Error("Original Motion committed receipt belongs to a different plan");
    if (receipt.projectRevisionAfter !== receipt.projectRevisionBefore + 1
      || receipt.projectRevisionAfter !== identity.revision
      || canonicalJson(receipt.projectIdentityAfter) !== canonicalJson(identity)) {
      throw new Error("Original Motion committed receipt project identity/revision/content is stale");
    }
    const created = Date.parse(receipt.createdAt), committed = Date.parse(receipt.committedAt);
    if (!Number.isFinite(created) || !Number.isFinite(committed) || committed < created) {
      throw new Error("Original Motion committed receipt chronology is invalid");
    }
    const binding = receipt.originalMotionBinding;
    if (binding.originalSourceEvidenceSha256 !== before.originalSourceEvidenceSha256) {
      throw new Error("Original Motion committed source evidence is stale");
    }
    if (binding.sceneProjectSha256 !== before.sceneProjectSha256) throw new Error("Original Motion committed scene objects are stale");
    // This binding is deliberately the full canonical saved project hash,
    // matching projectIdentityAfter. Renderer review-content SHA is separate.
    if (binding.renderContentSha256 !== identity.contentSha256) throw new Error("Original Motion committed project content hash is stale");
    const common = { executionReceiptId: receipt.receiptId, planSha256: receipt.planSha256, projectIdentity: identity,
      originalMotionBinding: Object.freeze({ ...binding }), qualityCertified: false };
    const seal = (receiptInput as Record<string, unknown>).issuerSeal;
    if (seal && typeof seal === "object" && !Array.isArray(seal)
      && (seal as Record<string, unknown>).schema === "editkin.original-motion-commit-seal/v2") {
      const trusted = z.object({ schema: z.literal("editkin.original-motion-commit-seal/v2"), scope: z.literal("protected_user"),
        keyId: digest, protection: z.enum(["windows_dpapi_current_user", "posix_owner_only"]) }).parse(seal);
      return Object.freeze({ ...common, qualityCertified: false, schema: "editkin.original-motion-render-binding-check/v2",
        scope: "protected-user-authenticated-commit", authority: Object.freeze({ keyId: trusted.keyId, protection: trusted.protection }) });
    }
    return Object.freeze({ ...common, qualityCertified: false,
      schema: "editkin.original-motion-render-binding-check/v1", scope: "same-process-authenticated-commit" });
  } });
}
