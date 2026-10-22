import type { PlainProblem } from "../application/plainProblems";
import { addProgressSample, estimateRemainingMs, parseRenderProgress, type ProgressSample, type RenderProgressView } from "../application/renderProgressModel";
import type { DesktopRenderResult, HaoDesktopApi } from "./apiTypes";

export type RenderJobKind = "video" | "alpha";
/** choosing: the save dialog is open (no panel yet). running → done | failed | canceled. */
export type RenderJobPhase = "choosing" | "running" | "done" | "failed" | "canceled";

export interface RenderJobState {
  id: string;
  kind: RenderJobKind;
  phase: RenderJobPhase;
  /** UI clock: when the renderer started (the location was chosen). */
  runningSinceMs?: number;
  finishedAtMs?: number;
  outputPath?: string;
  /** A URL the in-app player can open (desktop asset protocol). */
  outputUrl?: string;
  progress?: RenderProgressView;
  samples: readonly ProgressSample[];
  remainingMs?: number;
  cancelRequested: boolean;
  /** The creator moved the panel aside to keep editing. */
  collapsed: boolean;
  problem?: PlainProblem;
  retry?: () => void;
}

export const RENDER_JOB_POLL_MS = 500;

let state: RenderJobState | undefined;
const listeners = new Set<() => void>();
let poller: ReturnType<typeof setInterval> | undefined;
let now = () => Date.now();

function publish(next: RenderJobState | undefined): void {
  state = next;
  for (const listener of listeners) listener();
}
function update(id: string, patch: Partial<RenderJobState>): void {
  if (!state || state.id !== id) return;
  publish({ ...state, ...patch });
}

export function currentRenderJob(): RenderJobState | undefined { return state; }
export function subscribeRenderJob(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** A render that has not finished (including while the save dialog is open). */
export function renderJobBusy(): boolean { return state?.phase === "choosing" || state?.phase === "running"; }

export function newRenderJobId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `render-${[...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** What the host reported for this job; the first report means the location was chosen and rendering began. */
export function observeRenderJobProgress(id: string, report: unknown): void {
  if (!state || state.id !== id || (state.phase !== "choosing" && state.phase !== "running")) return;
  const host = report && typeof report === "object" ? report as Record<string, unknown> : undefined;
  if (host?.known !== true) return;
  const at = now();
  const progress = parseRenderProgress(host.progress) ?? state.progress;
  const samples = addProgressSample(state.samples, progress, at);
  publish({
    ...state,
    phase: "running",
    runningSinceMs: state.runningSinceMs ?? at,
    outputPath: typeof host.outputPath === "string" ? host.outputPath : state.outputPath,
    cancelRequested: state.cancelRequested || host.cancelRequested === true,
    progress, samples,
    remainingMs: estimateRemainingMs(samples),
  });
}

export function closeRenderJob(): void {
  if (state && (state.phase === "choosing" || state.phase === "running")) return;
  publish(undefined);
}

export function setRenderJobCollapsed(collapsed: boolean): void {
  if (state) update(state.id, { collapsed });
}

/** 「停止輸出」: the host asks the renderer to stop; the job ends when the render call returns. */
export async function cancelRenderJob(api: Pick<HaoDesktopApi, "cancelRenderJob"> | undefined): Promise<void> {
  if (!state || state.phase !== "running" || state.cancelRequested || !api?.cancelRenderJob) return;
  const id = state.id;
  update(id, { cancelRequested: true });
  try { await api.cancelRenderJob(id); }
  catch { update(id, { cancelRequested: false }); }
}

/** Waits (bounded) for a running job to end, e.g. before the window closes. */
export function waitForRenderJobEnd(timeoutMs: number): Promise<boolean> {
  if (!renderJobBusy()) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { unsubscribe(); resolve(false); }, timeoutMs);
    const unsubscribe = subscribeRenderJob(() => {
      if (renderJobBusy()) return;
      clearTimeout(timer); unsubscribe(); resolve(true);
    });
  });
}

export interface RenderJobRunOptions {
  api: Pick<HaoDesktopApi, "renderJobProgress">;
  kind: RenderJobKind;
  /** Starts the native render with this job ID (the host opens the save dialog first). */
  start: (jobId: string) => Promise<DesktopRenderResult>;
}

/**
 * Runs one export as the visible job: polls the host's progress while the render call is pending and leaves the
 * job in done / canceled (or no job, when the save dialog was closed). A thrown error is returned to the caller,
 * which records it with `failRenderJob` so the panel can say what happened in plain words.
 */
export async function runRenderJob({ api, kind, start }: RenderJobRunOptions): Promise<{ id: string; result: DesktopRenderResult }> {
  const id = newRenderJobId();
  if (poller) clearInterval(poller);
  publish({ id, kind, phase: "choosing", samples: [], cancelRequested: false, collapsed: false });
  const poll = () => {
    if (!api.renderJobProgress) return;
    void api.renderJobProgress(id).then(report => observeRenderJobProgress(id, report), () => undefined);
  };
  poller = setInterval(poll, RENDER_JOB_POLL_MS);
  try {
    const result = await start(id);
    if (!state || state.id !== id) return { id, result };
    if (result.canceled && !result.stoppedByUser) publish(undefined);
    else if (result.canceled) update(id, { phase: "canceled", finishedAtMs: now(), collapsed: false });
    else update(id, {
      phase: "done", finishedAtMs: now(), runningSinceMs: state.runningSinceMs ?? now(), collapsed: false,
      outputPath: result.outputPath ?? state.outputPath, outputUrl: result.outputUrl,
      progress: state.progress ? { ...state.progress, stage: "verify", fraction: undefined } : state.progress,
    });
    return { id, result };
  } finally {
    clearInterval(poller);
    poller = undefined;
  }
}

export function failRenderJob(id: string, problem: PlainProblem, retry?: () => void): void {
  if (!state || state.id !== id) return;
  update(id, { phase: "failed", finishedAtMs: now(), problem, retry, collapsed: false });
}

/** Tests only: show a given job state. */
export function setRenderJobForTest(next: RenderJobState | undefined): void {
  publish(next);
}

/** Tests only. */
export function resetRenderJobForTest(clock?: () => number): void {
  if (poller) clearInterval(poller);
  poller = undefined;
  now = clock ?? (() => Date.now());
  publish(undefined);
}
