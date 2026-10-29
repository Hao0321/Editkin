// W2-5: `job {op:list}` shows every running long operation (render, material_prep, batch) and `job {op:cancel}` stops any
// of them through its own system, while prepare_ai_material / get_/cancel_material_preparation_job and the batch job tools
// keep their exact shapes. Real job registry, material job manager and batch job manager; the preparation and the batch
// execution are controllable doubles (no media, no renders).
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import type { MaterialIntelligencePacket, PrepareMaterialRequest } from "../application/materialIntelligence";

const batch = vi.hoisted(() => ({ releases: [] as Array<() => void> }));
vi.mock("../application/autopilotBatchExecution", async original => ({
  ...await original<typeof import("../application/autopilotBatchExecution")>(),
  snapshotAutopilotBatchManifest: (manifest: unknown) => manifest,
  executeAutopilotBatch: vi.fn(async (_manifest: unknown, _statePath: string, _runtime: unknown, options: {
    shouldStop?: () => boolean; onProgress?: (progress: unknown) => unknown;
  }) => {
    await options.onProgress?.({ status: "PARTIAL", completed: 0, expected: 2, certified: false, items: [{ id: "one", phase: "queued" }, { id: "two", phase: "queued" }],
      sequence: 1, stage: "auditing", activeItemId: "one", applied: 0, failed: 0, queued: 2 });
    await new Promise<void>(resolve => {
      const timer = setInterval(() => { if (options.shouldStop?.()) { clearInterval(timer); resolve(); } }, 10);
      batch.releases.push(() => { clearInterval(timer); resolve(); });
    });
    const stopped = options.shouldStop?.() === true;
    return { status: stopped ? "PARTIAL" : "REVIEW_REQUIRED", completed: stopped ? 0 : 2, expected: 2, certified: false, items: [], stopped };
  }),
}));
import { MaterialPreparationJobs } from "../application/materialPreparationJobs";
import { AutopilotBatchJobManager } from "../application/autopilotBatchJobs";
import { mcpJobRegistry, mcpJobTracker, registerJobTool, resetMcpJobRegistriesForTest } from "./renderJobTools";
import { workspaceRoot } from "./storage";

const ENV_KEYS = ["EDITKIN_WORKSPACE", "EDITKIN_CACHE_ROOT"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const temp = useTempRoots();
let root = "";
const handlers = new Map<string, (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
registerJobTool({ registerTool: (name: string, _config: unknown, handler: never) => handlers.set(name, handler) } as never);
const job = async (input: Record<string, unknown>) => {
  const result = await handlers.get("job")!(input);
  expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(2048);
  return JSON.parse(result.content[0].text) as Record<string, any>;
};
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) { if (Date.now() > deadline) throw new Error("condition not reached"); await new Promise(done => setTimeout(done, 20)); }
}
const request: PrepareMaterialRequest = { sourcePath: "not-a-real-video", assetId: "asset", clipId: "clip", sourceStart: 0, duration: 90, fps: 30, kind: "video" };
const packet = { materialId: "a".repeat(64), cache: { packetSha256: "b".repeat(64) } } as MaterialIntelligencePacket;
const manifest = { schema: "editkin.autopilot-batch/v1", batchId: "b", expectedDeliverableCount: 2,
  items: [{ id: "one", projectPath: "a", planPath: "b", outputPath: "c" }, { id: "two", projectPath: "d", planPath: "e", outputPath: "f" }] } as never;

