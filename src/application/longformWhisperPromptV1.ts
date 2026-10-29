import { createHash } from "node:crypto";
import type { LongformWordTimingRequestV1 } from "../domain/longformWordTimingV1";
import { LONGFORM_CAPTION_LEXICON_V1 } from "../domain/longformCaptionLexiconV1";

export const LONGFORM_WHISPER_PROMPT_LIMITS_V1 = Object.freeze({ customCharacters: 256, resolvedUtf8Bytes: 224 });
export const LONGFORM_WHISPER_VOCABULARY_V1 = Object.freeze(
  [...new Set(LONGFORM_CAPTION_LEXICON_V1.fixes.map(([, replacement]) => replacement).filter(Boolean))]);
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export interface LongformWhisperPromptV1 {
  schema: "editkin.longform-whisper-initial-prompt/v1";
  text: string; textSha256: string; canonicalVocabularySha256: string;
  canonicalVocabularyIncluded: boolean; callerPromptIncluded: boolean;
  runtimeTokenCoverageVerified: false;
}

/** Short literal context for the existing recognizer, not transcript or timing evidence.
 * UTF-8 bytes are bounded; the decoder's actual token coverage is not measured here. */
export function resolveLongformWhisperPromptV1(language: LongformWordTimingRequestV1["language"], initialPrompt?: string): Readonly<LongformWhisperPromptV1> {
  if (!["auto", "zh", "en", "es", "ja", "ko"].includes(language)) throw Error("WORD_TIMING_PROMPT_LANGUAGE");
  if (initialPrompt !== undefined && (typeof initialPrompt !== "string" || !initialPrompt.trim()
    || initialPrompt.length > LONGFORM_WHISPER_PROMPT_LIMITS_V1.customCharacters
    || /[\uD800-\uDFFF]/u.test(initialPrompt) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(initialPrompt)))
    throw Error("WORD_TIMING_PROMPT_TEXT");
  const canonicalVocabularyIncluded = language === "zh";
  const text = [initialPrompt?.trim(), canonicalVocabularyIncluded ? LONGFORM_WHISPER_VOCABULARY_V1.join(", ") : ""]
    .filter(Boolean).join("\n");
  if (Buffer.byteLength(text, "utf8") > LONGFORM_WHISPER_PROMPT_LIMITS_V1.resolvedUtf8Bytes) throw Error("WORD_TIMING_PROMPT_BUDGET");
  return Object.freeze({ schema: "editkin.longform-whisper-initial-prompt/v1", text, textSha256: hash(text),
    canonicalVocabularySha256: hash(JSON.stringify(LONGFORM_WHISPER_VOCABULARY_V1)), canonicalVocabularyIncluded,
    callerPromptIncluded: initialPrompt !== undefined, runtimeTokenCoverageVerified: false });
}

export function longformWhisperPromptArgumentsV1(prompt: Readonly<LongformWhisperPromptV1>, help: string): string[] {
  if (!prompt.text) return [];
  if (!/^\s*(?:-\S+,\s*)?--prompt(?=\s|$)/m.test(help)) throw Error("WORD_TIMING_RUNTIME_PROMPT_MISSING");
  return ["--prompt", prompt.text];
}
