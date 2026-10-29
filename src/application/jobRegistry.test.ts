import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import {
  canTransitionJob, capJobPayload, JobError, JobRegistry, JOB_FILE, JOB_STATES, JOB_TERMINAL_STATES, JOB_TRANSITIONS, reconcileJobRecord,
  type JobContext, type JobRecord, type JobStateName,
} from "./jobRegistry";

const temp = useTempRoots();
// Real file I/O: a busy shared test drive (full-suite runs) can make each write take a second; the logic is not timed.
vi.setConfig({ testTimeout: 60_000 });
const registries: JobRegistry[] = [];
afterEach(async () => { await Promise.all(registries.splice(0).map(registry => registry.close({ cancel: true }))); });

function registry(root: string, options: ConstructorParameters<typeof JobRegistry>[1] = {}) {
  const created = new JobRegistry(root, { cancelPollMs: 20, progressWriteMs: 0, ...options });
  registries.push(created);
  return created;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** Work that runs until it is told to finish, or stops (and cleans up) when the job is cancelled. */
function gatedWork(gate: Promise<unknown>, onStart?: (context: JobContext) => void) {
  return async (context: JobContext) => {
    onStart?.(context);
    await new Promise<void>((resolve, reject) => {
      // Releasing processes and temporary files takes a moment; the job stays `cancelling` meanwhile.
      const stop = () => setTimeout(() => reject(context.signal.reason), 250);
      if (context.signal.aborted) return stop();
      context.signal.addEventListener("abort", stop, { once: true });
      void gate.then(() => { context.signal.removeEventListener("abort", stop); resolve(); });
    });
    return { done: true };
  };
}
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise(done => setTimeout(done, 15));
  }
}
const readRecord = async (root: string, jobId: string) => JSON.parse(await readFile(join(root, jobId, JOB_FILE), "utf8")) as JobRecord;

