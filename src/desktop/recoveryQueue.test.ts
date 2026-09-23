import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createProjectSession } from "../application/projectSession";
import { clearRecoveryFile, readRecoveryFile, writeRecoveryFileAtomic } from "../application/recoveryFiles";
import { createRecoveryQueue } from "./recoveryQueue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("serialized recovery queue (not native UI or cross-process acceptance)", () => {
  it("executes current operations in order and reports success only for current ownership", async () => {
    const queue = createRecoveryQueue();
    const firstStarted = deferred();
    const release = deferred();
    const order: string[] = [];
    const first = queue.enqueue(queue.current(), async () => { order.push("first:start"); firstStarted.resolve(); await release.promise; order.push("first:end"); });
    await firstStarted.promise;
    const second = queue.enqueue(queue.current(), async () => { order.push("second"); });
    expect(order).toEqual(["first:start"]);
    release.resolve();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("skips invalidated queued work before any IPC and suppresses an in-flight stale success", async () => {
    const queue = createRecoveryQueue();
    const started = deferred();
    const release = deferred();
    const generation = queue.current();
    const inFlight = queue.enqueue(generation, async () => { started.resolve(); await release.promise; });
    await started.promise;
    const staleClear = vi.fn(async () => {});
    const queued = queue.enqueue(generation, staleClear);
    const current = queue.invalidate();
    expect(current).toBe(queue.current());
    expect(current).toBeGreaterThan(generation);
    const latest = vi.fn(async () => {});
    const latestJob = queue.enqueue(current, latest);
    release.resolve();
    expect(await inFlight).toBe(false);
    expect(await queued).toBe(false);
    expect(staleClear).not.toHaveBeenCalled();
    expect(await latestJob).toBe(true);
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("rechecks actual project-session ownership at execution, not just queue insertion", async () => {
    const queue = createRecoveryQueue();
    const session = createProjectSession(createDemoProject());
    const oldOwner = session.getSnapshot().recoveryOwner;
    const started = deferred();
    const release = deferred();
    const first = queue.enqueue(queue.current(), async () => { started.resolve(); await release.promise; });
    await started.promise;
    const oldClear = vi.fn(async () => {});
    const stale = queue.enqueue(queue.current(), oldClear, () => session.isRecoveryOwnerCurrent(oldOwner));
    session.replaceProject({ ...createDemoProject(), name: "New session same ID" });
    const newOwner = session.getSnapshot().recoveryOwner;
    const newWrite = vi.fn(async () => {});
    const current = queue.enqueue(queue.current(), newWrite, () => session.isRecoveryOwnerCurrent(newOwner));
    release.resolve();
    await first;
    expect(await stale).toBe(false);
    expect(oldClear).not.toHaveBeenCalled();
    expect(await current).toBe(true);
    expect(newWrite).toHaveBeenCalledTimes(1);
  });

  it("rejects a failing operation without poisoning the next queued operation", async () => {
    const queue = createRecoveryQueue();
    const failure = new Error("owned write failure");
    const failed = queue.enqueue(queue.current(), async () => { throw failure; });
    const next = vi.fn(async () => {});
    const nextJob = queue.enqueue(queue.current(), next);
    await expect(failed).rejects.toBe(failure);
    expect(await nextJob).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns false if ownership changes during a successful operation", async () => {
    const queue = createRecoveryQueue();
    const started = deferred();
    const release = deferred();
    let owned = true;
    const result = queue.enqueue(queue.current(), async () => { started.resolve(); await release.promise; }, () => owned);
    await started.promise;
    owned = false;
    release.resolve();
    expect(await result).toBe(false);
  });

  it("keeps a real newer recovery file when an older clear is already in flight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-recovery-queue-"));
    const path = join(directory, "session.json");
    const nowMs = Date.now();
    const older = createDemoProject();
    const newer = { ...createDemoProject(), name: "Newest recoverable edit" };
    try {
      await writeRecoveryFileAtomic(path, { project: older, cleanUpdatedAt: older.updatedAt }, { nowMs });
      const queue = createRecoveryQueue();
      const started = deferred();
      const release = deferred();
      const order: string[] = [];
      const clear = queue.enqueue(queue.current(), async () => {
        order.push("clear:start"); started.resolve(); await release.promise;
        await clearRecoveryFile(path); order.push("clear:end");
      });
      await started.promise;
      const generation = queue.invalidate();
      const write = queue.enqueue(generation, async () => {
        order.push("write:start");
        await writeRecoveryFileAtomic(path, { project: newer, cleanUpdatedAt: older.updatedAt }, { nowMs: nowMs + 1 });
        order.push("write:end");
      });
      expect(order).toEqual(["clear:start"]);
      release.resolve();
      expect(await clear).toBe(false);
      expect(await write).toBe(true);
      expect(order).toEqual(["clear:start", "clear:end", "write:start", "write:end"]);
      expect(await readRecoveryFile(path, { nowMs: nowMs + 2 })).toMatchObject({ found: true, snapshot: { project: { name: newer.name } } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("never sends an obsolete clear queued behind a real recovery write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-recovery-stale-clear-"));
    const path = join(directory, "session.json");
    const nowMs = Date.now();
    const project = { ...createDemoProject(), name: "Keep this durable recovery" };
    try {
      const queue = createRecoveryQueue();
      const started = deferred();
      const release = deferred();
      const generation = queue.current();
      const write = queue.enqueue(generation, async () => {
        await writeRecoveryFileAtomic(path, { project, cleanUpdatedAt: project.updatedAt }, { nowMs });
        started.resolve(); await release.promise;
      });
      await started.promise;
      const clear = vi.fn(async () => { await clearRecoveryFile(path); });
      const queuedClear = queue.enqueue(generation, clear);
      queue.invalidate();
      release.resolve();
      expect(await write).toBe(false);
      expect(await queuedClear).toBe(false);
      expect(clear).not.toHaveBeenCalled();
      expect(await readRecoveryFile(path, { nowMs: nowMs + 1 })).toMatchObject({ found: true, snapshot: { project: { name: project.name } } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
