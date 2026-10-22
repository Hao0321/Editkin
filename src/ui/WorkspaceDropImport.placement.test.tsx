import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, native: {
  scaleFactor: vi.fn(), onDragDropEvent: vi.fn(), onScaleChanged: vi.fn(),
} }));
vi.mock("react", () => ({ useState: (value: unknown) => [value, vi.fn()], useRef: (current: unknown) => ({ current }), useEffect: (effect: () => void | (() => void)) => h.effects.push(effect) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => h.native }));
import { WorkspaceDropImport } from "./WorkspaceDropImport";
import { resolveTimelineImportPlacement, type TimelineImportPlacement, type WorkspaceDropPoint } from "./internalAssetPointerDrag";

const cleanups: Array<() => void> = [];
const flush = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 16; i++) await Promise.resolve(); };
function mount(native = false, devicePixelRatio: number | undefined = 2) {
  const window = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: native ? {} : undefined, devicePixelRatio }); vi.stubGlobal("window", window);
  const onBrowserFiles = vi.fn(), onDesktopPaths = vi.fn(), onStatus = vi.fn();
  WorkspaceDropImport({ onBrowserFiles, onDesktopPaths, onStatus });
  for (const effect of h.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  return { window, onBrowserFiles, onDesktopPaths, onStatus };
}
function drop(files: File[], clientX: number, clientY: number) {
  return Object.assign(new Event("drop", { cancelable: true }), { clientX, clientY, dataTransfer: { types: ["Files"], files } });
}
function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) } as DOMRect;
}
function capturePlacement(f: ReturnType<typeof mount>) {
  // Task-shaped geometry for the real production timeline resolver. These SDK
  // and DOM doubles do not claim that native input or real zoom was measured.
  const lane = { dataset: { trackId: "video-second", trackKind: "video", trackLocked: "false" }, getBoundingClientRect: () => rect(100, 235, 900, 350) };
  const viewport = { dataset: { timelinePixelsPerSecond: "80", timelineFps: "30" }, scrollLeft: 160,
    clientLeft: 0, clientTop: 0, clientWidth: 800, clientHeight: 400,
    getBoundingClientRect: () => rect(100, 200, 900, 600),
    querySelector: () => ({ getBoundingClientRect: () => rect(100, 200, 900, 235) }), querySelectorAll: () => [lane] };
  const shell = { getBoundingClientRect: () => rect(0, 100, 1000, 700), querySelector: () => viewport };
  const document = { querySelectorAll: () => [shell] } as unknown as Document;
  const placements: Array<TimelineImportPlacement | undefined> = [];
  f.onDesktopPaths.mockImplementation((_paths: string[], point: WorkspaceDropPoint) => {
    placements.push(resolveTimelineImportPlacement(point, document));
  });
  return placements;
}
const targetPoint = { clientX: 408, clientY: 260 };
const targetPlacement = { trackId: "video-second", trackKind: "video", timelineStart: 3.5 };
const authorPath = "C:/作者/日本語_한국어.mp4";
const physicalDrop = (ratio: number) => ({ payload: { type: "drop", paths: [authorPath],
  position: { x: targetPoint.clientX * ratio, y: targetPoint.clientY * ratio } } });
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
    f.window.devicePixelRatio = 3;
    scale({ payload: { scaleFactor: 3 } }); resolve(2); await flush();
    const nativeDrop = h.native.onDragDropEvent.mock.calls[0]![0];
    nativeDrop({ payload: { type: "drop", paths: ["C:/movie.mp4"], position: { x: 300, y: 180 } } });
    expect(f.onDesktopPaths).toHaveBeenLastCalledWith(["C:/movie.mp4"], { clientX: 100, clientY: 60 });
    expect(h.native.scaleFactor).toHaveBeenCalledTimes(1);
    f.window.devicePixelRatio = 1.5;
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

