/**
 * The footer's status line in simple mode (簡單模式): plain words for what is going on, never an encoder name such as
 * h264_nvenc, a revision number or an engine's full error text. Advanced mode keeps the detailed text.
 *
 * Causes come from plainProblems, so the footer, the problem notices and the export panel say the same thing. The raw
 * text is kept only for 「查看原因」. Every key below is a zh-TW interface message; the new ones are translated in
 * src/ui/i18n/interfaceMessages.19.ts.
 */
import { describeProblem, PROBLEM_TITLES, PROBLEM_TODO, PROBLEM_WHAT, problemCause, rawProblemDetail, type PlainProblem, type ProblemAction } from "./plainProblems";

/** The export job, as far as the footer needs it (src/desktop/renderJobStore.ts). */
export interface StatusRenderJob {
  phase: "choosing" | "running" | "done" | "failed" | "canceled";
  kind: "video" | "alpha";
  progress?: { fraction?: number };
  problem?: PlainProblem;
}

export interface PlainStatusContext {
  job?: StatusRenderJob;
  /** The last export failure the job reported; its raw text can stay in the status after the panel closes. */
  exportProblem?: PlainProblem;
}

export type PlainStatus =
  /** Already plain: show the status text as it is. */
  | { kind: "as-is" }
  /** A fixed interface message. */
  | { kind: "message"; key: string; values?: Readonly<Record<string, string | number>>; detail?: string }
  /**
   * Something did not work. `label` says what (the status's own plain words when it had them, else a key);
   * `fallbackLabel` is always a key. `what` and `todo` are plainProblems keys.
   */
  | { kind: "problem"; label: string; fallbackLabel: string; what: string; todo: string; detail: string }
  /** The plain zh-TW part of a status that also carried technical detail. */
  | { kind: "text"; text: string; detail: string };

export const STATUS_EXPORTING = "正在輸出影片…";
export const STATUS_EXPORTING_PERCENT = "正在輸出 {percent}%";
export const STATUS_EXPORTING_ALPHA = "正在輸出透明背景主檔";
export const STATUS_PROBLEM_LINE = "{label}：{what}";
export const STATUS_EXPORT_DONE = "影片輸出完成：{name}";
export const STATUS_OUTPUT_DONE = "輸出完成。";
export const STATUS_PROJECT_OPENED = "已打開「{name}」";
export const STATUS_PROJECT_RELOADED = "已載入新的版本。";
export const STATUS_BATCH_OPENED = "已打開剪好的專案。";
export const STATUS_NEUTRAL = "有新的訊息，點一下可以看詳細內容。";

/** A short label per action; export and "other" follow the reviewed wording 「輸出失敗：…」. */
export const STATUS_PROBLEM_LABELS: Readonly<Record<ProblemAction | "other", string>> = {
  export: "輸出失敗",
  save: PROBLEM_TITLES.save,
  open: PROBLEM_TITLES.open,
  import: PROBLEM_TITLES.import,
  relink: PROBLEM_TITLES.relink,
  reload: PROBLEM_TITLES.reload,
  other: "沒有完成",
};

/** Status texts that only announce that an export started; the job's measured progress replaces them. */
const EXPORT_START = new Set(["正在輸出影片…", "正在檢查 FFmpeg ProRes 4444／高位元 Alpha 能力並輸出透明背景主檔…"]);

const CJK = /[㐀-鿿]/;
const MAX_SCAN = 4_000;

