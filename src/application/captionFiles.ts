import type { EditorCommand } from "../domain/commands";
import { alignTime } from "../domain/editGraph";
import type { CaptionCue, EditProject } from "../domain/types";

export type CaptionFileFormat = "srt" | "vtt";

export interface CaptionFileCue {
  start: number;
  end: number;
  text: string;
}

export const CAPTION_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const CAPTION_FILE_MAX_CUES = 20_000;

export class CaptionFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionFileError";
  }
}

const pad = (value: number, width: number) => String(value).padStart(width, "0");

function formatTimestamp(seconds: number, separator: "," | "."): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor(totalMs / 60_000) % 60;
  const secs = Math.floor(totalMs / 1000) % 60;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${separator}${pad(totalMs % 1000, 3)}`;
}

/** Cue text may not contain blank lines: they end the cue in both formats. */
function cueLines(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim()).join("\n");
}

export function serializeCaptions(captions: readonly CaptionCue[], format: CaptionFileFormat): string {
  const separator = format === "srt" ? "," : ".";
  const blocks: string[] = [];
  for (const caption of [...captions].sort((a, b) => a.start - b.start)) {
    const raw = cueLines(caption.text);
    if (!raw) continue;
    const startMs = Math.max(0, Math.round(caption.start * 1000));
    // Rounding must never produce a zero-length cue.
    const end = Math.max(startMs + 1, Math.round((caption.start + caption.duration) * 1000)) / 1000;
    const timing = `${formatTimestamp(caption.start, separator)} --> ${formatTimestamp(end, separator)}`;
    // WebVTT interprets markup and entities in cue text; SRT has no escaping convention.
    const text = format === "vtt" ? raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : raw;
    blocks.push(format === "srt" ? `${blocks.length + 1}\n${timing}\n${text}` : `${timing}\n${text}`);
  }
  return format === "srt" ? `${blocks.join("\n\n")}${blocks.length ? "\n" : ""}` : `WEBVTT\n\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}

function parseTimestamp(value: string): number | undefined {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value);
  if (!match) return undefined;
  const [, hours = "0", minutes, seconds, fraction] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) return undefined;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction.padEnd(3, "0")) / 1000;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": "\u00a0", "&lrm;": "\u200e", "&rlm;": "\u200f" };
const MARKUP_TAG = /^\/?[A-Za-z][^<>]*$|^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}$/;

/** Removes only complete, well-formed tags and ASS overrides in one pass; a lone "<" stays literal text. */
function stripMarkup(input: string): string {
  let out = "";
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === "<") {
      const close = input.indexOf(">", index);
      if (close !== -1 && MARKUP_TAG.test(input.slice(index + 1, close))) { index = close; continue; }
    } else if (char === "{" && input[index + 1] === "\\") {
      const close = input.indexOf("}", index);
      if (close !== -1) { index = close; continue; }
    }
    out += char;
  }
  return out;
}

export function parseCaptionFile(source: string): CaptionFileCue[] {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const isVtt = /^WEBVTT(?:[ \t\n]|$)/.test(normalized);
  const blocks = normalized.split(/\n[ \t]*\n/).map((block) => block.trim()).filter(Boolean);
  if (isVtt) blocks.shift();
  const cues: CaptionFileCue[] = [];
  let ordinal = 0;
  for (const block of blocks) {
    if (isVtt && /^(NOTE|STYLE|REGION)(?:[ \t\n]|$)/.test(block)) continue;
    ordinal++;
    const lines = block.split("\n");
    const timingIndex = lines.slice(0, 2).findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) throw new CaptionFileError(`第 ${ordinal} 段找不到「開始 --> 結束」時間軸；未匯入任何字幕。`);
    const [left, right = ""] = lines[timingIndex].split("-->");
    const start = parseTimestamp(left.trim());
    const end = parseTimestamp(right.trim().split(/\s+/)[0] ?? "");
    if (start === undefined || end === undefined || end <= start) throw new CaptionFileError(`第 ${ordinal} 段時間格式不合法或結束早於開始；未匯入任何字幕。`);
    let text = stripMarkup(lines.slice(timingIndex + 1).join("\n"));
    if (isVtt) text = text.replace(/&(?:amp|lt|gt|nbsp|lrm|rlm);/g, (entity) => ENTITIES[entity]);
    text = text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
    if (!text) continue;
    cues.push({ start, end, text });
    if (cues.length > CAPTION_FILE_MAX_CUES) throw new CaptionFileError(`字幕超過 ${CAPTION_FILE_MAX_CUES} 段上限；未匯入任何字幕。`);
  }
  if (!cues.length) throw new CaptionFileError("字幕檔沒有可匯入的字幕。");
  return cues;
}

export function buildImportCaptionsCommand(project: Pick<EditProject, "fps">, cues: readonly CaptionFileCue[], idFactory: () => string): EditorCommand {
  const frame = 1 / project.fps;
  return {
    type: "batch",
    commands: cues.map((cue): EditorCommand => ({
      type: "add_caption",
      caption: {
        id: idFactory(), text: cue.text,
        start: alignTime(cue.start, project.fps),
        duration: Math.max(frame, alignTime(cue.end - cue.start, project.fps)),
      },
    })),
  };
}
