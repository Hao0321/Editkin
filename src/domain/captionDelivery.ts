import type { EditProject, CaptionCue } from "./types";
import type { EditorCommand } from "./commandTypes";

export type CaptionDeliveryMode = "original" | "translation" | "bilingual";
export type CaptionDeliveryFormat = "srt" | "vtt";
export interface CaptionIssue {
  code: "invalid" | "duplicate_id" | "overlap" | "off_frame" | "short" | "reading_speed" | "line_length";
  severity: "error" | "warning"; captionId: string; relatedId?: string; message: string;
}
export const CAPTION_DELIVERY_LIMITS = Object.freeze({ cues: 10_000, textBytes: 1024 * 1024, outputBytes: 2 * 1024 * 1024, retainedIssues: 200 });
export const CAPTION_READING_POLICY = Object.freeze({ minSeconds: .65, maxGraphemesPerSecond: 18, maxLineGraphemes: 42, maxLines: 2 });
type CaptionProject = Pick<EditProject, "fps" | "captions">;
const EPS = 1e-7;
const encoder = new TextEncoder();
const utf8 = (value: string) => encoder.encode(value).byteLength;
const frameAligned = (time: number, fps: number) => Math.abs(time * fps - Math.round(time * fps)) <= 1e-5;
const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
export function captionGraphemes(value: string): number {
  let count = 0;
  for (const { segment } of segmenter.segment(value)) if (!/^\s+$/u.test(segment)) count++;
  return count;
}
function ordered(project: CaptionProject) {
  if (!Number.isFinite(project.fps) || project.fps < 1 || project.fps > 240) throw Error("字幕幀率須介於 1–240 fps");
  if (!Array.isArray(project.captions) || project.captions.length > CAPTION_DELIVERY_LIMITS.cues) throw Error("字幕最多支援 10,000 句");
  let bytes = 0;
  for (const cue of project.captions) {
    if (!cue || typeof cue.id !== "string" || cue.id.length > 160 || typeof cue.text !== "string"
      || (cue.translation && (typeof cue.translation.text !== "string" || typeof cue.translation.language !== "string"))) throw Error("字幕資料形狀不合法");
    bytes += utf8(cue.id) + utf8(cue.text) + utf8(cue.translation?.text ?? "") + utf8(cue.translation?.language ?? "");
    if (bytes > CAPTION_DELIVERY_LIMITS.textBytes) throw Error("字幕文字超過 1 MiB 預算");
  }
  return [...project.captions].sort((a, b) => a.start - b.start || a.duration - b.duration || a.id.localeCompare(b.id));
}
function valid(cue: CaptionCue) {
  return Boolean(cue.id.trim()) && !/[\u0000-\u001f]/u.test(cue.id) && Number.isFinite(cue.start) && cue.start >= 0
    && Number.isFinite(cue.duration) && cue.duration > 0 && cue.start + cue.duration <= 86400
    && Boolean(cue.text.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(cue.text + (cue.translation?.text ?? ""));
}
function textWarnings(text: string, seconds: number, cache: Map<string, { count: number; long: boolean }>): string[] {
  const messages: string[] = [];
  let stats = cache.get(text);
  if (!stats) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n"), counts = lines.map(captionGraphemes);
    stats = { count: counts.reduce((sum, count) => sum + count, 0), long: lines.length > CAPTION_READING_POLICY.maxLines || counts.some(count => count > CAPTION_READING_POLICY.maxLineGraphemes) };
    cache.set(text, stats);
  }
  if (stats.count / seconds > CAPTION_READING_POLICY.maxGraphemesPerSecond) messages.push("閱讀速度偏快（以可見字元估算）");
  if (stats.long) messages.push("文字行數或單行長度偏多（尚未量測實體字型排版）");
  return messages;
}
export function inspectCaptionDelivery(project: CaptionProject) {
  const captions = ordered(project), issues: CaptionIssue[] = [], counts: Record<string, number> = {}, seen = new Set<string>(), textCache = new Map<string, { count: number; long: boolean }>();
  let errors = 0, warnings = 0, furthest: CaptionCue | undefined;
  const add = (issue: CaptionIssue) => {
    counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    if (issue.severity === "error") errors++; else warnings++;
    if (issues.length < CAPTION_DELIVERY_LIMITS.retainedIssues) issues.push(issue);
  };
  for (const cue of captions) {
    if (seen.has(cue.id)) add({ code: "duplicate_id", severity: "error", captionId: cue.id, message: "字幕 ID 重複" });
    seen.add(cue.id);
    if (!valid(cue)) { add({ code: "invalid", severity: "error", captionId: cue.id, message: "空白文字、控制字元或時間範圍不合法" }); continue; }
    if (furthest && cue.start < furthest.start + furthest.duration - EPS) add({ code: "overlap", severity: "error", captionId: cue.id, relatedId: furthest.id, message: `與 ${furthest.id} 時間重疊` });
    if (!furthest || cue.start + cue.duration > furthest.start + furthest.duration) furthest = cue;
    if (!frameAligned(cue.start, project.fps) || !frameAligned(cue.start + cue.duration, project.fps)) add({ code: "off_frame", severity: "warning", captionId: cue.id, message: "字幕邊界未對齊影格；匯出保留原時間" });
    if (cue.duration < CAPTION_READING_POLICY.minSeconds) add({ code: "short", severity: "warning", captionId: cue.id, message: "顯示時間不足 0.65 秒，請核對閱讀停留" });
    for (const [label, text] of [["原文", cue.text], ["翻譯", cue.translation?.text ?? ""]]) {
      if (!text.trim()) continue;
      for (const message of textWarnings(text, cue.duration, textCache)) add({ code: message.startsWith("閱讀") ? "reading_speed" : "line_length", severity: "warning", captionId: cue.id, message: `${label}：${message}` });
    }
    if (cue.translation?.text.trim() && cue.text.split(/\r?\n/).length + cue.translation.text.split(/\r?\n/).length > CAPTION_READING_POLICY.maxLines) add({ code: "line_length", severity: "warning", captionId: cue.id, message: "雙語合計超過兩行，請核對字幕區域" });
  }
  return { schema: "editkin.caption-delivery-report/v1" as const, cueCount: captions.length, errors, warnings, counts, issues,
    omittedIssues: errors + warnings - issues.length, readyForSidecar: errors === 0 && captions.length > 0,
    policy: CAPTION_READING_POLICY, boundary: "timing_and_readability_heuristics_only_not_speech_accuracy_or_physical_layout" as const };
}