// Token-level detail, removed or shortened inside an otherwise plain sentence.
const ENCODER = /\b(?:h26[45]|hevc|av1|vp[89]|prores|dnxhd|mpeg[24]|aac|opus|mjpeg)_[a-z0-9_]+\b|\blib(?:x26[45]|svtav1|aom|vpx|fdk_aac|opus|mp3lame|dav1d|webp)\b|\b(?:nvenc|qsv|amf|videotoolbox|vaapi|cuvid|nvdec)\b/gi;
const REVISION = /\b(?:revision|rev)\s*[#:：]?\s*\d+\b|(?<![\w.])r\d+(?![\w.])/gi;
const HASH = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi;
const URL_TOKEN = /\b(?:file|asset|blob|https?):\/\/[^\s"'“”「」，。；、]+/gi;
const WINDOWS_PATH = /(?:\\\\\?\\)?[A-Za-z]:[\\/](?:(?!\s+[㐀-鿿])[^\n\r"'“”「」『』，。；、<>|*?:·])*|\\\\[^\s\\/]+\\(?:(?!\s+[㐀-鿿])[^\n\r"'“”「」『』，。；、<>|*?:·])*/g;
const UNIX_PATH = /(?<![\w.:/])(?:\/[\w.@%+-]+){2,}\/?/g;
const TOKEN_PATTERNS = [ENCODER, REVISION, HASH, URL_TOKEN, WINDOWS_PATH, UNIX_PATH];

// Clause-level detail: a clause carrying any of these is dropped from a mixed status. Error codes are case-sensitive
// (ENOENT, EPERM…) so ordinary words such as "Editkin" never count.
const ENGLISH = /[A-Za-z]{2,}(?:[ \t,:;'"()/-]+[A-Za-z]{2,}){2,}/;
const ERROR_CODE = /\bE[A-Z]{3,}\b|\b0x[0-9a-fA-F]{4,}\b|\bHRESULT\b|\b[Ee]xit (?:code|status)\b|\bSIG[A-Z]{3,}\b|\berrno\b/;
const STACK = /\n\s*at\s+\S|\bat\s+[\w$.<>]+\s+\([^)\n]*:\d+:\d+\)/;
const CODE = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>|[{[]\s*"[^"\n]{1,80}"\s*:|=>|\b(?:undefined|null|NaN|TypeError|ReferenceError|SyntaxError|RangeError)\b/;
const TOOL = /\b(?:ffmpeg|ffprobe|stderr|stdout|dxgi|nvcuda|wgpu|vulkan|d3d1[12]|cuda|onnx)\b/i;
const CLAUSE_PATTERNS = [ENGLISH, ERROR_CODE, STACK, CODE, TOOL];

const FAILURE_WORDS = /失敗|錯誤|無法|不能|沒有成功|拒絕|逾時|中斷|找不到|不支援|\berror\b|\bfail|cannot|can't|unable|denied|invalid|not found|unexpected|exception|timed? ?out|refused|\babort|panic|crash/i;
const FAILURE_CODES = /\bE[A-Z]{3,}\b|\b[Ee]xit code\b/;
const PLAIN_FAILURE = /失敗|錯誤|無法|不能|沒有成功|沒有完成|拒絕|逾時|中斷|找不到|不支援/;

/** Which action a technical text was about, from its own words; undefined when it does not say. First match wins. */
const ACTION_HINTS: ReadonlyArray<readonly [ProblemAction, RegExp]> = [
  ["export", /輸出|匯出影片|render|export|encod|ffmpeg|nvenc|\bmux|output/i],
  ["reload", /重新載入|新的版本|reload/i],
  ["relink", /重新連結|接回|relink/i],
  ["import", /匯入|加入素材|import|ffprobe|probe/i],
  ["open", /開啟|打開|讀取專案|read_project|\bopen\b/i],
  ["save", /儲存|存檔|保存|\bsave|\bwrite/i],
];

function matches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(text);
  pattern.lastIndex = 0;
  return found;
}
const hasTokenDetail = (text: string) => TOKEN_PATTERNS.some(pattern => matches(pattern, text));
const hasClauseDetail = (text: string) => CLAUSE_PATTERNS.some(pattern => matches(pattern, text));

/** True when the text carries encoder names, revision numbers, paths, hashes, code or engine (English) error text. */
export function isTechnicalStatus(text: string): boolean {
  const scanned = text.slice(0, MAX_SCAN);
  return hasTokenDetail(scanned) || hasClauseDetail(scanned);
}

export function guessStatusAction(text: string): ProblemAction | undefined {
  return ACTION_HINTS.find(([, pattern]) => pattern.test(text))?.[0];
}

/** The last part of a path: the creator's own file name. */
export function fileNameOf(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** A project file's name without its .editkin.json / .json ending. */
function projectNameOf(path: string): string {
  const name = fileNameOf(path);
  return name.replace(/\.editkin\.json$/i, "").replace(/\.json$/i, "") || name;
}

/** Paths become their file names; encoder names, revision numbers, hashes and links are removed. */
function shortenTokens(text: string): string {
  return text
    .replace(URL_TOKEN, "")
    .replace(WINDOWS_PATH, match => fileNameOf(match.replace(/[\s.,]+$/, "")))
    .replace(UNIX_PATH, match => fileNameOf(match))
    .replace(ENCODER, "")
    .replace(REVISION, "")
    .replace(HASH, "")
    .replace(/\(\s*\)|（\s*）/g, "");
}

const SEPARATOR = /(\n+|；|;\s*|。|，|,\s+|：|:\s+| · )/;
const FULL_WIDTH: Readonly<Record<string, string>> = { ";": "；", ",": "，", ":": "：" };

/** The plain clauses of a mixed status: those with Chinese words and no engine text, code or stack trace. */
function plainClauses(text: string): string {
  // A bracketed aside with technical detail goes as a whole: 「（目前 revision 12，你的版本 11）」.
  const withoutAsides = text.replace(/（[^（）]*）|\([^()]*\)/g, aside => isTechnicalStatus(aside) ? "" : aside);
  const parts = shortenTokens(withoutAsides).split(SEPARATOR);
  const normalize = (separator: string) => {
    const compact = separator.trim();
    return separator.includes("\n") ? "\n" : compact === "·" ? " · " : FULL_WIDTH[compact] ?? compact;
  };
  let kept = "";
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index].trim();
    const separator = parts[index + 1] ?? "";
    if (clause && CJK.test(clause) && !hasClauseDetail(clause)) { kept += clause + normalize(separator); continue; }
    // A dropped clause takes the separator before it along: 「A：<error>；C」 becomes 「A；C」.
    if (kept && separator) kept = kept.replace(/(?: · |[：，；、\n])$/, "") + normalize(separator);
  }
  // A trailing colon, comma or dot separator means its detail was dropped: end the sentence there instead.
  kept = kept.replace(/(?:\s*·\s*|[：，；、\n])+$/, "").replace(/[ \t]{2,}/g, " ").trim();
  if (kept && text.trim().endsWith("。") && !/[。！？]$/.test(kept)) kept += "。";
  return kept;
}

function exportFailure(source: string, context: PlainStatusContext): PlainProblem | undefined {
  const failed = context.job?.phase === "failed" && context.job.problem ? context.job.problem : context.exportProblem;
  if (!failed || !source.trim()) return undefined;
  return rawProblemDetail(source) === failed.detail ? failed : undefined;
}

/** Statuses the editor builds around a path or an encoder: their plain form. */
function knownMessage(source: string): PlainStatus | undefined {
  const text = source.trim();
  let match = /^影片輸出完成：([\s\S]+?)(?: · [\s\S]*)?$/.exec(text);
  if (match) return { kind: "message", key: STATUS_EXPORT_DONE, values: { name: fileNameOf(match[1]) }, detail: source };
  if (/^(?:OpenEXR 序列完成|Alpha 主檔完成)：/.test(text)) return { kind: "message", key: STATUS_OUTPUT_DONE, detail: source };
  if (/^已載入專案檔裡的新版本：/.test(text)) return { kind: "message", key: STATUS_PROJECT_RELOADED, detail: source };
  if (/^已開啟批次成片的可編輯時間軸：/.test(text)) return { kind: "message", key: STATUS_BATCH_OPENED, detail: source };
  match = /^已開啟 ([\s\S]+)$/.exec(text);
  if (match && /[\\/]/.test(match[1])) return { kind: "message", key: STATUS_PROJECT_OPENED, values: { name: projectNameOf(match[1]) }, detail: source };
  return undefined;
}

/**
 * What the simple-mode footer shows for `source` (the editor's status text). Plain text stays as it is; technical
 * text becomes plain words, with the original kept as `detail` for 「查看原因」.
 */
export function simplifyStatus(source: string, context: PlainStatusContext = {}): PlainStatus {
  const job = context.job;
  const technical = isTechnicalStatus(source);
  if (job && (job.phase === "choosing" || job.phase === "running") && (EXPORT_START.has(source.trim()) || technical)) {
    const fraction = job.phase === "running" ? job.progress?.fraction : undefined;
    const percent = typeof fraction === "number" && Number.isFinite(fraction) ? Math.max(0, Math.min(100, Math.floor(fraction * 100))) : undefined;
    const detail = technical ? { detail: source } : {};
    if (percent !== undefined) return { kind: "message", key: STATUS_EXPORTING_PERCENT, values: { percent }, ...detail };
    return { kind: "message", key: job.kind === "alpha" ? STATUS_EXPORTING_ALPHA : STATUS_EXPORTING, ...detail };
  }
  const failedExport = exportFailure(source, context);
  if (failedExport) {
    return { kind: "problem", label: STATUS_PROBLEM_LABELS.export, fallbackLabel: STATUS_PROBLEM_LABELS.export,
      what: failedExport.what, todo: failedExport.todo, detail: failedExport.detail };
  }
  const known = knownMessage(source);
  if (known) return known;
  if (!technical) return { kind: "as-is" };

  const scanned = source.slice(0, MAX_SCAN);
  const kept = plainClauses(scanned);
  const failure = FAILURE_WORDS.test(scanned) || FAILURE_CODES.test(scanned);
  const action = guessStatusAction(scanned);
  const detail = rawProblemDetail(source);
  const fallbackLabel = STATUS_PROBLEM_LABELS[action ?? "other"];
  // A known action gets its own advice; rules restricted to one action never apply to an unknown one.
  const described = action ? describeProblem(action, scanned) : undefined;
  const cause = described?.cause ?? problemCause("save", scanned);
  const what = described?.what ?? PROBLEM_WHAT[cause];
  const todo = described?.todo ?? PROBLEM_TODO[cause];
  // The status's own plain words win when they do not report a failure: a skipped detail inside a finished job
  // (「自動配樂素材略過；其他自動剪輯照常完成。」) must not turn into a failure line.
  if (kept && !PLAIN_FAILURE.test(kept)) return { kind: "text", text: kept, detail };
  if (failure && cause !== "unknown") {
    const label = kept ? kept.replace(/[。！？]+$/, "") : fallbackLabel;
    return { kind: "problem", label, fallbackLabel, what, todo, detail };
  }
  if (kept) return { kind: "text", text: kept, detail };
  if (failure) return { kind: "problem", label: fallbackLabel, fallbackLabel, what, todo, detail };
  return { kind: "message", key: STATUS_NEUTRAL, detail };
}

/** Every zh-TW key this module can return (the i18n test checks each has translations). */
export function plainStatusMessageKeys(): string[] {
  return [...new Set([
    STATUS_EXPORTING, STATUS_EXPORTING_PERCENT, STATUS_EXPORTING_ALPHA, STATUS_PROBLEM_LINE, STATUS_EXPORT_DONE, STATUS_OUTPUT_DONE,
    STATUS_PROJECT_OPENED, STATUS_PROJECT_RELOADED, STATUS_BATCH_OPENED, STATUS_NEUTRAL, ...Object.values(STATUS_PROBLEM_LABELS),
  ])];
}
