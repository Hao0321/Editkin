import { AsyncLocalStorage } from "node:async_hooks";
import { rename } from "node:fs/promises";

interface RenderLifetime { signal: AbortSignal; deadlineAt: number }
const current = new AsyncLocalStorage<RenderLifetime>();

/** One deadline across composition prepasses, native work, muxing and identity. */
export async function withRenderLifetime<T>(options: { signal?: AbortSignal; timeoutMs?: number }, operation: () => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Invalid render lifetime timeout");
  const parent = current.getStore();
  const controller = new AbortController();
  const sources = [...new Set([parent?.signal, options.signal].filter((signal): signal is AbortSignal => Boolean(signal)))];
  const listeners = sources.map(signal => {
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
    return { signal, listener };
  });
  const deadlineAt = Math.min(performance.now() + timeoutMs, parent?.deadlineAt ?? Infinity);
  const timer = setTimeout(() => controller.abort(new Error("影片輸出總時間逾時")), Math.max(0, deadlineAt - performance.now()));
  try {
    controller.signal.throwIfAborted();
    return await current.run({ signal: controller.signal, deadlineAt }, async () => {
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
export function assertRenderActive(): void {
  const lifetime = current.getStore();
  lifetime?.signal.throwIfAborted();
  // CPU work may have kept the event loop from firing the timer yet.
  if (lifetime && performance.now() >= lifetime.deadlineAt) throw new Error("影片輸出總時間逾時");
}
export function renderStageTimeout(requested: number): number {
  assertRenderActive();
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Invalid render stage timeout");
  return Math.max(1, Math.min(requested, (current.getStore()?.deadlineAt ?? Infinity) - performance.now()));
}

/** Preserve the prior output until the replacement is actually committed. */
export async function publishRenderOutput(temporary: string, requested: string): Promise<void> {
  assertRenderActive();
  await rename(temporary, requested);
  // A cancellation racing the filesystem commit still cannot return GREEN.
  assertRenderActive();
}
