import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
vi.mock("../application/autoReframeSparseSourceV2", () => ({ prepareAutoReframeSparseSourceV2: vi.fn() }));
import { prepareAutoReframeSparseSourceV2 } from "../application/autoReframeSparseSourceV2";
import { createAutoReframeSparseV2 } from "../application/autoReframeSparseV2";
import { beginAutoReframeEditV1, autoReframeJobRequestV1, admitAutoReframePlanV1 } from "../application/autoReframeEditV1";
import { instrumentOnlyWorkflowReplyV1 } from "../application/__fixtures__/autoReframeWorkflowV1.fixture";
import { createDemoProject } from "../domain/demo";
import { parseProject } from "../application/projectCodec";
import { canonicalJson } from "../shared/canonicalJson";
import { engineTaskRequestSchemaV1 } from "../application/engineTaskContractV1";
import { dispatchEngineTaskV1, ENGINE_TASK_KINDS_V1 } from "./engineTaskRegistryV1";

const temp = resolve(process.env.TEMP!); let folder: string;
beforeEach(async () => { vi.resetAllMocks(); folder = await mkdtemp(join(temp, "engine-task-registry-")); });
afterEach(async () => { if (!folder.startsWith(temp + sep)) throw Error("test cleanup outside owned root"); await rm(folder, { recursive: true }); });
async function fixture(newProject = false) {
  const p = createDemoProject(); p.width = newProject ? 160 : 90; p.height = newProject ? 90 : 160; p.fps = 4;
  p.assets[0].uri = "source.mkv"; p.assets[0].duration = 2; p.assets[0].width = 64; p.assets[0].height = 40;
  p.assets[0].derivatives = { sourceSha256: "a".repeat(64), proxyUri: "do-not-analyze-proxy.mp4", generatedAt: "2026-10-18T00:00:00.000Z" };
  p.tracks[0].clips[0].duration = 1.25; p.tracks[0].clips[0].speed = 1; const project = parseProject(p);
  const job = await beginAutoReframeEditV1(project, "clip-demo", { operationId: "engine-task-unit", mode: newProject ? "new_portrait_project" : "current_portrait", outputWidth: 90, outputHeight: 160, subject: { kind: "saliency" },
    ...(newProject ? { newProject: { id: "separate-portrait", name: "Separate portrait", createdAt: "2026-10-18T00:00:00.000Z" } } : {}) });
  const payload = { schema: "editkin.engine-task/v1" as const, kind: "auto_reframe_v1" as const, project, input: autoReframeJobRequestV1(project, job) };
  const cacheRoot = join(folder, "cache"); await mkdir(cacheRoot);
  const runtime = { assetBase: folder, cacheRoot, ffmpeg: join(folder, "ffmpeg.exe"), ffprobe: join(folder, "ffprobe.exe") };
  vi.mocked(prepareAutoReframeSparseSourceV2).mockImplementation(async (target, input, rt) => {
    const sink = createAutoReframeSparseV2(target, input); sink.initialize(64, 40);
    for (let frame = 0; frame < 5; frame++) { rt.signal?.throwIfAborted(); sink.consume({ frame, time: frame / 4, sceneCut: frame === 0, pixelSha256: "c".repeat(64) }); await rt.onFrame?.(frame); }
    return instrumentOnlyWorkflowReplyV1(payload.input, sink.finish()).prepared;
  });
  const directory = join(cacheRoot, "engine-jobs-v1", payload.input.operationId), files = { progressPath: join(directory, "progress.json"), cancelPath: join(directory, "cancel.request") };
  return { payload, runtime, job, files, directory };
}
describe("single accepted engine-task service registry", () => {
  it.each([false, true])("uses the existing source adapter and client-admissible draft for new document %s", async separate => {
    const f = await fixture(separate), before = canonicalJson(f.payload), progress: unknown[] = [];
    const r = await dispatchEngineTaskV1(f.payload, f.runtime, { onProgress: p => progress.push(p) });
    if (r.kind !== "auto_reframe_v1") throw new Error("Expected auto_reframe_v1 reply");
    expect(r).toMatchObject({ schema: "editkin.engine-task-reply/v1", kind: "auto_reframe_v1", operationId: f.payload.input.operationId });
    expect(prepareAutoReframeSparseSourceV2).toHaveBeenCalledOnce(); expect(canonicalJson(f.payload)).toBe(before);
    expect(vi.mocked(prepareAutoReframeSparseSourceV2).mock.calls[0][2].sourcePath).toBe(join(folder, "source.mkv"));
    expect(() => admitAutoReframePlanV1(f.payload.project, f.job, r.result)).not.toThrow();
    expect(progress.at(-1)).toMatchObject({ schema: "editkin.engine-task-progress/v1", operationId: f.payload.input.operationId, progress: { stage: "finalize", completed: 1, total: 1 } });
    expect(ENGINE_TASK_KINDS_V1).toEqual(["auto_reframe_v1", "desktop_batch_item_v1", "motion_library_render_v1", "style_template_render_v1"]); expect(Object.isFrozen(ENGINE_TASK_KINDS_V1)).toBe(true);
  });
  it.each(["kind", "schema", "payload-path", "input-path", "input-runtime", "project-runtime"])("rejects %s injection before a package producer", async kind => {
    const f = await fixture(), p = structuredClone(f.payload) as any;
    if (kind === "kind") p.kind = "arbitrary"; if (kind === "schema") p.schema = "future";
    if (kind === "payload-path") p.sourcePath = "proxy.mp4"; if (kind === "input-path") p.input.sourcePath = "proxy.mp4";
    if (kind === "input-runtime") p.input.runtime = { ffmpeg: "untrusted.exe" }; if (kind === "project-runtime") p.runtime = { ffmpeg: "untrusted.exe" };
    await expect(dispatchEngineTaskV1(p, f.runtime)).rejects.toThrow(); expect(prepareAutoReframeSparseSourceV2).not.toHaveBeenCalled();
  });
  it.each(["revision", "source-hash", "target-hash", "locked", "camera"])("keeps existing %s admission before source analysis", async reason => {
    const f = await fixture();
    if (reason === "revision") f.payload.project.revision++; if (reason === "source-hash") f.payload.input.expectedSourceSha256 = "b".repeat(64);
    if (reason === "target-hash") f.payload.input.targetProjectSha256 = "b".repeat(64); if (reason === "locked") f.payload.project.tracks[0].locked = true;
    if (reason === "camera") f.payload.project.tracks[0].clips[0].transform.x = 1;
    await expect(dispatchEngineTaskV1(f.payload, f.runtime)).rejects.toThrow(); expect(prepareAutoReframeSparseSourceV2).not.toHaveBeenCalled();
  });
  it.each(["assetBase", "cacheRoot", "ffmpeg", "ffprobe"] as const)("requires an absolute host %s instead of caller tool/path fields", async key => {
    const f = await fixture(); await expect(dispatchEngineTaskV1(f.payload, { ...f.runtime, [key]: "relative" })).rejects.toThrow("HOST_RUNTIME");
    expect(prepareAutoReframeSparseSourceV2).not.toHaveBeenCalled();
  });
  it("retains the confirmed-subject refusal when a trusted resolver is unavailable", async () => {
    const f = await fixture(); f.payload.input.subject = { kind: "confirmed-matte-v2", confirmationSha256: "f".repeat(64) };
    await expect(dispatchEngineTaskV1(f.payload, f.runtime)).rejects.toThrow("REVIEWED_SUBJECT_UNAVAILABLE"); expect(prepareAutoReframeSparseSourceV2).not.toHaveBeenCalled();
  });
  it("does not let renderer requests set job file paths", async () => {
    const f = await fixture(); expect(engineTaskRequestSchemaV1.safeParse({ ...f.payload, job: f.files }).success).toBe(false);
  });
  it("shares file-control lifetime and flushes actual typed progress without removing host files", async () => {
    const f = await fixture(); await mkdir(f.directory, { recursive: true });
    await dispatchEngineTaskV1({ ...f.payload, job: f.files }, f.runtime);
    expect(JSON.parse(await readFile(f.files.progressPath, "utf8"))).toMatchObject({ schema: "editkin.engine-task-progress/v1", kind: "auto_reframe_v1", operationId: f.payload.input.operationId, progress: { stage: "finalize", completed: 1, total: 1 } });
    expect(await readdir(f.directory)).toEqual(["progress.json"]);
  });
  it.each(["outside-cache", "wrong-job", "split-parent", "relative"])("rejects %s control files without writing", async reason => {
    const f = await fixture(), files = { ...f.files };
    if (reason === "outside-cache") { files.progressPath = join(folder, "progress.json"); files.cancelPath = join(folder, "cancel.request"); }
    if (reason === "wrong-job") { files.progressPath = join(f.runtime.cacheRoot, "engine-jobs-v1", "another-job", "progress.json"); files.cancelPath = join(f.runtime.cacheRoot, "engine-jobs-v1", "another-job", "cancel.request"); }
    if (reason === "split-parent") files.cancelPath = join(folder, "cancel.request"); if (reason === "relative") files.progressPath = "progress.json";
    await expect(dispatchEngineTaskV1({ ...f.payload, job: files }, f.runtime)).rejects.toThrow("JOB_PATH"); expect(await readdir(folder)).toEqual(["cache"]);
  });
  it.each(["progress.json", "user.txt"])("does not overwrite an existing host-directory %s", async name => {
    const f = await fixture(); await mkdir(f.directory, { recursive: true }); await writeFile(join(f.directory, name), "retained user content");
    await expect(dispatchEngineTaskV1({ ...f.payload, job: f.files }, f.runtime)).rejects.toThrow("JOB_NOT_FRESH"); expect(await readFile(join(f.directory, name), "utf8")).toBe("retained user content");
  });
  it("refuses a junction job directory and leaves its target untouched", async () => {
    const f = await fixture(), target = join(folder, "target"); await mkdir(target); await mkdir(join(f.directory, ".."), { recursive: true }); await writeFile(join(target, "keep"), "keep");
    await symlink(target, f.directory, process.platform === "win32" ? "junction" : "dir");
    try { await expect(dispatchEngineTaskV1({ ...f.payload, job: f.files }, f.runtime)).rejects.toThrow("JOB_LINK"); expect(await readFile(join(target, "keep"), "utf8")).toBe("keep"); }
    finally { await unlink(f.directory); }
  });
  it("honors a pre-existing cancel request before producer/progress creation", async () => {
    const f = await fixture(); await mkdir(f.directory, { recursive: true }); await writeFile(f.files.cancelPath, "cancel\n");
    await expect(dispatchEngineTaskV1({ ...f.payload, job: f.files }, f.runtime)).rejects.toThrow("ENGINE_TASK_CANCELLED");
    expect(prepareAutoReframeSparseSourceV2).not.toHaveBeenCalled(); expect(await readdir(f.directory)).toEqual(["cancel.request"]);
  });
  it("preserves parent cancellation reason before starting and during a package frame", async () => {
    const f = await fixture(), controller = new AbortController(), reason = Error("parent-cancel"); controller.abort(reason);
    await expect(dispatchEngineTaskV1(f.payload, f.runtime, { signal: controller.signal })).rejects.toBe(reason); expect(prepareAutoReframeSparseSourceV2).not.toHaveBeenCalled();
    const during = new AbortController(); await expect(dispatchEngineTaskV1(f.payload, f.runtime, { signal: during.signal, onProgress: p => { if (p.progress.stage === "source") during.abort(reason); } })).rejects.toBe(reason);
  });
  it("checks a late cancel file again before returning an otherwise complete reply", async () => {
    const f = await fixture(); await mkdir(f.directory, { recursive: true });
    await expect(dispatchEngineTaskV1({ ...f.payload, job: f.files }, f.runtime, { onProgress: p => { if (p.progress.stage === "finalize") writeFileSync(f.files.cancelPath, "cancel\n"); } })).rejects.toThrow("ENGINE_TASK_CANCELLED");
  });
  it("refuses a caller project changed during analysis rather than returning its draft as current", async () => {
    const f = await fixture(); await expect(dispatchEngineTaskV1(f.payload, f.runtime, { onProgress: p => { if (p.progress.stage === "source") f.payload.project.name = "changed"; } })).rejects.toThrow("REQUEST_CHANGED");
  });
  it("snapshots host runtime before observers can redirect later source work", async () => {
    const f = await fixture(), expected = join(folder, "source.mkv");
    await dispatchEngineTaskV1(f.payload, f.runtime, { onProgress: () => { f.runtime.assetBase = join(folder, "changed-base"); } });
    expect(vi.mocked(prepareAutoReframeSparseSourceV2).mock.calls[0][2].sourcePath).toBe(expected);
  });
});