/** Explicitly selected tiny end overlaps only; no recut, text loss or ASR guess. */
export function prepareCaptionOverlapRepair(project: Pick<EditProject, "fps" | "captions" | "tracks">, captionIds: string[]) {
  const cues = ordered(project), report = inspectCaptionDelivery(project);
  if (!captionIds.length || captionIds.length > 100 || new Set(captionIds).size !== captionIds.length) throw Error("請指定 1–100 個不重複的前句 ID");
  if (report.counts.invalid || report.counts.duplicate_id) throw Error("先處理字幕資料錯誤再修正時間");
  if (project.tracks.some(track => track.kind === "caption" && track.locked)) throw Error("字幕軌道已鎖定");
  const commands: EditorCommand[] = [], changes: Array<{ captionId: string; nextId: string; oldEnd: number; newEnd: number; removedFrames: number }> = [];
  for (const id of captionIds) {
    const index = cues.findIndex(cue => cue.id === id), cue = cues[index], next = cues[index + 1];
    if (!cue || !next) throw Error(`找不到有後句的字幕：${id}`);
    if (cue.templateOwner) throw Error("模板管理的字幕請透過模板修訂");
    const end = cue.start + cue.duration, overlap = end - next.start;
    if (next.start <= cue.start + EPS || next.start + next.duration <= end + EPS || (cues[index + 2] && cues[index + 2].start < end - EPS)) throw Error("巢狀、同起點或多句重疊須逐句人工調整");
    if (![cue.start, end, next.start].every(value => frameAligned(value, project.fps))) throw Error("修正需要原句與後句邊界已對齊影格");
    const frames = Math.round(overlap * project.fps);
    if (overlap <= EPS || frames < 1 || frames > 4) throw Error("僅能修正 1–4 格的句尾重疊");
    if (next.start - cue.start < Math.ceil(CAPTION_READING_POLICY.minSeconds * project.fps) / project.fps - EPS) throw Error("修正後閱讀時間不足");
    const duration = (Math.round(next.start * project.fps) - Math.round(cue.start * project.fps)) / project.fps;
    commands.push({ type: "update_caption", captionId: id, patch: { duration } });
    changes.push({ captionId: id, nextId: next.id, oldEnd: end, newEnd: next.start, removedFrames: frames });
  }
  return { command: { type: "batch", commands } as EditorCommand, changes, boundary: "draft_requires_normal_v4_audit_apply" as const };
}

