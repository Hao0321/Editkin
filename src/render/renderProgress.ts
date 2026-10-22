import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The steps of one export, in the order they run. Only a stage that runs an FFmpeg encode with `-progress` and a
 * known output length ever reports a fraction; every other stage reports its name only (no invented percentage).
 */
export const RENDER_STAGES = ["prepare", "precompose", "scene3d", "frames", "audio", "effects", "encode", "verify"] as const;
export type RenderStageId = typeof RENDER_STAGES[number];

export interface RenderProgressSnapshot {
  schema: "editkin.render-progress/v1";
  stage: RenderStageId;
  /** 1-based part while a multi-part stage (pre-rendered compositions) runs. */
  part?: number;
  parts?: number;
  /** 0..1 of the current stage; present only when FFmpeg reported output time and the stage length is known. */
  fraction?: number;
  /** Seconds of output the current stage has written, and that stage's length. */
  doneSeconds?: number;
  totalSeconds?: number;
  startedAtMs: number;
  stageStartedAtMs: number;
  updatedAtMs: number;
  sequence: number;
}

export type RenderProgressSink = (snapshot: RenderProgressSnapshot) => void;

interface ProgressState {
  sink: RenderProgressSink;
  now: () => number;
  snapshot: RenderProgressSnapshot;
}

const current = new AsyncLocalStorage<ProgressState>();

const finiteSeconds = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;

function publish(state: ProgressState, patch: Partial<RenderProgressSnapshot>): void {
  const next: RenderProgressSnapshot = { ...state.snapshot, ...patch, updatedAtMs: state.now(), sequence: state.snapshot.sequence + 1 };
  for (const key of Object.keys(next) as Array<keyof RenderProgressSnapshot>) if (next[key] === undefined) delete next[key];
  state.snapshot = next;
  try { state.sink(next); } catch { /* A progress reader never changes the render's outcome. */ }
}

/** Runs `operation` with a progress reporter; stages and FFmpeg output time inside it reach `sink`. */
export async function withRenderProgress<T>(sink: RenderProgressSink | undefined, operation: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  if (!sink) return operation();
  const startedAtMs = now();
  const state: ProgressState = { sink, now, snapshot: { schema: "editkin.render-progress/v1", stage: "prepare", startedAtMs, stageStartedAtMs: startedAtMs, updatedAtMs: startedAtMs, sequence: 0 } };
  return current.run(state, async () => {
    publish(state, {});
    return operation();
  });
}

/**
 * Enters a stage. `totalSeconds` is the output length the stage's FFmpeg encode writes; without it the stage has no
 * fraction. Re-entering the same stage with the same length keeps its measured progress.
 */
export function reportRenderStage(stage: RenderStageId, totalSeconds?: number): void {
  const state = current.getStore();
  if (!state) return;
  const total = finiteSeconds(totalSeconds);
  const previous = state.snapshot;
  if (previous.stage === stage && previous.totalSeconds === total) return;
  publish(state, { stage, totalSeconds: total, doneSeconds: undefined, fraction: undefined, stageStartedAtMs: state.now() });
}

/** Which pre-rendered composition is running (1-based), or undefined once they are done. */
export function reportRenderPart(part?: number, parts?: number): void {
  const state = current.getStore();
  if (!state) return;
  const valid = part !== undefined && parts !== undefined && Number.isSafeInteger(part) && Number.isSafeInteger(parts) && part >= 1 && part <= parts;
  // A new part starts its own measurement, even when it is as long as the previous one.
  publish(state, valid ? { part, parts, doneSeconds: undefined, fraction: undefined, stageStartedAtMs: state.now() }
    : { part: undefined, parts: undefined });
}

/**
 * The reporter for one FFmpeg process, bound to the render that starts it (stdout events may run outside the
 * async context). It turns FFmpeg's `out_time` into the current stage's fraction; it never raises one past 1 or
 * lets it go backwards within a stage.
 */
export function renderProgressTimeReporter(): ((outputSeconds: number) => void) | undefined {
  const state = current.getStore();
  if (!state) return undefined;
  return (outputSeconds: number) => {
    if (!Number.isFinite(outputSeconds) || outputSeconds < 0) return;
    const snapshot = state.snapshot;
    const total = snapshot.totalSeconds;
    if (total === undefined) return;
    const doneSeconds = Math.min(total, outputSeconds);
    if (snapshot.doneSeconds !== undefined && doneSeconds <= snapshot.doneSeconds) return;
    publish(state, { doneSeconds, fraction: Math.min(1, Math.max(0, doneSeconds / total)) });
  };
}

/** The latest snapshot inside a render, for tests and diagnostics. */
export function currentRenderProgress(): RenderProgressSnapshot | undefined {
  return current.getStore()?.snapshot;
}
