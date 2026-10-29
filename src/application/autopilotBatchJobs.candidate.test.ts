import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeAutopilotBatch, readAutopilotBatchState, type AutopilotBatchManifest, type AutopilotBatchRuntime, type AutopilotBatchProgress } from "./autopilotBatchExecution";
import { AutopilotBatchJobManager } from "./autopilotBatchJobs";
import { createDemoProject } from "../domain/demo";
import { findClip, validateProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, redo, undo, type EditorHistory } from "../domain/history";
import { buildSemanticAutoEditCommand } from "./semanticAutoEditCommands";
import { planSemanticAutoEdit } from "./semanticAutoEdit";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(count = 2) {
  // TMP is explicitly redirected by the owned launcher. Keep fixtures for causal evidence.
  const root = await mkdtemp(join(tmpdir(), "jobs-control-"));
  const manifest: AutopilotBatchManifest = { schema: "editkin.autopilot-batch/v1", batchId: "controls", expectedDeliverableCount: count,
    items: Array.from({ length: count }, (_, index) => ({ id: `item-${index}`, projectPath: join(root, `${index}.editkin.json`),
      planPath: join(root, `${index}.plan.json`), outputPath: join(root, `${index}.mp4`) })) };
  const counts = { read: 0, audit: 0, apply: 0, reconcile: 0, render: 0 };
  const commits = new Map<string, { receipt: Record<string, unknown>; afterSha: string; planSha: string }>();
  const histories = new Map<string, EditorHistory>();
  const originals = new Map<string, string>();
  for (const item of manifest.items) {
    const project = createDemoProject();
    project.id = `project-${item.id}`;
    const source = project.assets.find(asset => asset.id === "asset-demo") ?? project.assets[0];
    source.provenance = "user-selected-local-source";
    source.redistributable = false;
    source.derivatives = { ...source.derivatives, sourceSha256: sha(`source:${item.id}`), generatedAt: "2026-10-18T00:00:00.000Z" };
    const sourcePath = join(root, `${item.id}.source-fixture`);
    source.uri = sourcePath;
    await writeFile(sourcePath, `source:${item.id}`);
    const clip = findClip(project, "clip-demo");
    const cues = [{ start: 0.2, end: 1.8, text: "第一個關鍵方法" }, { start: 3.2, end: 4.5, text: "最後總結結果" }].filter(cue => cue.end <= clip.duration);
    const plan = planSemanticAutoEdit({ duration: clip.duration, fps: project.fps, cues, targetRatio: .5 });
    const built = buildSemanticAutoEditCommand(project, clip, { cues }, plan, (kind, index) => `${item.id}-${kind}-${index}`);
    const projectText = JSON.stringify(project);
    originals.set(item.id, projectText);
    histories.set(item.id, createHistory(project));
    await writeFile(item.projectPath, projectText);
    await writeFile(item.planPath, JSON.stringify({ projectId: project.id, sourceSha256: source.derivatives.sourceSha256, command: built.command }));
  }
  const runtime: AutopilotBatchRuntime = {
    async validatePaths() {},
    async readPlan(item) { counts.read++; const text = await readFile(item.planPath, "utf8"); return { plan: JSON.parse(text), sha256: sha(text) }; },
    async audit(item, raw) {
      counts.audit++;
      const plan = raw as { projectId: string; sourceSha256: string };
      const project = JSON.parse(await readFile(item.projectPath, "utf8"));
      if (project.id !== plan.projectId) throw new Error("stale project identity");
      const source = project.assets.find((asset: { uri: string }) => asset.uri.endsWith(".source-fixture"));
      if (sha(await readFile(source.uri, "utf8")) !== plan.sourceSha256) throw new Error("stale source evidence");
      return { projectSha256: sha(JSON.stringify(project)) };
    },
    async apply(item, raw) {
      counts.apply++;
      const plan = raw as { command: Parameters<typeof dispatchCommand>[1] };
      const history = dispatchCommand(histories.get(item.id)!, plan.command, `operation:${item.id}`);
      validateProject(history.present);
      histories.set(item.id, history);
      const text = JSON.stringify(history.present);
      await writeFile(item.projectPath, text);
      const receipt = { schema: "fixture-committed-receipt", operation: item.id, state: "committed", projectId: history.present.id };
      commits.set(item.id, { receipt, afterSha: sha(text), planSha: sha(await readFile(item.planPath, "utf8")) });
      return receipt;
    },
    async reconcile(item, planSha) {
      counts.reconcile++;
      const commit = commits.get(item.id);
      if (!commit) return;
      if (commit.planSha !== planSha || sha(await readFile(item.projectPath, "utf8")) !== commit.afterSha) throw new Error("stale committed receipt");
      return commit.receipt;
    },
    async render(_item, path) { counts.render++; await writeFile(path, "fixture-only-output"); return { fixture: true }; },
    async verifyRender() {},
  };
  const statePath = join(root, "batch.state.json");
  const run = (options: Parameters<typeof executeAutopilotBatch>[3] = {}) => executeAutopilotBatch(manifest, statePath, runtime, options);
  return { root, manifest, runtime, counts, commits, histories, originals, statePath, run };
}