describe("job state machine", () => {
  it("allows only the documented transitions; terminal states never change and a running job stops through cancelling", () => {
    const allowed: Array<[JobStateName, JobStateName]> = [
      ["queued", "running"], ["queued", "cancelled"], ["queued", "failed"],
      ["running", "cancelling"], ["running", "succeeded"], ["running", "failed"],
      ["cancelling", "cancelled"], ["cancelling", "succeeded"], ["cancelling", "failed"],
    ];
    for (const from of JOB_STATES) for (const to of JOB_STATES) {
      expect(canTransitionJob(from, to), `${from}→${to}`).toBe(allowed.some(([a, b]) => a === from && b === to));
    }
    for (const state of JOB_TERMINAL_STATES) expect(JOB_TRANSITIONS[state]).toEqual([]);
    expect(canTransitionJob("running", "cancelled")).toBe(false);
  });

  it("queues FIFO per kind, reports progress, persists each state and ends succeeded with the result", async () => {
    const root = await temp.create("job-registry-run-");
    const jobs = registry(root);
    const first = deferred(), second = deferred();
    let firstContext: JobContext | undefined;
    const a = await jobs.submit({ kind: "render", label: { outputPath: "out/a.mp4" }, run: gatedWork(first.promise, context => { firstContext = context; }) });
    const b = await jobs.submit({ kind: "render", run: gatedWork(second.promise) });
    expect(a.state).toBe("running");
    expect(b.state).toBe("queued");
    expect(b.pollAfterMs).toBe(10_000);
    firstContext!.progress({ stage: "encode", fraction: 0.5, etaSeconds: 12, step: 3, steps: 4 });
    await until(async () => (await readRecord(root, a.jobId)).progress?.fraction === 0.5);
    expect(await jobs.status(a.jobId)).toMatchObject({ state: "running", progress: { stage: "encode", fraction: 0.5, etaSeconds: 12, step: 3, steps: 4 }, pollAfterMs: 5_000 });
    // Malformed progress is dropped, never persisted.
    firstContext!.progress({ stage: "encode", fraction: 7 } as never);
    expect((await jobs.status(a.jobId)).progress?.fraction).toBe(0.5);
    first.resolve();
    const done = await jobs.wait(a.jobId);
    expect(done).toMatchObject({ state: "succeeded", result: { done: true }, label: { outputPath: "out/a.mp4" } });
    expect(done.progress).toBeUndefined();
    expect(done.pollAfterMs).toBeUndefined();
    expect((await readRecord(root, a.jobId))).toMatchObject({ schema: "editkin.job/v1", state: "succeeded", result: { done: true } });
    await until(async () => (await jobs.status(b.jobId)).state === "running");
    second.resolve();
    expect((await jobs.wait(b.jobId)).state).toBe("succeeded");
  });

  it("cancels a queued job without running it, and a running job through cancelling after its work released everything", async () => {
    const root = await temp.create("job-registry-cancel-");
    const jobs = registry(root);
    const gate = deferred();
    let released = false;
    const running = await jobs.submit({ kind: "render", run: async context => {
      await gatedWork(gate.promise)(context).finally(() => { released = true; });
      return "never";
    } });
    let queuedRan = false;
    const queued = await jobs.submit({ kind: "render", run: async () => { queuedRan = true; return 1; } });
    expect(await jobs.cancel(queued.jobId)).toMatchObject({ state: "cancelled", cancelRequested: true, error: { code: "CANCELLED" } });
    const stopping = await jobs.cancel(running.jobId);
    expect(stopping).toMatchObject({ state: "cancelling", cancelRequested: true, pollAfterMs: 2_000 });
    expect(released).toBe(false);
    const ended = await jobs.wait(running.jobId);
    expect(released).toBe(true);
    expect(ended).toMatchObject({ state: "cancelled", error: { code: "CANCELLED" } });
    expect(ended.result).toBeUndefined();
    expect(queuedRan).toBe(false);
    // A finished job is not changed by another cancel.
    expect((await jobs.cancel(running.jobId)).state).toBe("cancelled");
    expect((await readRecord(root, running.jobId)).state).toBe("cancelled");
  });

  it("records a failure with its stable code, or the producer's classification, and keeps no result", async () => {
    const root = await temp.create("job-registry-fail-");
    const jobs = registry(root, { concurrency: { render: 2 } });
    const coded = await jobs.submit({ kind: "render", run: async () => { throw new JobError("OUTPUT_EXISTS", "輸出檔已存在"); } });
    const plain = await jobs.submit({ kind: "render", run: async () => { throw new Error("x".repeat(900)); },
      classifyError: () => ({ code: "RENDER_FAILED", message: "y".repeat(900) }) });
    expect(await jobs.wait(coded.jobId)).toMatchObject({ state: "failed", error: { code: "OUTPUT_EXISTS", message: "輸出檔已存在" } });
    const failed = await jobs.wait(plain.jobId);
    expect(failed).toMatchObject({ state: "failed", error: { code: "RENDER_FAILED" } });
    expect(failed.error!.message.length).toBe(400);
    await expect(jobs.status("job-000000000000000000000000")).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(jobs.status("../escape")).rejects.toMatchObject({ code: "JOB_ID_INVALID" });
  });
});

