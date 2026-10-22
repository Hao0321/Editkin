import * as z from "zod/v4";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const boundedIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/i);

/** Longest stored review/outcome note, in UTF-16 code units. */
export const AUTOPILOT_OUTCOME_NOTE_MAX = 1_000;
/** Appended to a shortened note so readers can tell text was cut. */
export const AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER = "…［已截斷］";
const graphemeSegmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

/**
 * Trims the note and, when it is still longer than the limit, cuts it at a grapheme (hence code-point) boundary and
 * appends the truncation marker. An over-long note must never fail the whole learning event.
 */
export function truncateAutopilotOutcomeNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length <= AUTOPILOT_OUTCOME_NOTE_MAX) return trimmed;
  const budget = AUTOPILOT_OUTCOME_NOTE_MAX - AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER.length;
  let end = 0;
  if (graphemeSegmenter) {
    // Only the region around the cut needs segmenting; a cluster crossing the budget is dropped whole.
    for (const { index, segment } of graphemeSegmenter.segment(trimmed.slice(0, budget + 64))) {
      if (index + segment.length > budget) break;
      end = index + segment.length;
    }
  } else {
    end = budget;
    const last = trimmed.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return `${trimmed.slice(0, end).trimEnd()}${AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER}`;
}

const outcomeNoteSchema = z.string()
  .describe(`審片／成效備註；超過 ${AUTOPILOT_OUTCOME_NOTE_MAX} 個 UTF-16 字元會在字元邊界自動截斷並加上「${AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER}」，不會讓整筆紀錄失敗。`)
  .transform(truncateAutopilotOutcomeNote)
  .pipe(z.string().max(AUTOPILOT_OUTCOME_NOTE_MAX));

export const autopilotOutcomeSchema = z.strictObject({
  schema: z.literal("hao.video-autopilot.learning-event/v1"),
  planSha256: sha256Schema,
  checkpoint: z.enum(["human_review", "agent_review", "D2", "D7", "D28"]),
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
    note: outcomeNoteSchema,
    reviewer: z.enum(["human", "agent"]).optional(),
    evidenceSha256: sha256Schema.optional(),
  }),
}).superRefine((event, context) => {
  if (new Set(event.selectedMemoryRuleIds).size !== event.selectedMemoryRuleIds.length) {
    context.addIssue({ code: "custom", path: ["selectedMemoryRuleIds"], message: "memory rule id 不可重複" });
  }
  if (event.checkpoint === "agent_review" && (event.review.reviewer !== "agent" || !event.review.evidenceSha256)) {
    context.addIssue({ code: "custom", path: ["review"], message: "agent_review requires an agent reviewer and artifact-bound evidence receipt" });
  }
  if (event.checkpoint === "human_review" && event.review.reviewer === "agent") {
    context.addIssue({ code: "custom", path: ["review", "reviewer"], message: "agent review must never be recorded as human approval" });
  }
  if (!["human_review", "agent_review"].includes(event.checkpoint) && Object.keys(event.metrics).length === 0) {
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
