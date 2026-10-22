import type { SemanticCue } from "./semanticAutoEdit";

/**
 * Whether a recognizer transcript is usable speech for the in-app auto edit (roadmap 1.14). Whisper
 * fills ambient-only footage with sound descriptions, outro boilerplate and noise tokens instead of
 * returning nothing; captioning those would put garbage on a scenic Short. The parser keeps them
 * verbatim (it is not a speech detector); only the auto edit's planning and captions skip them.
 */
export type DiscardedCueReason = "no-content" | "repetition" | "sound-description" | "recognizer-boilerplate";

export interface TranscriptSpeechAssessment {
  /** Cues the auto edit treats as speech: captions and pause trimming use only these. */
  speechCues: SemanticCue[];
  discarded: Array<SemanticCue & { reason: DiscardedCueReason }>;
  /** Seconds covered by speechCues. */
  speechSeconds: number;
  /** False when too little plausible speech remains: the clip is cut by picture instead. */
  usable: boolean;
}

const SOUND_DESCRIPTION = /^[[(（【♪♫*].*[\])）】♪♫*]$/su;
/** A cue that is nothing but a web address ("www.mooji.org" over ambient sound is a classic Whisper artefact). */
const BARE_ADDRESS = /^(?:https?:\/\/)?(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{Script=Latin}{2,}\/?[.。!！]?$/iu;
const BOILERPLATE: readonly RegExp[] = [
  /thanks?\s+(?:you\s+)?(?:(?:so|very)\s+much\s+)?for\s+watching/iu,
  /\bsubscribe\b|\blike\s+and\s+subscribe\b/iu,
  /訂閱|订阅|點贊|点赞|按讚|按赞|구독|チャンネル登録|ご視聴/u,
  /字幕\s*(?:由|by|提供|製作|制作|志願者|志愿者)|amara\.org|字幕組|字幕组/iu,
  /請不吝|请不吝|感謝觀看|感谢观看|謝謝觀看|谢谢观看|感謝收看|感谢收看|謝謝收看|谢谢收看/u,
];

function covered(cues: readonly SemanticCue[]): number {
  let total = 0; let current: { start: number; end: number } | undefined;
  for (const cue of [...cues].sort((left, right) => left.start - right.start)) {
    if (!current) current = { start: cue.start, end: cue.end };
    else if (cue.start <= current.end) current.end = Math.max(current.end, cue.end);
    else { total += current.end - current.start; current = { start: cue.start, end: cue.end }; }
  }
  return total + (current ? current.end - current.start : 0);
}

function discardReason(text: string): DiscardedCueReason | undefined {
  const trimmed = text.normalize("NFKC").trim();
  // Combining marks are not letters: "ន្្្្្្" (product whisper-cli on ambient IMG_3974) is one base letter.
  const content = [...trimmed.replace(/[\p{P}\p{S}\p{Z}\p{Cc}\p{M}�]/gu, "")];
  // A lone CJK character ("好", "對") is a word; a lone Latin letter or symbol residue is not.
  if (!content.length || (content.length === 1 && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}]/u.test(content[0]))) return "no-content";
  if (SOUND_DESCRIPTION.test(trimmed)) return "sound-description";
  const tokens = trimmed.split(/\s+/u);
  if (tokens.length >= 3 && tokens.every((token) => token === tokens[0])) return "repetition";
  if (BARE_ADDRESS.test(trimmed) || BOILERPLATE.some((pattern) => pattern.test(trimmed))) return "recognizer-boilerplate";
  return undefined;
}

// Han and kana are one family: Japanese writes both in one sentence.
const SCRIPTS: ReadonlyArray<[string, RegExp]> = [
  ["han-kana", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u], ["hangul", /\p{Script=Hangul}/u],
  ["latin", /\p{Script=Latin}/u], ["cyrillic", /\p{Script=Cyrillic}/u], ["other", /\p{L}/u],
];

/** Ambient noise decoded as a soup of unrelated languages: three or more scripts and none holding half the letters. */
function mixedScriptNoise(cues: readonly SemanticCue[]): boolean {
  const letters = new Map<string, number>();
  for (const cue of cues) {
    for (const character of cue.text) {
      const script = SCRIPTS.find(([, pattern]) => pattern.test(character))?.[0];
      if (script) letters.set(script, (letters.get(script) ?? 0) + 1);
    }
  }
  const total = [...letters.values()].reduce((sum, count) => sum + count, 0);
  return letters.size >= 3 && Math.max(...letters.values()) < total / 2;
}

export function assessTranscriptSpeech(cues: readonly SemanticCue[], duration: number): TranscriptSpeechAssessment {
  const speechCues: SemanticCue[] = [];
  const discarded: TranscriptSpeechAssessment["discarded"] = [];
  for (const cue of cues) {
    if (!cue.text.trim()) continue;
    const reason = discardReason(cue.text);
    if (reason) discarded.push({ ...cue, reason });
    else speechCues.push(cue);
  }
  const speechSeconds = covered(speechCues);
  // One stray line over ambient sound is not a talking clip (a lone cue must cover a quarter of the clip),
  // and neither is a soup of unrelated languages.
  const clip = Math.max(0, duration);
  const usable = speechCues.length > 0 && speechSeconds >= Math.max(1.5, 0.08 * clip)
    && (speechCues.length >= 2 || speechSeconds >= 0.25 * clip) && !mixedScriptNoise(speechCues);
  return { speechCues, discarded, speechSeconds, usable };
}