function time(ms: number, format: CaptionDeliveryFormat) {
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${format === "srt" ? "," : "."}${String(ms % 1000).padStart(3, "0")}`;
}
function plain(text: string, format: CaptionDeliveryFormat) {
  const normalized = text.replace(/\r\n?/g, "\n").trim().replace(/\n[ \t]*\n+/g, "\n");
  // SubRip players disagree on literal markup/entity decoding. Never silently
  // deliver stripped or visibly escaped words. WebVTT has a defined cue parser.
  if (format === "srt") {
    if (/[<>]|&(?:[A-Za-z][A-Za-z0-9]{1,31}|#\d{1,8}|#x[a-f\d]{1,8});/iu.test(normalized)) throw Error("SRT 播放器對角括號／文字實體顯示不一致；請改用 VTT 保留原文字");
    return normalized;
  }
  return normalized.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
export function exportCaptionDelivery(project: CaptionProject, format: CaptionDeliveryFormat, mode: CaptionDeliveryMode) {
  if (!["srt", "vtt"].includes(format) || !["original", "translation", "bilingual"].includes(mode)) throw Error("字幕匯出格式／語言模式不合法");
  const report = inspectCaptionDelivery(project), cues = ordered(project);
  if (!report.readyForSidecar) throw Error("字幕為空或有資料錯誤／時間重疊，請先修正後匯出");
  const rows: string[] = format === "vtt" ? ["WEBVTT\n"] : [];
  let outputBytes = format === "vtt" ? 7 : 0;
  for (const [index, cue] of cues.entries()) {
    if (mode !== "original" && !cue.translation?.text.trim()) throw Error(`字幕 ${cue.id} 缺少翻譯，無法完整匯出此語言模式`);
    const text = mode === "original" ? cue.text : mode === "translation" ? cue.translation!.text : `${cue.text}\n${cue.translation!.text}`;
    const start = Math.round(cue.start * 1000), end = Math.round((cue.start + cue.duration) * 1000);
    if (end <= start) throw Error("字幕短於毫秒精度，無法無損匯出時間");
    const row = `${index + 1}\n${time(start, format)} --> ${time(end, format)}\n${plain(text, format)}\n`;
    outputBytes += utf8(row) + 1;
    if (outputBytes > CAPTION_DELIVERY_LIMITS.outputBytes) throw Error("字幕輸出超過 2 MiB 預算");
    rows.push(row);
  }
  const text = rows.join("\n");
  return { format, mode, text, utf8Bytes: utf8(text), cueCount: cues.length, warnings: report.warnings,
    timestampRounding: "nearest_millisecond_no_timeline_shift" as const,
    textEncoding: "utf8_plain_text_escaped_markup_blank_lines_collapsed" as const };
}
