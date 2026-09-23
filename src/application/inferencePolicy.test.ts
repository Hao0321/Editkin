import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_CONTEXT_PROTOCOL,
  AUTOPILOT_INFERENCE_SCHEMA,
  inferenceRouterSha256,
  inferenceRunSchema,
  recommendInferenceRoute,
  renderInferenceRouterMarkdown,
} from "./inferencePolicy";

function runFixture() {
  const markdown = renderInferenceRouterMarkdown("editorial_plan", "balanced");
  return {
    schema: AUTOPILOT_INFERENCE_SCHEMA,
    provider: "codex",
    modelId: "gpt-5.6-sol",
    modelTier: "frontier",
    reasoningEffort: "medium",
    taskClass: "editorial_plan",
    priority: "balanced",
    context: {
      protocol: AUTOPILOT_CONTEXT_PROTOCOL,
      markdownRouterSha256: inferenceRouterSha256(markdown),
      packetTokens: 720,
      progressiveDisclosure: true,
      structuredExecutionTruth: true,
    },
    evaluation: { state: "unmeasured" },
    safeguards: {
      semanticAuditRequired: true,
      automaticEscalationOnBlock: true,
      executionMode: "audit_then_apply",
      secondPassRequired: true,
      humanReviewRequired: true,
    },
  } as const;
}

describe("model-adaptive inference policy", () => {
  it("uses Markdown for bounded routing and JSON for execution truth", () => {
    const run = inferenceRunSchema.parse(runFixture());
    expect(run.context.protocol).toBe("markdown-router+json-contract/v1");
    expect(run.context.markdownRouterSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("routes quality work to a second-pass quality profile without claiming measured superiority", () => {
    const route = recommendInferenceRoute("quality_critical", "quality");
    expect(route.preferred).toEqual({ modelId: "gpt-5.6-sol", reasoningEffort: "xhigh" });
    expect(route.secondPassRequired).toBe(true);
    expect(route.claimState).toBe("official_positioning_only_quality_unmeasured");
  });

  it("never lets an unmeasured model direct-apply or skip a critical second pass", () => {
    expect(() => inferenceRunSchema.parse({ ...runFixture(), safeguards: { ...runFixture().safeguards, executionMode: "direct_apply" } })).toThrow(/direct_apply/);
    expect(() => inferenceRunSchema.parse({ ...runFixture(), safeguards: { ...runFixture().safeguards, secondPassRequired: false } })).toThrow(/第二次/);
  });

  it("requires provenance before a model profile can be called measured", () => {
    expect(() => inferenceRunSchema.parse({ ...runFixture(), evaluation: { state: "measured" } })).toThrow(/suiteId/);
  });
});