describe("native drops use the live desktop CSS ratio for timeline placement", () => {
  const scaleCases = [1, 1.25, 1.5, 2].flatMap(dpi => [0.8, 1, 1.25, 1.5, 1.75, 2].map(zoom => ({ dpi, zoom })));
  it.each(scaleCases)("keeps the same lane/frame at monitor DPI $dpi and UI zoom $zoom", async ({ dpi, zoom }) => {
    h.native.scaleFactor.mockResolvedValueOnce(dpi);
    const ratio = dpi * zoom, f = mount(true, ratio), placements = capturePlacement(f); await flush();
    f.window.dispatchEvent(drop([{ name: "duplicate.mp4" } as File], targetPoint.clientX, targetPoint.clientY));
    h.native.onDragDropEvent.mock.calls[0]![0](physicalDrop(ratio));
    expect(f.onDesktopPaths).toHaveBeenCalledExactlyOnceWith([authorPath], targetPoint);
    expect(placements).toEqual([targetPlacement]);
    expect(Object.isFrozen(f.onDesktopPaths.mock.calls[0]![1])).toBe(true);
    expect(Object.isFrozen(placements[0])).toBe(true);
    expect(f.onBrowserFiles).not.toHaveBeenCalled(); expect(f.onStatus).not.toHaveBeenCalled();
    expect(h.native.scaleFactor).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects unusable live CSS ratio %s instead of guessing a location", async ratio => {
    const f = mount(true); Object.defineProperty(f.window, "devicePixelRatio", { value: ratio, writable: true, configurable: true }); await flush();
    h.native.onDragDropEvent.mock.calls[0]![0](physicalDrop(2));
    expect(f.onDesktopPaths).not.toHaveBeenCalled();
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("座標比例無效"));
  });
  it("captures the actual DOM ratio synchronously while preference metadata still describes the previous zoom", async () => {
    h.native.scaleFactor.mockResolvedValueOnce(1);
    vi.stubGlobal("document", { documentElement: { dataset: { uiScale: "1", pendingUiScale: "2" } } });
    const f = mount(true, 2), placements = capturePlacement(f); await flush();
    h.native.onDragDropEvent.mock.calls[0]![0](physicalDrop(2));
    expect(f.onDesktopPaths).toHaveBeenCalledExactlyOnceWith([authorPath], targetPoint);
    expect(placements).toEqual([targetPlacement]); expect(f.onStatus).not.toHaveBeenCalled();
  });
  it("reads a changed DOM zoom for each drop without waiting for another native DPI event", async () => {
    h.native.scaleFactor.mockResolvedValueOnce(1);
    const f = mount(true, 1), placements = capturePlacement(f); await flush();
    const nativeDrop = h.native.onDragDropEvent.mock.calls[0]![0];
    nativeDrop(physicalDrop(1)); f.window.devicePixelRatio = 2; nativeDrop(physicalDrop(2));
    expect(placements).toEqual([targetPlacement, targetPlacement]);
    expect(f.onDesktopPaths).toHaveBeenCalledTimes(2);
    expect(f.onDesktopPaths.mock.calls.every(([, point]) => point.clientX === 408 && point.clientY === 260)).toBe(true);
    expect(h.native.scaleFactor).toHaveBeenCalledTimes(1); expect(h.native.onScaleChanged).toHaveBeenCalledTimes(1);
    expect(f.onStatus).not.toHaveBeenCalled();
  });
  it("keeps the live ratio after a monitor change at 200% zoom and rejects an older initial DPI response", async () => {
    let resolve!: (value: number) => void; h.native.scaleFactor.mockImplementationOnce(() => new Promise<number>(yes => { resolve = yes; }));
    const f = mount(true, 2), placements = capturePlacement(f); await flush();
    f.window.devicePixelRatio = 6;
    h.native.onScaleChanged.mock.calls[0]![0]({ payload: { scaleFactor: 3 } }); resolve(2); await flush();
    h.native.onDragDropEvent.mock.calls[0]![0](physicalDrop(6));
    expect(f.onDesktopPaths).toHaveBeenCalledExactlyOnceWith([authorPath], targetPoint);
    expect(placements).toEqual([targetPlacement]); expect(f.onStatus).not.toHaveBeenCalled();
    expect(h.native.scaleFactor).toHaveBeenCalledTimes(1); expect(h.native.onDragDropEvent).toHaveBeenCalledTimes(1);
  });
});

// Direct handler/hook-double controls isolate the new subscription. Real React
// localization and browser state continuity are checked in separate suites.
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
