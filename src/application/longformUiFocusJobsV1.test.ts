import { expect, it, vi } from "vitest";
import { LongformUiFocusJobsV1 } from "./longformUiFocusJobsV1";
import type { LongformUiFocusJobResultV1 } from "../domain/longformUiFocusFileV1";

const request = { projectPath: "owned.editkin.json", expectedRevision: 0, clipId: "screen", language: "zh-Hant-TW", frameTimes: [.1], targetTexts: [] };
const result: LongformUiFocusJobResultV1 = { artifactId: "a".repeat(64), draftId: "b".repeat(64), state: "REVIEW_REQUIRED",
  frameCount: 1, candidateCount: 3, omittedFrameCount: 0, projectRevision: 0, projectModified: false, focusHintsReady: false };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
it("returns immediately, owns only completed producer artifacts and isolates snapshots from caller edits", async () => {
  const done = Promise.withResolvers<LongformUiFocusJobResultV1>(), jobs = new LongformUiFocusJobsV1({
    prepare: async (_request, _signal, progress) => { progress({ completedFrames: 1, totalFrames: 1 }); return done.promise; },
  });
  const started = jobs.start(request); expect(started.state).toBe("RUNNING"); await turn();
  expect(() => jobs.assertArtifactOwned(result.artifactId)).toThrow("THIS_OWNER");
  started.progress.completedFrames = 99; expect(jobs.get(started.jobId).progress.completedFrames).toBe(1);
  done.resolve(result); await turn(); const complete = jobs.get(started.jobId);
  expect(complete.state).toBe("COMPLETED"); jobs.assertArtifactOwned(result.artifactId);
  complete.result!.artifactId = "c".repeat(64); expect(jobs.get(started.jobId).result!.artifactId).toBe(result.artifactId);
  expect(() => jobs.assertFramesReturned(result.artifactId, ["focus-frame-1"])).toThrow("VIEW_SOURCE");
  jobs.markFramesReturned(result.artifactId, ["focus-frame-1"]); jobs.assertFramesReturned(result.artifactId, ["focus-frame-1"]);
  await jobs.close(); expect(() => jobs.assertArtifactOwned(result.artifactId)).toThrow("THIS_OWNER");
});
it("holds admission in CANCELLING until the producer settles; cancelled late success never gains ownership", async () => {
  const done = Promise.withResolvers<LongformUiFocusJobResultV1>(), entered = Promise.withResolvers<AbortSignal>();
  const jobs = new LongformUiFocusJobsV1({ prepare: async (_request, signal) => { entered.resolve(signal); return done.promise; } });
  const started = jobs.start(request), signal = await entered.promise;
  expect(jobs.cancel(started.jobId).state).toBe("CANCELLING"); expect(signal.aborted).toBe(true);
  expect(() => jobs.start(request)).toThrow("ALREADY_RUNNING"); expect(jobs.get(started.jobId).finishedAt).toBeUndefined();
  done.resolve(result); await turn(); expect(jobs.get(started.jobId)).toMatchObject({ state: "CANCELLED" });
  expect(jobs.get(started.jobId).result).toBeUndefined(); expect(() => jobs.assertArtifactOwned(result.artifactId)).toThrow("THIS_OWNER");
  await jobs.close();
});
it("EOF close waits for actual producer settlement and permanently refuses new work", async () => {
  const entered = Promise.withResolvers<void>(), done = Promise.withResolvers<LongformUiFocusJobResultV1>();
  const jobs = new LongformUiFocusJobsV1({ prepare: async () => { entered.resolve(); return done.promise; } });
  const started = jobs.start(request); await entered.promise; let closed = false;
  const closing = jobs.close().then(() => { closed = true; }); await turn();
  expect(closed).toBe(false); expect(jobs.get(started.jobId).state).toBe("CANCELLING"); expect(() => jobs.start(request)).toThrow("CLOSED");
  done.reject(new Error("owned child closed")); await closing; expect(closed).toBe(true); expect(jobs.get(started.jobId).state).toBe("CANCELLED");
});
it("bounds failure text and rejects malformed producer counts/progress without artifact authority", async () => {
  const prepare = vi.fn(async () => { throw Error("failure D:\\owned\\private.mp4\n" + "x".repeat(5000)); });
  const jobs = new LongformUiFocusJobsV1({ prepare }); const job = jobs.start(request); await turn();
  expect(jobs.get(job.jobId).error).not.toContain("private.mp4"); expect(jobs.get(job.jobId).error!.length).toBeLessThanOrEqual(1000);
  await jobs.close();
  const malformed = new LongformUiFocusJobsV1({ prepare: async () => ({ ...result, frameCount: 13 }) });
  const bad = malformed.start(request); await turn(); expect(malformed.get(bad.jobId)).toMatchObject({ state: "FAILED", error: "UI_FOCUS_JOB_RESULT" });
  expect(() => malformed.assertArtifactOwned(result.artifactId)).toThrow("THIS_OWNER"); await malformed.close();
  const progress = new LongformUiFocusJobsV1({ prepare: async (_raw, _signal, update) => { update({ completedFrames: 2, totalFrames: 1 }); return result; } });
  const wrong = progress.start(request); await turn(); expect(progress.get(wrong.jobId)).toMatchObject({ state: "FAILED", error: "UI_FOCUS_JOB_PROGRESS" }); await progress.close();
});
it("bounds history and revokes expired provenance, while duplicate live references retain it", async () => {
  let count = 0; const jobs = new LongformUiFocusJobsV1({ prepare: async () => ({ ...result, artifactId: (++count).toString(16).padStart(64, "0") }) });
  const oldest = jobs.start(request); await turn();
  for (let i = 0; i < 32; i++) { jobs.start(request); await turn(); }
  expect(() => jobs.get(oldest.jobId)).toThrow("NOT_FOUND"); expect(() => jobs.assertArtifactOwned("1".padStart(64, "0"))).toThrow("THIS_OWNER"); await jobs.close();
  const duplicate = new LongformUiFocusJobsV1({ prepare: async () => result });
  for (let i = 0; i < 33; i++) { duplicate.start(request); await turn(); }
  duplicate.assertArtifactOwned(result.artifactId); await duplicate.close();
});
it("refuses caller coordinates and unknown job IDs before producer work", async () => {
  const prepare = vi.fn(async () => result), jobs = new LongformUiFocusJobsV1({ prepare });
  expect(() => jobs.start({ ...request, bounds: { x: .1 } })).toThrow(); expect(prepare).not.toHaveBeenCalled();
  expect(() => jobs.cancel("uf-unknown")).toThrow("NOT_FOUND"); await jobs.close();
});
