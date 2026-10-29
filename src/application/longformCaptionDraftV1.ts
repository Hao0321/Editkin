import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { canonicalJson } from "../shared/canonicalJson";
import { colorBytesSha } from "./materialColorSamplingRuntime";
import { readLongformWordArtifactV1, readLongformWordWindowV1, type LongformWordRecognitionRuntimeV1 } from "./longformWordRecognitionV1";
import { captionWindows } from "./segmentedCaptions";
import type { LongformTimedWordV1 } from "../domain/longformWordTimingV1";
import { deriveLongformCaptionLinesV1 } from "./longformCaptionLinesV1";
import { TIMED_CAPTION_RULE_LIMITS_V1, type CaptionSourceWordV1 } from "./longformCaptionWordRulesV1";
import { readLongformCaptionSourceTextV1 } from "./longformCaptionSourceTextRuntimeV1";
import type { CaptionSourceTextIssueV1 } from "./longformCaptionSourceTextV1";

export type CaptionDraftRuntimeV1 = Pick<LongformWordRecognitionRuntimeV1, "sourceRoot" | "cacheRoot" | "signal">;
async function policyIdentity() {
  const paths = ["longformCaptionDraftV1.ts", "longformCaptionLinesV1.ts", "longformCaptionWordRulesV1.ts",
    "../domain/longformCaptionLexiconV1.ts", "longformWordRecognitionV1.ts", "longformWordTimingV1.ts",
    "../domain/longformWordTimingV1.ts", "segmentedCaptions.ts", "longformMaterialIntakeV1.ts",
    "longformCaptionSourceTextV1.ts", "longformCaptionSourceTextRuntimeV1.ts"];
  return sha256Canonical(await Promise.all(paths.map(async path => ({ path, sha256: colorBytesSha(await readFile(resolve(import.meta.dirname, path))) }))));
}
export interface CaptionDraftDepsV1 {
  artifact: typeof readLongformWordArtifactV1;
  window: typeof readLongformWordWindowV1;
  identity: () => Promise<string>;
  text: typeof readLongformCaptionSourceTextV1;
}
const production: CaptionDraftDepsV1 = { artifact: readLongformWordArtifactV1, window: readLongformWordWindowV1, identity: policyIdentity, text: readLongformCaptionSourceTextV1 };

/** Read and revalidate the original artifact around a separate, non-applying derivation. */
export async function readLongformCaptionDraftV1(runtime: CaptionDraftRuntimeV1, artifactId: string,
  maxCharacters = 15, offset = 0, limit = 100, deps: CaptionDraftDepsV1 = production) {
  if (!/^[a-f0-9]{64}$/.test(artifactId) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit)
    || limit < 1 || limit > 200 || !Number.isSafeInteger(maxCharacters) || maxCharacters < 2 || maxCharacters > 80)
    throw Error("CAPTION_DRAFT_INPUT_OR_PAGE");
  runtime.signal?.throwIfAborted();
  const policySha256 = await deps.identity(), artifact = await deps.artifact(runtime, artifactId);
  const artifactSignature = canonicalJson(artifact);
  if (!Number.isSafeInteger(artifact.wordCount) || artifact.wordCount < 0 || artifact.wordCount > TIMED_CAPTION_RULE_LIMITS_V1.words)
    throw Error("CAPTION_DRAFT_WORD_BUDGET");
  const narration = artifact.intake.materials.find(row => row.kind === "narration");
  if (!narration) throw Error("CAPTION_DRAFT_NARRATION");
  const plans = captionWindows(narration.duration), words: LongformTimedWordV1[] = [];
  const captionWords: CaptionSourceWordV1[] = [], sourceTextIssues: CaptionSourceTextIssueV1[] = [];
  let sourceTextIssueCount = 0;
  if (artifact.windows.length !== plans.length) throw Error("CAPTION_DRAFT_WINDOW_REFERENCE");
  for (const [index, row] of artifact.windows.entries()) {
    runtime.signal?.throwIfAborted();
    const current = await deps.window(join(resolve(runtime.cacheRoot), "longform-word-timing-v1/windows"),
      row.key, narration.duration, artifact.intake.request.language, plans[index]);
    if (!current || canonicalJson(current.index) !== canonicalJson(row)) throw Error("CAPTION_DRAFT_WINDOW_REFERENCE");
    if (words.length + current.parsed.words.length > TIMED_CAPTION_RULE_LIMITS_V1.words) throw Error("CAPTION_DRAFT_WORD_BUDGET");
    const wordOffset = words.length;
    const projected = await deps.text(join(resolve(runtime.cacheRoot), "longform-word-timing-v1/windows"), current, runtime.signal);
    if (projected.sourceRawSha256 !== row.rawSha256 || projected.words.length !== current.parsed.words.length
      || projected.words.some((word, at) => word.start !== current.parsed.words[at].start || word.end !== current.parsed.words[at].end))
      throw Error("CAPTION_DRAFT_TEXT_CLOCK_REFERENCE");
    for (const word of projected.words) captionWords.push(word);
    sourceTextIssueCount += projected.totalIssues;
    sourceTextIssues.push(...projected.issues.slice(0, Math.max(0, 200 - sourceTextIssues.length)).map(issue => ({ ...issue,
      beforeWordIndex: issue.beforeWordIndex + wordOffset, afterWordIndex: issue.afterWordIndex + wordOffset })));
    for (const word of current.parsed.words) words.push(word);
  }
  if (words.length !== artifact.wordCount) throw Error("CAPTION_DRAFT_WORD_REFERENCE");
  const derived = deriveLongformCaptionLinesV1(captionWords, narration.duration, maxCharacters);
  const wordSourceSha256 = sha256Canonical(words), captionTextSourceSha256 = sha256Canonical(captionWords);
  runtime.signal?.throwIfAborted();
  if (canonicalJson(await deps.artifact(runtime, artifactId)) !== artifactSignature || await deps.identity() !== policySha256)
    throw Error("CAPTION_DRAFT_SOURCE_OR_POLICY_CHANGED");
  const draftId = sha256Canonical({ artifactId, policySha256, wordSourceSha256, captionTextSourceSha256, maxCharacters });
  return { schema: "editkin.longform-caption-draft-page/v1" as const,
    binding: { wordArtifactId: artifactId, draftId, policySha256, wordSourceSha256, captionTextSourceSha256 },
    clock: "narration_local_seconds" as const, narrationSourceStart: narration.sourceStart,
    maxCharacters, sourceWords: words.length, originalAsrIssueCount: artifact.issueCount,
    sourceTextIssueCount, sourceTextIssues, sourceTextIssuesTruncated: sourceTextIssueCount > sourceTextIssues.length,
    totalLines: derived.lines.length, offset,
    lines: derived.lines.slice(offset, offset + limit).map((line, index) => ({ lineIndex: offset + index, ...line })),
    nextOffset: offset + limit < derived.lines.length ? offset + limit : null,
    totalLineIssues: derived.issues.length,
    issues: derived.issues.filter(issue => issue.lineIndex >= offset && issue.lineIndex < offset + limit),
    correctionSummary: { total: derived.derived.totalCorrections, removedSourceWords: derived.derived.removedSourceWordIndices.length,
      overlappingSourceWords: derived.derived.overlappingSourceWords },
    contentVerified: false as const, requiresEditorReview: true as const, syntheticTimingUsed: false as const,
    projectModified: false as const, boundary: "derived_caption_lines_only_not_project_commands_or_authorization" as const };
}