describe("calibrated batch execution controls", () => {
  it("positive: real semantic batch command persists once and one canonical undo restores the complete editable graph", async () => {
    const f = await fixture();
    expect((await f.run({ through: "apply" })).items.every(item => item.phase === "applied" && !item.error)).toBe(true);
    for (const item of f.manifest.items) {
      const history = f.histories.get(item.id)!;
      expect(history.past).toHaveLength(1);
      expect(history.journal).toHaveLength(1);
      expect(history.journal[0].command.type).toBe("batch");
      expect(JSON.parse(await readFile(item.projectPath, "utf8"))).toEqual(history.present);
      expect(undo(history).present).toEqual(JSON.parse(f.originals.get(item.id)!));
      expect(redo(undo(history)).present).toEqual(history.present);
    }
    await f.run({ through: "apply" });
    expect(f.counts.apply).toBe(2);
  });

  it("negative: cancel while queued starts no input preparation or apply", async () => {
    const f = await fixture();
    const result = await f.run({ through: "apply", shouldStop: () => true });
    expect(result.stopped).toBe(true);
    expect(f.counts).toEqual({ read: 0, audit: 0, apply: 0, reconcile: 0, render: 0 });
    for (const item of f.manifest.items) expect(await readFile(item.projectPath, "utf8")).toBe(f.originals.get(item.id));
  });

  it("negative: cancellation arriving during audit prevents the commit", async () => {
    const f = await fixture();
    let stop = false;
    const audit = f.runtime.audit;
    f.runtime.audit = async (...args) => { const result = await audit(...args); stop = true; return result; };
    const result = await f.run({ through: "apply", shouldStop: () => stop });
    expect(result.stopped).toBe(true);
    expect(f.counts.apply).toBe(0);
    const state = await readAutopilotBatchState(f.statePath, f.manifest);
    expect(state!.items.every(item => item.phase === "queued")).toBe(true);
    expect(await readFile(f.manifest.items[0].projectPath, "utf8")).toBe(f.originals.get("item-0"));
  });

  it("negative: delayed audit publishes live state before a terminal result exists", async () => {
    const f = await fixture();
    const entered = deferred(), held = deferred();
    const audit = f.runtime.audit;
    f.runtime.audit = async (...args) => { entered.resolve(); await held.promise; return audit(...args); };
    const manager = new AutopilotBatchJobManager();
    const started = manager.start(f.manifest, f.statePath, f.runtime, { through: "apply" });
    try {
      await entered.promise;
      const snapshot = manager.get(started.jobId) as ReturnType<typeof manager.get> & { progress?: { stage: string; activeItemId?: string; expected: number }; result?: unknown };
      expect(snapshot.result).toBeUndefined();
      expect(snapshot.progress).toMatchObject({ stage: "auditing", activeItemId: "item-0", expected: 2 });
    } finally {
      manager.cancel(started.jobId);
      held.resolve();
      expect((await manager.wait(started.jobId, 120_000)).finishedAt).toBeDefined();
    }
  });
});

