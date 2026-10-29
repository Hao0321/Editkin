import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import { REFERENCE_MOTION_VIDEO_TYPES } from "../motion/referenceMotionTemplates";

/** M1 one-tool Short (design: .rd/benchmarks/usable-v1-20261009/M1_ONE_TOOL_SHORT_DESIGN.md §3, §6.1 Q1/Q2).
 * The creator's brief is small and flat; every check here runs before anything beyond the bootstrap is written.
 * Browser-safe: the in-app dialog imports the same limits, glyph rule and number tokenizer. */
export const TEMPLATE_SHORT_START_SCHEMA = "editkin.template-short-start/v1" as const;
export const TEMPLATE_SHORT_BRIEF_SCHEMA = "editkin.template-short-brief/v1" as const;
export const TEMPLATE_SHORT_LOOK_SCHEMA = "editkin.template-short-look/v1" as const;
/** Measured on canonical UTF-8 JSON (canonicalJson), never on the caller's formatting. */
export const TEMPLATE_SHORT_START_MAX_BYTES = 512;
export const TEMPLATE_SHORT_BRIEF_MAX_BYTES = 1024;
export const TEMPLATE_SHORT_WINDOW_SECONDS = { min: 5, max: 15 } as const;
/** v1 families: selectable by copy shape (a hook, or 2–4 points). */
export const TEMPLATE_SHORT_FAMILIES = ["strike_reframe", "context_stack"] as const;
export type TemplateShortFamily = typeof TEMPLATE_SHORT_FAMILIES[number];
export type TemplateShortGenre = keyof typeof REFERENCE_MOTION_VIDEO_TYPES;
export const TEMPLATE_SHORT_GENRE_IDS = Object.keys(REFERENCE_MOTION_VIDEO_TYPES) as [TemplateShortGenre, ...TemplateShortGenre[]];
export const TEMPLATE_SHORT_ID_PATTERN = /^ts-\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{6}$/;

export type TemplateShortBlockCode = "BLOCK_START" | "BLOCK_BRIEF" | "BLOCK_COPY_GLYPH" | "BLOCK_UNVIEWED_FRAME" | "BLOCK_UNSUPPORTED_NUMBER"
  | "BLOCK_TEMPLATE" | "BLOCK_TEMPLATE_BEATS" | "BLOCK_TEMPLATE_QA" | "BLOCK_COMPOSE" | "BLOCK_DISK" | "BLOCK_AUDIT";
/** A run status BLOCK (§10): nothing beyond the bootstrap was written; `field` lets the dialog mark the input. */
export class TemplateShortBlockError extends Error {
  readonly status = "BLOCK" as const;
  constructor(readonly code: TemplateShortBlockCode, readonly detail: string, readonly field?: string) {
    super(`${code}: ${detail}`);
    this.name = "TemplateShortBlockError";
  }
}

const keyframeId = z.string().regex(/^kf-[1-9]\d{0,2}$/);
// ≤64 so the plan's `<shortId>-portrait` delivery variant stays within the 80-character editorial id.
const shortId = z.string().max(64).regex(TEMPLATE_SHORT_ID_PATTERN);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const seconds = z.number().nonnegative().max(86_400);
const copyText = (max: number) => z.string().trim().min(1).max(max);
const unit = z.number().min(0).max(1);
const extent = z.number().positive().max(1);

/** Call 1 (≤512 B) or its frame-page continuation `{schema, shortId, framePage}`, which creates nothing. */
export const templateShortStartSchema = z.strictObject({
  schema: z.literal(TEMPLATE_SHORT_START_SCHEMA),
  source: z.strictObject({ path: z.string().trim().min(1).max(1_024), in: seconds.optional(), out: seconds.optional() }).optional(),
  genre: z.enum(TEMPLATE_SHORT_GENRE_IDS).optional(),
  speech: z.enum(["auto", "none"]).optional(),
  shortId: shortId.optional(),
  framePage: z.number().int().min(2).max(64).optional(),
}).superRefine((value, context) => {
  if (value.shortId !== undefined || value.framePage !== undefined) {
    if (value.shortId === undefined || value.framePage === undefined || value.source || value.genre || value.speech) {
      context.addIssue({ code: "custom", message: "續看畫面只接受 shortId 與 framePage" });
    }
  } else if (!value.source || !value.genre) context.addIssue({ code: "custom", message: "start 需要 source 與 genre" });
  if (value.source?.in !== undefined && value.source.out !== undefined && value.source.out <= value.source.in) {
    context.addIssue({ code: "custom", path: ["source", "out"], message: "source.out 必須大於 source.in" });
  }
});
export type TemplateShortStart = z.output<typeof templateShortStartSchema>;

