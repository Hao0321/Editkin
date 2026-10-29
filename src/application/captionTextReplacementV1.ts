import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { CAPTION_DELIVERY_LIMITS, inspectCaptionDelivery } from "../domain/captionDelivery";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { canonicalJson } from "../shared/canonicalJson";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
function textInput(value: unknown, emptyAllowed: boolean): asserts value is string {
  if (typeof value !== "string" || (!emptyAllowed && !value.length) || control.test(value)
    || bytes(value) > CAPTION_DELIVERY_LIMITS.textBytes
    || [...value].some(char => char.codePointAt(0)! >= 0xd800 && char.codePointAt(0)! <= 0xdfff))
    throw Error("CAPTION_TEXT_LITERAL_INPUT");
}
function selected(project: EditProject, ids?: readonly string[]) {
  inspectCaptionDelivery(project); // Reuse the existing cue/text budget and shape check.
  if (ids === undefined) return project.captions;
  const wanted = new Set(ids);
  const available = new Set(project.captions.map(cue => cue.id));
  if (!ids.length || wanted.size !== ids.length || ids.length > CAPTION_DELIVERY_LIMITS.cues
    || ids.some(id => !available.has(id))) throw Error("CAPTION_TEXT_SELECTION");
  return project.captions.filter(cue => wanted.has(cue.id));
}
export interface CaptionTextMatchOptionsV1 { caseSensitive?: boolean; }
function caseMode(options?: CaptionTextMatchOptionsV1) {
  if (options?.caseSensitive !== undefined && typeof options.caseSensitive !== "boolean") throw Error("CAPTION_TEXT_CASE_MODE");
  return options?.caseSensitive ?? true;
}

/** Literal Unicode simple-case matching. Coordinates remain original UTF-16 offsets; no lowercased copy. */
export function* captionTextMatchRangesV1(text: string, query: string, caseSensitive = true): Generator<{ start: number; end: number }> {
  if (!query) return;
  if (caseSensitive) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(query, from); if (start < 0) return;
      from = start + query.length; yield { start, end: from };
    }
  } else {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const literal = new RegExp(escaped, "giu");
    for (let match = literal.exec(text); match; match = literal.exec(text)) yield { start: match.index, end: match.index + match[0].length };
  }
}
function occurrences(text: string, query: string, caseSensitive: boolean) {
  let count = 0, firstOffset = -1, removedBytes = 0;
  for (const range of captionTextMatchRangesV1(text, query, caseSensitive)) {
    if (firstOffset < 0) firstOffset = range.start;
    count++; if (!caseSensitive) removedBytes += bytes(text.slice(range.start, range.end));
  }
  return { count, firstOffset, removedBytes: caseSensitive ? count * bytes(query) : removedBytes };
}
function replaceLiteral(text: string, query: string, replacement: string, caseSensitive: boolean) {
  const pieces: string[] = []; let from = 0;
  for (const range of captionTextMatchRangesV1(text, query, caseSensitive)) {
    pieces.push(text.slice(from, range.start), replacement); from = range.end;
  }
  pieces.push(text.slice(from)); return pieces.join("");
}
function signature(project: EditProject) {
  return canonicalJson({ id: project.id, revision: project.revision, fps: project.fps, captions: project.captions,
    captionTrackLocks: project.tracks.filter(track => track.kind === "caption").map(track => ({ id: track.id, locked: track.locked })) });
}

/** Literal matches stay inside each original caption. Case-sensitive remains the historical default. */
export function findCaptionTextV1(project: EditProject, query: string, offset = 0,
  limit: number = CAPTION_DELIVERY_LIMITS.retainedIssues, captionIds?: readonly string[], options?: CaptionTextMatchOptionsV1) {
  textInput(query, false);
  const caseSensitive = caseMode(options);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1
    || limit > CAPTION_DELIVERY_LIMITS.retainedIssues) throw Error("CAPTION_TEXT_PAGE");
  const matches = selected(project, captionIds).flatMap(cue => {
    const found = occurrences(cue.text, query, caseSensitive);
    return found.count ? [{ captionId: cue.id, text: cue.text, start: cue.start, duration: cue.duration,
      occurrences: found.count, firstOffset: found.firstOffset }] : [];
  });
  return { query, matchingCues: matches.length, totalOccurrences: matches.reduce((sum, row) => sum + row.occurrences, 0),
    offsetUnit: "utf16-code-units" as const, offset, matches: matches.slice(offset, offset + limit),
    nextOffset: offset + limit < matches.length ? offset + limit : null };
}

