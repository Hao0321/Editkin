import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import { createProjectSession } from "../application/projectSession";
import { downloadBrowserDraft, renderBrowserDraft } from "../application/browserDraftExport";
import { useBrowserDraftExport } from "./useBrowserDraftExport";

const lifecycle = vi.hoisted(() => ({ cleanups: [] as Array<() => void>, state: vi.fn() }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, lifecycle.state],
  useEffect: (effect: () => () => void) => lifecycle.cleanups.push(effect()),
}));
vi.mock("../application/browserDraftExport", () => ({ renderBrowserDraft: vi.fn(), downloadBrowserDraft: vi.fn() }));
afterEach(() => { lifecycle.cleanups.splice(0).forEach(clean => clean()); vi.clearAllMocks(); });

function fixture() {
  const project = createDemoProject(), session = createProjectSession(project);
  const result = { blob: new Blob(["encoded fixture"]), extension: "mp4" as const, encoder: "fixture", width: 1280, height: 720, fps: 30 };
  let resolve!: (value: typeof result) => void;
  let reject!: (error: unknown) => void;
  vi.mocked(renderBrowserDraft).mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  const onStatus = vi.fn();
  const hook = useBrowserDraftExport({ project, session, runtimeUrls: {}, onStatus, onStart: vi.fn() });
  const signal = () => vi.mocked(renderBrowserDraft).mock.calls.at(-1)![2].signal;
  return { project, session, hook, onStatus, signal, resolve: () => resolve(result), reject: (error: unknown) => reject(error), result };
}

describe("browser draft task ownership", () => {
  it("coalesces duplicate calls, downloads once, and permits a completed retry", async () => {
    const f = fixture(); const work = f.hook.render(); await f.hook.render();
    expect(renderBrowserDraft).toHaveBeenCalledOnce(); f.resolve(); await work;
    expect(downloadBrowserDraft).toHaveBeenCalledOnce();
    vi.mocked(renderBrowserDraft).mockResolvedValueOnce(f.result); await f.hook.render();
    expect(downloadBrowserDraft).toHaveBeenCalledTimes(2);
  });
  it("cancels without downloading or publishing late progress, then permits retry", async () => {
    const f = fixture(); const work = f.hook.render(); f.hook.cancel(); f.onStatus.mockClear();
    expect(f.signal().aborted).toBe(true);
    vi.mocked(renderBrowserDraft).mock.calls[0][2].onProgress?.(90);
    expect(f.onStatus).not.toHaveBeenCalled(); f.resolve(); await work;
    expect(downloadBrowserDraft).not.toHaveBeenCalled();
    vi.mocked(renderBrowserDraft).mockResolvedValueOnce(f.result); await f.hook.render();
    expect(downloadBrowserDraft).toHaveBeenCalledOnce();
  });
  it("aborts a changed project and never downloads its stale render", async () => {
    const f = fixture(); const work = f.hook.render();
    f.session.setHistory(history => dispatchCommand(history, { type: "add_caption", caption: { id: "new", text: "new edit", start: 0, duration: 1 } }));
    expect(f.signal().aborted).toBe(true); f.resolve(); await work;
    expect(downloadBrowserDraft).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().history.present.captions[0].text).toBe("new edit");
  });
  it("aborts unmount and suppresses the old hook's download, status and state updates", async () => {
    const f = fixture(); const work = f.hook.render(); lifecycle.cleanups.splice(0).forEach(clean => clean());
    f.onStatus.mockClear(); lifecycle.state.mockClear(); expect(f.signal().aborted).toBe(true);
    f.reject(new Error("old task")); await work;
    expect(downloadBrowserDraft).not.toHaveBeenCalled(); expect(f.onStatus).not.toHaveBeenCalled(); expect(lifecycle.state).not.toHaveBeenCalled();
  });
  it("preserves an active task through metadata-only save acknowledgement", async () => {
    const f = fixture(); const work = f.hook.render(); const save = f.session.beginSave()!;
    f.session.completeSave(save, { path: "fixture.editkin.json", project: { ...save.project, revision: 1 } }); f.session.finishSave(save);
    expect(f.signal().aborted).toBe(false); f.resolve(); await work; expect(downloadBrowserDraft).toHaveBeenCalledOnce();
  });
});