/** Limits are the template input's own (referenceMotionTemplateInputSchema): UTF-16 units, tag in code points. */
export const TEMPLATE_SHORT_COPY_LIMITS = { hook: 24, payoff: 32, accent: 12, proof: 40, place: 24, tag: 8, pointLabel: 24, pointDetail: 40,
  minPoints: 2, maxPoints: 4 } as const;
export const templateShortCopySchema = z.strictObject({
  hook: copyText(TEMPLATE_SHORT_COPY_LIMITS.hook).optional(),
  payoff: copyText(TEMPLATE_SHORT_COPY_LIMITS.payoff),
  accent: copyText(TEMPLATE_SHORT_COPY_LIMITS.accent).optional(),
  proof: copyText(TEMPLATE_SHORT_COPY_LIMITS.proof).optional(),
  place: copyText(TEMPLATE_SHORT_COPY_LIMITS.place).optional(),
  tag: copyText(16).refine(value => Array.from(value).length <= TEMPLATE_SHORT_COPY_LIMITS.tag, "copy.tag 最多 8 字").optional(),
  points: z.array(z.strictObject({ label: copyText(TEMPLATE_SHORT_COPY_LIMITS.pointLabel), detail: copyText(TEMPLATE_SHORT_COPY_LIMITS.pointDetail).optional() }))
    .min(TEMPLATE_SHORT_COPY_LIMITS.minPoints).max(TEMPLATE_SHORT_COPY_LIMITS.maxPoints).optional(),
});
export type TemplateShortCopy = z.output<typeof templateShortCopySchema>;
export type TemplateShortCopyField = keyof TemplateShortCopy;

