// W2-4: 「好了，存成影片」 runs as the desktop export job. While it runs the window-close guard is armed (the same store the
// editor's 輸出影片 uses), the saving screen can stop it, and closing the window stops it first. Real project session,
// export job store and close-guard hook; the desktop API is a double and React's hooks are reduced to plain calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as Array<() => unknown> }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = next; }];
  },
}));
import { createProjectSession } from "../../application/projectSession";
import { createUiDemoProject } from "../../domain/demo";
import type { DesktopRenderResult, HaoDesktopApi, RenderJobReport } from "../../desktop/apiTypes";
import { currentRenderJob, renderJobBusy, resetRenderJobForTest, RENDER_JOB_POLL_MS } from "../../desktop/renderJobStore";
import { useWindowCloseGuard } from "../../desktop/useWindowCloseGuard";
import { createEasyFlowStore, type EasyBrief } from "./easyFlowModel";
import { createEditorShellEasyHost, type EasyShellProps } from "./useEasyFlowHost";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const brief: EasyBrief = { format: "horizontal", genre: "auto", title: "", description: "", styleVariant: 0,
  video: { id: "IMG_3310", name: "IMG_3310.MOV", orientation: "landscape", durationSeconds: 20 } };
const progress = (stage: string, doneSeconds?: number, totalSeconds?: number) => ({ schema: "editkin.render-progress/v1", stage, sequence: 1,
  ...(totalSeconds ? { totalSeconds, doneSeconds, fraction: (doneSeconds ?? 0) / totalSeconds } : {}) });

function desktop() {
  const render = deferred<DesktopRenderResult>();
  let report: RenderJobReport | undefined;
  const api = {
    renderProject: vi.fn((_project: unknown, _options?: { jobId?: string }) => render.promise),
    renderJobProgress: vi.fn(async (jobId: string) => report ?? { jobId, known: false }),
    cancelRenderJob: vi.fn(async (jobId: string) => ({ jobId, known: true, cancelRequested: true })),
    setCloseGuard: vi.fn(async (_armed: boolean) => undefined), acknowledgeCloseRequest: vi.fn(async () => undefined),
    closeWindowConfirmed: vi.fn(async () => undefined), clearRecovery: vi.fn(async () => undefined), keepRecoveryAside: vi.fn(async () => ({ kept: true })),
    onCloseRequested: vi.fn((_handler: () => void) => () => undefined),
  };
  const session = createProjectSession(createUiDemoProject());
  const props = { projectSession: session, isDesktop: true } as unknown as EasyShellProps;
  const { host } = createEditorShellEasyHost({ store: createEasyFlowStore(), live: () => ({ props, openWorkspace: vi.fn() }), launchRoughCut: vi.fn(),
    settle: () => Promise.resolve(), desktopApi: api as unknown as Partial<HaoDesktopApi> });
  return { api, render, host, session, setReport: (next: RenderJobReport) => { report = next; } };
}
/** One render of the close guard hook as useShellSafety mounts it: armed while an export job runs. */
function guard(api: ReturnType<typeof desktop>["api"]) {
  hooks.index = 0; hooks.effects = [];
  const value = useWindowCloseGuard({ api: api as never, dirty: false, exporting: renderJobBusy(), save: async () => undefined, isDirty: () => false });
  for (const effect of hooks.effects) effect();
  return value;
}

beforeEach(() => { vi.useFakeTimers(); hooks.values = []; resetRenderJobForTest(); });
afterEach(() => { resetRenderJobForTest(); vi.useRealTimers(); });

