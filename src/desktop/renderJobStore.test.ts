import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelRenderJob, closeRenderJob, currentRenderJob, failRenderJob, observeRenderJobProgress, renderJobBusy, resetRenderJobForTest, runRenderJob, RENDER_JOB_POLL_MS, waitForRenderJobEnd } from "./renderJobStore";
import type { DesktopRenderResult, RenderJobReport } from "./apiTypes";
import { describeProblem } from "../application/plainProblems";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const progress = (stage: string, doneSeconds?: number, totalSeconds?: number) => ({
  schema: "editkin.render-progress/v1", stage, sequence: 1,
  ...(totalSeconds ? { totalSeconds } : {}), ...(doneSeconds !== undefined && totalSeconds ? { doneSeconds, fraction: doneSeconds / totalSeconds } : {}),
});

let clock = 0;
beforeEach(() => { vi.useFakeTimers(); clock = 10_000; resetRenderJobForTest(() => clock); });
afterEach(() => { resetRenderJobForTest(); vi.useRealTimers(); });

describe("the visible export job", () => {
  it("shows nothing while the save dialog is open and nothing when it is closed", async () => {
    const render = deferred<DesktopRenderResult>();
    const reports: RenderJobReport[] = [];
    const api = { renderJobProgress: vi.fn(async (jobId: string) => reports.shift() ?? { jobId, known: false }) };
    const running = runRenderJob({ api, kind: "video", start: () => render.promise });
    expect(currentRenderJob()?.phase).toBe("choosing");
    expect(renderJobBusy()).toBe(true);
    await vi.advanceTimersByTimeAsync(RENDER_JOB_POLL_MS * 2);
    expect(currentRenderJob()?.phase).toBe("choosing");
    render.resolve({ canceled: true });
    await running;
    expect(currentRenderJob()).toBeUndefined();
  });

  it("follows the host's progress, measures speed, and ends as done with the file to open", async () => {
    const render = deferred<DesktopRenderResult>();
    let report: RenderJobReport | undefined;
    const api = { renderJobProgress: vi.fn(async (jobId: string) => report ?? { jobId, known: false }) };
    const running = runRenderJob({ api, kind: "video", start: () => render.promise });
    const id = currentRenderJob()!.id;
    expect(id).toMatch(/^render-[0-9a-f]{16}$/);
    report = { jobId: id, known: true, outputPath: "D:\\Videos\\trip.mp4", progress: progress("audio") };
    await vi.advanceTimersByTimeAsync(RENDER_JOB_POLL_MS);
    expect(currentRenderJob()).toMatchObject({ phase: "running", outputPath: "D:\\Videos\\trip.mp4", runningSinceMs: 10_000 });
    expect(currentRenderJob()!.progress).toMatchObject({ stage: "audio" });
    expect(currentRenderJob()!.progress).not.toHaveProperty("fraction");
    for (const [at, done] of [[11_000, 6], [13_000, 12], [15_000, 18]] as const) {
      clock = at;
      report = { jobId: id, known: true, outputPath: "D:\\Videos\\trip.mp4", progress: progress("encode", done, 60) };
      await vi.advanceTimersByTimeAsync(RENDER_JOB_POLL_MS);
    }
    expect(currentRenderJob()!.progress?.fraction).toBeCloseTo(.3);
    expect(currentRenderJob()!.remainingMs).toBe(14_000);
    clock = 30_000;
    render.resolve({ canceled: false, outputPath: "D:\\Videos\\trip.mp4", outputUrl: "asset://trip.mp4" });
    await running;
    expect(currentRenderJob()).toMatchObject({ phase: "done", outputUrl: "asset://trip.mp4", finishedAtMs: 30_000, collapsed: false });
    expect(renderJobBusy()).toBe(false);
    closeRenderJob();
    expect(currentRenderJob()).toBeUndefined();
  });

  it("stops through the host and ends as canceled; a failure keeps its plain problem", async () => {
    const render = deferred<DesktopRenderResult>();
    const api = { renderJobProgress: vi.fn(async (jobId: string) => ({ jobId, known: true, progress: progress("encode", 1, 10) })), cancelRenderJob: vi.fn(async (jobId: string) => ({ jobId, known: true, cancelRequested: true })) };
    const running = runRenderJob({ api, kind: "video", start: () => render.promise });
    await vi.advanceTimersByTimeAsync(RENDER_JOB_POLL_MS);
    const id = currentRenderJob()!.id;
    closeRenderJob(); // a running job cannot be dismissed
    expect(currentRenderJob()?.phase).toBe("running");
    await cancelRenderJob(api);
    await cancelRenderJob(api);
    expect(api.cancelRenderJob).toHaveBeenCalledTimes(1);
    expect(api.cancelRenderJob).toHaveBeenCalledWith(id);
    expect(currentRenderJob()?.cancelRequested).toBe(true);
    const ended = waitForRenderJobEnd(5_000);
    render.resolve({ canceled: true, stoppedByUser: true });
    await running;
    await expect(ended).resolves.toBe(true);
    expect(currentRenderJob()?.phase).toBe("canceled");

    const second = deferred<DesktopRenderResult>();
    const failing = runRenderJob({ api, kind: "video", start: () => second.promise });
    const secondId = currentRenderJob()!.id;
    second.resolve({ canceled: false, outputPath: "x" });
    await failing;
    failRenderJob(secondId, describeProblem("export", "ENOSPC: no space left on device"), () => undefined);
    expect(currentRenderJob()).toMatchObject({ phase: "failed", problem: { cause: "diskFull" } });
    observeRenderJobProgress(secondId, { jobId: secondId, known: true }); // late reports never revive a finished job
    expect(currentRenderJob()?.phase).toBe("failed");
  });
});
