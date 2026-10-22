import * as z from "zod/v4";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(16384).refine(value => !value.includes("\0"));
const media = z.strictObject({ id: z.string().min(1).max(160), path,
  sourceStart: z.number().nonnegative(), duration: z.number().positive().max(86400),
  expectedSha256: sha256.optional() });
export const longformWordTimingRequestV1Schema = z.strictObject({
  schema: z.literal("editkin.longform-word-timing-request/v1"),
  narration: media,
  script: z.union([
    z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(500000) }),
    z.strictObject({ kind: z.literal("file"), path }),
    z.strictObject({ kind: z.literal("paragraphs"), paragraphs: z.array(z.strictObject({
      id: z.string().min(1).max(160), text: z.string().min(1).max(20000),
    })).min(1).max(1024) }),
  ]),
  recordings: z.array(media).max(256),
  screenshots: z.array(z.strictObject({ id: z.string().min(1).max(160), path, expectedSha256: sha256.optional() })).max(512),
  language: z.enum(["auto", "zh", "en", "es", "ja", "ko"]),
  initialPrompt: z.string().min(1).max(256).optional(),
  whisperModel: z.enum(["small", "medium"]).optional(),
}).superRefine((value, context) => {
  const ids = [value.narration.id, ...value.recordings.map(row => row.id), ...value.screenshots.map(row => row.id)];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Duplicate material identity" });
  if (value.script.kind === "paragraphs" && new Set(value.script.paragraphs.map(row => row.id)).size !== value.script.paragraphs.length)
    context.addIssue({ code: "custom", path: ["script"], message: "Duplicate paragraph identity" });
});
export type LongformWordTimingRequestV1 = z.infer<typeof longformWordTimingRequestV1Schema>;

export const LONGFORM_WORD_TIMING_V1 = Object.freeze({
  schema: "editkin.longform-word-timing/v1", clock: "narration_local_seconds",
  recognizerFormat: "whisper.cpp.full-json", coreSeconds: 30, contextSeconds: 2,
  maximumWindowJsonBytes: 16 * 1024 * 1024, maximumWindowTokens: 8192,
  timingAuthority: "recognizer_token_offsets_milliseconds", syntheticTimingAllowed: false,
  contentVerification: "UNVERIFIED_REQUIRES_EDITOR_REVIEW", newModelRequired: false,
} as const);

export interface LongformWordTimingWindowV1 {
  index: number; start: number; coreStart: number; coreEnd: number; duration: number;
}
export interface LongformTimedWordV1 {
  text: string; start: number; end: number; confidence: number;
  windowIndex: number; segmentIndex: number; characterStart: number; characterEnd: number;
  tokenIndices: number[]; sharedTokenRange: boolean;
}
export interface LongformWordTimingIssueV1 {
  code: "SEGMENT_RANGE" | "TOKEN_RANGE" | "TOKEN_TEXT_MISMATCH" | "INVALID_UNICODE"
    | "UNTIMED_WORD" | "SHARED_TOKEN_RANGE" | "OVERLAPPING_WORDS";
  windowIndex: number; segmentIndex: number; tokenIndex?: number; text?: string;
}
export interface LongformParsedWordWindowV1 {
  schema: "editkin.longform-word-window/v1";
  clock: "narration_local_seconds"; window: LongformWordTimingWindowV1;
  rawJsonSha256: string; words: LongformTimedWordV1[]; issues: LongformWordTimingIssueV1[];
  segments: Array<{ text: string; start: number; end: number }>;
  requiresReview: boolean; syntheticTimingUsed: false;
}
