import { normalizeReviewPolicy, reviewPolicyActor } from "../domain/reviewPolicy";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import type { AestheticReviewPolicy } from "../domain/types";

// Deliberately incomplete review, used by plan-binding unit fixtures.
export function testDesignReviewEnvelope(input?: AestheticReviewPolicy) {
  const policy = normalizeReviewPolicy(input), policySha256 = sha256Canonical(policy), actor = reviewPolicyActor(policy);
  return { reviewPolicy: policy, reviewPolicySha256: policySha256,
    context: { review: { policy, policySha256, actor, checkpoint: actor === "agent" ? "agent_review" : "human_review", required: true, completed: false } } };
}