describe("safe boundaries, recovery and one execution owner", () => {
  it("stops after an in-flight commit is reconciled; a fresh manager resumes without a second apply", async () => {
    const f = await fixture(), entered = deferred(), held = deferred();
    const apply = f.runtime.apply;
    f.runtime.apply = async (...args) => { entered.resolve(); await held.promise; return apply(...args); };
    const manager = new AutopilotBatchJobManager({ maxConcurrentJobs: 1 });
    const started = manager.start(f.manifest, f.statePath, f.runtime);
    try {
      await entered.promise;
      expect(manager.get(started.jobId).progress).toMatchObject({ stage: "applying", activeItemId: "item-0", applied: 0 });
      expect(manager.cancel(started.jobId).status).toBe("CANCEL_REQUESTED");
    } finally { held.resolve(); }
    expect((await manager.wait(started.jobId, 120_000)).status).toBe("STOPPED");
    expect(f.counts.apply).toBe(1);
    expect(f.counts.reconcile).toBe(1);
    expect(f.counts.render).toBe(0);
    expect((await readAutopilotBatchState(f.statePath, f.manifest))!.items.map(item => item.phase)).toEqual(["applied", "queued"]);
    const restarted = new AutopilotBatchJobManager({ maxConcurrentJobs: 1 });
    await restarted.run(f.manifest, f.statePath, f.runtime, { through: "apply" });
    expect(f.counts.apply).toBe(2);
    expect(f.histories.get("item-0")!.past).toHaveLength(1);
  });

  it("cancels at the durable applying intent before calling apply", async () => {
    const f = await fixture();
    let stop = false;
    const options = { through: "apply" as const, shouldStop: () => stop, onProgress: (p: AutopilotBatchProgress) => { if (p.stage === "applying") stop = true; } };
    expect((await f.run(options)).stopped).toBe(true);
    expect(f.counts.apply).toBe(0);
    expect((await readAutopilotBatchState(f.statePath, f.manifest))!.items[0].phase).toBe("queued");
    await f.run({ through: "apply" });
    expect(f.counts.apply).toBe(2);
  });

  it("lost commit response plus cancellation preserves uncertainty until receipt reconciliation", async () => {
    const f = await fixture();
    let stop = false;
    const apply = f.runtime.apply;
    f.runtime.apply = async (...args) => { await apply(...args); stop = true; throw new Error("response lost after commit"); };
    expect((await f.run({ shouldStop: () => stop })).stopped).toBe(true);
    expect((await readAutopilotBatchState(f.statePath, f.manifest))!.items[0]).toMatchObject({ phase: "applying", error: "response lost after commit" });
    f.runtime.apply = apply;
    await f.run({ through: "apply" });
    await f.run({ through: "apply" });
    expect(f.counts.apply).toBe(2);
    expect(f.histories.get("item-0")!.past).toHaveLength(1);
    expect(f.histories.get("item-1")!.past).toHaveLength(1);
  });

  it("never retries an uncertain mutation without a matching committed receipt", async () => {
    const f = await fixture(1);
    let attempts = 0;
    f.runtime.apply = async item => { attempts++; await writeFile(item.projectPath, "uncertain user-visible mutation"); throw new Error("crash before receipt"); };
    await f.run({ through: "apply" });
    const retry = await f.run({ through: "apply" });
    expect(attempts).toBe(1);
    expect(retry.items[0].error).toContain("reconcile");
    expect(await readFile(f.manifest.items[0].projectPath, "utf8")).toBe("uncertain user-visible mutation");
  });

  it("an audit failure affects only its item and retry does not reapply the succeeding item", async () => {
    const f = await fixture();
    const audit = f.runtime.audit;
    f.runtime.audit = async (item, plan) => { if (item.id === "item-0") throw new Error("rights denied by existing gate"); return audit(item, plan); };
    const partial = await f.run({ through: "apply" });
    expect(partial.items[0].error).toBe("rights denied by existing gate");
    expect(partial.items[1]).toMatchObject({ phase: "applied", error: undefined });
    expect(f.histories.get("item-0")!.past).toHaveLength(0);
    f.runtime.audit = audit;
    await f.run({ through: "apply", itemId: "item-0" });
    await f.run({ through: "apply" });
    expect(f.counts.apply).toBe(2);
  });

  it.each(["plan", "project"] as const)("rejects %s changes while audit is pending", async kind => {
    const f = await fixture();
    const audit = f.runtime.audit;
    f.runtime.audit = async (item, plan) => {
      const receipt = await audit(item, plan);
      if (item.id === "item-0") {
        const path = kind === "plan" ? item.planPath : item.projectPath;
        const content = JSON.parse(await readFile(path, "utf8"));
        if (kind === "plan") content.projectId = "replacement-plan"; else content.id = "replacement-project";
        await writeFile(path, JSON.stringify(content));
      }
      return receipt;
    };
    const result = await f.run({ through: "apply" });
    expect(result.items[0].error).toContain(kind === "plan" ? "計畫已變更" : "手動修改");
    expect(result.items[1].phase).toBe("applied");
    expect(f.counts.apply).toBe(1);
  });

  it("stale source evidence is rejected by the injected existing audit boundary", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "item-0.source-fixture"), "source was replaced");
    const result = await f.run({ through: "apply" });
    expect(result.items[0].error).toBe("stale source evidence");
    expect(f.counts.apply).toBe(1);
    expect(await readFile(f.manifest.items[0].projectPath, "utf8")).toBe(f.originals.get("item-0"));
  });

  it("a single last item cancelled during its render reports STOPPED after preserving the completed transaction", async () => {
    const f = await fixture(1);
    let stop = false;
    const render = f.runtime.render;
    f.runtime.render = async (...args) => { stop = true; return render(...args); };
    const result = await f.run({ shouldStop: () => stop });
    expect(result.stopped).toBe(true);
    expect(result.completed).toBe(1);
    expect(await readFile(f.manifest.items[0].outputPath, "utf8")).toBe("fixture-only-output");
    await f.run();
    expect(f.counts.apply).toBe(1);
    expect(f.counts.render).toBe(1);
  });

  it("observer mutation, synchronous throw and asynchronous rejection cannot change commits or manager snapshots", async () => {
    const f = await fixture();
    const manager = new AutopilotBatchJobManager({ maxConcurrentJobs: 1 });
    const started = manager.start(f.manifest, f.statePath, f.runtime, { through: "apply", onProgress: progress => {
      progress.items.length = 0;
      if (progress.sequence % 2) throw new Error("observer unavailable");
      return Promise.reject(new Error("asynchronous observer unavailable"));
    } });
    expect((await manager.wait(started.jobId, 120_000)).finishedAt).toBeDefined();
    const snapshot = manager.get(started.jobId);
    expect(snapshot.status).toBe("PARTIAL");
    expect(snapshot.progress!.items).toHaveLength(2);
    expect(snapshot.progress).toMatchObject({ stage: "finished", applied: 2, failed: 0 });
    snapshot.progress!.items.length = 0;
    snapshot.result!.items[0].phase = "queued";
    expect(manager.get(started.jobId).progress!.items).toHaveLength(2);
    expect(manager.get(started.jobId).result!.items[0].phase).toBe("applied");
    expect(f.counts.apply).toBe(2);
  });

  it("snapshots the manifest and requested mode synchronously instead of retargeting queued work", async () => {
    const f = await fixture(1), manager = new AutopilotBatchJobManager();
    const originalPath = f.manifest.items[0].projectPath;
    const options = { through: "apply" as "apply" | "render" };
    const started = manager.start(f.manifest, f.statePath, f.runtime, options);
    f.manifest.items[0].projectPath = join(f.root, "replacement.editkin.json");
    options.through = "render";
    expect((await manager.wait(started.jobId, 120_000)).finishedAt).toBeDefined();
    expect(f.counts.apply).toBe(1);
    expect(f.counts.render).toBe(0);
    expect(await readFile(originalPath, "utf8")).not.toBe(f.originals.get("item-0"));
    await expect(readFile(f.manifest.items[0].projectPath)).rejects.toThrow();
  });

  it("sync and async callers share the same cap and ownership, with no hidden pending queue", async () => {
    const f = await fixture(1), other = await fixture(1), entered = deferred(), held = deferred();
    const manager = new AutopilotBatchJobManager({ maxConcurrentJobs: 1, maxRetainedJobs: 2 });
    const audit = f.runtime.audit;
    f.runtime.audit = async (...args) => { entered.resolve(); await held.promise; return audit(...args); };
    const running = manager.run(f.manifest, f.statePath, f.runtime, { through: "apply" });
    try {
      await entered.promise;
      expect(manager.getResourceUsage()).toMatchObject({ activeJobs: 1, queuedJobs: 0, totalJobs: 1 });
      await expect(manager.run(f.manifest, f.statePath, f.runtime)).rejects.toThrow("已有進行中的工作");
      expect(() => manager.start(other.manifest, other.statePath, other.runtime)).toThrow("上限");
      await expect(manager.run(other.manifest, other.statePath, other.runtime)).rejects.toThrow("上限");
      expect(other.counts.read).toBe(0);
    } finally { held.resolve(); await running; }
    expect(f.counts.apply).toBe(1);
    expect(manager.getResourceUsage()).toMatchObject({ activeJobs: 0, queuedJobs: 0, retainedFinishedJobs: 1 });
  });

  it("rejects larger resource caps and invalid request cardinality before any work", async () => {
    expect(() => new AutopilotBatchJobManager({ maxConcurrentJobs: 5 })).toThrow("資源上限");
    expect(() => new AutopilotBatchJobManager({ maxConcurrentJobs: 0 })).toThrow("資源上限");
    expect(() => new AutopilotBatchJobManager({ maxRetainedJobs: 129 })).toThrow("資源上限");
    const f = await fixture(1), manager = new AutopilotBatchJobManager();
    expect(() => manager.start(f.manifest, f.statePath, f.runtime, { itemId: "missing" })).toThrow("未知");
    await expect(executeAutopilotBatch({ ...f.manifest, expectedDeliverableCount: 65 }, f.statePath, f.runtime)).rejects.toThrow();
    expect(f.counts.read).toBe(0);
    expect(manager.getResourceUsage().totalJobs).toBe(0);
  });

  it("retains bounded live/result state through 256 short failures and 32 successful resumptions", async () => {
    const f = await fixture(1), manager = new AutopilotBatchJobManager({ maxConcurrentJobs: 1, maxRetainedJobs: 4 });
    let maxActive = 0, maxTotal = 0, maxFinished = 0, maxSnapshotBytes = 0;
    const sample = () => {
      const usage = manager.getResourceUsage();
      maxActive = Math.max(maxActive, usage.activeJobs); maxTotal = Math.max(maxTotal, usage.totalJobs);
      maxFinished = Math.max(maxFinished, usage.retainedFinishedJobs);
      expect(usage.queuedJobs).toBe(0);
    };
    const failing = { ...f.runtime, validatePaths: async () => { throw new Error("short admission fixture failure"); } };
    const began = performance.now();
    for (let index = 0; index < 256; index++) {
      const start = manager.start(f.manifest, f.statePath, failing); sample();
      await new Promise<void>(done => setImmediate(done));
      const end = manager.get(start.jobId); sample();
      expect(end.status).toBe("FAILED");
      maxSnapshotBytes = Math.max(maxSnapshotBytes, Buffer.byteLength(JSON.stringify(end)));
    }
    for (let index = 0; index < 32; index++) {
      await manager.run(f.manifest, f.statePath, f.runtime, { through: "apply", onProgress: sample }); sample();
    }
    expect(f.counts.apply).toBe(1);
    expect(maxActive).toBe(1); expect(maxTotal).toBeLessThanOrEqual(5); expect(maxFinished).toBe(4);
    const metrics = { shortFailures: 256, successfulRequests: 32, actualApplies: f.counts.apply,
      maxActive, maxTotal, maxFinished, maxSnapshotBytes, final: manager.getResourceUsage(),
      elapsedMs: performance.now() - began, journalBytes: (await stat(f.statePath)).size, resultBytes: Buffer.byteLength(JSON.stringify(await f.run({ through: "apply" }))) };
    if (process.env.AUTOEDIT_EVIDENCE_PREFIX) await writeFile(`${process.env.AUTOEDIT_EVIDENCE_PREFIX}.churn-metrics.json`, JSON.stringify(metrics, null, 2));
  });

  it("a maximum-cardinality batch remains sequential and emits counts agreeing with its durable journal", async () => {
    const f = await fixture(64), manager = new AutopilotBatchJobManager({ maxConcurrentJobs: 1, maxRetainedJobs: 1 });
    let active = 0, maxActive = 0, maxProgressBytes = 0, events = 0;
    const observerViolations: string[] = [];
    const apply = f.runtime.apply;
    f.runtime.apply = async (...args) => { active++; maxActive = Math.max(maxActive, active); try { return await apply(...args); } finally { active--; } };
    const result = await manager.run(f.manifest, f.statePath, f.runtime, { through: "apply", onProgress: progress => {
      events++;
      if (progress.items.length !== 64) observerViolations.push("wrong cardinality");
      if (progress.applied !== progress.items.filter(item => item.phase === "applied" && !item.error).length) observerViolations.push("wrong applied count");
      maxProgressBytes = Math.max(maxProgressBytes, Buffer.byteLength(JSON.stringify(progress)));
    } });
    expect(f.counts.apply).toBe(64); expect(maxActive).toBe(1);
    expect(observerViolations).toEqual([]);
    const state = await readAutopilotBatchState(f.statePath, f.manifest);
    expect(result.items.map(item => item.phase)).toEqual(state!.items.map(item => item.phase));
    expect(manager.getResourceUsage()).toMatchObject({ retainedProgressItems: 64, retainedResultItems: 64, queuedJobs: 0 });
    if (process.env.AUTOEDIT_EVIDENCE_PREFIX) await writeFile(`${process.env.AUTOEDIT_EVIDENCE_PREFIX}.cardinality-metrics.json`, JSON.stringify({ items:64, maxActive, events, maxProgressBytes,
      journalBytes:(await stat(f.statePath)).size, resultBytes:Buffer.byteLength(JSON.stringify(result)), usage:manager.getResourceUsage() }, null, 2));
  }, 120_000); // 64 items x fsynced journal writes and OS project locks: about 100 ms per durable write on a busy shared disk (W2-3 measured); the subject is sequencing, not throughput.
});
