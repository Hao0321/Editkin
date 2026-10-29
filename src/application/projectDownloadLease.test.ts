import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import { createProjectDownloadOwner } from "./projectDownloadLease";
import { createProjectSession } from "./projectSession";
import { decodeProjectBytes } from "./projectCodec";
import { PROJECT_DOWNLOAD_URL_LIFETIME_MS } from "./exportGraph";
import { createAppProjectFileActions } from "./appProjectFileActions";
import { createAppRenderActions } from "./appRenderActions";

const cleanups: Array<() => void> = [];
type TestAnchor = { href: string; download: string; hidden: boolean; attached: boolean; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
function fixture() {
  vi.useFakeTimers();
  const listeners = new Map<string, () => void>();
  let failDispatch = false;
  const anchors: TestAnchor[] = [];
  const create = vi.fn((_blob: Blob) => `blob:owned-${anchors.length + 1}`), revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  vi.stubGlobal("window", { confirm: () => true,
    addEventListener: (name: string, work: () => void) => listeners.set(name, work), removeEventListener: (name: string) => listeners.delete(name) });
  vi.stubGlobal("document", { body: { appendChild: (anchor: { attached: boolean }) => { anchor.attached = true; } },
    createElement: () => {
      const anchor: TestAnchor = { href: "", download: "", hidden: false, attached: false,
        click: vi.fn(() => { expect(anchor.attached).toBe(true); if (failDispatch) throw new Error("dispatch rejected"); }),
        remove: vi.fn(() => { anchor.attached = false; }) };
      anchors.push(anchor); return anchor;
    } });
  const session = createProjectSession(createDemoProject());
  const changed = vi.fn();
  const owner = createProjectDownloadOwner({ session, onChange: changed });
  const detach = owner.attach(); cleanups.push(detach);
  const edit = (name: string) => session.setHistory(current => dispatchCommand(current, { type: "rename_project", name }));
  const decoded = async (index: number) => decodeProjectBytes(new Uint8Array(await create.mock.calls[index][0].arrayBuffer()));
  return { session, owner, detach, listeners, changed, create, revoke, anchors, edit, decoded, fail: () => { failDispatch = true; } };
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("one controlled snapshot download lease (browser I/O doubles, no physical delivery claim)", () => {
  it("encodes one real graph, dispatches that same URL once, and expires exactly at fifteen seconds", async () => {
    const f = fixture();
    const result = f.owner.request();
    const view = f.owner.getCurrent()!;
    expect(result.status).toBe("download_requested");
    expect(Object.isFrozen(view)).toBe(true);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.anchors[0].href).toBe(view.url);
    expect(f.anchors[0].click).toHaveBeenCalledTimes(1);
    expect(f.anchors[0].remove).toHaveBeenCalledTimes(1);
    expect((await f.decoded(0)).tracks[0].clips[0].id).toBe("clip-demo");
    vi.advanceTimersByTime(PROJECT_DOWNLOAD_URL_LIFETIME_MS - 1);
    expect(view.isAvailable()).toBe(true);
    expect(f.revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(view.isAvailable()).toBe(false);
    expect(f.owner.getCurrent()).toBeUndefined();
    expect(f.revoke).toHaveBeenCalledTimes(1);
    expect(f.revoke).toHaveBeenCalledWith(view.url);
  });
  it("retains sent bytes after actual edits and labels them older without clearing dirty/history/disk revision", async () => {
    const f = fixture();
    f.edit("Submitted version");
    f.owner.request();
    const view = f.owner.getCurrent()!;
    const revision = f.session.getSnapshot().diskRevision;
    f.edit("Later editing");
    const state = f.session.getSnapshot();
    expect(view.isCurrent()).toBe(false);
    expect(view.isAvailable()).toBe(true);
    expect((await f.decoded(0)).name).toBe("Submitted version");
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.session.getSnapshot()).toBe(state);
    expect(state).toMatchObject({ dirty: true, diskRevision: revision, projectPath: undefined, savePending: false });
  });
  it("project replacement cancels an old session even when ID/path are reused", () => {
    const f = fixture();
    f.owner.request();
    const old = f.owner.getCurrent()!;
    f.session.replaceProject(structuredClone(f.session.getSnapshot().history.present));
    expect(old.isAvailable()).toBe(false);
    expect(f.owner.getCurrent()).toBeUndefined();
    expect(f.revoke).toHaveBeenCalledWith(old.url);
    expect(f.changed).toHaveBeenLastCalledWith(undefined);
    f.owner.request();
    expect(f.owner.getCurrent()!.requestId).not.toBe(old.requestId);
  });
  it("a retired timer and old cancel button cannot clear a newer lease", () => {
    const f = fixture(), schedules = vi.spyOn(globalThis, "setTimeout");
    f.owner.request();
    const old = f.owner.getCurrent()!;
    const callback = schedules.mock.calls.find(call => call[1] === PROJECT_DOWNLOAD_URL_LIFETIME_MS)![0];
    f.owner.request();
    const current = f.owner.getCurrent()!;
    expect(f.revoke).toHaveBeenCalledTimes(1);
    expect(f.revoke).toHaveBeenCalledWith(old.url);
    if (typeof callback !== "function") throw new Error("Expected actual lease timer callback");
    callback(); f.owner.cancel(old.requestId);
    expect(f.owner.getCurrent()).toBe(current);
    expect(current.isAvailable()).toBe(true);
    expect(f.revoke).toHaveBeenCalledTimes(1);
  });
  it("pagehide/unmount close only the owned lease, and React remount cannot be detached by an old cleanup", () => {
    const f = fixture();
    f.detach();
    const detach = f.owner.attach(); cleanups.push(detach);
    f.owner.request();
    const first = f.owner.getCurrent()!;
    f.detach();
    expect(first.isAvailable()).toBe(true);
    f.listeners.get("pagehide")!();
    expect(f.revoke).toHaveBeenCalledTimes(1);
    expect(f.revoke).toHaveBeenCalledWith(first.url);
    f.owner.request();
    const second = f.owner.getCurrent()!;
    detach(); detach();
    expect(second.isAvailable()).toBe(false);
    expect(f.revoke).toHaveBeenCalledTimes(2);
    expect(f.listeners.size).toBe(0);
    expect(() => f.owner.request()).toThrow("失效");
  });
  it("rejects a stale request without disturbing the current lease and preserves real dispatch errors", () => {
    const f = fixture(), prior = f.session.getSnapshot().history.present;
    f.edit("Current"); f.owner.request();
    const live = f.owner.getCurrent()!, state = f.session.getSnapshot();
    expect(() => f.owner.request(prior)).toThrow("失效");
    expect(f.owner.getCurrent()).toBe(live);
    expect(f.revoke).not.toHaveBeenCalled();
    f.fail();
    expect(() => f.owner.request()).toThrow("dispatch rejected");
    expect(f.owner.getCurrent()).toBeUndefined();
    expect(f.revoke).toHaveBeenCalledTimes(2);
    expect(f.session.getSnapshot()).toBe(state);
  });
  it("Save and browser render fallback share the live-session owner and native save baselines remain untouched", async () => {
    const f = fixture(), status = vi.fn();
    const files = createAppProjectFileActions({ session: f.session, requestProjectDownload: f.owner.request, loadOpenedProject: vi.fn(),
      setRuntimeUrls: vi.fn(), setSelectedClipId: vi.fn(), setSelectedCaptionId: vi.fn(), setPlayhead: vi.fn(), setPlaying: vi.fn(), setPlaybackRate: vi.fn(),
      setTrackingMode: vi.fn(), setTrackingSelection: vi.fn(), setStatus: status });
    const render = createAppRenderActions({ project: f.session.getSnapshot().history.present, session: f.session, requestProjectDownload: f.owner.request, setStatus: status });
    f.edit("Save snapshot"); await files.saveProject();
    const first = f.owner.getCurrent()!;
    f.edit("Current render fallback"); const state = f.session.getSnapshot();
    await render.renderVideo();
    expect(f.owner.getCurrent()!.requestId).not.toBe(first.requestId);
    expect(f.revoke).toHaveBeenCalledTimes(1);
    expect(f.revoke).toHaveBeenCalledWith(first.url);
    expect((await f.decoded(1)).name).toBe("Current render fallback");
    expect(f.session.getSnapshot()).toBe(state);
    expect(state).toMatchObject({ dirty: true, diskRevision: 0, projectPath: undefined, savePending: false });
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("已送出專案下載"));
    files.newProject();
    expect(f.owner.getCurrent()).toBeUndefined();
  });
});
