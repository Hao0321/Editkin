import { Converter } from "opencc-js/cn2t";
import type { CaptionScript, CaptionScriptConversion } from "./automaticCaptionTypes";

/** Whisper often writes Taiwanese Mandarin in Simplified characters. Editkin is a
 * Taiwan product, so Chinese caption text defaults to Taiwan Traditional for every
 * UI locale; "original" keeps the recognizer's characters. */
export const DEFAULT_CAPTION_SCRIPT: CaptionScript = "zh-TW";

export function captionScriptTarget(value: unknown): CaptionScript {
  if (value === undefined) return DEFAULT_CAPTION_SCRIPT;
  if (value === "zh-TW" || value === "original") return value;
  throw new Error("自動字幕文字轉換只支援 zh-TW 或 original");
}

/** Requested Mandarin Chinese, any region/script subtag (zh, zh-TW, zh-Hant, cmn…). */
export function isChineseCaptionLanguage(language: string): boolean {
  return /^(?:zh|cmn)(?:-|$)/i.test(language);
}

const KANA_OR_HANGUL = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN = /\p{Script=Han}/u;
const HAN_ALL = /\p{Script=Han}/gu;
/** One unit per run of non-Han letters, so an English term counts like one word. */
const OTHER_LETTER_RUNS = /[^\P{L}\p{Script=Han}]+/gu;

/** Kanji/hanja alone cannot tell Chinese from Japanese/Korean. The transcript must be
 * Han-dominant, and kana/hangul lines must be a minority of its CJK lines (a stray
 * hallucinated Japanese/Korean line is tolerated; that line itself is never converted). */
export function looksLikeChineseCaptionText(texts: readonly string[]): boolean {
  let han = 0, otherRuns = 0, cjkLines = 0, kanaOrHangulLines = 0;
  for (const text of texts) {
    han += text.match(HAN_ALL)?.length ?? 0;
    otherRuns += text.match(OTHER_LETTER_RUNS)?.length ?? 0;
    const kanaOrHangul = KANA_OR_HANGUL.test(text);
    if (kanaOrHangul || HAN.test(text)) cjkLines += 1;
    if (kanaOrHangul) kanaOrHangulLines += 1;
  }
  return han > 0 && kanaOrHangulLines * 2 < cjkLines && han / (han + otherRuns) >= 0.3;
}

let s2twp: ((text: string) => string) | undefined;
const TAI_PROBE = "";

/** OpenCC s2twp, except an input 台 stays 台 where s2twp only maps that character
 * to 臺 (台灣, 一台車): everyday Taiwan usage, and already-Traditional text stays as is.
 * Each 台 is probed with a private-use placeholder; it is kept only when the rest of
 * the output is identical, so phrase conversions such as 台风→颱風 are kept. */
export function convertCaptionTextToTaiwan(text: string): string {
  s2twp ??= Converter({ from: "cn", to: "twp" });
  const converted = s2twp(text);
  if (!text.includes("台") || !converted.includes("臺") || text.includes(TAI_PROBE)) return converted;
  const output = converted.split("");
  for (let index = text.indexOf("台"); index >= 0; index = text.indexOf("台", index + 1)) {
    const probe = s2twp(`${text.slice(0, index)}${TAI_PROBE}${text.slice(index + 1)}`);
    const at = probe.indexOf(TAI_PROBE);
    if (at >= 0 && probe.lastIndexOf(TAI_PROBE) === at && converted[at] === "臺"
      && `${probe.slice(0, at)}臺${probe.slice(at + 1)}` === converted) output[at] = "台";
  }
  return output.join("");
}

/** `language` is the requested language. A cue that contains kana/hangul is never
 * converted; translation lines are not touched. */
export function convertCaptionCuesScript<T extends { text: string }>(
  cues: readonly T[], language: string, script: CaptionScript,
): { cues: T[]; scriptConversion?: CaptionScriptConversion } {
  if (script === "original" || !cues.length) return { cues: [...cues] };
  const chinese = isChineseCaptionLanguage(language)
    || (language === "auto" && looksLikeChineseCaptionText(cues.map((cue) => cue.text)));
  if (!chinese) return { cues: [...cues] };
  return {
    cues: cues.map((cue) => {
      if (KANA_OR_HANGUL.test(cue.text)) return cue;
      const text = convertCaptionTextToTaiwan(cue.text);
      return text === cue.text ? cue : { ...cue, text };
    }),
    scriptConversion: "s2twp",
  };
}
