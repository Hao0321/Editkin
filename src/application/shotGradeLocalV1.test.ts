import { beforeEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { createDemoProject } from "../domain/demo";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { createProjectSession } from "./projectSession";
import { prepareShotGradeLocalV1, applyPreparedShotGradeLocalV1, discardShotGradeLocalV1 } from "./shotGradeLocalV1";
import type { ShotGradeLocalEvaluationContextV1 } from "./shotGradeLocalEvaluationV1";

const io = vi.hoisted(() => ({ code: vi.fn(), evaluate: vi.fn(), verify: vi.fn(), runtime: vi.fn() }));
vi.mock("./shotGradeCodeIdentityV1", () => ({ shotGradeCodeIdentityV1: io.code }));
vi.mock("./shotGradeLocalEvaluationV1", () => ({ evaluateShotGradeLocalV1: io.evaluate, verifyShotGradeLocalOriginalsV1: io.verify }));
vi.mock("./materialColorSamplingRuntime", async original => ({ ...await original<typeof import("./materialColorSamplingRuntime")>(), getMaterialColorRuntimeIdentity: io.runtime }));
const required = [
  "src/application/mediaDerivativeHistory.ts", "src/application/projectSession.ts",
  "src/application/shotGradeLocalContractV1.ts", "src/application/shotGradeLocalEvaluationV1.ts", "src/application/shotGradeLocalV1.ts",
  "src/domain/clipGradeSnapshotV1.ts", "src/domain/clipGradeSnapshotV1Schema.ts", "src/domain/clipTimeRemapCommandsV1.ts", "src/domain/clipTimeRemapV1.ts",
  "src/domain/history.ts", "src/domain/mesh3dOverlayValidationV1.ts", "src/domain/timeRemapClockV1.ts", "src/domain/timeRemapFrameCountV1.ts",
  "src/domain/trackedTextBindingV1.ts", "src/domain/vectorTrackingV1.ts", "src/motion/mesh3dOverlayV1.ts",
];
const identity = () => ({ identitySha256: "c".repeat(64), implementations: required.map(name => ({ name, sha256: "d".repeat(64) })) });
const runtimeIdentity = () => ({ status: "verified", identitySha256: "e".repeat(64) });
function evaluation() {
  return { state: "ready", reason: "actual-gates-test-double", grade: { schema: "editkin.color-grade/v2", nodes: [{ id: "local", label: "對色", offset: { r: .03 } }] },
    sources: [{ clipId: "clip-demo", assetId: "asset-demo", sha256: "a".repeat(64), uri: "owned.mp4", path: resolve("owned.mp4"), version: { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n } }],
    runtimeIdentity: runtimeIdentity(), numericalEvaluation: { scope: "UNIT_OWNERSHIP_DOUBLE_NOT_REAL_PIXEL_PROOF" },
    measurements: { before: null, after: null, safety: null, match: null, neutrality: null }, surfaces: {} };
}
function fixture() {
  const session = createProjectSession(createDemoProject(), "owned.editkin.json"), host = { assetBase: resolve("."), cacheRoot: resolve("owned-cache"), ffmpegPath: resolve("ffmpeg.exe"), ffprobePath: resolve("ffprobe.exe") };
  let selected = true; const runtime = { isCurrent: () => selected }, payload = { schema: "editkin.shot-grade-local-request/v1", expectedRevision: 0, mode: "auto_balance",
    target: { clipId: "clip-demo", samples: [{ id: "p", time: .2 }], regions: [] }, destination: { kind: "append", label: "對色" }, roiBasis: "local-layer-raster-normalized", reason: "Ownership test", maximumTimeMs: 10000 };
  const prepare = () => prepareShotGradeLocalV1(session, payload, host, runtime);
  return { session, host, runtime, payload, prepare, deselect: () => { selected = false; } };
}
const gradeWrites = (f: ReturnType<typeof fixture>) => f.session.getSnapshot().history.journal.filter(r => r.command.type === "set_clip_grade_v2").length;
beforeEach(() => {
  vi.clearAllMocks(); io.code.mockImplementation(identity); io.runtime.mockImplementation(async () => runtimeIdentity()); io.verify.mockResolvedValue(undefined);
  io.evaluate.mockImplementation(async (ctx: ShotGradeLocalEvaluationContextV1) => { ctx.check(); return evaluation(); });
});
it("prepares without editing, then applies one real ordinary grade command with Undo/Redo", async () => {
  const f = fixture(), before = structuredClone(f.session.getSnapshot().history.present), packet = await f.prepare(); expect(gradeWrites(f)).toBe(0);
  expect(packet.directApplyAllowed).toBe(false); expect(packet.vaContractAdmission).toBe(false);
  expect(await applyPreparedShotGradeLocalV1(f.session, packet)).toMatchObject({ status: "applied", undoSteps: 1 }); expect(gradeWrites(f)).toBe(1);
  const after = structuredClone(f.session.getSnapshot().history.present); f.session.setHistory(undo(f.session.getSnapshot().history)); expect(f.session.getSnapshot().history.present).toEqual(before);
  f.session.setHistory(redo(f.session.getSnapshot().history)); expect(f.session.getSnapshot().history.present).toEqual(after);
});
it("refuses current canonical coverage missing any local runtime before analysis", async () => {
  const f = fixture(); io.code.mockReturnValue({ ...identity(), implementations: [] }); await expect(f.prepare()).rejects.toThrow(/RUNTIME_CLOSURE_REQUIRED/); expect(io.evaluate).not.toHaveBeenCalled(); expect(gradeWrites(f)).toBe(0);
});
it.each(required)("refuses missing transitive canonical coverage for %s", async missing => {
  const f = fixture(), value = identity(); value.implementations = value.implementations.filter(row => row.name !== missing); io.code.mockReturnValue(value);
  await expect(f.prepare()).rejects.toThrow(/RUNTIME_CLOSURE_REQUIRED/); expect(io.evaluate).not.toHaveBeenCalled(); expect(gradeWrites(f)).toBe(0);
});
it("refuses a locked target before analysis", async () => {
  const f = fixture(); f.session.getSnapshot().history.present.tracks[0].locked = true; await expect(f.prepare()).rejects.toThrow(/TARGET_LOCKED/); expect(io.evaluate).not.toHaveBeenCalled();
});
it.each(["serialized", "changed-command", "changed-measurement", "foreign-session"])("refuses %s preparation authority", async mode => {
  const f = fixture(), packet = await f.prepare();
  if (mode === "serialized") await expect(applyPreparedShotGradeLocalV1(f.session, JSON.parse(JSON.stringify(packet)))).rejects.toThrow(/INVALID_OR_USED/);
  if (mode === "changed-command") { packet.command!.clipId = "other"; await expect(applyPreparedShotGradeLocalV1(f.session, packet)).rejects.toThrow(/INVALID_OR_USED/); }
  if (mode === "changed-measurement") { packet.reason = "forged"; await expect(applyPreparedShotGradeLocalV1(f.session, packet)).rejects.toThrow(/INVALID_OR_USED/); }
  if (mode === "foreign-session") await expect(applyPreparedShotGradeLocalV1(createProjectSession(createDemoProject()), packet)).rejects.toThrow(/INVALID_OR_USED/);
  expect(gradeWrites(f)).toBe(0);
});
it("consumes before awaiting revalidation so concurrent double applies cannot duplicate Undo", async () => {
  const f = fixture(), packet = await f.prepare(); let release!: () => void; io.verify.mockImplementation(() => new Promise<void>(done => { release = done; }));
  const first = applyPreparedShotGradeLocalV1(f.session, packet); await expect(applyPreparedShotGradeLocalV1(f.session, packet)).rejects.toThrow(/INVALID_OR_USED/); release(); await first; expect(gradeWrites(f)).toBe(1);
});
it("discarded proposals cannot be applied", async () => {
  const f = fixture(), packet = await f.prepare(); expect(discardShotGradeLocalV1(packet)).toBe(true); expect(discardShotGradeLocalV1(packet)).toBe(false);
  await expect(applyPreparedShotGradeLocalV1(f.session, packet)).rejects.toThrow(/INVALID_OR_USED/); expect(gradeWrites(f)).toBe(0);
});
it.each(["selection", "same-id-project", "content", "in-place-grade", "host-path", "save-as"])("rejects %s changing while preparation awaits", async mode => {
  const f = fixture(); let release!: () => void; io.evaluate.mockImplementation(async (ctx: ShotGradeLocalEvaluationContextV1) => { await new Promise<void>(done => { release = done; }); ctx.check(); return evaluation(); });
  const work = f.prepare();
  if (mode === "selection") f.deselect();
  if (mode === "same-id-project") f.session.replaceProject(structuredClone(f.session.getSnapshot().history.present), "owned.editkin.json");
  if (mode === "content") f.session.setHistory(dispatchCommandSafely(f.session.getSnapshot().history, { type: "rename_project", name: "external" }).state);
  if (mode === "in-place-grade") f.session.getSnapshot().history.present.tracks[0].clips[0].color.exposure = .2;
  if (mode === "host-path") f.host.cacheRoot = resolve("another-cache");
  if (mode === "save-as") { const save = f.session.beginSave(true)!; f.session.completeSave(save, { path: "different.editkin.json", project: { ...save.project, revision: save.project.revision + 1 } }); }
  release(); await expect(work).rejects.toThrow(/CONTEXT_CHANGED/); expect(gradeWrites(f)).toBe(0);
});
it.each(["selection", "content", "code", "source", "tool", "apply-guard"])("revalidates %s before applying", async mode => {
  const f = fixture(), packet = await f.prepare();
  if (mode === "selection") f.deselect();
  if (mode === "content") f.session.setHistory(dispatchCommandSafely(f.session.getSnapshot().history, { type: "rename_project", name: "external" }).state);
  if (mode === "code") io.code.mockReturnValue({ ...identity(), identitySha256: "f".repeat(64) });
  if (mode === "source") io.verify.mockRejectedValue(Error("original changed"));
  if (mode === "tool") io.runtime.mockResolvedValue({ ...runtimeIdentity(), identitySha256: "f".repeat(64) });
  await expect(applyPreparedShotGradeLocalV1(f.session, packet, mode === "apply-guard" ? { isCurrent: () => false } : undefined)).rejects.toThrow();
  expect(gradeWrites(f)).toBe(0); await expect(applyPreparedShotGradeLocalV1(f.session, packet)).rejects.toThrow(/INVALID_OR_USED/);
});
it("does not apply after project replacement during source revalidation", async () => {
  const f = fixture(), packet = await f.prepare(); let release!: () => void; io.verify.mockImplementation(() => new Promise<void>(done => { release = done; }));
  const work = applyPreparedShotGradeLocalV1(f.session, packet); f.session.replaceProject(structuredClone(f.session.getSnapshot().history.present)); release(); await expect(work).rejects.toThrow(/CONTEXT_CHANGED/); expect(gradeWrites(f)).toBe(0);
});
it("keeps preparation cancellation active while the proposal is being reviewed", async () => {
  const f = fixture(), controller = new AbortController(); const packet = await prepareShotGradeLocalV1(f.session, f.payload, f.host, { ...f.runtime, signal: controller.signal }); controller.abort();
  await expect(applyPreparedShotGradeLocalV1(f.session, packet)).rejects.toThrow(); expect(gradeWrites(f)).toBe(0);
});
it("unchanged has zero Undo and not-applicable has no apply authority", async () => {
  for (const state of ["unchanged", "not_applicable"]) {
    const f = fixture(); io.evaluate.mockResolvedValue({ ...evaluation(), state, grade: null }); const packet = await f.prepare();
    if (state === "unchanged") expect(await applyPreparedShotGradeLocalV1(f.session, packet)).toMatchObject({ status: "unchanged", undoSteps: 0 });
    else await expect(applyPreparedShotGradeLocalV1(f.session, packet)).rejects.toThrow(/NOT_APPLICABLE/);
    expect(gradeWrites(f)).toBe(0); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  }
});
it("does not retry a commit whose listener threw after the real one-Undo write", async () => {
  const f = fixture(), packet = await f.prepare(), remove = f.session.subscribe(() => { throw Error("listener failure after commit"); });
  await expect(applyPreparedShotGradeLocalV1(f.session, packet)).rejects.toThrow(/APPLY_RESULT_UNCERTAIN/); remove(); expect(gradeWrites(f)).toBe(1);
  await expect(applyPreparedShotGradeLocalV1(f.session, packet)).rejects.toThrow(/INVALID_OR_USED/); expect(gradeWrites(f)).toBe(1);
});
