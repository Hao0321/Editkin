import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autopilotBatchManifestSchema, executeAutopilotBatch, readAutopilotBatchState, type AutopilotBatchManifest, type AutopilotBatchRuntime } from "./autopilotBatchExecution";
import { AutopilotBatchJobManager } from "./autopilotBatchJobs";
const roots: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-v4-batch-")); roots.push(root);
  const manifest: AutopilotBatchManifest = { schema: "editkin.autopilot-batch/v1", batchId: "test", expectedDeliverableCount: 2,
    items: ["one", "two"].map(id => ({ id, projectPath: join(root, `${id}.editkin.json`), planPath: join(root, `${id}.plan.json`), outputPath: join(root, `${id}.mp4`) })) };
  for (const item of manifest.items) { await writeFile(item.projectPath, `original:${item.id}`); await writeFile(item.planPath, `plan:${item.id}`); }
  const counts = { audit: 0, apply: 0, render: 0, verify: 0 };
  const commits = new Map<string, Record<string, unknown>>();
  const runtime: AutopilotBatchRuntime = {
    async validatePaths() {},
    async readPlan(item) { const value = await readFile(item.planPath, "utf8"); return { plan: value, sha256: sha(value) }; },
    async audit() { counts.audit++; return { accepted: true }; },
    async apply(item) { counts.apply++; await writeFile(item.projectPath, `edited:${item.id}`); const receipt = { id: item.id, committed: true }; commits.set(item.id, receipt); return receipt; },
    async reconcile(item) { return commits.get(item.id); },
    async render(item, output) { counts.render++; await writeFile(output, `video:${item.id}`); return { duration: 3 }; },
    async verifyRender() { counts.verify++; },
  };
  const statePath = join(root, "batch.state.json");
  const run = (options = {}) => executeAutopilotBatch(manifest, statePath, runtime, options);
  return { root, manifest, runtime, counts, commits, statePath, run };
}
describe("current v4 batch transactional runner", () => {
  it("preserves N independent projects/outputs and exact retries perform no work", async () => {
    const f = await fixture(); expect((await f.run()).status).toBe("REVIEW_REQUIRED");
    expect(f.counts).toEqual({ audit: 2, apply: 2, render: 2, verify: 2 });
    expect(await readFile(f.manifest.items[0].outputPath, "utf8")).toBe("video:one");
    expect(await readFile(f.manifest.items[1].outputPath, "utf8")).toBe("video:two");
    expect((await f.run()).completed).toBe(2);
    expect(f.counts).toEqual({ audit: 2, apply: 2, render: 2, verify: 2 });
  });
  it("isolates a rejected audit and completes the other deliverable", async () => {
    const f = await fixture(); const audit = f.runtime.audit;
    f.runtime.audit = async (item, plan) => { if (item.id === "one") throw new Error("missing live design"); return audit(item, plan); };
    const result = await f.run(); expect(result.completed).toBe(1); expect(result.items[0].error).toContain("missing live design");
    expect(await readFile(f.manifest.items[0].projectPath, "utf8")).toBe("original:one");
    f.runtime.audit = audit;
    expect((await f.run()).completed).toBe(2); expect(f.counts.apply).toBe(2);
  });
  it("isolates malformed JSON during initialization and retries only the repaired item", async () => {
    const f = await fixture();
    f.runtime.readPlan = async item => {
      const value = await readFile(item.planPath, "utf8");
      return { plan: JSON.parse(value), sha256: sha(value) };
    };
    await writeFile(f.manifest.items[0].planPath, "{ malformed");
    await writeFile(f.manifest.items[1].planPath, '{"valid":true}');
    const result = await f.run();
    expect(result.completed).toBe(1); expect(result.items[0].error).toContain("輸入未就緒");
    expect(f.counts.apply).toBe(1);
    await writeFile(f.manifest.items[0].planPath, '{"repaired":true}');
    expect((await f.run({ itemId: "one" })).completed).toBe(2);
    expect(f.counts).toEqual({ audit: 2, apply: 2, render: 2, verify: 2 });
  });
  it("isolates a missing project while preserving every readable input identity", async () => {
    const f = await fixture();
    await rm(f.manifest.items[0].projectPath);
    expect((await f.run()).completed).toBe(1);
    await writeFile(f.manifest.items[0].projectPath, "restored project");
    await writeFile(f.manifest.items[0].planPath, "changed plan while project missing");
    const result = await f.run({ itemId: "one" });
    expect(result.completed).toBe(1); expect(result.items[0].error).toContain("計畫已變更");
    expect(f.counts.apply).toBe(1);
  });
  it("reconciles a committed apply after response loss without applying twice", async () => {
    const f = await fixture(); const apply = f.runtime.apply; let failed = false;
    f.runtime.apply = async (...args) => { const result = await apply(...args); if (!failed) { failed = true; throw new Error("connection lost after commit"); } return result; };
    expect((await f.run()).completed).toBe(1);
    expect((await f.run()).completed).toBe(2); expect(f.counts.apply).toBe(2);
  });
  it("blocks uncertain apply without a committed receipt when project changed", async () => {
    const f = await fixture();
    f.runtime.apply = async item => { await writeFile(item.projectPath, "uncertain edit"); throw new Error("crash"); };
    await f.run(); const result = await f.run();
    expect(result.completed).toBe(0); expect(result.items.every(item => item.error?.includes("reconcile"))).toBe(true);
    expect(f.counts.render).toBe(0);
  });
  it("allows a new audit only when interrupted apply left exact original bytes", async () => {
    const f = await fixture(); const apply = f.runtime.apply;
    f.runtime.apply = async () => { throw new Error("failed before mutation"); }; await f.run();
    f.runtime.apply = apply; expect((await f.run()).completed).toBe(2); expect(f.counts.apply).toBe(2);
  });
  it("protects manual edits both before apply and after committed apply", async () => {
    const f = await fixture(); await f.run({ through: "apply" });
    await writeFile(f.manifest.items[0].projectPath, "human edit");
    const result = await f.run(); expect(result.completed).toBe(1); expect(result.items[0].error).toContain("人工修改");
    expect(await readFile(f.manifest.items[0].projectPath, "utf8")).toBe("human edit"); expect(f.counts.apply).toBe(2);
  });
  it("rejects changed plans and never overwrites an existing output", async () => {
    const f = await fixture(); await writeFile(f.manifest.items[0].outputPath, "user video");
    expect((await f.run()).completed).toBe(1); expect(f.counts.apply).toBe(1);
    await writeFile(f.manifest.items[1].planPath, "new plan");
    const result = await f.run(); expect(result.items[1].error).toContain("計畫已變更");
    expect(await readFile(f.manifest.items[0].outputPath, "utf8")).toBe("user video");
  });
  it("retries interrupted render in a new owned file, retaining evidence and not reapplying", async () => {
    const f = await fixture(); const render = f.runtime.render; const attempts: string[] = []; let failed = false;
    f.runtime.render = async (item, output) => { attempts.push(output); const result = await render(item, output); if (!failed) { failed = true; throw new Error("render interrupted"); } return result; };
    expect((await f.run()).completed).toBe(1); expect((await f.run()).completed).toBe(2);
    expect(new Set(attempts).size).toBe(3); expect(f.counts.apply).toBe(2);
    expect(await readFile(attempts[0], "utf8")).toBe("video:one");
  });
  it("rejects a corrupt candidate without signing a completed output", async () => {
    const f = await fixture(); f.runtime.verifyRender = async item => { if (item.id === "one") throw new Error("decode error"); };
    const result = await f.run(); expect(result.completed).toBe(1); expect(result.items[0].error).toBe("decode error");
    await expect(readFile(f.manifest.items[0].outputPath)).rejects.toThrow();
  });
  it("rejects changed outputs on resume without rerendering", async () => {
    const f = await fixture(); await f.run(); await writeFile(f.manifest.items[0].outputPath, "tampered video");
    const result = await f.run(); expect(result.completed).toBe(1); expect(f.counts.render).toBe(2); expect(result.items[0].error).toContain("影片已變更");
  });
  it("binds the immutable manifest and validates cardinality", async () => {
    const f = await fixture(); await f.run();
    await expect(readAutopilotBatchState(f.statePath, { ...f.manifest, batchId: "changed" })).rejects.toThrow("清單已變更");
    expect(() => autopilotBatchManifestSchema.parse({ ...f.manifest, expectedDeliverableCount: 3 })).toThrow();
    expect(() => autopilotBatchManifestSchema.parse({ ...f.manifest, items: [f.manifest.items[0], f.manifest.items[0]] })).toThrow();
  });
  it("rejects project mutation during render and keeps independent output", async () => {
    const f = await fixture(); const render = f.runtime.render;
    f.runtime.render = async (item, output) => { const result = await render(item, output); if (item.id === "one") await writeFile(item.projectPath, "user edited while rendering"); return result; };
    expect((await f.run()).completed).toBe(1);
    await expect(readFile(f.manifest.items[0].outputPath)).rejects.toThrow();
  });
  it("returns an async job before render completes, cancels before promotion and resumes from the journal", async () => {
    const f = await fixture();
    const manager = new AutopilotBatchJobManager();
    const originalRender = f.runtime.render;
    let releaseRender!: () => void;
    let enteredRender!: () => void;
    const entered = new Promise<void>(resolve => { enteredRender = resolve; });
    const held = new Promise<void>(resolve => { releaseRender = resolve; });
    f.runtime.render = async (...args) => {
      if (args[0].id === "one") { enteredRender(); await held; }
      return originalRender(...args);
    };
    const started = manager.start(f.manifest, f.statePath, f.runtime);
    expect(started.status).toBe("RUNNING");
    expect(() => manager.start(f.manifest, f.statePath, f.runtime)).toThrow("已有進行中的工作");
    if (process.platform === "win32") {
      expect(() => manager.start(f.manifest, f.statePath.toUpperCase(), f.runtime)).toThrow("已有進行中的工作");
    }
    await entered;
    expect(manager.get(started.jobId).status).toBe("RUNNING");
    expect(manager.cancel(started.jobId).status).toBe("CANCEL_REQUESTED");
    releaseRender();
    await vi.waitFor(() => expect(manager.get(started.jobId).status).toBe("STOPPED"));
    expect(f.counts).toEqual({ audit: 1, apply: 1, render: 1, verify: 0 });
    await expect(readFile(f.manifest.items[0].outputPath)).rejects.toThrow();
    const interrupted = await readAutopilotBatchState(f.statePath, f.manifest);
    expect(interrupted!.items[0].phase).toBe("rendering");
    expect(await readFile(interrupted!.items[0].candidatePath!, "utf8")).toBe("video:one");
    await expect(readFile(f.manifest.items[1].outputPath)).rejects.toThrow();
    expect(manager.cancel(started.jobId).status).toBe("STOPPED");
    const restarted = new AutopilotBatchJobManager();
    const resumed = restarted.start(f.manifest, f.statePath, f.runtime);
    await vi.waitFor(() => expect(restarted.get(resumed.jobId).status).toBe("REVIEW_REQUIRED"));
    expect(f.counts).toEqual({ audit: 2, apply: 2, render: 3, verify: 2 });
  });
  it("returns an async job before render completes, stops at an item boundary and resumes from the journal", async () => {
    const f = await fixture();
    const manager = new AutopilotBatchJobManager();
    const originalAudit = f.runtime.audit, originalApply = f.runtime.apply, originalRender = f.runtime.render;
    const itemCounts: Record<string, { apply: number; render: number }> = {
      one: { apply: 0, render: 0 }, two: { apply: 0, render: 0 },
    };
    const receiptPath = (id: string) => join(f.root, `${id}.boundary-commit.json`);
    let enterFirst!: () => void, releaseFirst!: () => void;
    let enterSecond!: () => void, releaseSecond!: () => void;
    const firstEntered = new Promise<void>(resolve => { enterFirst = resolve; });
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondEntered = new Promise<void>(resolve => { enterSecond = resolve; });
    const secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
    let holdSecond = true;
    // This runtime port uses a disk-backed test commit receipt bound to exact plan/project bytes.
    f.runtime.apply = async (item, plan, audit) => {
      itemCounts[item.id].apply++;
      const committed = await originalApply(item, plan, audit);
      const receipt = { ...committed, schema: "test.batch-boundary-commit/v1", state: "committed",
        planSha256: (await f.runtime.readPlan(item)).sha256, projectSha256: sha(await readFile(item.projectPath, "utf8")) };
      await writeFile(receiptPath(item.id), JSON.stringify(receipt), { flag: "wx" });
      return receipt;
    };
    f.runtime.reconcile = async (item, planSha256) => {
      let receipt: Record<string, unknown>;
      try { receipt = JSON.parse(await readFile(receiptPath(item.id), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      if (receipt.id !== item.id || receipt.state !== "committed" || receipt.planSha256 !== planSha256
        || receipt.projectSha256 !== sha(await readFile(item.projectPath, "utf8"))) return undefined;
      return receipt;
    };
    f.runtime.render = async (...args) => {
      itemCounts[args[0].id].render++;
      if (args[0].id === "one") { enterFirst(); await firstHeld; }
      return originalRender(...args);
    };
    f.runtime.audit = async (...args) => {
      if (args[0].id === "two" && holdSecond) { enterSecond(); await secondHeld; }
      return originalAudit(...args);
    };
    const started = manager.start(f.manifest, f.statePath, f.runtime);
    try {
      expect(started.status).toBe("RUNNING");
      expect(started.result).toBeUndefined();
      expect(f.counts).toEqual({ audit: 0, apply: 0, render: 0, verify: 0 });
      await firstEntered;
      expect(manager.get(started.jobId).status).toBe("RUNNING");
      await expect(readFile(f.manifest.items[0].outputPath)).rejects.toThrow();
      releaseFirst();
      await secondEntered;
      const firstJournal = await readAutopilotBatchState(f.statePath, f.manifest);
      if (!firstJournal) throw new Error("Missing committed first-item journal");
      expect(firstJournal.items[0].phase).toBe("review_required");
      expect(firstJournal.items[0].executionReceipt).toMatchObject({ id: "one", state: "committed" });
      expect(firstJournal.items[1].phase).toBe("queued");
      expect(firstJournal.items[1].executionReceipt).toBeUndefined();
      const protectedPaths = [f.manifest.items[0].projectPath, f.manifest.items[0].outputPath, receiptPath("one")];
      const protectedBytes = await Promise.all(protectedPaths.map(path => readFile(path)));
      expect(itemCounts).toEqual({ one: { apply: 1, render: 1 }, two: { apply: 0, render: 0 } });
      expect(manager.cancel(started.jobId).status).toBe("CANCEL_REQUESTED");
      holdSecond = false; releaseSecond();
      await vi.waitFor(() => expect(manager.get(started.jobId).status).toBe("STOPPED"));
      expect(manager.get(started.jobId).result).toMatchObject({ stopped: true, completed: 1 });
      expect(await Promise.all(protectedPaths.map(path => readFile(path)))).toEqual(protectedBytes);
      expect(await readFile(f.manifest.items[1].projectPath, "utf8")).toBe("original:two");
      await expect(readFile(f.manifest.items[1].outputPath)).rejects.toThrow();
      await expect(readFile(receiptPath("two"))).rejects.toThrow();
      expect(itemCounts.two).toEqual({ apply: 0, render: 0 });
      // A fresh registry and cleared process-local map must resume from disk, not remembered commits.
      f.commits.clear();
      const resumedManager = new AutopilotBatchJobManager();
      expect(() => resumedManager.get(started.jobId)).toThrow("找不到");
      const resumed = resumedManager.start(f.manifest, f.statePath, f.runtime);
      expect(resumed.jobId).not.toBe(started.jobId);
      await vi.waitFor(() => expect(resumedManager.get(resumed.jobId).status).toBe("REVIEW_REQUIRED"));
      expect(resumedManager.get(resumed.jobId).result?.completed).toBe(2);
      expect(itemCounts).toEqual({ one: { apply: 1, render: 1 }, two: { apply: 1, render: 1 } });
      expect(await Promise.all(protectedPaths.map(path => readFile(path)))).toEqual(protectedBytes);
      expect(await readFile(f.manifest.items[1].outputPath, "utf8")).toBe("video:two");
      const finalJournal = await readAutopilotBatchState(f.statePath, f.manifest);
      expect(finalJournal?.items[0]).toEqual(firstJournal.items[0]);
      expect(finalJournal?.items[1].phase).toBe("review_required");
    } finally {
      releaseFirst(); releaseSecond();
      if (!manager.get(started.jobId).finishedAt) {
        manager.cancel(started.jobId);
        await vi.waitFor(() => expect(manager.get(started.jobId).finishedAt).toBeDefined());
      }
    }
  });
  it("reports a fatal async job failure without claiming completion", async () => {
    const f = await fixture();
    f.runtime.validatePaths = async () => { throw new Error("invalid batch path"); };
    const manager = new AutopilotBatchJobManager();
    const started = manager.start(f.manifest, f.statePath, f.runtime);
    await vi.waitFor(() => expect(manager.get(started.jobId).status).toBe("FAILED"));
    expect(manager.get(started.jobId).error).toContain("invalid batch path");
    await expect(readAutopilotBatchState(f.statePath, f.manifest)).resolves.toBeUndefined();
  });
});
