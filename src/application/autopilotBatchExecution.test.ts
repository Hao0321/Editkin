import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autopilotBatchManifestSchema, executeAutopilotBatch, readAutopilotBatchState, type AutopilotBatchManifest, type AutopilotBatchRuntime } from "./autopilotBatchExecution";
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
});
