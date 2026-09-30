import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KitSourceJobs, readCurrentKitSourcePreparation, requestCurrentKitSourceCancellation } from "./kitSourceJobs";
import { pinKitProjectExternalSources, stageKitProjectSources } from "./kitSourceStaging";

const roots: string[] = [];
afterEach(async () => { pinKitProjectExternalSources("", ""); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-kit-jobs-")); roots.push(root);
  const workspace = join(root, "workspace"), imports = join(root, "imports");
  await mkdir(workspace); await mkdir(imports);
  const source = join(imports, "source.mp4"), project = join(workspace, "movie.editkin.json");
  await writeFile(source, Buffer.alloc(1024 * 1024, 3));
  await writeFile(project, JSON.stringify({ assets: [{ id: "a", uri: source }], tracks: [{ clips: [{ id: "c", assetId: "a" }] }] }));
  pinKitProjectExternalSources(workspace, project);
  const facts = await stat(source);
  return { workspace, project, source, sources: [{ path: source, bytes: facts.size, mtimeMs: facts.mtimeMs }] };
}
async function settled(jobs: KitSourceJobs, id: string) {
  for (let i = 0; i < 100; i++) {
    const status = jobs.status(id);
    if (["COMPLETED", "FAILED", "CANCELLED", "UNCERTAIN"].includes(status.status)) return status;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error("Kit source job did not settle");
}

describe("large Kit source preparation jobs", () => {
  it("returns an ID, reports verified progress and coalesces repeated create", async () => {
    const { workspace, project, source, sources } = await fixture();
    let controllerCalls = 0;
    const jobs = new KitSourceJobs(workspace, project, async (_input, options) => {
      const staged = await stageKitProjectSources(workspace, project, options);
      options.onControllerStart(); controllerCalls++;
      return { run_dir: join(workspace, "synthetic-run"), verifiedSnapshot: Boolean(staged.snapshot) };
    });
    const request = { command: "create", runId: "same-run" };
    const started = jobs.start(request, sources);
    expect(started.status).toBe("PREPARING");
    expect(jobs.start(request, sources).preparationId).toBe(started.preparationId);
    const done = await settled(jobs, started.preparationId);
    expect(done.status).toBe("COMPLETED");
    expect(done.progress?.phase).toBe("ready");
    expect(done.result).toMatchObject({ verifiedSnapshot: true });
    expect(jobs.start(request, sources).preparationId).toBe(started.preparationId);
    const reopened = new KitSourceJobs(workspace, project, async () => { throw Error("should not rerun"); });
    expect(reopened.start(request, sources).preparationId).toBe(started.preparationId);
    expect(() => reopened.start({ command: "create", runId: "same-run", priority: "quality" }, sources)).toThrow(/runId already/);
    expect(controllerCalls).toBe(1);
    expect(createHash("sha256").update(await readFile(source)).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("cancels preparation before controller and resumes the same request", async () => {
    const { workspace, project, sources } = await fixture();
    let controllerCalls = 0;
    const jobs = new KitSourceJobs(workspace, project, async (_input, options) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 150);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Error("cancelled")); }, { once: true });
        if (options.signal?.aborted) { clearTimeout(timer); reject(Error("cancelled")); }
      });
      options.onControllerStart(); controllerCalls++;
      return { run_dir: join(workspace, "run") };
    });
    const started = jobs.start({ command: "create" }, sources);
    expect(jobs.cancel(started.preparationId).status).toBe("CANCELLING");
    expect((await settled(jobs, started.preparationId)).status).toBe("CANCELLED");
    expect(controllerCalls).toBe(0);
    expect(jobs.resume(started.preparationId).status).toBe("PREPARING");
    expect((await settled(jobs, started.preparationId)).status).toBe("COMPLETED");
    expect(controllerCalls).toBe(1);
  });

  it("marks a controller-phase crash uncertain instead of resubmitting it", async () => {
    const { workspace, project, sources } = await fixture();
    const jobs = new KitSourceJobs(workspace, project, async (_input, options) => {
      options.onControllerStart(); return { run_dir: join(workspace, "run") };
    });
    const started = jobs.start({ command: "create", runId: "known-run" }, sources);
    expect((await settled(jobs, started.preparationId)).status).toBe("COMPLETED");
    const path = join(workspace, ".editkin-kit-sources", "jobs", `${started.preparationId}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.status = "CREATING"; record.ownerPid = 99999999;
    await writeFile(path, JSON.stringify(record));
    const reopened = new KitSourceJobs(workspace, project, async () => { throw Error("should not execute"); });
    expect(reopened.status(started.preparationId)).toMatchObject({ status: "UNCERTAIN", runId: "known-run" });
    expect(() => reopened.resume(started.preparationId)).toThrow(/Only interrupted/);
  });

  it("does not offer desktop cancellation after Kit controller creation starts", async () => {
    const { workspace, project, sources } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const jobs = new KitSourceJobs(workspace, project, async (_input, options) => {
      options.onControllerStart(); await gate; return { run_dir: join(workspace, "run") };
    });
    const started = jobs.start({ command: "create" }, sources);
    expect(readCurrentKitSourcePreparation(workspace, project)?.status).toBe("CREATING");
    expect(requestCurrentKitSourceCancellation(workspace, project)).toBe(false);
    release();
    expect((await settled(jobs, started.preparationId)).status).toBe("COMPLETED");
  });
});
