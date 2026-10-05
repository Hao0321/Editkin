import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", () => ({ useState: (value: unknown) => [value, vi.fn()], useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback, useEffect: (effect: () => void | (() => void)) => h.effects.push(effect) }));
import { useCreativeLibrary } from "./useCreativeLibrary";
import { createProjectSession } from "../application/projectSession";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import { timelineAssetDuration } from "../ui/timelineAssetDrop";
import type { TimelineImportPlacement } from "../ui/internalAssetPointerDrag";
import type { HaoDesktopApi, PickedMedia, PrepareMediaResult } from "./types";
import type { MediaAsset } from "../domain/types";

const cleanups: Array<() => void> = [];
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => { h.effects.length = 0; });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(count = 1, provisional = false) {
  const original = createDemoProject(), clip = original.tracks[0]!.clips[0]!;
  const initial = { ...original, tracks: [...original.tracks.map(track => ({ ...track, clips: [] })), { ...original.tracks[0]!, id: "video-second", name: "Second", clips: [] }] };
  const session = createProjectSession(initial);
  const items: PickedMedia[] = Array.from({ length: count }, (_, index) => ({ asset: { ...original.assets[0]!, id: `incoming-${index}`, uri: `source-${index}.mp4`, duration: 2.017 }, previewUrl: `raw-${index}` }));
  const prepared = (item: PickedMedia): PrepareMediaResult => ({ assetId: item.asset.id, derivatives: { sourceSha256: "a".repeat(64), generatedAt: new Date(0).toISOString() }, runtimeUrls: { [item.asset.id]: `proxy-${item.asset.id}` }, cacheHit: false });
  const api = { pickMedia: vi.fn(async () => items), importMediaPaths: vi.fn(async (_paths: string[]) => items), importCreativeAsset: vi.fn(async (_id: string) => items[0]!),
    prepareMedia: vi.fn(async (asset: MediaAsset) => prepared(items.find(item => item.asset.id === asset.id)!)),
    listInstalledPlugins: vi.fn(async () => ({ plugins: [] })), getWorkflowProfile: vi.fn(async () => ({ profile: undefined })),
    listCreativeLibrary: vi.fn(async () => ({ id: "fixture", name: "Fixture", version: "1", attribution: "Original", assetCount: provisional ? 1 : 0, assetBytes: 100,
      musicAssetCount: 0, sfxAssetCount: 0, restrictedAssetCount: 0, assets: provisional ? [{ id: "library:fixture", name: "Actual listed source", category: "broll", role: "context", domains: ["general"], mediaKind: "video", bytes: 100, license: "CC0", provenance: "original fixture", duration: 2.017, width: 1920, height: 1080 }] : [] })) };
  const onPicked = vi.fn((picked: PickedMedia[], options?: { backgroundMusic?: boolean; placement?: TimelineImportPlacement }): boolean => {
    const placement = options?.placement; let start = placement?.timelineStart ?? Math.max(20, ...session.getSnapshot().history.present.tracks.flatMap(track => track.clips.map(item => item.timelineStart + item.duration)));
    session.setHistory(history => dispatchCommand(history, { type: "batch", commands: picked.flatMap(item => {
      const duration = timelineAssetDuration(item.asset, initial.fps), timelineStart = start; start += duration;
      return [{ type: "import_asset" as const, asset: item.asset }, { type: "add_clip" as const, clip: { ...structuredClone(clip), id: `clip-${item.asset.id}`, assetId: item.asset.id,
        trackId: placement?.trackId ?? "video-main", timelineStart, sourceStart: 0, duration } }];
    }) })); return true;
  });
  const onPrepared = vi.fn(), onStatus = vi.fn();
  const hook = useCreativeLibrary({ api: api as unknown as HaoDesktopApi, projectSession: session, onPicked, onPrepared, onStatus, onCommands: vi.fn() });
  for (const effect of h.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  return { initial, session, items, api, prepared, onPicked, onPrepared, onStatus, hook };
}
describe("desktop asynchronous import retains immutable timeline placement", () => {
  it("captures paths and hovered lane/time before pick awaits and commits exact complete source frames", async () => {
    const f = fixture(), pick = deferred<PickedMedia[]>(); f.api.importMediaPaths.mockImplementationOnce(() => pick.promise);
    const paths = ["C:/original.mp4"], placement: TimelineImportPlacement = { trackId: "video-second", trackKind: "video", timelineStart: 3.5 };
    const run = f.hook.importDesktopPaths(paths, placement);
    paths[0] = "C:/changed.mp4"; (placement as { trackId: string; timelineStart: number }).trackId = "video-main"; (placement as { timelineStart: number }).timelineStart = 99;
    pick.resolve(f.items); await run;
    expect(f.api.importMediaPaths).toHaveBeenCalledExactlyOnceWith(["C:/original.mp4"]);
    const captured = f.onPicked.mock.calls[0]![1]!.placement!;
    expect(captured).toEqual({ trackId: "video-second", trackKind: "video", timelineStart: 3.5 }); expect(Object.isFrozen(captured)).toBe(true);
    expect(f.session.getSnapshot().history.present.tracks.find(track => track.id === "video-second")!.clips[0]).toMatchObject({ timelineStart: 3.5, duration: 2 });
  });
  it("holds an entire placed multi-file drop on one preparation failure and retries in original source order at original time", async () => {
    const f = fixture(3), placement = { trackId: "video-second", trackKind: "video" as const, timelineStart: 3.5 };
    f.api.prepareMedia.mockImplementationOnce(async asset => f.prepared(f.items.find(item => item.asset.id === asset.id)!)).mockRejectedValueOnce(Error("one proxy failed"));
    await f.hook.importDesktopPaths(["one.mp4", "two.mp4", "three.mp4"], placement);
    expect(f.onPicked).not.toHaveBeenCalled(); expect(f.onPrepared).not.toHaveBeenCalled(); expect(f.session.getSnapshot().history.present).toBe(f.initial);
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("整批 3 份尚未加入")); placement.timelineStart = 99;
    await f.hook.retryFailedImports();
    expect(f.onPicked).toHaveBeenCalledTimes(1); expect(f.onPicked.mock.calls[0]![0].map(item => item.asset.id)).toEqual(["incoming-0", "incoming-1", "incoming-2"]);
    expect(f.onPicked.mock.calls[0]![1]!.placement!.timelineStart).toBe(3.5);
    expect(f.session.getSnapshot().history.present.tracks.find(track => track.id === "video-second")!.clips.map(item => item.timelineStart)).toEqual([3.5, 5.5, 7.5]);
  });
  it("explicit false commit preserves original retry intent and never claims ready or applies previews", async () => {
    const f = fixture(), placement = { trackId: "video-second", trackKind: "video" as const, timelineStart: 3.5 };
    f.onPicked.mockReturnValueOnce(false); await f.hook.importDesktopPaths(["one.mp4"], placement);
    expect(f.onPrepared).not.toHaveBeenCalled(); expect(f.session.getSnapshot().history.present).toBe(f.initial);
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("尚未加入"));
    await f.hook.retryFailedImports(); expect(f.onPicked).toHaveBeenCalledTimes(2);
    expect(f.onPicked.mock.calls[1]![1]!.placement).toBe(f.onPicked.mock.calls[0]![1]!.placement); expect(f.onPrepared).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid placement before native import and stale same-ID project sessions before commit or retry", async () => {
    const f = fixture(); await f.hook.importDesktopPaths(["one.mp4"], { trackId: "video-second", trackKind: "video", timelineStart: -1 });
    expect(f.api.importMediaPaths).not.toHaveBeenCalled(); expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("位置無效"));
    const preparation = deferred<PrepareMediaResult>(); f.api.prepareMedia.mockImplementationOnce(() => preparation.promise);
    const run = f.hook.importDesktopPaths(["one.mp4"], { trackId: "video-second", trackKind: "video", timelineStart: 3.5 }); await flush();
    f.session.replaceProject({ ...f.initial, name: "New same-ID session" }); preparation.resolve(f.prepared(f.items[0]!)); await run; await f.hook.retryFailedImports();
    expect(f.onPicked).not.toHaveBeenCalled(); expect(f.onPrepared).not.toHaveBeenCalled();
  });
  it("unplaced picker keeps successful subset behavior and retries only its failed source", async () => {
    const f = fixture(2); f.api.prepareMedia.mockRejectedValueOnce(Error("failed")); await f.hook.importDesktopMedia();
    expect(f.onPicked.mock.calls[0]![0].map(item => item.asset.id)).toEqual(["incoming-1"]); expect(f.onPicked.mock.calls[0]![1]).not.toHaveProperty("placement");
    await f.hook.retryFailedImports(); expect(f.onPicked.mock.calls[1]![0].map(item => item.asset.id)).toEqual(["incoming-0"]);
  });
  it.each(["native", "provisional"])("does not enqueue %s creative background work when consumer rejects", async route => {
    const f = fixture(1, route === "provisional"); await flush(); f.onPicked.mockReturnValue(false); await f.hook.importCreativeAsset("library:fixture"); await flush();
    expect(f.onPicked).toHaveBeenCalledTimes(1); expect(f.api.prepareMedia).not.toHaveBeenCalled(); expect(f.onPrepared).not.toHaveBeenCalled();
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("尚未加入")); expect(f.session.getSnapshot().history.present).toBe(f.initial);
  });
});
