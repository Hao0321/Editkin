import { alignTime } from "../domain/editGraph";
import type { SmartCutKeepRange } from "../domain/smartCut";
import { analyzeSemanticHighlightSignals, type SemanticHighlightRole } from "./semanticHighlightSignals";

export interface SemanticCue { start: number; end: number; text: string }
export interface SemanticCut { time: number; score: number }

export interface SemanticAutoEditRequest {
  duration: number;
  fps: number;
  cues: readonly SemanticCue[];
  cuts?: readonly SemanticCut[];
  targetRatio?: number;
  minSegmentDuration?: number;
  maxSegmentDuration?: number;
}

export interface SemanticSegment {
  start: number;
  end: number;
  score: number;
  selected: boolean;
  text: string;
  reasons: string[];
  roles: SemanticHighlightRole[];
}

export interface SemanticAutoEditPlan {
  engine: "editkin-explainable-highlight-0.2";
  keepRanges: SmartCutKeepRange[];
  segments: SemanticSegment[];
  originalDuration: number;
  keptDuration: number;
  removedDuration: number;
  targetRatio: number;
}

const SIGNAL_WORDS = /(重點|關鍵|結論|方法|結果|原因|證明|總結|為什麼|怎麼|important|key|result|because|therefore|how|why|summary|\d)/giu;
const FILLER_SEPARATORS = new Set([",", ".", "!", "?", "，", "。", "！", "？", "、"]);
const FILLER_FIXED_WORDS = ["那個", "就是", "然後", "okay", "ok"];

