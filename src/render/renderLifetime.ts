import { AsyncLocalStorage } from "node:async_hooks";
import { rename } from "node:fs/promises";

/** Longest delay a Node timer accepts; a longer delay would fire immediately. */
export const MAX_RENDER_TIMER_MS = 2_147_483_647;
/** Floor of every export deadline: startup, probes, muxing and output identity. */
export const RENDER_DEADLINE_BASE_MS = 30 * 60_000;
/** Allowance per second of rendered work, i.e. an export may run 60x slower than real time. */
export const RENDER_DEADLINE_PER_WORK_SECOND_MS = 60_000;
/** A watched encoder that shows no progress for this long is treated as stalled. */
export const DEFAULT_RENDER_STALL_MS = 10 * 60_000;

interface RenderLifetime { signal: AbortSignal; deadlineAt: number; limitMs: number; stallMs: number; abort(reason: unknown): void }
const current = new AsyncLocalStorage<RenderLifetime>();

/** The total export deadline scales with the seconds of video the render must produce (final output plus
 * pre-rendered compositions); there is no fixed cap. Hangs are caught by the no-progress watchdog instead. */
export function renderDeadlineForWorkSeconds(workSeconds: number): number {
  const seconds = Number.isFinite(workSeconds) && workSeconds > 0 ? workSeconds : 0;
  return Math.min(MAX_RENDER_TIMER_MS, Math.ceil(RENDER_DEADLINE_BASE_MS + seconds * RENDER_DEADLINE_PER_WORK_SECOND_MS));
}

/** Budget for fully decoding a finished export (verification): never below the former fixed 20 minutes, and
 * growing by 4 seconds per second of video so long films are not failed by a hidden cap. */
export function fullDecodeTimeoutMs(durationSeconds: number): number {
  const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  return Math.min(MAX_RENDER_TIMER_MS, Math.max(20 * 60_000, Math.ceil(10 * 60_000 + seconds * 4_000)));
}

/** Human-readable zh-TW duration for deadline and stall messages. */
export function formatRenderDuration(milliseconds: number): string {
  const totalMinutes = Math.round(milliseconds / 60_000);
  if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1_000))} 秒`;
  if (totalMinutes < 60) return `${totalMinutes} 分鐘`;
  const hours = Math.floor(totalMinutes / 60), minutes = totalMinutes % 60;
  return minutes ? `${hours} 小時 ${minutes} 分鐘` : `${hours} 小時`;
}

function deadlineError(limitMs: number): Error {
  return new Error(`影片輸出總時間逾時（上限 ${formatRenderDuration(limitMs)}）`);
}

/** The watched process stopped making observable progress; the render is aborted, never GREEN. */
export function renderStallError(label: string, stallMs: number): Error {
  return new Error(`影片輸出停滯：${label} 已連續 ${formatRenderDuration(stallMs)}沒有任何進度（可能卡住，或磁碟／驅動程式沒有回應），已中止這次輸出。`);
}

/**
 * One deadline across composition prepasses, native work, muxing and identity. An explicit `timeoutMs` is a hard
 * total deadline; otherwise the deadline scales with `workSeconds`. `stallMs` bounds how long a watched encoder may
 * go without observable progress (see runProcess).
 */
export async function withRenderLifetime<T>(options: { signal?: AbortSignal; timeoutMs?: number; workSeconds?: number; stallMs?: number }, operation: () => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? renderDeadlineForWorkSeconds(options.workSeconds ?? 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_RENDER_TIMER_MS) throw new Error("Invalid render lifetime timeout");
  const parent = current.getStore();
  const stallMs = options.stallMs ?? parent?.stallMs ?? DEFAULT_RENDER_STALL_MS;
  if (!Number.isFinite(stallMs) || stallMs <= 0 || stallMs > MAX_RENDER_TIMER_MS) throw new Error("Invalid render stall timeout");
  const controller = new AbortController();
  const sources = [...new Set([parent?.signal, options.signal].filter((signal): signal is AbortSignal => Boolean(signal)))];
  const listeners = sources.map(signal => {
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
    return { signal, listener };
  });
  const startedAt = performance.now();
  const deadlineAt = Math.min(startedAt + timeoutMs, parent?.deadlineAt ?? Infinity);
  const limitMs = deadlineAt - startedAt;
  const timer = setTimeout(() => controller.abort(deadlineError(limitMs)), Math.max(0, deadlineAt - performance.now()));
  try {
    controller.signal.throwIfAborted();
    return await current.run({ signal: controller.signal, deadlineAt, limitMs, stallMs, abort: reason => controller.abort(reason) }, async () => {
      const result = await operation();
      assertRenderActive();
      return result;
    });
  } finally {
    clearTimeout(timer);
    for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
  }
}

export function renderLifetimeSignal(): AbortSignal | undefined { return current.getStore()?.signal; }
/** The no-progress window for watched processes, or undefined outside a render lifetime. */
export function renderLifetimeStallMs(): number | undefined { return current.getStore()?.stallMs; }
/** Fails the whole current render (every later stage and the publication refuse to continue). */
export function renderLifetimeAbort(): ((reason: unknown) => void) | undefined { return current.getStore()?.abort; }
/** Remaining total budget, bounded to a valid timer delay, or undefined outside a render lifetime. */
export function renderLifetimeRemainingMs(): number | undefined {
  const lifetime = current.getStore();
  return lifetime ? Math.max(1, Math.min(MAX_RENDER_TIMER_MS, Math.floor(lifetime.deadlineAt - performance.now()))) : undefined;
}
export function assertRenderActive(): void {
  const lifetime = current.getStore();
  lifetime?.signal.throwIfAborted();
  // CPU work may have kept the event loop from firing the timer yet.
  if (lifetime && performance.now() >= lifetime.deadlineAt) throw deadlineError(lifetime.limitMs);
}
export function renderStageTimeout(requested: number): number {
  assertRenderActive();
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Invalid render stage timeout");
  return Math.max(1, Math.min(requested, MAX_RENDER_TIMER_MS, (current.getStore()?.deadlineAt ?? Infinity) - performance.now()));
}

/** Preserve the prior output until the replacement is actually committed. */
export async function publishRenderOutput(temporary: string, requested: string): Promise<void> {
  assertRenderActive();
  await rename(temporary, requested);
  // A cancellation racing the filesystem commit still cannot return GREEN.
  assertRenderActive();
}


/** A root lifetime for explicitly shared media work. The supplied signal belongs to the shared
 * producer, never an individual lease. Its explicit deadline and default stall policy do not
 * inherit a caller render context; ordinary nested render lifetimes keep their existing policy. */
export function withIndependentRenderLifetime<T>(options: { signal: AbortSignal; timeoutMs: number }, operation: () => Promise<T>): Promise<T> {
  return current.exit(() => withRenderLifetime(options, operation));
}
