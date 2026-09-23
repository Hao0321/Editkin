import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MaterialPreparationJobs } from "./materialPreparationJobs";
import type { MaterialIntelligencePacket, PrepareMaterialRequest } from "./materialIntelligence";
import { runAnalysisProcess } from "./analysisProcess";

const roots: string[] = [], managers: MaterialPreparationJobs[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request: PrepareMaterialRequest = { sourcePath: "test-not-a-real-video", assetId: "asset", clipId: "clip", sourceStart: 0, duration: 90, fps: 30, kind: "video" };
const packet = { materialId: "a".repeat(64), cache: { packetSha256: "b".repeat(64) } } as MaterialIntelligencePacket;
async function fixture(prepare: ConstructorParameters<typeof MaterialPreparationJobs>[1]) {
  const root = await mkdtemp(join(tmpdir(), "editkin-material-job-test-")); roots.push(root);
  const runtime = { ffmpegPath: process.execPath, modelRoot: root, cacheRoot: root };
  const manager = new MaterialPreparationJobs(root, prepare); managers.push(manager);
  return { root, runtime, manager };
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await check()) { if (Date.now() > deadline) throw Error("test condition timeout"); await new Promise(done => setTimeout(done, 5)); }
}
describe("nonblocking material jobs (control fixtures, not media quality)", () => {
  it("requires explicit resume after an independently proven dead owner", async () => {
    const { manager, runtime, root } = await fixture(async () => ({ packet, cacheHit: true }));
    const initial = await manager.start(request, runtime);
    await until(async () => (await manager.status(initial.job.jobId)).state === "COMPLETED");
    await manager.close();
    const exited = await runAnalysisProcess(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { label: "dead-owner fixture", timeoutMs: 1000 });
    const deadPid = Number(exited.stdout.toString()); expect(() => process.kill(deadPid, 0)).toThrow();
    const path = join(root, "material-preparation-jobs", `${initial.job.jobId}.json`);
    const state = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...state, ownerPid: deadPid, state: "RUNNING", result: undefined }));
    const restarted = new MaterialPreparationJobs(root, async () => ({ packet, cacheHit: true })); managers.push(restarted);
    expect((await restarted.status(initial.job.jobId)).state).toBe("INTERRUPTED");
    await expect(restarted.start(request, runtime)).rejects.toThrow("指定 resumeJobId");
    const resumed = await restarted.start(request, runtime, initial.job.jobId);
    expect(resumed.job.resumedFrom).toBe(initial.job.jobId);
    await until(async () => (await restarted.status(resumed.job.jobId)).state === "COMPLETED");
  });

  it("returns and coalesces while actual work is delayed; status remains independent", async () => {
    let finish!: () => void, calls = 0;
    const delayed = new Promise<void>(done => { finish = done; });
    const { manager, runtime } = await fixture(async (_request, worker) => { calls++; await worker.onProgress?.({ phase: "scene" }); await delayed; return { packet, cacheHit: false }; });
    try {
      const before = Date.now(), one = await manager.start(request, runtime);
      expect(Date.now() - before).toBeLessThan(1000);
      const two = await manager.start(request, runtime);
      expect(two.coalesced).toBe(true); expect(two.job.jobId).toBe(one.job.jobId); expect(calls).toBe(1);
      expect((await manager.status(one.job.jobId)).state).toBe("RUNNING");
      await expect(manager.start({ ...request, clipId: "other" }, runtime)).rejects.toThrow("已有素材分析");
      finish(); await until(async () => (await manager.status(one.job.jobId)).state === "COMPLETED");
      expect((await manager.status(one.job.jobId)).result?.materialId).toBe(packet.materialId);
    } finally { finish(); }
  });
  it("cancellation stays pending until worker closed and explicit resume receives fresh request/runtime", async () => {
    let exited = false, attempts = 0;
    const { manager, runtime, root } = await fixture(async (_request, worker) => {
      attempts++;
      if (attempts === 1) await new Promise<void>((_done, reject) => {
        const stop = () => setTimeout(() => { exited = true; reject(Error("worker stopped")); }, 25);
        worker.signal?.addEventListener("abort", stop, { once: true }); if (worker.signal?.aborted) stop();
      });
      return { packet, cacheHit: true };
    });
    const started = await manager.start(request, runtime);
    expect((await manager.cancel(started.job.jobId)).state).toBe("CANCELLING");
    expect(exited).toBe(false);
    await until(async () => (await manager.status(started.job.jobId)).state === "CANCELLED");
    expect(exited).toBe(true); expect((await manager.status(started.job.jobId)).result).toBeUndefined();
    await expect(manager.start({ ...request, sourceStart: 1 }, runtime, started.job.jobId)).rejects.toThrow("續跑要求不一致");
    const resumed = await manager.start(request, runtime, started.job.jobId);
    await until(async () => (await manager.status(resumed.job.jobId)).state === "COMPLETED");
    expect(resumed.job.resumedFrom).toBe(started.job.jobId); expect(resumed.job.jobId).not.toBe(started.job.jobId);
    const reopened = new MaterialPreparationJobs(root); managers.push(reopened);
    try { await until(async () => (await reopened.status(resumed.job.jobId)).state === "COMPLETED"); }
    catch (error) { throw Error(JSON.stringify({ error: String(error), memory: await manager.status(resumed.job.jobId), persisted: await reopened.status(resumed.job.jobId) })); }
  });
  it("does not steal another live owner or launch executable paths from persisted data", async () => {
    let finish!: () => void;
    const wait = new Promise<void>(done => { finish = done; });
    const { manager, runtime, root } = await fixture(async () => { await wait; return { packet, cacheHit: false }; });
    try {
      const one = await manager.start(request, runtime);
      const other = new MaterialPreparationJobs(root, async () => { throw Error("must not run"); }); managers.push(other);
      expect((await other.start(request, runtime)).job.jobId).toBe(one.job.jobId);
      await expect(other.cancel(one.job.jobId)).rejects.toThrow("其他仍在執行");
      const saved = JSON.parse(await readFile(join(root, "material-preparation-jobs", `${one.job.jobId}.json`), "utf8"));
      expect(JSON.stringify(saved)).not.toContain("test-not-a-real-video");
      await writeFile(join(root, "material-preparation-jobs", "bad.json"), "{}");
      await expect(other.status("../bad")).rejects.toThrow();
    } finally { finish(); }
  });
});