/** `creator:<workspace-relative path>#<anchor>`: a creator-owned file that must contain the number it backs (M10). */
export function parseCreatorFactRef(ref: string): { path: string; anchor: string } | undefined {
  const match = /^creator:([^#]+)#([^#]+)$/.exec(ref);
  if (!match || match[1].trim() !== match[1] || match[2].trim() !== match[2]) return undefined;
  const segments = match[1].split(/[\\/]/);
  if (/^[a-z]:/i.test(match[1]) || segments.some(segment => !segment || segment === "." || segment === "..")) return undefined;
  return { path: match[1], anchor: match[2] };
}

/** Call 2 (≤1,024 B). `{schema, shortId, resume:true}` continues an interrupted job and carries nothing else. */
export const templateShortBriefSchema = z.strictObject({
  schema: z.literal(TEMPLATE_SHORT_BRIEF_SCHEMA),
  shortId,
  seen: z.array(z.strictObject({ kf: keyframeId, note: z.string().trim().min(1).max(48) })).min(1).max(4).optional(),
  copy: templateShortCopySchema.optional(),
  topic: z.string().trim().min(1).max(120).optional(),
  family: z.enum(TEMPLATE_SHORT_FAMILIES).optional(),
  // Only with `seen`: a subject rectangle comes from looking at the served frames.
  focus: z.strictObject({ x: unit, y: unit, w: extent, h: extent })
    .refine(rect => rect.x + rect.w <= 1 + 1e-9 && rect.y + rect.h <= 1 + 1e-9, "focus 超出畫面").optional(),
  facts: z.array(z.strictObject({ text: copyText(40), ref: z.string().max(160).refine(ref => parseCreatorFactRef(ref) !== undefined,
    "facts.ref 必須是 creator:<工作資料夾內相對路徑>#<段落>") })).min(1).max(4).optional(),
  resume: z.literal(true).optional(),
}).superRefine((value, context) => {
  if (value.resume) {
    if (value.seen || value.copy || value.topic || value.family || value.focus || value.facts) {
      context.addIssue({ code: "custom", message: "resume 只接受 schema 與 shortId；修改文案請重新 make" });
    }
    return;
  }
  if (!value.seen) context.addIssue({ code: "custom", path: ["seen"], message: "seen 必填：每張提供的畫面都要寫下看到什麼" });
  if (!value.copy) context.addIssue({ code: "custom", path: ["copy"], message: "copy 必填" });
});
export type TemplateShortBrief = z.output<typeof templateShortBriefSchema>;
/** §3.2: the brief's topic, or the payoff plus the first seen note, cut to 120 UTF-16 units on a character boundary. */
export function templateShortTopic(brief: { topic?: string; copy: { payoff: string }; seen: ReadonlyArray<{ note: string }> }): string {
  if (brief.topic !== undefined) return brief.topic;
  let topic = "";
  for (const character of `${brief.copy.payoff}：${brief.seen[0]?.note ?? ""}`) {
    if (topic.length + character.length > 120) break;
    topic += character;
  }
  return topic.replace(/：$/, "");
}

export const templateShortLookSchema = z.strictObject({
  schema: z.literal(TEMPLATE_SHORT_LOOK_SCHEMA), shortId, materialId: sha256,
  frames: z.array(z.strictObject({ id: keyframeId, time: z.number().nonnegative(), sha256, servedAt: z.string().min(1).max(40),
    page: z.number().int().min(1).max(64) })).max(64),
});
export type TemplateShortLook = z.output<typeof templateShortLookSchema>;

function pathLabel(path: readonly PropertyKey[]) {
  return path.map(part => typeof part === "number" ? `[${part}]` : `.${String(part)}`).join("").replace(/^\./, "");
}
function zodBlock(code: TemplateShortBlockCode, error: z.ZodError, input: unknown): TemplateShortBlockError {
  const issue = error.issues[0], label = pathLabel(issue.path);
  const named = label || (code === "BLOCK_START" ? "start" : "brief");
  const missing = issue.path.reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[key] : undefined, input) === undefined;
  const detail = issue.code === "too_big" ? `${named} 最多 ${String(issue.maximum)}${issue.origin === "array" ? " 項" : issue.origin === "string" ? " 字" : ""}`
    : issue.code === "too_small" ? (issue.origin === "string" && Number(issue.minimum) === 1 ? `${named} 不可空白`
      : `${named} 至少 ${String(issue.minimum)}${issue.origin === "array" ? " 項" : issue.origin === "string" ? " 字" : ""}`)
    : issue.code === "invalid_type" && missing ? `${named} 必填`
    : issue.code === "unrecognized_keys" ? `${named} 不接受欄位：${issue.keys.join("、")}`
    : issue.code === "invalid_value" ? `${named} 只接受：${issue.values.map(String).join("、")}`
    : issue.code === "custom" ? issue.message
    : `${named} 格式錯誤`;
  return new TemplateShortBlockError(code, detail, label || undefined);
}

/** Byte cap on canonical UTF-8 JSON, checked before the schema. */
export function assertBriefBytes(input: unknown, maxBytes: number, code: TemplateShortBlockCode = "BLOCK_BRIEF"): number {
  const bytes = new TextEncoder().encode(canonicalJson(input)).byteLength;
  if (bytes > maxBytes) throw new TemplateShortBlockError(code, `內容是 ${bytes} bytes，上限 ${maxBytes} bytes（canonical UTF-8 JSON）`);
  return bytes;
}
export function parseTemplateShortStart(input: unknown): TemplateShortStart {
  assertBriefBytes(input, TEMPLATE_SHORT_START_MAX_BYTES, "BLOCK_START");
  const parsed = templateShortStartSchema.safeParse(input);
  if (!parsed.success) throw zodBlock("BLOCK_START", parsed.error, input);
  return parsed.data;
}
export function parseTemplateShortBrief(input: unknown): TemplateShortBrief {
  assertBriefBytes(input, TEMPLATE_SHORT_BRIEF_MAX_BYTES, "BLOCK_BRIEF");
  const parsed = templateShortBriefSchema.safeParse(input);
  if (!parsed.success) throw zodBlock("BLOCK_BRIEF", parsed.error, input);
  return parsed.data;
}

/** Integer project frames of the source window. With no `out`, the first 15 s from `in` are used (`clamped`). */
export function resolveTemplateShortWindow(source: { in?: number; out?: number }, sourceDurationSeconds: number, fps: number) {
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new TemplateShortBlockError("BLOCK_START", "素材沒有可用的時長", "source.path");
  }
  const available = Math.floor(sourceDurationSeconds * fps + 1e-6), minimum = TEMPLATE_SHORT_WINDOW_SECONDS.min * fps, maximum = TEMPLATE_SHORT_WINDOW_SECONDS.max * fps;
  const sourceStartFrame = Math.round((source.in ?? 0) * fps);
  const endFrame = source.out !== undefined ? Math.round(source.out * fps) : Math.min(available, sourceStartFrame + maximum);
  const shown = (frames: number) => (frames / fps).toFixed(1);
  if (sourceStartFrame >= available) throw new TemplateShortBlockError("BLOCK_START", `入點 ${shown(sourceStartFrame)} 秒超過素材長度 ${shown(available)} 秒`, "source.in");
  if (endFrame > available) throw new TemplateShortBlockError("BLOCK_START", `出點 ${shown(endFrame)} 秒超過素材長度 ${shown(available)} 秒`, "source.out");
  const durationFrames = endFrame - sourceStartFrame;
  if (durationFrames < minimum) {
    throw new TemplateShortBlockError("BLOCK_START", source.in === undefined && source.out === undefined
      ? `素材只有 ${shown(durationFrames)} 秒，模板短片需要 5–15 秒` : `選取的片段只有 ${shown(durationFrames)} 秒，模板短片需要 5–15 秒`, "source");
  }
  if (durationFrames > maximum) throw new TemplateShortBlockError("BLOCK_START", `選取的片段有 ${shown(durationFrames)} 秒，模板短片需要 5–15 秒`, "source.out");
  return { sourceStartFrame, durationFrames, clampedToMaximum: source.out === undefined && available - sourceStartFrame > maximum };
}

