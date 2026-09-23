import { describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useState: (value: unknown) => [typeof value === "function" ? (value as () => unknown)() : value, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => { effect(); },
}));

import type { CreativeLibraryAsset, CreativeLibrarySummary } from "../application/creativeLibrary";
import { createProjectSession } from "../application/projectSession";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import type { HaoDesktopApi, PickedMedia, PrepareMediaResult } from "./types";
import { provisionalCreativePick, useCreativeLibrary } from "./useCreativeLibrary";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const listedVideo: CreativeLibraryAsset = {
  id: "owner-visual:fixture", name: "Verified fixture", category: "broll", role: "supplemental-footage",
  domains: ["general"], mediaKind: "video", bytes: 1024, license: "LicenseRef-Editkin-Owner-Visual-Bundle-Grant-1.0",
  provenance: "fixture", duration: 3, width: 1920, height: 1080, redistributable: true,
  distributionScope: "bundled-redistributable", colorMetadata: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
};

function summary(asset: CreativeLibraryAsset): CreativeLibrarySummary {
  return { id: "studio.hao.creator-library", name: "Fixture", version: "1", attribution: "Fixture", assetCount: 1,
    assetBytes: asset.bytes, assets: [asset], musicAssetCount: 0, sfxAssetCount: 0, restrictedAssetCount: 0 };
}

async function flush(turns = 16) { for (let turn = 0; turn < turns; turn += 1) await Promise.resolve(); }

function fixture(asset = listedVideo) {
  const project = createDemoProject(), projectSession = createProjectSession(project), preparation = deferred<PrepareMediaResult>();
  const nativePick = deferred<PickedMedia>();
  const api = {
    listCreativeLibrary: vi.fn(async () => summary(asset)),
    listInstalledPlugins: vi.fn(async () => ({ plugins: [] })),
    getWorkflowProfile: vi.fn(async () => ({ profile: undefined })),
    importCreativeAsset: vi.fn(() => nativePick.promise),
    prepareMedia: vi.fn(() => preparation.promise),
  };
  const onPicked = vi.fn((items: PickedMedia[]) => {
    const picked = items[0]!;
    projectSession.setHistory(history => dispatchCommand(history, { type: "batch", commands: [
      { type: "import_asset", asset: picked.asset },
      { type: "add_clip", clip: { ...structuredClone(project.tracks[0]!.clips[0]!), id: `clip-${picked.asset.id}`,
        assetId: picked.asset.id, timelineStart: 20, duration: picked.asset.duration } },
    ] }));
  });
  const onPrepared = vi.fn(), onStatus = vi.fn();
  const hook = useCreativeLibrary({ api: api as unknown as HaoDesktopApi, projectSession, onPicked, onPrepared, onStatus, onCommands: vi.fn() });
  return { project, projectSession, preparation, nativePick, api, onPicked, onPrepared, onStatus, hook };
}

describe("creative-library provisional timeline commit", () => {
  it("constructs a portable asset only from complete listed metadata", () => {
    const picked = provisionalCreativePick(listedVideo.id, listedVideo)!;
    expect(picked.asset).toMatchObject({ name: listedVideo.name, kind: "video", duration: 3, width: 1920, height: 1080,
      uri: "creative://studio.hao.creator-library/owner-visual%3Afixture", color: { interpretation: "auto", primaries: "bt709" } });
    expect(picked.previewUrl).toBe(picked.asset.uri);
    expect(provisionalCreativePick(listedVideo.id, { ...listedVideo, duration: undefined })).toBeUndefined();
    expect(provisionalCreativePick(listedVideo.id, { ...listedVideo, width: undefined })).toBeUndefined();
    expect(provisionalCreativePick("unsafe/id", { ...listedVideo, id: "unsafe/id" })).toBeUndefined();
  });

  it("adds a clip before native resolve/probe and prepares it in background", async () => {
    const f = fixture();
    await flush();
    const before = f.projectSession.getSnapshot().history.present.tracks[0]!.clips.length;
    await f.hook.importCreativeAsset(listedVideo.id);
    expect(f.onPicked).toHaveBeenCalledTimes(1);
    expect(f.projectSession.getSnapshot().history.present.tracks[0]!.clips).toHaveLength(before + 1);
    expect(f.api.importCreativeAsset).not.toHaveBeenCalled();
    const picked = f.onPicked.mock.calls[0]![0][0]!;
    expect(picked.asset.uri).toBe("creative://studio.hao.creator-library/owner-visual%3Afixture");
    await flush();
    expect(f.api.prepareMedia).toHaveBeenCalledExactlyOnceWith(picked.asset);
    f.preparation.resolve({ assetId: picked.asset.id, derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-09-04T00:00:00.000Z" },
      runtimeUrls: { [picked.asset.id]: "asset://verified-proxy" }, cacheHit: false });
    await flush();
    expect(f.onPrepared).toHaveBeenCalledTimes(1);
  });

  it("keeps one provisional clip on failure and retries validation without duplicating it", async () => {
    const f = fixture();
    await flush();
    await f.hook.importCreativeAsset(listedVideo.id);
    await flush();
    const picked = f.onPicked.mock.calls[0]![0][0]!, count = f.projectSession.getSnapshot().history.present.tracks[0]!.clips.length;
    f.preparation.reject(Error("hash mismatch"));
    await flush();
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("不會假裝成功"));
    const prepared = { assetId: picked.asset.id, derivatives: { sourceSha256: "b".repeat(64), generatedAt: "2026-09-04T00:00:00.000Z" },
      runtimeUrls: { [picked.asset.id]: "asset://retry-proxy" }, cacheHit: false } satisfies PrepareMediaResult;
    f.api.prepareMedia.mockResolvedValueOnce(prepared);
    await f.hook.retryFailedImports();
    expect(f.onPicked).toHaveBeenCalledTimes(1);
    expect(f.projectSession.getSnapshot().history.present.tracks[0]!.clips).toHaveLength(count);
    expect(f.onPrepared).toHaveBeenCalledExactlyOnceWith([prepared]);
  });

  it("falls back to native import when visual geometry is not listed", async () => {
    const f = fixture({ ...listedVideo, width: undefined });
    await flush();
    const operation = f.hook.importCreativeAsset(listedVideo.id);
    await flush();
    expect(f.api.importCreativeAsset).toHaveBeenCalledExactlyOnceWith(listedVideo.id);
    expect(f.onPicked).not.toHaveBeenCalled();
    f.nativePick.resolve({ asset: { ...f.project.assets[0]!, id: "native", uri: "creative://studio.hao.creator-library/owner-visual%3Afixture" }, previewUrl: "asset://native" });
    await operation;
    expect(f.onPicked).toHaveBeenCalledTimes(1);
  });
});
