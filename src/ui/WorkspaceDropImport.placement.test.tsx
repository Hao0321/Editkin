import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, native: {
  scaleFactor: vi.fn(), onDragDropEvent: vi.fn(), onScaleChanged: vi.fn(),
} }));
vi.mock("react", () => ({ useState: (value: unknown) => [value, vi.fn()], useRef: (current: unknown) => ({ current }), useEffect: (effect: () => void | (() => void)) => h.effects.push(effect) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => h.native }));
import { WorkspaceDropImport } from "./WorkspaceDropImport";

const cleanups: Array<() => void> = [];
const flush = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 16; i++) await Promise.resolve(); };
function mount(native = false) {
  const window = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: native ? {} : undefined }); vi.stubGlobal("window", window);
  const onBrowserFiles = vi.fn(), onDesktopPaths = vi.fn(), onStatus = vi.fn();
  WorkspaceDropImport({ onBrowserFiles, onDesktopPaths, onStatus });
  for (const effect of h.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  return { window, onBrowserFiles, onDesktopPaths, onStatus };
}
function drop(files: File[], clientX: number, clientY: number) {
  return Object.assign(new Event("drop", { cancelable: true }), { clientX, clientY, dataTransfer: { types: ["Files"], files } });
}
beforeEach(() => { h.effects.length = 0; h.native.scaleFactor.mockReset().mockResolvedValue(2); h.native.onDragDropEvent.mockReset().mockResolvedValue(vi.fn()); h.native.onScaleChanged.mockReset().mockResolvedValue(vi.fn()); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });
describe("external workspace drop preserves actual placement before importing", () => {
  it("passes exact browser CSS coordinates and only supported files", () => {
    const f = mount(), movie = { name: "movie.mp4" } as File, rejected = { name: "notes.txt" } as File;
    f.window.dispatchEvent(drop([movie, rejected], 511, 322));
    expect(f.onBrowserFiles).toHaveBeenCalledExactlyOnceWith([movie], { clientX: 511, clientY: 322 });
    expect(Object.isFrozen(f.onBrowserFiles.mock.calls[0]![1])).toBe(true);
    expect(f.onStatus).toHaveBeenCalledWith(expect.stringContaining("1 個檔案")); expect(f.onDesktopPaths).not.toHaveBeenCalled();
  });
  it("uses actual native scaleFactor for physical coordinates and suppresses duplicate HTML5 import", async () => {
    const f = mount(true); await flush();
    f.window.dispatchEvent(drop([{ name: "duplicate.mp4" } as File], 1, 2));
    const handler = h.native.onDragDropEvent.mock.calls[0]![0];
    handler({ payload: { type: "drop", paths: ["C:/movie.mp4", "C:/notes.txt"], position: { x: 1022, y: 644 } } }); await flush();
    expect(h.native.scaleFactor).toHaveBeenCalledTimes(1);
    expect(f.onDesktopPaths).toHaveBeenCalledExactlyOnceWith(["C:/movie.mp4"], { clientX: 511, clientY: 322 });
    expect(Object.isFrozen(f.onDesktopPaths.mock.calls[0]![1])).toBe(true); expect(f.onBrowserFiles).not.toHaveBeenCalled();
  });
  it.each(["zero", "nonfinite", "reject"])("blocks native %s scale without guessed devicePixelRatio", async mode => {
    if (mode === "reject") h.native.scaleFactor.mockRejectedValueOnce(Error("scale unavailable"));
    else h.native.scaleFactor.mockResolvedValueOnce(mode === "zero" ? 0 : Number.NaN);
    const f = mount(true); await flush();
    h.native.onDragDropEvent.mock.calls[0]?.[0]({ payload: { type: "drop", paths: ["C:/movie.mp4"], position: { x: 80, y: 60 } } });
    expect(f.onDesktopPaths).not.toHaveBeenCalled(); expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("拖放匯入"));
  });
  it("does not register a late native scale response after disposal and removes its listener", async () => {
    let resolve!: (value: number) => void; h.native.scaleFactor.mockImplementationOnce(() => new Promise<number>(yes => { resolve = yes; }));
    const f = mount(true); await flush();
    for (const cleanup of cleanups.splice(0)) cleanup(); resolve(2); await flush();
    expect(h.native.onDragDropEvent).not.toHaveBeenCalled(); expect(f.onDesktopPaths).not.toHaveBeenCalled(); expect(f.onStatus).not.toHaveBeenCalled();
    expect(await h.native.onScaleChanged.mock.results[0]!.value).toHaveBeenCalledTimes(1);
  });
  it("uses live scale events synchronously and an older initial response cannot overwrite them", async () => {
    let resolve!: (value: number) => void; h.native.scaleFactor.mockImplementationOnce(() => new Promise<number>(yes => { resolve = yes; }));
    const f = mount(true); await flush(); const scale = h.native.onScaleChanged.mock.calls[0]![0];
    scale({ payload: { scaleFactor: 3 } }); resolve(2); await flush();
    const nativeDrop = h.native.onDragDropEvent.mock.calls[0]![0];
    nativeDrop({ payload: { type: "drop", paths: ["C:/movie.mp4"], position: { x: 300, y: 180 } } });
    expect(f.onDesktopPaths).toHaveBeenLastCalledWith(["C:/movie.mp4"], { clientX: 100, clientY: 60 });
    expect(h.native.scaleFactor).toHaveBeenCalledTimes(1);
    scale({ payload: { scaleFactor: 1.5 } });
    nativeDrop({ payload: { type: "drop", paths: ["C:/movie.mp4"], position: { x: 300, y: 180 } } });
    expect(f.onDesktopPaths).toHaveBeenLastCalledWith(["C:/movie.mp4"], { clientX: 200, clientY: 120 });
    scale({ payload: { scaleFactor: Number.NaN } });
    nativeDrop({ payload: { type: "drop", paths: ["C:/movie.mp4"], position: { x: 300, y: 180 } } });
    expect(f.onDesktopPaths).toHaveBeenCalledTimes(2); expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("座標比例無效"));
  });
  it("removes browser listeners on cleanup and rejects native nonfinite coordinates", async () => {
    const web = mount(); for (const cleanup of cleanups.splice(0)) cleanup();
    web.window.dispatchEvent(drop([{ name: "movie.mp4" } as File], 10, 20)); expect(web.onBrowserFiles).not.toHaveBeenCalled();
    const f = mount(true); await flush();
    h.native.onDragDropEvent.mock.calls[0]![0]({ payload: { type: "drop", paths: ["C:/movie.mp4"], position: { x: Number.NaN, y: 20 } } }); await flush();
    expect(f.onDesktopPaths).not.toHaveBeenCalled(); expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("座標比例無效"));
  });
});