/** Slot table (§3.4): brief copy field → template input field per family. A field absent here is rejected for that family. */
export const TEMPLATE_SHORT_SLOTS = {
  strike_reframe: { payoff: { input: "title", required: true }, accent: { input: "accentText" }, hook: { input: "previousText", required: true },
    proof: { input: "subtitle" }, place: { input: "kicker" }, tag: { input: "tag" } },
  context_stack: { payoff: { input: "title", required: true }, accent: { input: "accentText" }, place: { input: "kicker" },
    points: { input: "items", required: true } },
} as const satisfies Record<TemplateShortFamily, Partial<Record<TemplateShortCopyField, { input: string; required?: true }>>>;
const COPY_FIELDS = ["hook", "payoff", "accent", "proof", "place", "tag", "points"] as const satisfies readonly TemplateShortCopyField[];

export function assertCopySlots(family: TemplateShortFamily, copy: TemplateShortCopy): void {
  const slots: Partial<Record<TemplateShortCopyField, { input: string; required?: true }>> = TEMPLATE_SHORT_SLOTS[family];
  for (const field of COPY_FIELDS) {
    const slot = slots[field], present = copy[field] !== undefined;
    if (present && !slot) throw new TemplateShortBlockError("BLOCK_BRIEF", `copy.${field} 不適用於 ${family}`, `copy.${field}`);
    if (!present && slot?.required) throw new TemplateShortBlockError("BLOCK_BRIEF", `copy.${field} 必填（${family}）`, `copy.${field}`);
  }
  if (copy.accent !== undefined && !copy.payoff.includes(copy.accent)) {
    throw new TemplateShortBlockError("BLOCK_BRIEF", `accent「${copy.accent}」必須出現在 payoff「${copy.payoff}」裡`, "copy.accent");
  }
}

/** Every on-screen copy string with its field label (`points[1].label`). */
export function templateShortCopyTexts(copy: TemplateShortCopy, options: { includeAccent?: boolean } = {}): Array<{ field: string; text: string }> {
  const texts: Array<{ field: string; text: string }> = [];
  for (const field of ["hook", "payoff", "accent", "proof", "place", "tag"] as const) {
    const text = copy[field];
    if (text !== undefined && (field !== "accent" || options.includeAccent !== false)) texts.push({ field, text });
  }
  copy.points?.forEach((point, index) => {
    texts.push({ field: `points[${index}].label`, text: point.label });
    if (point.detail !== undefined) texts.push({ field: `points[${index}].detail`, text: point.detail });
  });
  return texts;
}

