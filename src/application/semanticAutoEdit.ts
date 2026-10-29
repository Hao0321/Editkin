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

/** highlight = condense by spoken-content score (Shorts); narration pause trim = keep every spoken
 * cue and remove only pauses (long-form/talking); visual quality = no speech, keep the steadiest shots. */
export type AutoEditPlanEngine = "editkin-explainable-highlight-0.2" | "editkin-narration-pause-trim-0.1" | "editkin-visual-quality-0.1";

export interface SemanticAutoEditPlan {
  engine: AutoEditPlanEngine;
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

/** Runs of strictly overlapping spoken cues. Cues that only touch stay separate runs, so their shared edge is a valid cut. */
function speechRuns(cues: readonly SemanticCue[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  for (const cue of cues) {
    if (!cue.text.trim()) continue;
    const last = runs.at(-1);
    if (last && cue.start < last.end) last.end = Math.max(last.end, cue.end);
    else runs.push({ start: cue.start, end: cue.end });
  }
  return runs;
}

/** A cut must fall between words: a boundary inside spoken audio moves to the nearer edge of that speech,
 * a little into the surrounding pause when there is one. Scene cuts and length caps never split a cue. */
function outsideSpeech(time: number, runs: ReadonlyArray<{ start: number; end: number }>): number {
  let low = 0; let high = runs.length - 1; let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (runs[middle].start < time) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  const run = runs[found];
  if (!run || time >= run.end) return time;
  const pad = 0.12;
  if (time - run.start <= run.end - time) return run.start - Math.min(pad, Math.max(0, (run.start - (runs[found - 1]?.end ?? 0)) / 2));
  return run.end + Math.min(pad, Math.max(0, ((runs[found + 1]?.start ?? Number.POSITIVE_INFINITY) - run.end) / 2));
}

function semanticBoundaries(request: SemanticAutoEditRequest, minSegment: number, maxSegment: number): number[] {
  const boundaries = [0, request.duration, ...(request.cuts ?? []).map((cut) => cut.time)];
  const cues = [...request.cues].sort((left, right) => left.start - right.start);
  for (let index = 1; index < cues.length; index += 1) {
    const gap = cues[index].start - cues[index - 1].end;
    if (gap >= 0.75) boundaries.push(cues[index - 1].end + gap / 2);
  }
  for (let cursor = maxSegment; cursor < request.duration; cursor += maxSegment) boundaries.push(cursor);
  const runs = speechRuns(cues);
  const aligned = uniqueAligned(boundaries.map((time, index) => index < 2 ? time : outsideSpeech(time, runs)), request.duration, request.fps);
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

function assertPlanTimeline(request: { duration: number; fps: number }): void {
  if (!Number.isFinite(request.duration) || request.duration <= 0 || request.duration > 24 * 3600) throw new Error("智慧成片素材時長不合法");
  if (!Number.isFinite(request.fps) || request.fps <= 0 || request.fps > 240) throw new Error("智慧成片 fps 不合法");
  if (Math.floor(request.duration * request.fps + 1e-7) < 1) throw new Error("智慧成片素材不足一個完整影格");
}

export function planSemanticAutoEdit(request: SemanticAutoEditRequest): SemanticAutoEditPlan {
  assertPlanTimeline(request);
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

function mergeRanges(ranges: ReadonlyArray<{ start: number; end: number }>, joinBelow: number): Array<{ start: number; end: number }> {
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const last = merged.at(-1);
    if (last && range.start - last.end < joinBelow) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function textWithin(cues: readonly SemanticCue[], start: number, end: number): string {
  return cues.filter((cue) => cue.text.trim() && cue.start < end && cue.end > start).map((cue) => cue.text.trim()).join(" ");
}

function keptSeconds(ranges: readonly SmartCutKeepRange[], fps: number): number {
  return alignTime(ranges.reduce((sum, range) => sum + range.end - range.start, 0), fps);
}

export interface NarrationPauseTrimRequest {
  duration: number;
  fps: number;
  cues: readonly SemanticCue[];
  /** Ranges an independent audio silence detector kept (seconds, clip-relative). Audible speech the
   * transcript missed is kept as well; without this evidence the transcript alone decides. */
  audioKeepRanges?: readonly SmartCutKeepRange[];
  /** Shortest stretch without speech that is removed; shorter pauses stay untouched. */
  minPause?: number;
  /** Seconds kept before every spoken cue (breath/onset) and after it (decay). */
  leadIn?: number;
  tail?: number;
}

export const NARRATION_PAUSE_TRIM = Object.freeze({ minPause: 0.75, leadIn: 0.15, tail: 0.3 });

/**
 * Long-form/talking edit (roadmap 1.14): every spoken cue is kept whole and only pauses are removed,
 * the equivalent of targetRatio 1. Nothing is ranked or dropped for being "less important".
 */
export function planNarrationPauseTrim(request: NarrationPauseTrimRequest): SemanticAutoEditPlan {
  assertPlanTimeline(request);
  const { fps } = request;
  const normalized = normalizedRequest({ duration: request.duration, fps, cues: request.cues });
  const spoken = normalized.cues.filter((cue) => cue.text.trim());
  if (!spoken.length) throw new Error("沒有可用來判斷重點的語音內容");
  if ((request.audioKeepRanges?.length ?? 0) > 100_000) throw new Error("智慧成片分析項目超過安全上限");
  const audio = (request.audioKeepRanges ?? []).map((range) => {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) throw new Error("智慧成片聲音區間不合法");
    return { start: range.start, end: range.end };
  });
  const lastFrame = Math.floor(request.duration * fps + 1e-7) / fps;
  const leadIn = clamp(request.leadIn ?? NARRATION_PAUSE_TRIM.leadIn, 0, 1);
  const tail = clamp(request.tail ?? NARRATION_PAUSE_TRIM.tail, 0, 2);
  const minPause = clamp(request.minPause ?? NARRATION_PAUSE_TRIM.minPause, leadIn + tail + 1 / fps, 60);
  // A pause of minPause keeps leadIn + tail of itself, so what remains removable is at least this long.
  const joinBelow = minPause - leadIn - tail;
  const kept = mergeRanges([...spoken.map((cue) => ({ start: cue.start - leadIn, end: cue.end + tail })), ...audio]
    .map((range) => ({ start: clamp(range.start, 0, lastFrame), end: clamp(range.end, 0, lastFrame) }))
    .filter((range) => range.end > range.start), joinBelow);
  if (!kept.length) kept.push({ start: 0, end: lastFrame });
  if (kept[0].start < joinBelow) kept[0].start = 0;
  if (lastFrame - kept[kept.length - 1].end < joinBelow) kept[kept.length - 1].end = lastFrame;
  // Frame-align outward: rounding must never shave a spoken frame.
  const keepRanges = mergeRanges(kept.map((range) => ({
    start: Math.floor(range.start * fps + 1e-6) / fps,
    end: Math.min(lastFrame, Math.ceil(range.end * fps - 1e-6) / fps),
  })), 0.5 / fps).map((range) => ({ start: alignTime(range.start, fps), end: alignTime(range.end, fps) }))
    .filter((range) => range.end - range.start >= 1 / fps - 1e-9);
  const segments: SemanticSegment[] = [];
  const pause = (start: number, end: number): SemanticSegment => ({ start, end, score: 0, selected: false, text: "", reasons: ["停頓"], roles: [] });
  let cursor = 0;
  for (const range of keepRanges) {
    if (range.start - cursor > 1e-9) segments.push(pause(cursor, range.start));
    const text = textWithin(spoken, range.start, range.end);
    segments.push({ start: range.start, end: range.end, score: 1, selected: true, text, reasons: [text ? "完整保留旁白" : "保留可聽見的聲音"], roles: [] });
    cursor = range.end;
  }
  if (lastFrame - cursor > 1e-9) segments.push(pause(cursor, lastFrame));
  const keptDuration = keptSeconds(keepRanges, fps);
  return {
    engine: "editkin-narration-pause-trim-0.1",
    keepRanges,
    segments,
    originalDuration: request.duration,
    keptDuration,
    removedDuration: Math.max(0, request.duration - keptDuration),
    targetRatio: 1,
  };
}

/** Smart Cut (silence detector) keep ranges in frames to clip-relative seconds. */
export function audioKeepRangesFromSmartCut(result: { fps: number; ranges: ReadonlyArray<{ startFrame: number; endFrame: number }> }): SmartCutKeepRange[] {
  if (!Number.isFinite(result.fps) || result.fps <= 0) return [];
  return result.ranges
    .filter((range) => Number.isFinite(range.startFrame) && Number.isFinite(range.endFrame) && range.startFrame >= 0 && range.endFrame > range.startFrame)
    .map((range) => ({ start: range.startFrame / result.fps, end: range.endFrame / result.fps }));
}

/** Silence-detector settings for narration evidence: only pauses of at least this length count as silent. */
export const NARRATION_SILENCE_DETECTION = Object.freeze({ minSilence: 0.75, padding: 0.1 });

/** The scene detector at its lowest threshold: frame-change spikes mark jolts, whip pans and handling
 * (real handheld clips score below 1 almost everywhere; jolts reach roughly 1-6, scene cuts 10+). */
export const VISUAL_ACTIVITY_DETECTION = Object.freeze({ threshold: 1, minSceneDuration: 0.2 });

export interface VisualActivitySample { time: number; score: number }

export interface VisualQualityRequest {
  duration: number;
  fps: number;
  /** Shot boundaries from the scene detector at its default threshold. */
  cuts?: readonly SemanticCut[];
  /** Frame-change samples from VISUAL_ACTIVITY_DETECTION; absent means picture stability is unmeasured. */
  activity?: readonly VisualActivitySample[];
  /** Seconds to keep; clamped to the usable footage. */
  targetDuration: number;
  windowSeconds?: number;
  /** Seconds dropped at both ends of every shot (record start/stop handling, transition frames). */
  edgeTrim?: number;
}

/** No-speech target: a Short keeps 8–30 s of the steadiest footage; long-form drops only the worst ~20%. */
export function visualHighlightTargetSeconds(duration: number, shortForm: boolean): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return shortForm ? Math.min(duration, Math.max(Math.min(duration, 8), Math.min(30, duration * 0.65))) : duration * 0.8;
}

interface VisualWindow { shot: number; start: number; end: number; quality: number; instability: number; spike: boolean; offCentre: number }

/**
 * Footage without speech (roadmap 1.14): choose segments by picture steadiness instead of failing.
 * Each shot loses its shaky edges, the rest is split into windows scored by frame-change energy, every
 * shot's best window is preferred before a second window of any shot, and the chosen windows stay in
 * shooting order.
 */
export function planVisualQualityAutoEdit(request: VisualQualityRequest): SemanticAutoEditPlan {
  assertPlanTimeline(request);
  const { duration, fps } = request;
  const normalized = normalizedRequest({ duration, fps, cues: [], cuts: request.cuts ?? [] });
  if ((request.activity?.length ?? 0) > 1_000_000) throw new Error("智慧成片分析項目超過安全上限");
  const activity = (request.activity ?? [])
    .filter((sample) => Number.isFinite(sample.time) && Number.isFinite(sample.score) && sample.time >= 0 && sample.time <= duration && sample.score >= 0)
    .sort((left, right) => left.time - right.time);
  const lastFrame = Math.floor(duration * fps + 1e-7) / fps;
  const target = clamp(Number.isFinite(request.targetDuration) ? request.targetDuration : lastFrame, 1 / fps, lastFrame);
  const windowSeconds = clamp(request.windowSeconds ?? 3, 1, 10);
  const edgeTrim = clamp(request.edgeTrim ?? 0.4, 0, 2);
  const edges = uniqueAligned([0, lastFrame, ...(normalized.cuts ?? []).map((cut) => cut.time)], duration, fps);
  const firstAtOrAfter = (time: number) => {
    let low = 0; let high = activity.length;
    while (low < high) { const middle = (low + high) >> 1; if (activity[middle].time < time) low = middle + 1; else high = middle; }
    return low;
  };
  const windows: VisualWindow[] = [];
  const shots = Array.from({ length: edges.length - 1 }, (_, shot) => {
    const shotStart = edges[shot]; const shotEnd = edges[shot + 1];
    const trim = Math.min(edgeTrim, (shotEnd - shotStart) * 0.15);
    return { shot, shotStart, shotEnd, start: shotStart + trim, end: shotEnd - trim };
  }).filter((shot) => shot.shotEnd - shot.shotStart >= 1 / fps);
  // A flash shot (under half a second once its edges are trimmed) is not a candidate unless nothing else is.
  const steady = shots.filter((shot) => shot.end - shot.start >= 0.5);
  for (const { shot, shotStart, shotEnd, ...usable } of steady.length ? steady : shots) {
    const length = shotEnd - shotStart;
    const { start, end } = usable.end - usable.start >= 1 / fps ? usable : { start: shotStart, end: shotEnd };
    const count = Math.max(1, Math.round((end - start) / windowSeconds));
    const step = (end - start) / count;
    for (let index = 0; index < count; index += 1) {
      const windowStart = start + index * step;
      const windowEnd = index === count - 1 ? end : start + (index + 1) * step;
      let energy = 0; let peak = 0;
      for (let cursor = firstAtOrAfter(windowStart); cursor < activity.length && activity[cursor].time < windowEnd; cursor += 1) {
        energy += Math.min(activity[cursor].score, 10);
        peak = Math.max(peak, activity[cursor].score);
      }
      const instability = clamp(energy / (10 * 5 * Math.max(windowEnd - windowStart, 1 / fps)), 0, 1);
      const spike = peak >= 4;
      const centre = (shotStart + shotEnd) / 2;
      // Quantized so equal candidates tie exactly and the earlier footage wins, not floating-point noise.
      windows.push({ shot, start: windowStart, end: windowEnd, instability, spike,
        quality: Number(clamp(1 - instability - (spike ? 0.15 : 0), 0, 1).toFixed(6)),
        offCentre: Number((Math.abs((windowStart + windowEnd) / 2 - centre) / Math.max(length / 2, 1 / fps)).toFixed(6)) });
    }
  }
  const rank = (left: number, right: number) => windows[right].quality - windows[left].quality
    || windows[left].offCentre - windows[right].offCentre || windows[left].start - windows[right].start;
  const chosen = new Set<number>();
  let chosenSeconds = 0;
  const take = (index: number) => {
    if (chosen.has(index) || chosenSeconds >= target - 0.5 / fps) return;
    chosen.add(index);
    chosenSeconds += windows[index].end - windows[index].start;
  };
  const bestPerShot = new Map<number, number>();
  windows.forEach((candidate, index) => {
    const best = bestPerShot.get(candidate.shot);
    if (best === undefined || rank(index, best) < 0) bestPerShot.set(candidate.shot, index);
  });
  [...bestPerShot.values()].sort(rank).forEach(take);
  windows.map((_, index) => index).sort(rank).forEach(take);
  const segments = windows.map((candidate, index): SemanticSegment => ({
    start: alignTime(candidate.start, fps), end: alignTime(candidate.end, fps), score: Number(candidate.quality.toFixed(4)), selected: chosen.has(index), text: "",
    reasons: chosen.has(index) ? [candidate.instability < 0.1 ? "畫面穩定" : "晃動較少"] : [candidate.spike ? "明顯晃動" : "保留長度已足夠"],
    roles: [],
  }));
  const keepRanges = mergeRanges(segments.filter((segment) => segment.selected).map(({ start, end }) => ({ start, end: Math.min(end, lastFrame) })), 0.5 / fps)
    .map((range) => ({ start: alignTime(range.start, fps), end: alignTime(range.end, fps) }))
    .filter((range) => range.end - range.start >= 1 / fps - 1e-9);
  if (!keepRanges.length) throw new Error("智慧成片沒有產生可保留區間");
  const keptDuration = keptSeconds(keepRanges, fps);
  return {
    engine: "editkin-visual-quality-0.1",
    keepRanges,
    segments,
    originalDuration: duration,
    keptDuration,
    removedDuration: Math.max(0, duration - keptDuration),
    targetRatio: Number(clamp(target / duration, 0, 1).toFixed(4)),
  };
}