// A repeated, nested regex can backtrack exponentially on a long transcript.
// Consume each character once so hostile caption text cannot stall auto-edit.
function isFillerOnly(text: string): boolean {
  const value = text.toLowerCase();
  let cursor = 0;
  let sawWord = false;
  while (cursor < value.length) {
    const character = value[cursor];
    if (/\s/u.test(character) || FILLER_SEPARATORS.has(character)) {
      if (!sawWord) return false;
      cursor += 1;
      continue;
    }
    if ("嗯呃啊喔好".includes(character)) {
      sawWord = true;
      cursor += 1;
      continue;
    }
    const fixed = FILLER_FIXED_WORDS.find((word) => value.startsWith(word, cursor));
    if (fixed) {
      sawWord = true;
      cursor += fixed.length;
      continue;
    }
    const repeated = value.startsWith("erm", cursor) ? ["erm", "m"]
      : value.startsWith("um", cursor) ? ["um", "m"]
      : value.startsWith("uh", cursor) ? ["uh", "h"] : undefined;
    if (!repeated) return false;
    sawWord = true;
    cursor += repeated[0].length;
    while (value[cursor] === repeated[1]) cursor += 1;
  }
  return sawWord;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function uniqueAligned(values: number[], duration: number, fps: number): number[] {
  const lastFrame = Math.floor(duration * fps + 1e-7) / fps;
  return [...new Set(values.map((value) => Math.min(lastFrame, alignTime(clamp(value, 0, duration), fps))))]
    .filter((value) => value >= 0 && value <= duration)
    .sort((left, right) => left - right);
}

function normalizedRequest(request: SemanticAutoEditRequest): SemanticAutoEditRequest {
  if (request.cues.length > 100_000 || (request.cuts?.length ?? 0) > 100_000) throw new Error("智慧成片分析項目超過安全上限");
  const cues = request.cues.map((cue) => {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > request.duration || cue.text.length > 20_000) throw new Error("智慧成片 cue 不合法");
    return { ...cue, text: cue.text.normalize("NFKC") };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const cuts = (request.cuts ?? []).map((cut) => {
    if (!Number.isFinite(cut.time) || !Number.isFinite(cut.score) || cut.time <= 0 || cut.time >= request.duration || cut.score < 0 || cut.score > 100) throw new Error("智慧成片場景切點不合法");
    return { ...cut };
  }).sort((left, right) => left.time - right.time);
  return { ...request, cues, cuts };
}

function semanticBoundaries(request: SemanticAutoEditRequest, minSegment: number, maxSegment: number): number[] {
  const boundaries = [0, request.duration, ...(request.cuts ?? []).map((cut) => cut.time)];
  const cues = [...request.cues].sort((left, right) => left.start - right.start);
  for (let index = 1; index < cues.length; index += 1) {
    const gap = cues[index].start - cues[index - 1].end;
    if (gap >= 0.75) boundaries.push(cues[index - 1].end + gap / 2);
  }
  for (let cursor = maxSegment; cursor < request.duration; cursor += maxSegment) boundaries.push(cursor);
  const aligned = uniqueAligned(boundaries, request.duration, request.fps);
  const coalesced = [aligned[0] ?? 0];
  for (const boundary of aligned.slice(1, -1)) {
    if (boundary - coalesced[coalesced.length - 1] >= minSegment) coalesced.push(boundary);
  }
  // Container/audio tails need not end on a video frame. Nearest rounding can
  // extend a selected range past the asset, which the command boundary rejects.
  const last = Math.floor(request.duration * request.fps + 1e-7) / request.fps;
  if (last - coalesced[coalesced.length - 1] < minSegment && coalesced.length > 1) coalesced.pop();
  coalesced.push(last);
  return coalesced;
}

function coveredSeconds(ranges: Array<{ start: number; end: number }>): number {
  const sorted = ranges.filter((range) => range.end > range.start).sort((left, right) => left.start - right.start);
  let total = 0; let current: { start: number; end: number } | undefined;
  for (const range of sorted) {
    if (!current) current = { ...range };
    else if (range.start <= current.end) current.end = Math.max(current.end, range.end);
    else { total += current.end - current.start; current = { ...range }; }
  }
  return total + (current ? current.end - current.start : 0);
}

function scoreSegment(start: number, end: number, request: SemanticAutoEditRequest, overlapping: readonly SemanticCue[], boundaryCut: readonly SemanticCut[]): Omit<SemanticSegment, "selected"> {
  const duration = end - start;
  const spoken = overlapping.filter((cue) => cue.text.trim());
  const text = spoken.map((cue) => cue.text.trim()).join(" ");
  const compactText = text.replace(/\s/g, "");
  const speechSeconds = coveredSeconds(spoken.map((cue) => ({ start: Math.max(start, cue.start), end: Math.min(end, cue.end) })));
  const speechCoverage = clamp(speechSeconds / Math.max(duration, 1 / request.fps), 0, 1);
  const density = clamp(compactText.length / Math.max(8, duration * 7), 0, 1);
  const signals = text.match(SIGNAL_WORDS)?.length ?? 0;
  const signalScore = clamp(signals / 3, 0, 1);
  const emphasis = /[!?！？]/.test(text) ? 1 : 0;
  const visualScore = clamp(Math.max(0, ...boundaryCut.map((cut) => cut.score)) / 100, 0, 1);
  const fillerPenalty = compactText && isFillerOnly(text.trim()) ? 0.82 : 0;
  const semantic = analyzeSemanticHighlightSignals(text);
  const score = clamp(0.12 * speechCoverage + 0.08 * density + 0.06 * signalScore + 0.04 * emphasis + 0.05 * visualScore + semantic.bonus - semantic.penalty - fillerPenalty, 0, 1);
  const reasons: string[] = [...semantic.reasons];
  if (speechCoverage >= 0.55) reasons.push("語音密度高");
  if (signalScore > 0) reasons.push("包含重點語句");
  if (emphasis) reasons.push("語氣強調");
  if (visualScore >= 0.1) reasons.push("場景切換");
  if (fillerPenalty) reasons.push("僅有填充語");
  if (!text) reasons.push("沒有可辨識語音");
  return { start, end, score: Number(score.toFixed(4)), text, reasons, roles: semantic.roles };
}

function scoreSegments(boundaries: number[], request: SemanticAutoEditRequest): Array<Omit<SemanticSegment, "selected">> {
  const cues = request.cues; const cuts = request.cuts ?? [];
  let cueCursor = 0; let cutCursor = 0;
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    while (cueCursor < cues.length && cues[cueCursor].end <= start) cueCursor += 1;
    const overlapping: SemanticCue[] = [];
    for (let cursor = cueCursor; cursor < cues.length && cues[cursor].start < end; cursor += 1) {
      if (cues[cursor].end > start) overlapping.push(cues[cursor]);
    }
    while (cutCursor < cuts.length && cuts[cutCursor].time < start - .55) cutCursor += 1;
    const boundaryCuts: SemanticCut[] = [];
    for (let cursor = cutCursor; cursor < cuts.length && cuts[cursor].time <= end + .55; cursor += 1) {
      if (Math.abs(cuts[cursor].time - start) < .55 || Math.abs(cuts[cursor].time - end) < .55) boundaryCuts.push(cuts[cursor]);
    }
    return scoreSegment(start, end, request, overlapping, boundaryCuts);
  });
}

