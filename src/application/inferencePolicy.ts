import { createHash } from "node:crypto";
import * as z from "zod/v4";

export const AUTOPILOT_INFERENCE_SCHEMA = "hao.video-autopilot.inference-route/v1" as const;
export const AUTOPILOT_CONTEXT_PROTOCOL = "markdown-router+json-contract/v1" as const;

export const reasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max", "unknown"]);
export const inferenceTaskClassSchema = z.enum(["bulk_analysis", "rough_cut", "editorial_plan", "quality_critical", "contract_audit"]);
export const inferencePrioritySchema = z.enum(["economy", "balanced", "quality"]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

export const inferenceRunSchema = z.strictObject({
  schema: z.literal(AUTOPILOT_INFERENCE_SCHEMA),
  provider: z.enum(["codex", "claude_code", "other"]),
  modelId: z.string().trim().min(1).max(128),
  modelTier: z.enum(["frontier", "balanced", "efficient", "unknown"]),
  reasoningEffort: reasoningEffortSchema,
  taskClass: inferenceTaskClassSchema,
  priority: inferencePrioritySchema,
  context: z.strictObject({
    protocol: z.literal(AUTOPILOT_CONTEXT_PROTOCOL),
    markdownRouterSha256: sha256Schema,
    packetTokens: z.number().int().min(1).max(1_100),
    progressiveDisclosure: z.literal(true),
    structuredExecutionTruth: z.literal(true),
  }),
  evaluation: z.strictObject({
    state: z.enum(["unmeasured", "diagnostic", "measured"]),
    suiteId: z.string().trim().min(1).max(128).optional(),
    receiptSha256: sha256Schema.optional(),
  }),
  safeguards: z.strictObject({
    semanticAuditRequired: z.literal(true),
    automaticEscalationOnBlock: z.literal(true),
    executionMode: z.enum(["direct_apply", "audit_then_apply", "plan_only"]),
    secondPassRequired: z.boolean(),
    humanReviewRequired: z.literal(true),
  }),
}).superRefine((run, context) => {
  if (run.evaluation.state === "measured" && (!run.evaluation.suiteId || !run.evaluation.receiptSha256)) {
    context.addIssue({ code: "custom", path: ["evaluation"], message: "measured model profile 必須綁定 suiteId 與 receiptSha256" });
  }
  if (run.evaluation.state !== "measured" && run.safeguards.executionMode === "direct_apply") {
    context.addIssue({ code: "custom", path: ["safeguards", "executionMode"], message: "未量測 model profile 不得 direct_apply" });
  }
  if (["editorial_plan", "quality_critical", "contract_audit"].includes(run.taskClass) && !run.safeguards.secondPassRequired) {
    context.addIssue({ code: "custom", path: ["safeguards", "secondPassRequired"], message: `${run.taskClass} 必須執行第二次語意複核` });
  }
  if (run.taskClass === "quality_critical" && run.safeguards.executionMode !== "audit_then_apply") {
    context.addIssue({ code: "custom", path: ["safeguards", "executionMode"], message: "quality_critical 必須 audit_then_apply" });
  }
});

export type InferenceRun = z.infer<typeof inferenceRunSchema>;
export type InferenceTaskClass = z.infer<typeof inferenceTaskClassSchema>;
export type InferencePriority = z.infer<typeof inferencePrioritySchema>;

export interface InferenceRecommendation {
  preferred: { modelId: string; reasoningEffort: Exclude<z.infer<typeof reasoningEffortSchema>, "unknown"> };
  fallbacks: Array<{ modelId: string; reasoningEffort: Exclude<z.infer<typeof reasoningEffortSchema>, "unknown"> }>;
  secondPassRequired: boolean;
  executionMode: "audit_then_apply" | "plan_only";
  claimState: "official_positioning_only_quality_unmeasured";
}

export function recommendInferenceRoute(taskClass: InferenceTaskClass, priority: InferencePriority): InferenceRecommendation {
  const qualityCritical = taskClass === "quality_critical" || taskClass === "contract_audit";
  if (qualityCritical || priority === "quality") {
    return {
      preferred: { modelId: "gpt-5.6-sol", reasoningEffort: qualityCritical ? "xhigh" : "high" },
      fallbacks: [{ modelId: "gpt-5.6-sol", reasoningEffort: "medium" }, { modelId: "gpt-5.6-terra", reasoningEffort: "high" }],
      secondPassRequired: true,
      executionMode: "audit_then_apply",
      claimState: "official_positioning_only_quality_unmeasured",
    };
  }
  if (taskClass === "bulk_analysis" || priority === "economy") {
    return {
      preferred: { modelId: "gpt-5.6-luna", reasoningEffort: "medium" },
      fallbacks: [{ modelId: "gpt-5.6-terra", reasoningEffort: "low" }, { modelId: "gpt-5.6-sol", reasoningEffort: "low" }],
      secondPassRequired: false,
      executionMode: "audit_then_apply",
      claimState: "official_positioning_only_quality_unmeasured",
    };
  }
  if (taskClass === "editorial_plan") {
    return {
      preferred: { modelId: "gpt-5.6-sol", reasoningEffort: "medium" },
      fallbacks: [{ modelId: "gpt-5.6-terra", reasoningEffort: "high" }, { modelId: "gpt-5.6-sol", reasoningEffort: "low" }],
      secondPassRequired: true,
      executionMode: "audit_then_apply",
      claimState: "official_positioning_only_quality_unmeasured",
    };
  }
  return {
    preferred: { modelId: "gpt-5.6-terra", reasoningEffort: "medium" },
    fallbacks: [{ modelId: "gpt-5.6-luna", reasoningEffort: "high" }, { modelId: "gpt-5.6-sol", reasoningEffort: "low" }],
    secondPassRequired: false,
    executionMode: "audit_then_apply",
    claimState: "official_positioning_only_quality_unmeasured",
  };
}

export function renderInferenceRouterMarkdown(taskClass: InferenceTaskClass, priority: InferencePriority): string {
  const route = recommendInferenceRoute(taskClass, priority);
  return [
    "# Editkin bounded task router",
    "",
    `- Task: ${taskClass}`,
    `- Priority: ${priority}`,
    `- Preferred: ${route.preferred.modelId} / ${route.preferred.reasoningEffort}`,
    `- Second semantic pass: ${route.secondPassRequired ? "required" : "optional"}`,
    "",
    "## Invariants",
    "",
    "- Load only the routed context packet and selected memory IDs.",
    "- Treat source evidence as truth; never invent facts, tracks, mattes, rights, or human approval.",
    "- Return the current Editkin JSON plan contract. Markdown explains intent; JSON is the execution truth.",
    "- Run audit_autopilot_plan before apply_autopilot_plan. On BLOCK, repair or escalate; never bypass the gate.",
    "- Every output remains REVIEW_REQUIRED until human review.",
  ].join("\n");
}

export function inferenceRouterSha256(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

export function summarizeInference(run: InferenceRun) {
  return {
    provider: run.provider,
    modelId: run.modelId,
    modelTier: run.modelTier,
    reasoningEffort: run.reasoningEffort,
    taskClass: run.taskClass,
    priority: run.priority,
    evaluationState: run.evaluation.state,
    executionMode: run.safeguards.executionMode,
    secondPassRequired: run.safeguards.secondPassRequired,
    contextProtocol: run.context.protocol,
  };
}