describe("存成影片 is a visible, stoppable export job", () => {
  it("runs with a job id, arms the close guard, reports measured progress to the saving screen and ends with the file to play", async () => {
    const d = desktop();
    const saving = d.host.engine.saveVideo({ orientation: "horizontal", flags: [] }, brief);
    await vi.advanceTimersByTimeAsync(0);
    const jobId = currentRenderJob()!.id;
    expect(d.api.renderProject).toHaveBeenCalledWith(d.session.getSnapshot().history.present, { jobId });
    expect(currentRenderJob()).toMatchObject({ phase: "choosing", presentation: "inline" });
    expect(renderJobBusy()).toBe(true);
    guard(d.api);
    expect(d.api.setCloseGuard).toHaveBeenLastCalledWith(true);

    d.setReport({ jobId, known: true, outputPath: "D:\\Videos\\IMG_3310.mp4", progress: progress("encode", 10, 20) });
    await vi.advanceTimersByTimeAsync(RENDER_JOB_POLL_MS);
    const view = d.host.saveJob!.current();
    expect(view).toMatchObject({ stage: "encode", fraction: 0.5, cancelRequested: false, canCancel: true });
    expect(d.host.saveJob!.current()).toBe(view);

    d.render.resolve({ canceled: false, outputPath: "D:\\Videos\\IMG_3310.mp4", outputUrl: "http://asset.localhost/IMG_3310.mp4?v=1" });
    expect(await saving).toEqual({ path: "D:\\Videos\\IMG_3310.mp4", fileName: "IMG_3310.mp4", folderName: "Videos", url: "http://asset.localhost/IMG_3310.mp4?v=1" });
    expect(currentRenderJob()).toBeUndefined();
    expect(d.host.saveJob!.current()).toBeUndefined();
    guard(d.api);
    expect(d.api.setCloseGuard).toHaveBeenLastCalledWith(false);
  });

  it("停止存檔 stops the renderer; the save then ends with nothing saved and the guard disarmed", async () => {
    const d = desktop();
    const saving = d.host.engine.saveVideo({ orientation: "horizontal", flags: [] }, brief);
    await vi.advanceTimersByTimeAsync(0);
    const jobId = currentRenderJob()!.id;
    d.setReport({ jobId, known: true, progress: progress("frames") });
    await vi.advanceTimersByTimeAsync(RENDER_JOB_POLL_MS);
    await d.host.saveJob!.cancel();
    expect(d.api.cancelRenderJob).toHaveBeenCalledWith(jobId);
    expect(d.host.saveJob!.current()).toMatchObject({ cancelRequested: true });
    d.render.resolve({ canceled: true, stoppedByUser: true });
    expect(await saving).toBeUndefined();
    expect(renderJobBusy()).toBe(false);
    expect(currentRenderJob()).toBeUndefined();
  });

  it("closing the window during the save stops the export first, then closes", async () => {
    const d = desktop();
    const saving = d.host.engine.saveVideo({ orientation: "horizontal", flags: [] }, brief);
    await vi.advanceTimersByTimeAsync(0);
    const jobId = currentRenderJob()!.id;
    d.setReport({ jobId, known: true, progress: progress("encode", 2, 20) });
    await vi.advanceTimersByTimeAsync(RENDER_JOB_POLL_MS);
    const closing = guard(d.api).closeWithoutSaving();
    await vi.advanceTimersByTimeAsync(0);
    expect(d.api.cancelRenderJob).toHaveBeenCalledWith(jobId);
    expect(d.api.closeWindowConfirmed).not.toHaveBeenCalled();
    d.render.resolve({ canceled: true, stoppedByUser: true });
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    expect(await saving).toBeUndefined();
    expect(d.api.closeWindowConfirmed).toHaveBeenCalledTimes(1);
  });

  it("a failed save leaves no job behind (the result screen shows the problem), and a second save cannot start while one runs", async () => {
    const d = desktop();
    const failing = d.host.engine.saveVideo({ orientation: "horizontal", flags: [] }, brief);
    await vi.advanceTimersByTimeAsync(0);
    await expect(d.host.engine.saveVideo({ orientation: "horizontal", flags: [] }, brief)).rejects.toThrow("已經有一支影片正在輸出，請等它做完再存。");
    d.render.reject(new Error("ENOSPC: no space left on device"));
    await expect(failing).rejects.toThrow("ENOSPC");
    expect(currentRenderJob()).toBeUndefined();
    expect(renderJobBusy()).toBe(false);
  });
});