export interface CaptionTextReplacementPreviewV1 {
  schema: "editkin.caption-text-replacement-preview/v1";
  status: "PREPARED" | "UNCHANGED"; query: string; replacement: string; caseSensitive?: boolean;
  matchingCues: number; totalOccurrences: number; changedCues: number;
  changes: Array<{ captionId: string; before: string; after: string; occurrences: number }>;
}
interface OwnedPreview {
  source: EditProject; sourceSignature: string; previewSignature: string; command?: EditorCommand;
}
const prepared = new WeakMap<CaptionTextReplacementPreviewV1, OwnedPreview>();

/** Prepare only text patches. The normal command/history path still performs the actual edit. */
export function prepareCaptionTextReplacementV1(project: EditProject, query: string, replacement: string,
  captionIds?: readonly string[], options?: CaptionTextMatchOptionsV1): CaptionTextReplacementPreviewV1 {
  textInput(query, false); textInput(replacement, true);
  const caseSensitive = caseMode(options);
  const cues = selected(project, captionIds), changes: CaptionTextReplacementPreviewV1["changes"] = [];
  const replacementBytes = bytes(replacement);
  let totalOccurrences = 0, matchingCues = 0;
  let resultingBytes = project.captions.reduce((sum, cue) => sum + bytes(cue.id) + bytes(cue.text)
    + bytes(cue.translation?.text ?? "") + bytes(cue.translation?.language ?? ""), 0);
  for (const cue of cues) {
    const found = occurrences(cue.text, query, caseSensitive); if (!found.count) continue;
    matchingCues++; totalOccurrences += found.count;
    if (caseSensitive && query === replacement) continue;
    resultingBytes += found.count * replacementBytes - found.removedBytes;
    if (resultingBytes > CAPTION_DELIVERY_LIMITS.textBytes) throw Error("CAPTION_TEXT_REPLACEMENT_BUDGET");
    const after = replaceLiteral(cue.text, query, replacement, caseSensitive); // '$' sequences remain literal.
    if (after === cue.text) continue;
    if (!after.trim()) throw Error("CAPTION_TEXT_REPLACEMENT_EMPTY_CUE");
    changes.push({ captionId: cue.id, before: cue.text, after, occurrences: found.count });
  }
  if (changes.length && captionTrackLocked(project)) throw Error(TRACK_LOCKED_MESSAGE);
  const result: CaptionTextReplacementPreviewV1 = { schema: "editkin.caption-text-replacement-preview/v1",
    status: changes.length ? "PREPARED" : "UNCHANGED", query, replacement, matchingCues, totalOccurrences,
    changedCues: changes.length, changes, ...(caseSensitive ? {} : { caseSensitive: false }) };
  if (bytes(JSON.stringify(result)) > CAPTION_DELIVERY_LIMITS.outputBytes) throw Error("CAPTION_TEXT_PREVIEW_BUDGET");
  const command: EditorCommand | undefined = changes.length ? { type: "batch",
    commands: changes.map(row => ({ type: "update_caption", captionId: row.captionId, patch: { text: row.after } })) } : undefined;
  prepared.set(result, { source: project, sourceSignature: signature(project), previewSignature: canonicalJson(result), command });
  return result;
}

/** A cloned/foreign preview, in-place edit, lock change or new project generation requires a fresh preview. */
export function currentCaptionTextReplacementCommandV1(project: EditProject, preview: CaptionTextReplacementPreviewV1) {
  const owned = prepared.get(preview);
  if (!owned || owned.source !== project || owned.sourceSignature !== signature(project)
    || owned.previewSignature !== canonicalJson(preview)) throw Error("CAPTION_TEXT_PREVIEW_STALE_OR_FOREIGN");
  return owned.command ? structuredClone(owned.command) : undefined;
}
