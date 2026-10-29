import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeAutopilotBatch, type AutopilotBatchManifest, type AutopilotBatchRuntime } from "./autopilotBatchExecution";
import { AutopilotBatchJobManager } from "./autopilotBatchJobs";

/** W2-3 regressions: the promoted staging hard link (Area C B4) and the batch job's cancel → STOPPED transition (B13). */
const roots: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-batch-w23-")); roots.push(root);
  const manifest: AutopilotBatchManifest = { schema: "editkin.autopilot-batch/v1", batchId: "w23", expectedDeliverableCount: 1,
    items: [{ id: "short", projectPath: join(root, "short.editkin.json"), planPath: join(root, "short.plan.json"), outputPath: join(root, "output.mp4") }] };
  await writeFile(manifest.items[0].projectPath, "original"); await writeFile(manifest.items[0].planPath, "plan");
  const commits = new Map<string, Record<string, unknown>>();
  const hold: { render?: Promise<void> } = {};
  const runtime: AutopilotBatchRuntime = {
    async validatePaths() {},
    async readPlan(item) { const value = await readFile(item.planPath, "utf8"); return { plan: value, sha256: sha(value) }; },
    async audit() { return { accepted: true }; },
    async apply(item) { await writeFile(item.projectPath, "edited"); const receipt = { id: item.id }; commits.set(item.id, receipt); return receipt; },
    async reconcile(item) { return commits.get(item.id); },
    async render(_item, output) { await hold.render; await writeFile(output, "video"); return {}; },
    async verifyRender() {},
  };
  return { root, manifest, runtime, hold, statePath: join(root, "batch.state.json") };
}

describe("autopilot batch W2-3", () => {
  it("removes the promoted staging name, leaving only the output (no stray .editkin-<item>-<uuid>.mp4 hard link)", async () => {
    const f = await fixture();
    expect((await executeAutopilotBatch(f.manifest, f.statePath, f.runtime)).status).toBe("REVIEW_REQUIRED");
    expect(await readFile(f.manifest.items[0].outputPath, "utf8")).toBe("video");
    expect((await readdir(f.root)).filter(name => name.endsWith(".mp4"))).toEqual(["output.mp4"]);
    // An exact retry still verifies the delivered output without the staging name.
    expect((await executeAutopilotBatch(f.manifest, f.statePath, f.runtime)).status).toBe("REVIEW_REQUIRED");
  }, 120_000);

  it("a cancelled job reaches STOPPED once its in-flight render finishes, however long that takes", async () => {
    const f = await fixture();
    let release!: () => void;
    f.hold.render = new Promise<void>(done => { release = done; });
    const manager = new AutopilotBatchJobManager();
    const started = manager.start(f.manifest, f.statePath, f.runtime);
    // Wait until the job is rendering, then cancel; the render keeps going for well over the old 1 s poll budget.
    for (let i = 0; i < 2400 && manager.get(started.jobId).progress?.stage !== "rendering"; i++) await new Promise(done => setTimeout(done, 25));
    expect(manager.get(started.jobId).progress?.stage).toBe("rendering");
    expect(manager.cancel(started.jobId).status).toBe("CANCEL_REQUESTED");
    expect((await manager.wait(started.jobId, 50)).status).toBe("CANCEL_REQUESTED");
    setTimeout(release, 1500);
    const settled = await manager.wait(started.jobId, 60_000);
    expect(settled.status).toBe("STOPPED");
    expect(settled.finishedAt).toBeDefined();
    expect(manager.cancel(started.jobId).status).toBe("STOPPED");
  }, 120_000);
});
