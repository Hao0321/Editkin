import { describe, expect, it, vi } from "vitest";
vi.mock("react", () => ({
  useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
}));
import { createProjectSession } from "../application/projectSession";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import type { HaoDesktopApi, PickedMedia, PrepareMediaResult } from "./types";
import type { EditorCommand } from "../domain/commands";
import { useCreativeLibrary } from "./useCreativeLibrary";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const project = createDemoProject();
  const projectSession = createProjectSession(project);
  const pick = deferred<PickedMedia[]>();
  const creativePick = deferred<PickedMedia>();
  const prepare = deferred<PrepareMediaResult>();
  const plugin = deferred<EditorCommand[]>();
  const api = {
    pickMedia: vi.fn(() => pick.promise), importMediaPaths: vi.fn(() => pick.promise),
    importCreativeAsset: vi.fn(() => creativePick.promise), prepareMedia: vi.fn(() => prepare.promise),
    compilePluginTool: vi.fn(() => plugin.promise),
  };
  const item: PickedMedia = { asset: { ...project.assets[0], id: "incoming", uri: "D:/fixture-only/media.mp4" }, previewUrl: "fixture://preview" };
  const prepared: PrepareMediaResult = { assetId: item.asset.id, derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-08-31T00:00:00.000Z" }, runtimeUrls: { [item.asset.id]: "fixture://proxy" }, cacheHit: false };
  const onPicked = vi.fn((items: PickedMedia[]) => {
    for (const picked of items) projectSession.setHistory(history => dispatchCommand(history, { type: "import_asset", asset: picked.asset }));
  });
  const onPrepared = vi.fn();
  const onStatus = vi.fn();
  const onCommands = vi.fn((commands: EditorCommand[]) => projectSession.setHistory(history => dispatchCommand(history, { type: "batch", commands })));
  const options = { api: api as unknown as HaoDesktopApi, projectSession, onPicked, onPrepared, onStatus, onCommands };
  const hook = useCreativeLibrary(options);
  return { projectSession, pick, creativePick, prepare, plugin, api, item, prepared, onPicked, onPrepared, onStatus, onCommands, hook };
}

