import * as z from "zod/v4";
import type { AestheticReviewPolicy } from "./types";

// Match the canonical Python policy's Unicode character budget and normalization.
const authorization = z.string().refine(value => [...value].length <= 2000, "Authorization exceeds 2000 characters")
  .transform(value => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, ""));
export const reviewPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("human"), authorization: authorization.optional() }),
  z.strictObject({ mode: z.literal("agent_reference_comparison"), authorization: authorization.refine(value => value.length > 0, "Agent review requires creator authorization") }),
]);

export function normalizeReviewPolicy(input?: unknown): AestheticReviewPolicy {
  const policy = reviewPolicySchema.parse(input === undefined ? { mode: "human" } : input);
  return policy.mode === "human" && !policy.authorization ? { mode: "human" } : policy;
}

export function reviewPolicyActor(policy: AestheticReviewPolicy): "agent" | "human" {
  return policy.mode === "agent_reference_comparison" ? "agent" : "human";
}
