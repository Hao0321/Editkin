import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand, undo } from "../domain/history";
import { createProjectSession } from "../application/projectSession";
import { analyzeBrowserSmartCut } from "../application/browserSmartCut";
import { useSmartCut } from "./useSmartCut";

const lifecycle = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }), useState: (value: unknown) => [value, () => {}],
  useEffect: (effect: () => () => void) => lifecycle.cleanups.push(effect()),
}));
vi.mock("../application/browserSmartCut", () => ({ analyzeBrowserSmartCut: vi.fn() }));
afterEach(() => { lifecycle.cleanups.splice(0).forEach(clean => clean()); vi.clearAllMocks(); });

function fixture() {
  const project = createDemoProject(), projectSession = createProjectSession(project);
  const result = { ranges: [{ startFrame: 0, endFrame: 150 }, { startFrame: 210, endFrame: 360 }], fps: 30, sourceFrames: 360, removedFrames: 60, cutCount: 1, silenceCount: 1, thresholdDb: -30, analyzedSeconds: 12, engine: "fixture", cacheHit: false };
  let resolve!: (value: typeof result) => void;
  vi.mocked(analyzeBrowserSmartCut).mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  const onStatus = vi.fn(), onCommand = vi.fn(command => projectSession.setHistory(history => dispatchCommand(history, command)));
  const hook = useSmartCut({ project, projectSession, selectedClip: project.tracks[0].clips[0], runtimeUrls: { "asset-demo": "blob:fixture" }, onStatus, onCommand });
  return { project, projectSession, onStatus, onCommand, hook, resolve: () => resolve(result), signal: () => vi.mocked(analyzeBrowserSmartCut).mock.calls[0][0].signal! };
}

describe("browser Smart Cut task cancellation", () => {
  it("coalesces duplicates and commits one undoable command", async () => {
    const f = fixture(); const work = f.hook.run(); await f.hook.run();
    expect(analyzeBrowserSmartCut).toHaveBeenCalledOnce(); f.resolve(); await work;
    expect(f.onCommand).toHaveBeenCalledOnce(); f.projectSession.setHistory(undo);
    expect(f.projectSession.getSnapshot().history.present).toEqual(f.project);
  });
  it("aborts analysis on content change while preserving the newer edit", async () => {
    const f = fixture(); const work = f.hook.run();
    f.projectSession.setHistory(history => dispatchCommand(history, { type: "add_caption", caption: { id: "new", text: "new edit", start: 0, duration: 1 } }));
    expect(f.signal().aborted).toBe(true); f.resolve(); await work;
    expect(f.onCommand).not.toHaveBeenCalled(); expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("重新執行"));
  });
  it("aborts on unmount and does not publish a late result", async () => {
    const f = fixture(); const work = f.hook.run(); lifecycle.cleanups.splice(0).forEach(clean => clean());
    expect(f.signal().aborted).toBe(true); f.onStatus.mockClear(); f.resolve(); await work;
    expect(f.onCommand).not.toHaveBeenCalled(); expect(f.onStatus).not.toHaveBeenCalled();
  });
});
