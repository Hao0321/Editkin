import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MaterialPreparationJobs } from "./materialPreparationJobs";
import type { MaterialIntelligencePacket, PrepareMaterialRequest } from "./materialIntelligence";
import { runAnalysisProcess } from "./analysisProcess";

/** W2-3 regressions (Area C B3/B3b): parallel long-clip preparation, named interrupted jobs, crashed-lock recovery. */
const roots: string[] = [], managers: MaterialPreparationJobs[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request: PrepareMaterialRequest = { sourcePath: "test-not-a-real-video", assetId: "asset", clipId: "clip", sourceStart: 0, duration: 90, fps: 30, kind: "video" };
const packet = { materialId: "a".repeat(64), cache: { packetSha256: "b".repeat(64) } } as MaterialIntelligencePacket;
async function fixture(prepare: ConstructorParameters<typeof MaterialPreparationJobs>[1]) {
  const root = await mkdtemp(join(tmpdir(), "editkin-material-slots-")); roots.push(root);
  const runtime = { ffmpegPath: process.execPath, modelRoot: root, cacheRoot: root };
  const manager = new MaterialPreparationJobs(root, prepare); managers.push(manager);
  return { root, runtime, manager };
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw Error("test condition timeout"); await new Promise(done => setTimeout(done, 10)); }
}
async function deadPid() {
  const exited = await runAnalysisProcess(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { label: "dead-owner fixture", timeoutMs: 5000 });
  const pid = Number(exited.stdout.toString()); expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

describe("material preparation slots", () => {
  it("prepares two different long clips in parallel (the v4 material-prepare fan-out)", async () => {
    let finish!: () => void, calls = 0;
    const held = new Promise<void>(done => { finish = done; });
    const { manager, runtime } = await fixture(async () => { calls++; await held; return { packet, cacheHit: false }; });
    try {
      const one = await manager.start(request, runtime), two = await manager.start({ ...request, clipId: "other" }, runtime);
      expect(two.coalesced).toBe(false); expect(two.job.jobId).not.toBe(one.job.jobId);
      await until(async () => calls === 2);
      expect((await manager.status(one.job.jobId)).state).toBe("RUNNING");
      expect((await manager.status(two.job.jobId)).state).toBe("RUNNING");
      // The same request still coalesces onto its running job.
      expect((await manager.start(request, runtime)).job.jobId).toBe(one.job.jobId);
      finish();
      await until(async () => (await manager.status(one.job.jobId)).state === "COMPLETED" && (await manager.status(two.job.jobId)).state === "COMPLETED");
    } finally { finish(); }
  });

  it("an interrupted job names its resumeJobId and blocks only its own request", async () => {
    const { manager, runtime, root } = await fixture(async () => ({ packet, cacheHit: true }));
    const initial = await manager.start(request, runtime);
    await until(async () => (await manager.status(initial.job.jobId)).state === "COMPLETED");
    await manager.close();
    const path = join(root, "material-preparation-jobs", `${initial.job.jobId}.json`);
    const state = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...state, ownerPid: await deadPid(), state: "RUNNING", result: undefined,
      progress: { phase: "transcript", completedSegments: 3, totalSegments: 9, analyzedSeconds: 30, totalSeconds: 90, cachedSegments: 3 } }));
    const restarted = new MaterialPreparationJobs(root, async () => ({ packet, cacheHit: true })); managers.push(restarted);
    await expect(restarted.start(request, runtime)).rejects.toThrow(`resumeJobId=${initial.job.jobId}`);
    await expect(restarted.start(request, runtime)).rejects.toThrow("3/9");
    const other = await restarted.start({ ...request, clipId: "other" }, runtime);
    expect(other.job.state).toBe("RUNNING");
    const resumed = await restarted.start(request, runtime, initial.job.jobId);
    expect(resumed.job.resumedFrom).toBe(initial.job.jobId);
    await until(async () => (await restarted.status(resumed.job.jobId)).state === "COMPLETED");
  });

  it("recovers a coordination lock left by a crashed process, never one held by a live process", async () => {
    const { manager, runtime, root } = await fixture(async () => ({ packet, cacheHit: true }));
    const directory = join(root, "material-preparation-jobs"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "coordination.lock"), `${await deadPid()}:crashed-instance`);
    const started = await manager.start(request, runtime);
    await until(async () => (await manager.status(started.job.jobId)).state === "COMPLETED");
    await writeFile(join(directory, "coordination.lock"), `${process.ppid}:live-instance`);
    await expect(manager.start({ ...request, clipId: "other" }, runtime)).rejects.toThrow("素材工作鎖忙碌");
    expect(await readFile(join(directory, "coordination.lock"), "utf8")).toBe(`${process.ppid}:live-instance`);
  });
});
