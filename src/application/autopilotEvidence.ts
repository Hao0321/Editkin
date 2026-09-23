import * as z from "zod/v4";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const boundedIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/i);

export const autopilotOutcomeSchema = z.strictObject({
  schema: z.literal("hao.video-autopilot.learning-event/v1"),
  planSha256: sha256Schema,
  checkpoint: z.enum(["human_review", "D2", "D7", "D28"]),
  platform: z.enum(["youtube", "youtube_shorts", "instagram_reels", "archive"]),
  artifactId: boundedIdSchema,
  selectedMemoryRuleIds: z.array(z.string().regex(/^(?:M\d{1,4}|K-[a-f0-9]{12})$/i)).max(6),
  metrics: z.strictObject({
    impressions: z.number().int().nonnegative().optional(),
    views: z.number().int().nonnegative().optional(),
    watchTimeSeconds: z.number().nonnegative().optional(),
    averageViewDurationSeconds: z.number().nonnegative().optional(),
    averagePercentageViewed: z.number().min(0).max(100).optional(),
    clickThroughRatePercent: z.number().min(0).max(100).optional(),
    first30SecondRetentionPercent: z.number().min(0).max(100).optional(),
  }),
  review: z.strictObject({
    accepted: z.boolean(),
    severeError: z.boolean(),
    note: z.string().trim().max(1_000),
  }),
}).superRefine((event, context) => {
  if (new Set(event.selectedMemoryRuleIds).size !== event.selectedMemoryRuleIds.length) {
    context.addIssue({ code: "custom", path: ["selectedMemoryRuleIds"], message: "memory rule id 不可重複" });
  }
  if (event.checkpoint !== "human_review" && Object.keys(event.metrics).length === 0) {
    context.addIssue({ code: "custom", path: ["metrics"], message: `${event.checkpoint} 必須至少提供一項平台指標` });
  }
});

export type AutopilotOutcome = z.infer<typeof autopilotOutcomeSchema>;

export interface AutopilotReceiptPayload {
  schema: "hao.video-autopilot.execution-receipt/v1";
  state: "pending" | "committed";
  receiptId: string;
  projectRevisionBefore: number;
  projectRevisionAfter?: number;
  planSchema: string;
  planSha256: string;
  source: unknown;
  route: unknown;
  budget: unknown;
  coverage: unknown;
  quality: { inputState: string; outputState: "review_required"; certified: false };
  createdAt: string;
  committedAt?: string;
}

export function learningHandoff(outcome: AutopilotOutcome, attribution?: {
  executionReceiptId: string;
  skillSelectionReceiptSha256: string;
  selectedSkills: Array<{ skillId: string; manifestSha256: string; packSha256: string }>;
}) {
  return {
    schema: outcome.schema,
    checkpoint: outcome.checkpoint,
    planSha256: outcome.planSha256,
    selectedMemoryRuleIds: outcome.selectedMemoryRuleIds,
    attribution,
    instruction: "Route this immutable event through the current video-autopilot Learn/Outcome lifecycle. Do not auto-promote a rule from a single event.",
  };
}