// Q1. Mirror of the private textUnits rule in typography/preparedGlyphRun.ts (simple unshaped LTR text only); that file
// has mixed line endings and has no exported text check yet. templateShortBrief.test.ts compares this mirror with the
// real rule over every BMP code point, so a change there fails the build here. Missing glyphs in the bundled face are
// still caught at compile (MISSING_GLYPH).
const markOrFormat = /[\p{M}\p{Cf}\p{Cs}]/u;
const pictographic = /\p{Extended_Pictographic}/u;
const latinOrHan = /[\p{Script=Latin}\p{Script=Han}]/u;
const commonPunctuation = /\p{P}/u;
const space = /\p{Zs}/u;
export function templateShortGlyphSupported(character: string): boolean {
  if (character === "\n") return true;
  const codePoint = character.codePointAt(0)!;
  return !(markOrFormat.test(character) || pictographic.test(character)
    || !(space.test(character) || (codePoint >= 0x21 && codePoint <= 0x7e)
      || latinOrHan.test(character) || (commonPunctuation.test(character)
        && ((codePoint >= 0xa1 && codePoint <= 0xbf) || (codePoint >= 0x2000 && codePoint <= 0x206f)
          || (codePoint >= 0x3001 && codePoint <= 0x303f)))
      || (codePoint >= 0xff01 && codePoint <= 0xff5e)));
}
/** Names the field and the 1-based character, e.g. 「hook 第 3 字『・』字型不支援」. */
export function assertGlyphs(copy: TemplateShortCopy): void {
  for (const { field, text } of templateShortCopyTexts(copy)) {
    let index = 0;
    for (const character of text) {
      index++;
      if (!templateShortGlyphSupported(character)) throw new TemplateShortBlockError("BLOCK_COPY_GLYPH", `${field} 第 ${index} 字『${character}』字型不支援`, `copy.${field}`);
    }
  }
}

// Q2 (M10). A number on screen needs a source. Digit runs (ASCII or full-width, decimals, thousands groups, attached
// % ％ ℃ °) are always numbers; CJK numerals only before a counting unit, so 「一道道」「三民」 are words, not claims.
export interface TemplateShortNumberToken { text: string; value: number; offset: number }
const DIGIT_RUN = /[0-9０-９]+(?:[,，][0-9０-９]{3}(?![0-9０-９]))*(?:[.．][0-9０-９]+)?[%％℃°]?/y;
const CJK_RUN = /[〇零一二兩三四五六七八九十百千萬億]+/y;
const COUNT_UNITS = ["道菜", "公里", "公尺", "分鐘", "小時", "元", "塊", "米", "秒", "年", "月", "日", "天", "人", "倍", "度", "個", "家", "間", "層", "樓", "次", "名", "支"];
const CJK_DIGITS: Record<string, number> = { "〇": 0, "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
const CJK_SMALL_UNITS: Record<string, number> = { "十": 10, "百": 100, "千": 1000 };
const CJK_LARGE_UNITS: Record<string, number> = { "萬": 1e4, "億": 1e8 };

function digitValue(text: string): number {
  const ascii = text.replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10)).replace(/．/g, ".").replace(/[,，%％℃°]/g, "");
  return Number(ascii);
}
/** 一百五十 = 150; colloquial 一百五 = 150, 三千五 = 3500, 兩萬五 = 25000; positional 二〇二六 = 2026. */
export function chineseNumeralValue(run: string): number {
  const characters = [...run];
  if (!characters.some(character => character in CJK_SMALL_UNITS || character in CJK_LARGE_UNITS)) {
    return Number(characters.map(character => CJK_DIGITS[character]).join(""));
  }
  let total = 0, section = 0, digit = 0, hasDigit = false, lastUnit = 0, zero = false, digitFollowsUnit = false;
  for (const character of characters) {
    if (character in CJK_DIGITS) {
      if (CJK_DIGITS[character] === 0) { zero = true; hasDigit = false; digit = 0; digitFollowsUnit = false; continue; }
      digitFollowsUnit = !hasDigit && lastUnit > 0;
      digit = CJK_DIGITS[character]; hasDigit = true;
    } else if (character in CJK_SMALL_UNITS) {
      section += (hasDigit ? digit : 1) * CJK_SMALL_UNITS[character];
      digit = 0; hasDigit = false; lastUnit = CJK_SMALL_UNITS[character]; zero = false; digitFollowsUnit = false;
    } else {
      total += ((section + (hasDigit ? digit : 0)) || 1) * CJK_LARGE_UNITS[character];
      section = 0; digit = 0; hasDigit = false; lastUnit = CJK_LARGE_UNITS[character]; zero = false; digitFollowsUnit = false;
    }
  }
  if (hasDigit && digitFollowsUnit && !zero && lastUnit >= 100) digit *= lastUnit / 10;
  return total + section + (hasDigit ? digit : 0);
}
export function numberTokens(text: string): TemplateShortNumberToken[] {
  const tokens: TemplateShortNumberToken[] = [];
  for (let offset = 0; offset < text.length;) {
    DIGIT_RUN.lastIndex = offset;
    const digits = DIGIT_RUN.exec(text);
    if (digits) { tokens.push({ text: digits[0], value: digitValue(digits[0]), offset }); offset += digits[0].length; continue; }
    CJK_RUN.lastIndex = offset;
    const numeral = CJK_RUN.exec(text);
    if (numeral) {
      const after = offset + numeral[0].length;
      if (COUNT_UNITS.some(unit => text.startsWith(unit, after))) tokens.push({ text: numeral[0], value: chineseNumeralValue(numeral[0]), offset });
      offset = after; continue;
    }
    offset++;
  }
  return tokens;
}

