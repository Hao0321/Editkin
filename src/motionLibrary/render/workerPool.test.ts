import { describe, expect, it } from "vitest";
import { createTaskPool, defaultMotionLibraryConcurrency, mapWithConcurrency } from "./workerPool";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("task pool", () => {
  it("defaults to min(6, cpus - 2), at least 1", () => {
    const value = defaultMotionLibraryConcurrency();
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(6);
  });
  it("never runs more than its concurrency and keeps result order", async () => {
    const pool = createTaskPool(2);
    let running = 0, peak = 0;
    const results = await Promise.all([30, 10, 20, 5, 15].map((ms, index) => pool.run(async () => {
      running += 1; peak = Math.max(peak, running);
      await delay(ms);
      running -= 1;
      return index;
    })));
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(pool.active).toBe(0);
    expect(pool.pending).toBe(0);
  });
  it("aborting a waiting task rejects it without running it", async () => {
    const pool = createTaskPool(1);
    let ran = false;
    const blocker = pool.run(() => delay(30));
    const controller = new AbortController();
    const waiting = pool.run(async () => { ran = true; }, controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    await blocker;
    expect(ran).toBe(false);
    await expect(pool.run(async () => 1, AbortSignal.abort())).rejects.toBeDefined();
    expect(() => createTaskPool(0)).toThrow();
  });
  it("mapWithConcurrency rejects with the first real failure and aborts siblings", async () => {
    const seen: string[] = [];
    await expect(mapWithConcurrency([1, 2, 3, 4], 2, async (value, _index, signal) => {
      if (value === 2) throw new Error("boom");
      await delay(20);
      if (signal.aborted) seen.push(`aborted-${value}`);
      return value;
    })).rejects.toThrow("boom");
    expect(await mapWithConcurrency([3, 1, 2], 3, async value => { await delay(value * 5); return value * 2; })).toEqual([6, 2, 4]);
    expect(seen.length).toBeLessThanOrEqual(1);
  });
});
