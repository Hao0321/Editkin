import { describe, expect, it } from "vitest";
import { MaterialPreparationWorkPool } from "./materialEvidenceCache";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function empty<T, P>(pool: MaterialPreparationWorkPool<T, P>) {
  expect(pool.snapshot()).toMatchObject({ entries: 0, active: 0, queued: 0, leases: 0, retainedBytes: 0, keyBytes: 0, handles: 0 });
}

describe("material preparation shared-work lifecycle", () => {
  it("performs one cold operation, reuses a held ready result, and releases only at the last lease", async () => {
    const pool = new MaterialPreparationWorkPool<{ value: string }>(), work = deferred<{ value: string }>();
    let calls = 0;
    const a = pool.acquire("same-sha/settings/revision", async () => { calls++; return work.promise; });
    const b = pool.acquire("same-sha/settings/revision", async () => { calls++; throw Error("duplicate"); });
    work.resolve({ value: "ordinary material" });
    expect(await a.result).toEqual(await b.result); expect(calls).toBe(1);
    const warm = pool.acquire("same-sha/settings/revision", async () => { throw Error("unexpected warm computation"); });
    expect(await warm.result).toEqual({ value: "ordinary material" });
    await a.release(); await a.release(); await b.release();
    expect(pool.snapshot()).toMatchObject({ entries: 1, leases: 1, retainedBytes: Buffer.byteLength(JSON.stringify({ value: "ordinary material" })) });
    await warm.release(); empty(pool);
  });
  it("one cancellation never aborts the producer required by another lease", async () => {
    const pool = new MaterialPreparationWorkPool<string>(), work = deferred<string>(), abort = new AbortController();
    let workerSignal!: AbortSignal;
    const a = pool.acquire("same", async signal => { workerSignal = signal; return work.promise; }, { signal: abort.signal });
    const b = pool.acquire("same", async () => "wrong");
    abort.abort(); await expect(a.result).rejects.toMatchObject({ name: "AbortError" }); await a.release();
    expect(workerSignal.aborted).toBe(false); expect(pool.snapshot().leases).toBe(1);
    work.resolve("shared result"); expect(await b.result).toBe("shared result"); await b.release(); empty(pool);
  });
  it("the final cancellation holds key and active capacity until actual cleanup closes", async () => {
    const pool = new MaterialPreparationWorkPool<string>({ maxActive: 1 }), cleanup = deferred<void>(), abort = new AbortController();
    let signal!: AbortSignal, closed = false, released = false;
    const lease = pool.acquire("same", async actual => { signal = actual; await cleanup.promise; closed = true; actual.throwIfAborted(); return "late"; }, { signal: abort.signal });
    abort.abort(); await expect(lease.result).rejects.toMatchObject({ name: "AbortError" });
    const pending = lease.release().then(() => { released = true; }); await tick();
    expect(signal.aborted).toBe(true); expect(released).toBe(false); expect(closed).toBe(false);
    expect(() => pool.acquire("same", async () => "overlap")).toThrow("DRAINING");
    expect(pool.snapshot()).toMatchObject({ entries: 1, active: 1, leases: 0 });
    cleanup.resolve(); await pending; expect(closed).toBe(true); empty(pool);
    const retry = pool.acquire("same", async () => "retry"); expect(await retry.result).toBe("retry"); await retry.release(); empty(pool);
  });
  it("removes a cancelled queued lease without ever invoking its producer", async () => {
    const pool = new MaterialPreparationWorkPool<string>({ maxActive: 1 }), work = deferred<string>(); let queuedCalls = 0;
    const first = pool.acquire("first", () => work.promise), abort = new AbortController();
    const queued = pool.acquire("queued", async () => { queuedCalls++; return "bad"; }, { signal: abort.signal });
    expect(pool.snapshot().queued).toBe(1); abort.abort(); await expect(queued.result).rejects.toMatchObject({ name: "AbortError" }); await queued.release();
    work.resolve("ok"); await first.result; await first.release(); expect(queuedCalls).toBe(0); empty(pool);
  });
  it("release remains idempotent when a producer abort hook synchronously reenters it", async () => {
    const pool = new MaterialPreparationWorkPool<string>(), cleanup = deferred<void>();
    let reentrant: Promise<void> | undefined;
    const lease = pool.acquire("same", async signal => {
      signal.addEventListener("abort", () => { reentrant = lease.release(); }, { once: true });
      await cleanup.promise; signal.throwIfAborted(); return "late";
    });
    const released = lease.release(); expect(reentrant).toBe(released);
    await expect(lease.result).rejects.toMatchObject({ name: "AbortError" });
    expect(pool.snapshot().leases).toBe(0); cleanup.resolve(); await released; empty(pool);
  });
  it("does not notify a lease cancelled synchronously by a peer progress hook", async () => {
    const pool = new MaterialPreparationWorkPool<string, string>(), gate = deferred<void>(), abort = new AbortController(); let cancelledNotifications = 0;
    const a = pool.acquire("same", async (_signal, progress) => { await gate.promise; await progress("color"); return "ok"; }, { onProgress: () => abort.abort() });
    const b = pool.acquire("same", async () => "wrong", { signal: abort.signal, onProgress: () => { cancelledNotifications++; } });
    gate.resolve(); await expect(b.result).rejects.toMatchObject({ name: "AbortError" }); await b.release();
    expect(await a.result).toBe("ok"); expect(cancelledNotifications).toBe(0); await a.release(); empty(pool);
  });
  it("bounds entries and runs the admitted queue with one active worker", async () => {
    const pool = new MaterialPreparationWorkPool<string>({ maxEntries: 2, maxActive: 1 }), work = deferred<string>(); let secondCalls = 0;
    const a = pool.acquire("one", () => work.promise), b = pool.acquire("two", async () => { secondCalls++; return "two"; });
    expect(() => pool.acquire("three", async () => "not admitted")).toThrow("BACKPRESSURE");
    expect(pool.snapshot()).toMatchObject({ entries: 2, active: 1, queued: 1 }); expect(secondCalls).toBe(0);
    work.resolve("one"); await a.result; expect(await b.result).toBe("two");
    await a.release(); await b.release(); expect(pool.snapshot().peak.active).toBe(1); empty(pool);
  });
  it("bounds leases even when every caller has the same key", async () => {
    const pool = new MaterialPreparationWorkPool<string>({ maxLeases: 2 }), work = deferred<string>();
    const a = pool.acquire("same", () => work.promise), b = pool.acquire("same", async () => "wrong");
    expect(() => pool.acquire("same", async () => "over-capacity")).toThrow("BACKPRESSURE");
    work.resolve("ok"); await Promise.all([a.result, b.result]); await a.release(); await b.release();
    expect(pool.snapshot().peak.leases).toBe(2); empty(pool);
  });
  it("does not reuse work after source/settings/revision identity changes", async () => {
    const pool = new MaterialPreparationWorkPool<string>(); let calls = 0;
    const keys = ["sha-a/auto/rev4", "sha-b/auto/rev4", "sha-a/en/rev4", "sha-a/auto/rev5"];
    const leases = keys.map(key => pool.acquire(key, async () => { calls++; return key; }));
    expect(await Promise.all(leases.map(lease => lease.result))).toEqual(keys); expect(calls).toBe(4);
    await Promise.all(leases.map(lease => lease.release())); empty(pool);
  });
  it("a failed producer leaves no cached failure and can be retried", async () => {
    const pool = new MaterialPreparationWorkPool<string>();
    const a = pool.acquire("key", async () => { throw Error("injected failure"); });
    await expect(a.result).rejects.toThrow("injected failure"); await a.release(); empty(pool);
    const b = pool.acquire("key", async () => "recovered"); expect(await b.result).toBe("recovered"); await b.release(); empty(pool);
  });
  it("bounds UTF-8 identity metadata before creating an entry", () => {
    const pool = new MaterialPreparationWorkPool<string>({ maxKeyBytes: 4 });
    expect(() => pool.acquire("長字串", async () => "bad")).toThrow("KEY_BUDGET"); empty(pool);
  });
  it("refuses an oversized serialized result and releases all owned resources", async () => {
    const pool = new MaterialPreparationWorkPool<string>({ maxRetainedBytes: 8 });
    const a = pool.acquire("key", async () => "too large");
    await expect(a.result).rejects.toThrow("RESULT_BUDGET"); await a.release(); expect(pool.snapshot().peak.retainedBytes).toBe(0); empty(pool);
  });
  it("never evicts a result still leased to make room for another result", async () => {
    const pool = new MaterialPreparationWorkPool<string>({ maxRetainedBytes: 8 });
    const a = pool.acquire("one", async () => "1234"); expect(await a.result).toBe("1234");
    const b = pool.acquire("two", async () => "abcd"); await expect(b.result).rejects.toThrow("RESULT_BUDGET");
    expect(pool.snapshot().retainedBytes).toBe(6); expect(await a.result).toBe("1234");
    await b.release(); await a.release(); empty(pool);
  });
  it("a progress callback failure releases only that caller", async () => {
    const pool = new MaterialPreparationWorkPool<string, { phase: string }>(), gate = deferred<void>(); let observed = 0;
    const a = pool.acquire("same", async (_signal, progress) => { await gate.promise; await progress({ phase: "color" }); return "ok"; },
      { onProgress: () => { throw Error("observer failure"); } });
    const b = pool.acquire("same", async () => "wrong", { onProgress: () => { observed++; } });
    gate.resolve(); await expect(a.result).rejects.toThrow("observer failure"); await a.release();
    expect(await b.result).toBe("ok"); expect(observed).toBe(1); await b.release(); empty(pool);
  });
  it("an already cancelled request allocates no controller or listener", () => {
    const pool = new MaterialPreparationWorkPool<string>(), abort = new AbortController(); abort.abort();
    expect(() => pool.acquire("key", async () => "bad", { signal: abort.signal })).toThrow(); empty(pool);
  });
  it.each([{ maxEntries: 0 }, { maxActive: 17 }, { maxLeases: NaN }, { maxRetainedBytes: -1 }])("refuses invalid limits %j", limits => {
    expect(() => new MaterialPreparationWorkPool(limits)).toThrow("LIMITS_INVALID");
  });
  it("records deterministic peak entries, logical bytes and owned handles", async () => {
    const pool = new MaterialPreparationWorkPool<string>({ maxEntries: 2, maxActive: 1, maxLeases: 3, maxRetainedBytes: 20 });
    const work = deferred<string>(), abort = new AbortController();
    const a = pool.acquire("key-a", () => work.promise, { signal: abort.signal });
    const b = pool.acquire("key-a", async () => "wrong");
    const c = pool.acquire("key-b", async () => "two");
    work.resolve("one"); await Promise.all([a.result, b.result, c.result]);
    const held = pool.snapshot(); expect(held.peak).toEqual({ entries: 2, active: 1, leases: 3, retainedBytes: 10, keyBytes: 10, handles: 3 });
    await a.release(); await b.release(); await c.release(); empty(pool);
    console.info("MATERIAL_PREPARATION_LOGICAL_RESOURCES " + JSON.stringify({ held, final: pool.snapshot(), osHandlesMeasured: false }));
  });
});