function mergeSelectedRanges(segments: SemanticSegment[], fps: number): SmartCutKeepRange[] {
  const selected = segments.filter((segment) => segment.selected).sort((left, right) => left.start - right.start);
  const ranges: SmartCutKeepRange[] = [];
  for (const segment of selected) {
    const previous = ranges.at(-1);
    if (previous && Math.abs(previous.end - segment.start) <= 0.5 / fps) previous.end = segment.end;
    else ranges.push({ start: segment.start, end: segment.end });
  }
  return ranges.map((range) => ({ start: alignTime(range.start, fps), end: alignTime(range.end, fps) }));
}

export function planSemanticAutoEdit(request: SemanticAutoEditRequest): SemanticAutoEditPlan {
  if (!Number.isFinite(request.duration) || request.duration <= 0 || request.duration > 24 * 3600) throw new Error("智慧成片素材時長不合法");
  if (!Number.isFinite(request.fps) || request.fps <= 0 || request.fps > 240) throw new Error("智慧成片 fps 不合法");
  if (Math.floor(request.duration * request.fps + 1e-7) < 1) throw new Error("智慧成片素材不足一個完整影格");
  const normalized = normalizedRequest(request);
  if (!normalized.cues.some((cue) => cue.text.trim())) throw new Error("沒有可用來判斷重點的語音內容");
  const targetRatio = clamp(normalized.targetRatio ?? 0.65, 0.2, 1);
  const minSegment = clamp(normalized.minSegmentDuration ?? 0.8, 1 / normalized.fps, Math.min(5, normalized.duration));
  const maxSegment = clamp(normalized.maxSegmentDuration ?? 12, minSegment, Math.max(minSegment, normalized.duration));
  const boundaries = semanticBoundaries(normalized, minSegment, maxSegment);
  const scored = scoreSegments(boundaries, normalized);
  const targetDuration = normalized.duration * targetRatio;
  const selected = new Set<number>();
  let selectedDuration = 0;
  for (const item of scored.map((segment, index) => ({ segment, index })).sort((left, right) => (
    right.segment.score - left.segment.score || left.segment.start - right.segment.start
  ))) {
    if (selectedDuration >= targetDuration && selected.size) break;
    selected.add(item.index);
    selectedDuration += item.segment.end - item.segment.start;
  }
  const segments = scored.map((segment, index): SemanticSegment => ({ ...segment, selected: selected.has(index) }));
  const keepRanges = mergeSelectedRanges(segments, normalized.fps);
  const keptDuration = alignTime(keepRanges.reduce((sum, range) => sum + range.end - range.start, 0), normalized.fps);
  return {
    engine: "editkin-explainable-highlight-0.2",
    keepRanges,
    segments,
    originalDuration: normalized.duration,
    keptDuration,
    removedDuration: Math.max(0, normalized.duration - keptDuration),
    targetRatio,
  };
}