describe("jobs across MCP server restarts", () => {
  it("a new registry on the same root reports a job the previous one finished, and lists it", async () => {
    const root = await temp.create("job-registry-restart-");
    const before = registry(root);
    const job = await before.submit({ kind: "render", scope: "D:/ws", label: { outputPath: "out/a.mp4" }, run: async () => ({ outputPath: "D:/ws/out/a.mp4", bytes: 1234 }) });
    await before.wait(job.jobId);
    await before.close();
    const after = registry(root);
    expect(await after.status(job.jobId)).toMatchObject({ state: "succeeded", result: { outputPath: "D:/ws/out/a.mp4", bytes: 1234 } });
    expect((await after.list({ scope: "D:/ws" })).map(item => item.jobId)).toEqual([job.jobId]);
    expect(await after.list({ scope: "D:/other" })).toEqual([]);
  });

  it("reads a job whose owner process is gone as failed INTERRUPTED (derived on read, never written)", async () => {
    const root = await temp.create("job-registry-interrupted-");
    const owner = registry(root);
    const gate = deferred();
    const job = await owner.submit({ kind: "render", run: gatedWork(gate.promise, context => context.progress({ stage: "frames" })) });
    await until(async () => (await readRecord(root, job.jobId)).progress?.stage === "frames");
    const alive = registry(root, { isProcessAlive: () => true });
    expect(await alive.status(job.jobId)).toMatchObject({ state: "running", progress: { stage: "frames" } });
    const gone = registry(root, { isProcessAlive: () => false });
    expect(await gone.status(job.jobId)).toMatchObject({ state: "failed", error: { code: "INTERRUPTED" } });
    expect((await readRecord(root, job.jobId)).state).toBe("running");
    // A stale heartbeat also reads as interrupted (pid reuse), while a fresh one does not.
    const record = await readRecord(root, job.jobId);
    const now = Date.parse(record.heartbeatAt);
    expect(reconcileJobRecord(record, { now: now + 61_000, isProcessAlive: () => true, staleAfterMs: 60_000 }).state).toBe("failed");
    expect(reconcileJobRecord(record, { now: now + 1_000, isProcessAlive: () => true, staleAfterMs: 60_000 }).state).toBe("running");
    gate.resolve();
    expect((await owner.wait(job.jobId)).state).toBe("succeeded");
  });

  it("stops a job another live process runs through cancel.request, and that owner ends it cancelled", async () => {
    const root = await temp.create("job-registry-remote-cancel-");
    const owner = registry(root);
    const gate = deferred();
    const job = await owner.submit({ kind: "render", run: gatedWork(gate.promise) });
    // The owner writes `running` in the background; another process reads what is on disk.
    await until(async () => (await readRecord(root, job.jobId)).state === "running");
    const other = registry(root, { isProcessAlive: () => true });
    expect(await other.cancel(job.jobId)).toMatchObject({ state: "running", cancelRequested: true });
    expect(existsSync(join(root, job.jobId, "cancel.request"))).toBe(true);
    expect(await owner.wait(job.jobId)).toMatchObject({ state: "cancelled", cancelRequested: true, error: { code: "CANCELLED" } });
    expect(await other.status(job.jobId)).toMatchObject({ state: "cancelled" });
  });

  it("keeps the newest finished jobs and never removes an unfinished one", async () => {
    const root = await temp.create("job-registry-retain-");
    const first = registry(root);
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const job = await first.submit({ kind: "render", run: async () => index });
      ids.push(job.jobId);
      await first.wait(job.jobId);
      await new Promise(done => setTimeout(done, 5));
    }
    await first.close();
    // A hand-written unfinished record of a live owner survives pruning.
    const live = { ...(await readRecord(root, ids[0])), jobId: "job-111111111111111111111111", state: "running" as const, createdAt: "2000-01-01T00:00:00.000Z" };
    delete (live as Partial<JobRecord>).result;
    await (await import("node:fs/promises")).mkdir(join(root, live.jobId));
    await writeFile(join(root, live.jobId, JOB_FILE), JSON.stringify(live));
    const second = registry(root, { retain: 2, isProcessAlive: () => true });
    await second.wait((await second.submit({ kind: "render", run: async () => "new" })).jobId);
    const left = (await readdir(root)).sort();
    expect(left).toContain(ids[3]);
    expect(left).toContain(ids[2]);
    expect(left).not.toContain(ids[0]);
    expect(left).not.toContain(ids[1]);
    expect(left).toContain(live.jobId);
  });
});

describe("capped job payloads", () => {
  it("keeps small payloads, and shrinks large ones under the byte cap without throwing", () => {
    expect(capJobPayload({ a: 1 })).toEqual({ a: 1 });
    const large = { outputPath: "D:/ws/out.mp4", warnings: Array.from({ length: 50 }, (_, index) => `warning-${index}-${"z".repeat(200)}`), nested: { deep: { deeper: { deepest: { x: "y" } } } } };
    const capped = capJobPayload(large, 600);
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(600);
    expect(capped).toMatchObject({ outputPath: "D:/ws/out.mp4" });
    const huge = capJobPayload({ a: "q".repeat(5_000), b: "w".repeat(5_000) }, 200) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(200);
  });
});

