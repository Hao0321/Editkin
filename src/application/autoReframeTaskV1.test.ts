import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./autoReframeSparseSourceV2", () => ({ prepareAutoReframeSparseSourceV2: vi.fn() }));
vi.mock("./autoReframeReviewedSourceV1", () => ({ prepareAutoReframeReviewedSourceV1: vi.fn() }));
import { prepareAutoReframeSparseSourceV2 } from "./autoReframeSparseSourceV2";
import { prepareAutoReframeReviewedSourceV1 } from "./autoReframeReviewedSourceV1";
import { createAutoReframeSparseV2 } from "./autoReframeSparseV2";
import { analyzeAutoReframeTaskV1 } from "./autoReframeTaskV1";
import { autoReframeJobRequestV1, beginAutoReframeEditV1 } from "./autoReframeEditV1";
import { autoReframeWorkflowFixtureV1, instrumentOnlyWorkflowReplyV1, workflowIdentityV1 } from "./__fixtures__/autoReframeWorkflowV1.fixture";
import { confirmRotoSubjectV1 } from "./rotoMatteTrustV1";
import { withRenderLifetime } from "../render/renderLifetime";
import type { ReviewedReframeMatteOptionsV1 } from "./autoReframeReviewedMatteV1";

beforeEach(() => vi.resetAllMocks());
async function fixture(reviewed = false, newProject = false) {
  const p = autoReframeWorkflowFixtureV1(!newProject);
  const identity = { schema: "editkin.roto-matte-identity/v1", sourceSha256: "a".repeat(64), cutoutSha256: "b".repeat(64), alphaSha256: "c".repeat(64),
    analysisSha256: "d".repeat(64), nativeCoreSha256: "e".repeat(64), sourceStart: .5, width: 64, height: 40, frameCount: 5, fps: 4, qualityState: "diagnostic" };
  const trust = confirmRotoSubjectV1(identity, { subjectCorrect: true, reviewerId: "f".repeat(64), reviewedAt: new Date().toISOString() });
  const confirmationSha256 = createHash("sha256").update(JSON.stringify(trust)).digest("hex");
  const matte = { artifacts: { trust, cutout: { matteIdentity: trust.identity } }, minimumAlpha: .1, referenceFrame: 0 } as ReviewedReframeMatteOptionsV1;
  const job = await beginAutoReframeEditV1(p, "selected", { operationId: "task-unit", mode: newProject ? "new_portrait_project" : "current_portrait",
    outputWidth: 90, outputHeight: 160, subject: reviewed ? { kind: "confirmed-matte-v2", confirmationSha256 } : { kind: "saliency" }, ...(newProject ? { newProject: workflowIdentityV1() } : {}) });
  const request = autoReframeJobRequestV1(p, job), runtime = { assetBase: resolve(".rd"), cacheRoot: resolve(".rd/instrument-only-cache"), ffmpegPath: "not-run", ffprobePath: "not-run", timeoutMs: 5000 };
  vi.mocked(prepareAutoReframeSparseSourceV2).mockImplementation(async (target, input, rt) => {
    const sink = createAutoReframeSparseV2(target, input); sink.initialize(64, 40);
    for (let frame = 0; frame < 5; frame++) { sink.consume({ frame, time: frame / 4, pixelSha256: "c".repeat(64), sceneCut: frame === 0 }); await rt.onFrame?.(frame); }
    return instrumentOnlyWorkflowReplyV1(request, sink.finish()).prepared;
  });
  vi.mocked(prepareAutoReframeReviewedSourceV1).mockImplementation(async (target, input, _matte, rt) => {
    rt.onMatteProgress?.({ stage: "measure", completed: 5, total: 5 }); const prepared = await prepareAutoReframeSparseSourceV2(target, input, rt);
    prepared.analysis.matte = { subjectConfirmationSha256: confirmationSha256, sourceBinding: "explicit_confirmed_v2_matte", saliencyFallbackOnLoss: false } as never; return prepared;
  });
  return { p, request, runtime, matte, confirmationSha256 };
}
describe("Node task adapter for the existing future engine-task owner", () => {
  it.each([false, true])("resolves the original path, preserves the graph, and returns a draft (new document %s)", async newProject => {
    const f = await fixture(false, newProject), before = JSON.stringify(f.p), progress: unknown[] = [];
    const r = await analyzeAutoReframeTaskV1(f.p, f.request, { ...f.runtime, onProgress: p => progress.push(p) });
    expect(JSON.stringify(f.p)).toBe(before); expect(r.request).toEqual(f.request); expect(r.prepared.mutationPerformed).toBe(false);
    const [target, , runtime] = vi.mocked(prepareAutoReframeSparseSourceV2).mock.calls[0];
    expect(runtime.sourcePath).toBe(resolve(f.runtime.assetBase, "source.mkv")); expect(runtime.sourcePath).not.toContain("never-the-original");
    expect(target.id).toBe(newProject ? "separate-portrait" : f.p.id); expect(progress[0]).toEqual({ stage: "verify", completed: 0, total: 1 });
    expect(progress).toContainEqual({ stage: "source", completed: 5, total: 5 }); expect(progress.at(-1)).toEqual({ stage: "finalize", completed: 1, total: 1 });
    expect(progress.length).toBeLessThanOrEqual(5); expect(prepareAutoReframeReviewedSourceV1).not.toHaveBeenCalled();
  });
  it("uses only the explicitly confirmed matte route and passes one lifetime to the resolver", async () => {
    const f = await fixture(true), resolver = vi.fn(async (_sha, source) => { expect(source.signal.aborted).toBe(false); return f.matte; });
    const r = await analyzeAutoReframeTaskV1(f.p, f.request, { ...f.runtime, resolveReviewedMatte: resolver });
    expect(resolver).toHaveBeenCalledOnce(); expect(resolver.mock.calls[0][0]).toBe(f.confirmationSha256); expect(prepareAutoReframeReviewedSourceV1).toHaveBeenCalledOnce();
    expect(r.prepared.analysis.matte).toMatchObject({ subjectConfirmationSha256: f.confirmationSha256, saliencyFallbackOnLoss: false });
  });
  it.each(["resolver missing", "confirmation changed", "confirmation invalid"])("refuses %s before starting any decoder", async reason => {
    const f = await fixture(true); if (reason === "confirmation changed") f.matte.artifacts.trust.reviewerId = "0".repeat(64);
    if (reason === "confirmation invalid") f.matte.artifacts.trust.subjectCorrect = false as never;
    await expect(analyzeAutoReframeTaskV1(f.p, f.request, { ...f.runtime, ...(reason === "resolver missing" ? {} : { resolveReviewedMatte: async () => f.matte }) })).rejects.toThrow();
    expect(prepareAutoReframeReviewedSourceV1).not.toHaveBeenCalled(); expect(prepareAutoReframeSparseSourceV2).not.toHaveBeenCalled();
  });
  it.each(["project", "target", "source", "client-path", "relative-base"])("refuses %s request drift before producers", async reason => {
    const f = await fixture(); if (reason === "project") f.p.revision++; if (reason === "target") f.request.targetProjectSha256 = "0".repeat(64);
    if (reason === "source") f.request.expectedSourceSha256 = "0".repeat(64);
    if (reason === "client-path") Object.assign(f.request, { sourcePath: "proxy.mp4" }); if (reason === "relative-base") f.runtime.assetBase = "relative";
    await expect(analyzeAutoReframeTaskV1(f.p, f.request, f.runtime)).rejects.toThrow(); expect(prepareAutoReframeSparseSourceV2).not.toHaveBeenCalled();
  });
  it("cancels a pending resolver promptly, preserves parent reason and ignores its late success", async () => {
    const f = await fixture(true), c = new AbortController(), reason = Error("parent-cancel-pending-resolver");
    let started!: () => void, resolveMatte!: (m: ReviewedReframeMatteOptionsV1) => void; const entered = new Promise<void>(r => { started = r; });
    const pending = withRenderLifetime({ signal: c.signal, timeoutMs: 5000 }, () => analyzeAutoReframeTaskV1(f.p, f.request, { ...f.runtime,
      resolveReviewedMatte: () => { started(); return new Promise(r => { resolveMatte = r; }); } }));
    await entered; c.abort(reason); await expect(pending).rejects.toBe(reason); resolveMatte(f.matte); await Promise.resolve();
    expect(prepareAutoReframeReviewedSourceV1).not.toHaveBeenCalled();
  });
  it("counts subject-resolution time against the same total deadline", async () => {
    const f = await fixture(true);
    await expect(analyzeAutoReframeTaskV1(f.p, f.request, { ...f.runtime, timeoutMs: 20, resolveReviewedMatte: () => new Promise(() => {}) })).rejects.toThrow("逾時");
    expect(prepareAutoReframeReviewedSourceV1).not.toHaveBeenCalled();
  });
  it("refuses a source edit made while resolving the confirmed subject", async () => {
    const f = await fixture(true);
    await expect(analyzeAutoReframeTaskV1(f.p, f.request, { ...f.runtime, resolveReviewedMatte: async () => { f.p.captions[0].text = "changed"; return f.matte; } })).rejects.toThrow("STALE");
    expect(prepareAutoReframeReviewedSourceV1).not.toHaveBeenCalled();
  });
  it("does not publish after progress mutates the original graph or cancels its parent", async () => {
    const f = await fixture(); await expect(analyzeAutoReframeTaskV1(f.p, f.request, { ...f.runtime, onProgress: p => { if (p.stage === "source") f.p.revision++; } })).rejects.toThrow("STALE");
    const g = await fixture(), c = new AbortController(), reason = Error("stop-after-source");
    await expect(analyzeAutoReframeTaskV1(g.p, g.request, { ...g.runtime, signal: c.signal, onProgress: p => { if (p.stage === "source") c.abort(reason); } })).rejects.toBe(reason);
  });
});
