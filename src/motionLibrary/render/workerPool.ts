import { availableParallelism } from "node:os";

/**
 * Concurrency for motion library rendering.
 *
 * DESIGN.md proposed a worker_threads pool of min(6, cpus − 2) for SVG
 * generation. Measured on the target machine (24 logical CPUs, bundled
 * FFmpeg 8.1, 1080×1920, 2026-10-15) a simpler design is faster:
 *
 * - SVG generation in the calling thread: T01 0.36 ms/frame, X01 0.07 ms,
 *   B01 (≈1,650 dots) 4.5 ms — far under the 20 ms budget. A worker would also
 *   have to parse each 7–13 MB CJK face again (≈230 ms per face per worker).
 * - The cost is FFmpeg: librsvg rasterizes in one thread (≈11 ms/frame for T01,
 *   ≈28 ms for B01) and prores_ks 4444 already uses every core (≈360 ms/frame
 *   single-threaded, ≈34 ms/frame with all threads).
 * - Splitting a clip into 4–6 frame ranges encoded by parallel FFmpeg
 *   processes (then stream-copy concat) was slower, not faster: B01 120 frames
 *   5.1 s single vs 7.3 s (NVMe) / 8.2 s (HDD) with 4 processes; T01 150 frames
 *   5.15 s single vs 5.26 s with 6.
 *
 * So frames are generated in-thread and each clip is encoded by one FFmpeg
 * process; a process-wide encode pool (default 1 slot) keeps concurrent
 * renders from oversubscribing the CPU. createTaskPool is the generic bounded,
 * abortable queue behind it, also used for batch jobs (contact sheets).
 */

/** min(6, cpus − 2), at least 1: the DESIGN.md pool size for CPU-parallel work. */
export function defaultMotionLibraryConcurrency(): number {
  return Math.max(1, Math.min(6, availableParallelism() - 2));
}

export interface TaskPool {
  readonly concurrency: number;
  /** Tasks currently running. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly pending: number;
  /** Run `task` when a slot is free. Rejects with the signal's reason if aborted while waiting. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export function createTaskPool(concurrency: number): TaskPool {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error("Task pool concurrency must be an integer in 1..64");
  let active = 0;
  const waiting: Array<{ start: () => void; cancel: (reason: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];
  const next = () => {
    while (active < concurrency && waiting.length) {
      const entry = waiting.shift()!;
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
      if (entry.signal?.aborted) { entry.cancel(abortReason(entry.signal)); continue; }
      entry.start();
    }
  };
  return {
    concurrency,
    get active() { return active; },
    get pending() { return waiting.length; },
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      return new Promise<T>((resolve, reject) => {
        const entry: (typeof waiting)[number] = {
          signal,
          cancel: reject,
          start: () => {
            active += 1;
            let promise: Promise<T>;
            try { promise = task(); } catch (error) { promise = Promise.reject(error); }
            promise.then(resolve, reject).finally(() => { active -= 1; next(); });
          },
        };
        if (signal) {
          entry.onAbort = () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) { waiting.splice(index, 1); reject(abortReason(signal)); }
          };
          signal.addEventListener("abort", entry.onAbort, { once: true });
        }
        waiting.push(entry);
        next();
      });
    },
  };
}

let encodePool = createTaskPool(1);

/** The shared pool every motion library FFmpeg encode runs through. */
export function motionLibraryEncodePool(): TaskPool {
  return encodePool;
}

/** Change the number of simultaneous FFmpeg encodes (default 1; see the measurements above). Running tasks keep their slot. */
export function setMotionLibraryEncodeConcurrency(concurrency: number): void {
  encodePool = createTaskPool(concurrency);
}

/** Map items through `task` with at most `concurrency` in flight; results keep input order. First failure aborts the rest. */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number,
  task: (item: T, index: number, signal: AbortSignal) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const pool = createTaskPool(Math.max(1, Math.min(concurrency, Math.max(1, items.length))));
  const controller = new AbortController();
  const forward = () => controller.abort(signal ? abortReason(signal) : undefined);
  signal?.addEventListener("abort", forward, { once: true });
  if (signal?.aborted) forward();
  try {
    const settled = await Promise.allSettled(items.map((item, index) => pool.run(async () => {
      try { return await task(item, index, controller.signal); } catch (error) { controller.abort(error); throw error; }
    }, controller.signal)));
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw signal?.aborted ? abortReason(signal) : firstRealFailure(settled) ?? failure.reason;
    return settled.map(result => (result as PromiseFulfilledResult<R>).value);
  } finally {
    signal?.removeEventListener("abort", forward);
  }
}

/** Prefer the error that caused the abort over the AbortErrors it triggered in siblings. */
function firstRealFailure(settled: PromiseSettledResult<unknown>[]): unknown {
  for (const result of settled) {
    if (result.status === "rejected" && !(result.reason instanceof DOMException && result.reason.name === "AbortError")) return result.reason;
  }
  return undefined;
}