beforeAll(async () => {
  root = await temp.create("w25-job-kinds-");
  process.env.EDITKIN_WORKSPACE = join(root, "ws");
  process.env.EDITKIN_CACHE_ROOT = join(root, "cache");
});
afterAll(async () => {
  for (const release of batch.releases) release();
  await resetMcpJobRegistriesForTest({ cancel: true });
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

describe("one job tool over every long operation", () => {
  it("lists render, material_prep and batch together and cancels each through its own system; the legacy tools keep their shapes", async () => {
    const materials = new MaterialPreparationJobs(join(root, "material"), async (_request, options) => {
      await options?.onProgress?.({ phase: "transcript", completedSegments: 1, totalSegments: 4, analyzedSeconds: 22, totalSeconds: 90, cachedSegments: 0 });
      await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
      return { packet, cacheHit: false };
    }, mcpJobTracker);
    const batches = new AutopilotBatchJobManager({ tracker: mcpJobTracker });
    let renderStopped = false;
    const render = await mcpJobRegistry().submit({ kind: "render", scope: workspaceRoot(), label: { outputPath: "out/a.mp4" }, run: async ({ signal }) => {
      await new Promise((_, reject) => signal.addEventListener("abort", () => { renderStopped = true; reject(signal.reason); }, { once: true }));
    } });
    const material = await materials.start(request, { ffmpegPath: process.execPath, modelRoot: root, cacheRoot: join(root, "material") });
    const started = batches.start(manifest, join(root, "batch.state.json"), {} as never);
    expect(Object.keys(material)).toEqual(["job", "coalesced"]);
    expect(Object.keys(started).sort()).toEqual(["finishedAt", "jobId", "startedAt", "status", "statePath"].sort());

    await until(async () => (await job({ op: "list" })).jobs.filter((row: { state: string }) => row.state === "running").length === 3);
    const rows = (await job({ op: "list" })).jobs as Array<Record<string, string>>;
    const byKind = Object.fromEntries(rows.map(row => [row.kind, row]));
    expect(Object.keys(byKind).sort()).toEqual(["batch", "material_prep", "render"]);
    expect(byKind.material_prep.ownerJobId).toBe(material.job.jobId);
    expect(byKind.batch.ownerJobId).toBe(started.jobId);
    await until(async () => (await job({ op: "status", jobId: byKind.material_prep.jobId })).progress?.stage === "transcript");
    expect((await job({ op: "status", jobId: byKind.material_prep.jobId })).progress).toMatchObject({ stage: "transcript", fraction: 0.25, parts: 4 });
    await until(async () => (await job({ op: "status", jobId: byKind.batch.jobId })).progress?.stage === "auditing");
    expect((await job({ op: "status", jobId: byKind.batch.jobId })).progress).toMatchObject({ stage: "auditing", fraction: 0, part: 1, parts: 2 });

    // Material: stopped through its own abort; its own status keeps the v4 shape.
    expect((await job({ op: "cancel", jobId: byKind.material_prep.jobId })).state).toBe("cancelling");
    await until(async () => (await materials.status(material.job.jobId)).state === "CANCELLED");
    expect(await materials.status(material.job.jobId)).toMatchObject({ schema: "editkin.material-preparation-job/v1", jobId: material.job.jobId, state: "CANCELLED" });
    await until(async () => (await job({ op: "status", jobId: byKind.material_prep.jobId })).state === "cancelled");

    // Batch: stopped at its cooperative boundary; its own job reports CANCEL_REQUESTED, then STOPPED.
    expect((await job({ op: "cancel", jobId: byKind.batch.jobId })).state).toBe("cancelling");
    expect(["CANCEL_REQUESTED", "STOPPED"]).toContain(batches.get(started.jobId).status);
    expect((await batches.wait(started.jobId, 10_000)).status).toBe("STOPPED");
    await until(async () => (await job({ op: "status", jobId: byKind.batch.jobId })).state === "cancelled");

    expect((await job({ op: "cancel", jobId: render.jobId })).state).toBe("cancelling");
    await until(async () => (await job({ op: "status", jobId: render.jobId })).state === "cancelled");
    expect(renderStopped).toBe(true);
    await materials.close();
  }, 60_000);

  it("reports a finished material preparation and a finished batch with their results; the legacy cancel moves the mirror too", async () => {
    let finishPrepare!: () => void;
    const held = new Promise<void>(done => { finishPrepare = done; });
    const materials = new MaterialPreparationJobs(join(root, "material-2"), async () => { await held; return { packet, cacheHit: true }; }, mcpJobTracker);
    const material = await materials.start({ ...request, clipId: "clip-2" }, { ffmpegPath: process.execPath, modelRoot: root, cacheRoot: join(root, "material-2") });
    const batches = new AutopilotBatchJobManager({ tracker: mcpJobTracker });
    const started = batches.start(manifest, join(root, "batch-2.state.json"), {} as never);
    const mirror = async (ownerJobId: string) => ((await job({ op: "list" })).jobs as Array<Record<string, string>>).find(row => row.ownerJobId === ownerJobId);
    await until(async () => Boolean(await mirror(material.job.jobId)) && Boolean(await mirror(started.jobId)));
    finishPrepare();
    await until(async () => (await materials.status(material.job.jobId)).state === "COMPLETED");
    const materialMirror = (await mirror(material.job.jobId))!;
    await until(async () => (await job({ op: "status", jobId: materialMirror.jobId })).state === "succeeded");
    expect((await job({ op: "status", jobId: materialMirror.jobId })).result).toEqual({ materialId: "a".repeat(64), packetSha256: "b".repeat(64), cacheHit: true,
      next: "get_material_preparation_job" });

    batch.releases.at(-1)!();
    expect((await batches.wait(started.jobId, 10_000)).status).toBe("REVIEW_REQUIRED");
    const batchMirror = (await mirror(started.jobId))!;
    await until(async () => (await job({ op: "status", jobId: batchMirror.jobId })).state === "succeeded");
    expect((await job({ op: "status", jobId: batchMirror.jobId })).result).toEqual({ status: "REVIEW_REQUIRED", completed: 2, expected: 2, next: "get_autopilot_batch_job" });

    // The legacy cancel tool of the batch system moves the mirror to cancelling, then cancelled.
    const third = batches.start(manifest, join(root, "batch-3.state.json"), {} as never);
    await until(async () => Boolean(await mirror(third.jobId)));
    batches.cancel(third.jobId);
    expect((await batches.wait(third.jobId, 10_000)).status).toBe("STOPPED");
    const thirdMirror = (await mirror(third.jobId))!;
    await until(async () => (await job({ op: "status", jobId: thirdMirror.jobId })).state === "cancelled");
    await materials.close();
  }, 60_000);
});
