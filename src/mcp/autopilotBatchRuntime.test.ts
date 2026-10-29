import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAutopilotBatch } from "../application/autopilotBatchExecution";
import type { MediaProbe } from "../render/ffmpegContracts";

// Probe and decode are controlled (no real media). Manifest/workspace resolution, project reads, the batch
// journal, locks and the hard-link promotion are the real production code.
const controls = vi.hoisted(() => ({ calls: [] as string[], probe: undefined as MediaProbe | undefined }));
vi.mock("../application/inspectMedia", async importOriginal => ({ ...await importOriginal<typeof import("../application/inspectMedia")>(),
  inspectMedia: async () => { controls.calls.push("probe"); return controls.probe!; } }));
vi.mock("../application/analysisProcess", async importOriginal => ({ ...await importOriginal<typeof import("../application/analysisProcess")>(),
  runAnalysisProcess: async (_executable: string, args: string[]) => { controls.calls.push(args.includes("-xerror") ? "decode" : "other"); return { stdout: Buffer.alloc(0), stderr: "" }; } }));
// The renderer itself is controlled: only the deadline signal the runtime hands it is observed.
const renders = vi.hoisted(() => ({ signals: [] as Array<AbortSignal | undefined> }));
vi.mock("./renderTools", async importOriginal => ({ ...await importOriginal<typeof import("./renderTools")>(),
  renderAutopilotProject: async (_projectPath: string, candidate: string, _preferGpu: boolean, _verified: unknown, signal?: AbortSignal) => {
    renders.signals.push(signal); await writeFile(candidate, "controlled render"); return { content: [{ type: "text" as const, text: "{}" }] }; } }));
import { createAutopilotBatchRuntime, loadAutopilotBatch, type AutopilotBatchRuntimeOptions } from "./autopilotBatchTools";
import { createProjectFile } from "./storage";

const previousWorkspace = process.env.EDITKIN_WORKSPACE;
let workspace = "";
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "editkin-batch-runtime-"));
  process.env.EDITKIN_WORKSPACE = workspace;
  controls.calls.length = 0;
});
afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = previousWorkspace;
  await rm(workspace, { recursive: true, force: true });
});

async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function batch(options?: AutopilotBatchRuntimeOptions) {
  const project = await createProjectFile("short/short.editkin.json", "Batch runtime control", 1080, 1920, 30);
  controls.probe = { duration: 0, width: project.width, height: project.height, hasVideo: true, hasAudio: true };
  await writeFile(join(workspace, "short", "plan.v4.json"), JSON.stringify({ schema: "controlled-plan" }));
  await writeFile(join(workspace, "short", "batch.json"), JSON.stringify({ schema: "editkin.autopilot-batch/v1", batchId: "short", expectedDeliverableCount: 1,
    items: [{ id: "short", projectPath: "short/short.editkin.json", planPath: "short/plan.v4.json", outputPath: "short/output.mp4" }] }));
  const loaded = await loadAutopilotBatch("short/batch.json");
  const runtime = createAutopilotBatchRuntime(loaded, false, options);
  // Audit, apply and render are this boundary's fakes; verifyRender is the runtime under test.
  runtime.audit = async () => ({ accepted: true });
  runtime.apply = async () => ({ committed: true });
  runtime.reconcile = async () => ({ committed: true });
  runtime.render = async (_item, candidate) => { controls.calls.push("render"); await writeFile(candidate, "controlled candidate bytes"); return {}; };
  return { loaded, run: () => executeAutopilotBatch(loaded.manifest, loaded.statePath, runtime), output: join(workspace, "short", "output.mp4") };
}

describe("autopilot batch runtime seam", () => {
  it("resolves the manifest inside the workspace and keeps the default verify when no wrapper is given", async () => {
    const f = await batch();
    expect(f.loaded.manifest.items[0].outputPath).toBe(join(workspace, "short", "output.mp4"));
    expect(f.loaded.statePath).toBe(join(workspace, "short", "batch.json.state.json"));
    expect((await f.run()).status).toBe("REVIEW_REQUIRED");
    expect(controls.calls).toEqual(["render", "probe", "decode"]);
    expect(await readFile(f.output, "utf8")).toBe("controlled candidate bytes");
  });

  it("runs the wrapper only after the default probe and full decode, with that probe and project", async () => {
    const wrapper = vi.fn<NonNullable<AutopilotBatchRuntimeOptions["verifyRender"]>>(async () => { controls.calls.push("wrapper"); });
    const f = await batch({ verifyRender: wrapper });
    expect((await f.run()).status).toBe("REVIEW_REQUIRED");
    expect(controls.calls).toEqual(["render", "probe", "decode", "wrapper"]);
    const [item, candidate, base] = wrapper.mock.calls[0];
    expect(item.id).toBe("short");
    expect(candidate).toMatch(/\.editkin-short-[a-f0-9-]{36}\.mp4$/);
    expect(base.probe).toBe(controls.probe);
    expect(base.project.width).toBe(1080);
    expect(await exists(f.output)).toBe(true);
  });

  it("a wrapper throw stops promotion and keeps the unverified candidate", async () => {
    const f = await batch({ verifyRender: async () => { throw new Error("controlled technical QA failure"); } });
    const result = await f.run();
    expect(result.status).toBe("PARTIAL");
    expect(result.items[0]).toMatchObject({ phase: "rendering", error: "controlled technical QA failure" });
    expect(await exists(f.output)).toBe(false);
    const state = JSON.parse(await readFile(f.loaded.statePath, "utf8"));
    expect(await exists(state.items[0].candidatePath)).toBe(true);
    expect(state.items[0].candidateSha256).toBeUndefined();
  });

  it("never reaches the wrapper when the default verify fails", async () => {
    const wrapper = vi.fn(async () => {});
    const f = await batch({ verifyRender: wrapper });
    controls.probe = { ...controls.probe!, hasAudio: false };
    const result = await f.run();
    expect(result.items[0].error).toContain("音畫");
    expect(controls.calls).toEqual(["render", "probe"]);
    expect(wrapper).not.toHaveBeenCalled();
    expect(await exists(f.output)).toBe(false);
  });

  it("hands the renderer a deadline signal only when renderTimeoutMs is set (template short: scaled to length)", async () => {
    const f = await batch();
    const item = f.loaded.manifest.items[0], candidate = join(workspace, "short", "deadline-candidate.mp4");
    renders.signals.length = 0;
    await createAutopilotBatchRuntime(f.loaded, false, { renderTimeoutMs: 600_000 }).render(item, candidate);
    await createAutopilotBatchRuntime(f.loaded, false).render(item, candidate);
    expect(renders.signals).toHaveLength(2);
    expect(renders.signals[0]).toBeInstanceOf(AbortSignal);
    expect(renders.signals[0]!.aborted).toBe(false);
    expect(renders.signals[1]).toBeUndefined();
  });
});
