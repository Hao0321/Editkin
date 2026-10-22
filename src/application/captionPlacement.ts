import type { CaptionCue } from "../domain/types";

/** Where ＋ 文字 puts a new caption. */
export interface CaptionInsertPlan {
  /** Seconds on the project's frame grid. */
  start: number;
  duration: number;
  /** True when the playhead was inside existing text (or a gap too short to read), so the new text starts later. */
  moved: boolean;
}

const EPSILON = 1e-6;
/** A caption shorter than this cannot be read; such a gap is skipped. */
export const MIN_NEW_CAPTION_SECONDS = 0.5;
export const NEW_CAPTION_SECONDS = 3;

/**
 * Captions are one line of text at a time: the preview shows a single caption and the caption check reports overlaps
 * as errors. A new caption therefore never goes on top of existing text. It starts at the playhead when that spot is
 * free; inside existing text it starts where that text ends (the next free spot), and it is shortened to fit before
 * the following caption. A gap shorter than half a second is skipped.
 */
export function planCaptionInsert(captions: ReadonlyArray<Pick<CaptionCue, "start" | "duration">>, playhead: number, fps: number,
  preferredSeconds = NEW_CAPTION_SECONDS): CaptionInsertPlan {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const align = (time: number) => Math.max(0, Math.round(time * rate) / rate);
  const sorted = captions.filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.duration) && cue.duration > 0)
    .map(cue => ({ start: cue.start, end: cue.start + cue.duration })).sort((a, b) => a.start - b.start);
  const preferred = Math.max(MIN_NEW_CAPTION_SECONDS, Number.isFinite(preferredSeconds) ? preferredSeconds : NEW_CAPTION_SECONDS);
  let start = align(Number.isFinite(playhead) ? playhead : 0);
  let moved = false;
  for (let guard = 0; guard <= sorted.length + 1; guard += 1) {
    const covering = sorted.find(cue => cue.start <= start + EPSILON && start < cue.end - EPSILON);
    if (covering) { start = align(covering.end); moved = true; continue; }
    const next = sorted.find(cue => cue.start > start + EPSILON);
    const room = next ? next.start - start : Infinity;
    if (room + EPSILON >= MIN_NEW_CAPTION_SECONDS) {
      const duration = Math.max(1 / rate, Math.floor(Math.min(preferred, room) * rate + EPSILON) / rate);
      return { start, duration, moved };
    }
    start = align(next!.end);
    moved = true;
  }
  const end = sorted.reduce((latest, cue) => Math.max(latest, cue.end), 0);
  return { start: align(end), duration: Math.round(preferred * rate) / rate, moved: true };
}