describe("attached jobs (W2-5: another job system runs them, the registry lists and stops them)", () => {
  it("mirrors an owner's job: running with its ownerJobId, progress, and the owner's end, also after a restart", async () => {
    const root = await temp.create("job-registry-attach-");
    const jobs = registry(root);
    let cancels = 0;
    const attached = await jobs.attach({ kind: "material_prep", scope: "D:/ws", ownerJobId: "owner-1", label: { clipId: "clip" }, cancel: () => { cancels += 1; } });
    expect(await jobs.status(attached.jobId)).toMatchObject({ kind: "material_prep", state: "running", ownerJobId: "owner-1", label: { clipId: "clip" }, pollAfterMs: 5_000 });
    attached.progress({ stage: "transcript", fraction: 0.25, part: 1, parts: 4 });
    expect((await jobs.status(attached.jobId)).progress).toEqual({ stage: "transcript", fraction: 0.25, part: 1, parts: 4 });
    expect((await jobs.list({ scope: "D:/ws" })).map(job => job.ownerJobId)).toEqual(["owner-1"]);
    await attached.finish({ state: "succeeded", result: { materialId: "m" } });
    await attached.finish({ state: "failed", error: { code: "LATE", message: "ignored" } });
    expect(await jobs.status(attached.jobId)).toMatchObject({ state: "succeeded", result: { materialId: "m" } });
    expect(cancels).toBe(0);
    await jobs.close();
    expect(await registry(root).status(attached.jobId)).toMatchObject({ state: "succeeded", ownerJobId: "owner-1", result: { materialId: "m" } });
  });

  it("stops an attached job through its owner's own cancel, here and from another process, and ends as the owner reports", async () => {
    const root = await temp.create("job-registry-attach-cancel-");
    const jobs = registry(root);
    let cancels = 0;
    const attached = await jobs.attach({ kind: "batch", ownerJobId: "batch-1", cancel: () => { cancels += 1; attached.cancelRequested(); } });
    expect(await jobs.cancel(attached.jobId)).toMatchObject({ state: "cancelling", cancelRequested: true });
    await until(() => cancels === 1);
    await jobs.cancel(attached.jobId);
    expect(cancels).toBe(1);
    await attached.finish({ state: "cancelled" });
    expect(await jobs.status(attached.jobId)).toMatchObject({ state: "cancelled", error: { code: "CANCELLED" } });

    let remoteCancels = 0;
    const remote = await jobs.attach({ kind: "batch", ownerJobId: "batch-2", cancel: () => { remoteCancels += 1; } });
    await until(async () => (await readRecord(root, remote.jobId)).state === "running");
    const other = registry(root, { isProcessAlive: () => true });
    expect(await other.cancel(remote.jobId)).toMatchObject({ state: "running", cancelRequested: true });
    await until(() => remoteCancels === 1);
    expect((await jobs.status(remote.jobId)).state).toBe("cancelling");
    // The owner finished its work anyway: an attached job may still end succeeded after a stop was asked.
    await remote.finish({ state: "succeeded", result: { status: "REVIEW_REQUIRED" } });
    expect(await other.status(remote.jobId)).toMatchObject({ state: "succeeded" });
  });

  it("an owner's own cancel tool moves the mirror to cancelling, and a failure keeps its code", async () => {
    const root = await temp.create("job-registry-attach-owner-");
    const jobs = registry(root);
    const attached = await jobs.attach({ kind: "material_prep", ownerJobId: "m-2", cancel: () => undefined });
    attached.cancelRequested();
    expect((await jobs.status(attached.jobId)).state).toBe("cancelling");
    await attached.finish({ state: "cancelled", error: { code: "CANCELLED", message: "分析已取消；已完成分段已保留" } });
    expect(await jobs.status(attached.jobId)).toMatchObject({ state: "cancelled", error: { message: "分析已取消；已完成分段已保留" } });
    const failing = await jobs.attach({ kind: "batch", ownerJobId: "b-3", cancel: () => undefined });
    await failing.finish({ state: "failed", error: { code: "BATCH_FAILED", message: "x".repeat(900) } });
    const failed = await jobs.status(failing.jobId);
    expect(failed).toMatchObject({ state: "failed", error: { code: "BATCH_FAILED" } });
    expect(failed.error!.message.length).toBe(400);
  });
});