/** Who typed the copy: the creator in the app (their own claim), or the agent session (needs a source). */
export type TemplateShortCopyAuthor = "creator" | "agent";
export interface TemplateShortNumberCorpus {
  copyAuthor: TemplateShortCopyAuthor;
  /** Transcript cue texts of this material. */
  transcript?: readonly string[];
  /** Contents of the brief's `facts[].ref` files (workspace, ≤64 KB each). */
  facts?: ReadonlyArray<{ ref: string; content: string }>;
  /** `seen[].note` lines: a number read off a frame. */
  seen?: readonly string[];
}
export type TemplateShortNumberBasis = "creator_declared" | "transcript" | "fact" | "frame_observed";
export interface TemplateShortNumberEvidence { token: TemplateShortNumberToken; basis: TemplateShortNumberBasis; ref?: string }

export function verifyNumbers(tokens: readonly TemplateShortNumberToken[], corpus: TemplateShortNumberCorpus, field?: string): TemplateShortNumberEvidence[] {
  const values = (texts: readonly string[] = []) => new Set(texts.flatMap(text => numberTokens(text).map(token => token.value)));
  const transcript = values(corpus.transcript), seen = values(corpus.seen);
  const facts = (corpus.facts ?? []).map(fact => ({ ref: fact.ref, values: values([fact.content]) }));
  return tokens.map(token => {
    if (corpus.copyAuthor === "creator") return { token, basis: "creator_declared" as const };
    if (transcript.has(token.value)) return { token, basis: "transcript" as const };
    const fact = facts.find(candidate => candidate.values.has(token.value));
    if (fact) return { token, basis: "fact" as const, ref: fact.ref };
    if (seen.has(token.value)) return { token, basis: "frame_observed" as const };
    throw new TemplateShortBlockError("BLOCK_UNSUPPORTED_NUMBER", `${field ? `${field} 的` : ""}『${token.text}』找不到來源`, field ? `copy.${field}` : undefined);
  });
}
/** Q2 over every on-screen copy field. A number backed only by a seen note keeps the run at REVIEW_REQUIRED or below. */
export function assertBriefNumbers(copy: TemplateShortCopy, corpus: TemplateShortNumberCorpus) {
  const evidence = templateShortCopyTexts(copy, { includeAccent: false })
    .flatMap(({ field, text }) => verifyNumbers(numberTokens(text), corpus, field).map(row => ({ field, ...row })));
  return { evidence, reviewRequired: evidence.some(row => row.basis === "frame_observed") };
}

/** M9 (look before writing): every cited frame was served for this short, every served frame is cited exactly once,
 * and each served frame is still the current packet keyframe. This proves the bytes reached the session, not that
 * anyone looked. */
export function assertSeenCoverage(seen: ReadonlyArray<{ kf: string }>, look: TemplateShortLook, current: ReadonlyArray<{ id: string; sha256: string }>,
  expectedShortId?: string): void {
  const block = (detail: string) => new TemplateShortBlockError("BLOCK_UNVIEWED_FRAME", detail, "seen");
  if (expectedShortId !== undefined && look.shortId !== expectedShortId) throw block(`畫面紀錄屬於 ${look.shortId}，不是 ${expectedShortId}`);
  if (!look.frames.length) throw block("還沒有提供任何畫面；先呼叫 start_template_short 看過畫面再寫文案");
  const served = new Map(look.frames.map(frame => [frame.id, frame])), cited = new Set<string>();
  for (const row of seen) {
    if (!served.has(row.kf)) throw block(`${row.kf} 沒有提供給這支短片（${look.shortId}）`);
    if (cited.has(row.kf)) throw block(`${row.kf} 被引用了兩次`);
    cited.add(row.kf);
  }
  for (const frame of look.frames) {
    if (!cited.has(frame.id)) throw block(`${frame.id} 已提供但 seen 沒有寫下看到什麼`);
    if (current.find(candidate => candidate.id === frame.id)?.sha256 !== frame.sha256) throw block(`${frame.id} 的畫面已變更（SHA 不同），請重新取得畫面`);
  }
}
