import { afterEach, expect, it, vi } from "vitest";
import { LongformUiFocusJobsV1 } from "./longformUiFocusJobsV1";
import { summarizeLongformUiFocusArtifactV1 } from "./longformUiFocusArtifactV1";
import { LongformUiFocusConfirmationsV1, LongformUiFocusHoldJobsV1, type LongformUiFocusHoldResultV1 } from "./longformUiFocusHoldJobsV1";
import { uiFocusHoldJobFixtureV1 } from "./longformUiFocusHoldJobsV1.fixture";
const owners: Array<{ close(): Promise<void> }> = []; afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); });
const turn = () => new Promise<void>(done => setImmediate(done));
async function fixture() {
  const f = await uiFocusHoldJobFixtureV1(), source = new LongformUiFocusJobsV1({ prepare: async () => summarizeLongformUiFocusArtifactV1(f.artifact) });
  source.start(f.artifact.request); await turn();
  const confirmations = new LongformUiFocusConfirmationsV1(), read = vi.fn(async () => f.artifact), prepare = vi.fn(async () => structuredClone(f.result)), validateCurrent = vi.fn(async () => {});
  const holder = new LongformUiFocusHoldJobsV1({ assertOwned: id => source.assertArtifactOwned(id), assertViewed: (id, ids) => source.assertFramesReturned(id, ids), confirmations, read, prepare, validateCurrent });
  owners.push(source, holder);
  const view = () => source.markFramesReturned(f.artifact.artifactId, [f.candidate.frameId]);
  const confirm = () => confirmations.rememberVerified(f.artifact.artifactId, [f.candidate.candidateId]);
  return { ...f, source, confirmations, holder, read, prepare, validateCurrent, view, confirm };
}
it("requires this owner's produced artifact and successful confirmation before any filesystem ingress", async () => {
  const f = await fixture(); f.view();
  expect(() => f.holder.start(f.request)).toThrow("CONFIRM_TARGET_FIRST"); f.confirm();
  expect(() => f.holder.start({ ...f.request, artifactId: "e".repeat(64) })).toThrow("THIS_OWNER");
  expect(() => f.holder.start({ ...f.request, bounds: f.candidate.bounds })).toThrow();
  expect(f.read).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
});
it("also requires the actual candidate source image to have been returned", async () => {
  const f = await fixture(); f.confirm(); const job = f.holder.start(f.request); await turn();
  expect(await f.holder.get(job.jobId)).toMatchObject({ state: "FAILED", error: "UI_FOCUS_VIEW_SOURCE_FRAMES_FIRST" }); expect(f.prepare).not.toHaveBeenCalled();
});
it("returns immutable compact tickets and bounded exact source-clock pages, keeping hint/art acceptance pending", async () => {
  const f = await fixture(); f.view(); f.confirm(); const job = f.holder.start(f.request);
  expect(job.state).toBe("RUNNING"); await turn();
  const value = await f.holder.get(job.jobId); expect(value).toMatchObject({ state: "COMPLETED", result: { sourceFrameCount: 24, focusHintsReady: false } });
  value.result!.flags.push("external mutation"); const page = await f.holder.read(job.jobId, 7, 2);
  expect(page.items.map(row => row.pts)).toEqual([13, 14]); expect(page.nextOffset).toBe(9);
  expect(page.items[0].localObservation).toEqual(f.result.localObservations[7]); expect(page.result!.flags).toEqual([]);
  expect(page.sourceTimeBase).toEqual({ numerator: 1, denominator: 30 }); expect(page.rawSha256).toBe(f.result.rawSha256);
  page.items[0].targetQuad[0].x = 999; expect((await f.holder.read(job.jobId, 7, 1)).items[0].targetQuad[0].x).not.toBe(999);
  await expect(f.holder.read(job.jobId, 0, 65)).rejects.toThrow("PAGE_BUDGET");
});
it("rechecks ownership after read and refuses changed source/project/provider at publication and later reads", async () => {
  const f = await fixture(); f.view(); f.confirm();
  f.read.mockImplementationOnce(async () => { await f.source.close(); return f.artifact; });
  const first = f.holder.start(f.request); await turn(); expect((await f.holder.get(first.jobId)).state).toBe("FAILED"); expect(f.prepare).not.toHaveBeenCalled();
  const other = await fixture(); other.view(); other.confirm();
  const job = other.holder.start(other.request); await turn(); other.validateCurrent.mockRejectedValue(Error("UI_FOCUS_SOURCE_CHANGED"));
  await expect(other.holder.get(job.jobId)).rejects.toThrow("SOURCE_CHANGED"); await expect(other.holder.read(job.jobId, 0, 1)).rejects.toThrow("SOURCE_CHANGED");
  const third = await fixture(); third.view(); third.confirm(); third.validateCurrent.mockRejectedValue(Error("UI_FOCUS_PROJECT_CHANGED"));
  const pending = third.holder.start(third.request); await turn(); expect(await third.holder.get(pending.jobId)).toMatchObject({ state: "FAILED", error: "UI_FOCUS_PROJECT_CHANGED" });
});
it("does not publish a malformed internally prepared receipt", async () => {
  const f = await fixture(); f.view(); f.confirm(); f.prepare.mockImplementationOnce(async () => ({ ...f.result, sourceEnd: 999 }));
  const job = f.holder.start(f.request); await turn(); expect(await f.holder.get(job.jobId)).toMatchObject({ state: "FAILED", error: "UI_FOCUS_HOLD_JOB_RESULT" });
});
it("keeps cancellation and admission pending until the underlying owned analyzer promise settles (protocol mock)", async () => {
  const f = await fixture(); f.view(); f.confirm(); const entered = Promise.withResolvers<void>(), done = Promise.withResolvers<LongformUiFocusHoldResultV1>();
  f.prepare.mockImplementationOnce(async () => { entered.resolve(); return done.promise; });
  const job = f.holder.start(f.request); await entered.promise;
  try {
    expect(f.holder.cancel(job.jobId).state).toBe("CANCELLING"); expect((await f.holder.get(job.jobId)).state).toBe("CANCELLING");
    expect(() => f.holder.start(f.request)).toThrow("ALREADY_RUNNING"); await expect(f.holder.read(job.jobId, 0, 1)).rejects.toThrow("NOT_COMPLETED");
  } finally { done.reject(Error("analysis-cancelled")); }
  await turn(); expect((await f.holder.get(job.jobId)).state).toBe("CANCELLED");
});
it("close waits for the current analyzer and revokes confirmations/history after settlement (protocol mock)", async () => {
  const f = await fixture(); f.view(); f.confirm(); const entered = Promise.withResolvers<void>(), done = Promise.withResolvers<LongformUiFocusHoldResultV1>();
  f.prepare.mockImplementationOnce(async () => { entered.resolve(); return done.promise; }); f.holder.start(f.request); await entered.promise;
  let closed = false; const close = f.holder.close().then(() => { closed = true; });
  try { await turn(); expect(closed).toBe(false); expect(() => f.holder.start(f.request)).toThrow("JOBS_CLOSED"); }
  finally { done.reject(Error("analysis-cancelled")); }
  await close; expect(() => f.confirmations.assertConfirmed(f.request.artifactId, f.request.candidateId)).toThrow("CONFIRM_TARGET_FIRST");
});
it("bounds completed job history to32 and remembered confirmations to64 per artifact", async () => {
  const f = await fixture(); f.view(); f.confirm(); let first = "";
  for (let i = 0; i < 33; i++) { const job = f.holder.start(f.request); first ||= job.jobId; await turn(); expect((await f.holder.get(job.jobId)).state).toBe("COMPLETED"); }
  await expect(f.holder.get(first)).rejects.toThrow("NOT_FOUND");
  const ids = Array.from({ length: 65 }, (_, index) => "uif-" + index.toString(16).padStart(64, "0"));
  f.confirmations.rememberVerified(f.request.artifactId, ids);
  expect(() => f.confirmations.assertConfirmed(f.request.artifactId, ids[0])).toThrow("CONFIRM_TARGET_FIRST");
  expect(() => f.confirmations.assertConfirmed(f.request.artifactId, ids[64])).not.toThrow();
});