describe("creative library deferred callback ownership (mock React state, real hook functions/store)", () => {
  it.each(["picker", "drop", "creative"])("ignores a late %s import after same-id project replacement", async source => {
    const f = fixture();
    const task = source === "picker" ? f.hook.importDesktopMedia() : source === "drop" ? f.hook.importDesktopPaths([f.item.asset.uri]) : f.hook.importCreativeAsset("fixture-asset");
    const original = f.projectSession.getSnapshot().history.present;
    f.projectSession.replaceProject({ ...original, name: "New session" });
    f.onStatus.mockClear();
    f.prepare.resolve(f.prepared);
    if (source === "creative") f.creativePick.resolve(f.item); else f.pick.resolve([f.item]);
    await task;
    expect(f.onPicked).not.toHaveBeenCalled();
    expect(f.onPrepared).not.toHaveBeenCalled();
    expect(f.onStatus).not.toHaveBeenCalled();
    expect(f.projectSession.getSnapshot().history.present.assets.some(asset => asset.id === f.item.asset.id)).toBe(false);
  });

  it("ignores late proxy completion after project replacement", async () => {
    const f = fixture();
    const task = f.hook.importDesktopMedia();
    f.pick.resolve([f.item]);
    await Promise.resolve();
    expect(f.onPicked).not.toHaveBeenCalled();
    f.projectSession.replaceProject({ ...f.projectSession.getSnapshot().history.present, name: "Reopened same IDs" });
    f.onStatus.mockClear();
    f.prepare.resolve(f.prepared);
    await task;
    expect(f.onPrepared).not.toHaveBeenCalled();
    expect(f.onStatus).not.toHaveBeenCalled();
  });

  it("keeps additive imports valid during same-session edits and applies prepared media once", async () => {
    const f = fixture();
    const task = f.hook.importDesktopMedia();
    f.projectSession.setHistory(history => dispatchCommand(history, { type: "rename_project", name: "Still editing" }));
    f.pick.resolve([f.item]);
    f.prepare.resolve(f.prepared);
    await task;
    expect(f.onPicked).toHaveBeenCalledTimes(1);
    expect(f.onPrepared).toHaveBeenCalledExactlyOnceWith([f.prepared]);
    expect(f.projectSession.getSnapshot().history.present.name).toBe("Still editing");
  });

  it("commits a verified creative-library item before its background proxy finishes", async () => {
    const f = fixture();
    const task = f.hook.importCreativeAsset("fixture-asset");
    f.creativePick.resolve(f.item);
    await task;
    expect(f.onPicked).toHaveBeenCalledExactlyOnceWith([f.item], { backgroundMusic: false });
    expect(f.onPrepared).not.toHaveBeenCalled();
    f.prepare.resolve(f.prepared);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(f.onPrepared).toHaveBeenCalledExactlyOnceWith([f.prepared]);
  });

  it("does not apply proxy metadata to a removed or relinked asset", async () => {
    const f = fixture();
    f.onPicked.mockImplementation(items=>{for(const picked of items)f.projectSession.setHistory(history=>dispatchCommand(history,{type:"import_asset",asset:{...picked.asset,uri:"D:/fixture-only/relinked.mp4"}}));});
    const task = f.hook.importDesktopMedia();
    f.pick.resolve([f.item]);
    await Promise.resolve();
    f.projectSession.setHistory(history => ({ ...history, present: { ...history.present, assets: history.present.assets.map(asset => asset.id === f.item.asset.id ? { ...asset, uri: "D:/fixture-only/relinked.mp4" } : asset) } }));
    f.prepare.resolve(f.prepared);
    await task;
    expect(f.onPrepared).not.toHaveBeenCalled();
  });

  it.each(["edit", "same-id replacement"])("rejects plugin commands after %s", async change => {
    const f = fixture();
    const task = f.hook.invokePluginTool("fixture", "rename", "clip-demo");
    if (change === "edit") f.projectSession.setHistory(history => dispatchCommand(history, { type: "rename_project", name: "Keep edit" }));
    else f.projectSession.replaceProject({ ...f.projectSession.getSnapshot().history.present, name: "Keep session" });
    f.onStatus.mockClear();
    f.plugin.resolve([{ type: "rename_project", name: "STALE PLUGIN" }]);
    await task;
    expect(f.onCommands).not.toHaveBeenCalled();
    expect(f.projectSession.getSnapshot().history.present.name).not.toBe("STALE PLUGIN");
    if (change === "same-id replacement") expect(f.onStatus).not.toHaveBeenCalled();
  });

  it("valid plugin survives save acknowledgment but duplicate starts issue one request", async () => {
    const f = fixture();
    const task = f.hook.invokePluginTool("fixture", "rename", "clip-demo");
    const duplicate = f.hook.invokePluginTool("fixture", "rename", "clip-demo");
    const save = f.projectSession.beginSave()!;
    f.projectSession.completeSave(save, { path: "D:/fixture-only/saved.json", project: { ...save.project, revision: 1 } });
    f.projectSession.finishSave(save);
    f.plugin.resolve([{ type: "rename_project", name: "Valid plugin" }]);
    await Promise.all([task, duplicate]);
    expect(f.api.compilePluginTool).toHaveBeenCalledTimes(1);
    expect(f.onCommands).toHaveBeenCalledTimes(1);
    expect(f.projectSession.getSnapshot().history.present.name).toBe("Valid plugin");
  });

  it("does not publish an old import error into a new project", async () => {
    const f = fixture();
    const task = f.hook.importDesktopMedia();
    f.projectSession.replaceProject(createDemoProject());
    f.onStatus.mockClear();
    f.pick.reject("old native failure");
    await task;
    expect(f.onStatus).not.toHaveBeenCalled();
  });
});
