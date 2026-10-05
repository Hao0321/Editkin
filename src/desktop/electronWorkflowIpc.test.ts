import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createElectronWorkflowServices, electronWorkflowPaths, ELECTRON_MEDIA_IMPORT_MAX_PATHS,
  ELECTRON_MEDIA_IMPORT_MAX_REQUESTS,
  ELECTRON_MEDIA_IMPORT_DEADLINE_MS, ELECTRON_MEDIA_IMPORT_MAX_ANCESTORS,
  registerElectronWorkflowIpc,
} from "../../electron/workflowIpc";
import { safeEmptyWorkflowProfile } from "../plugins/workflowProfileFileStore";
import type { MediaProbe } from "../render/ffmpegContracts";
import type { HaoDesktopApi } from "./types";
import { mediaProbeForDisplay } from "../render/mediaDisplayGeometry";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>(),
  expose: vi.fn<(name: string, api: HaoDesktopApi) => void>(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: bridge.expose }, ipcRenderer: { invoke: bridge.invoke },
}));

const ownedRoots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); bridge.invoke.mockResolvedValue({}); });
afterEach(async () => {
  for (const root of ownedRoots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("editkin-electron-workflow-")) {
      throw new Error("Refuse cleanup outside the owned isolated fixture");
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(now?: () => number) {
  const root = await mkdtemp(join(resolve(tmpdir()), "editkin-electron-workflow-"));
  ownedRoots.push(root);
  const userData = join(root, "userdata"), bundled = join(root, "bundled-plugins");
  await mkdir(userData); await mkdir(bundled);
  const paths = electronWorkflowPaths(userData, bundled);
  const inspect = vi.fn<(path: string, ffprobePath?: string) => Promise<MediaProbe>>(async () => ({
    duration: 2.5, width: 320, height: 180, hasVideo: true, hasAudio: true,
  }));
  const previewUrl = vi.fn((path: string) => `fixture-preview:${path}`);
  const openPath = vi.fn<(path: string) => Promise<string>>(async () => "");
  const services = createElectronWorkflowServices(paths, { ffprobePath: "fixture-ffprobe-not-executed", inspect, previewUrl, openPath,
    ...(now ? { now } : {}) });
  type Handler = Parameters<Parameters<typeof registerElectronWorkflowIpc>[0]>[1];
  const handlers = new Map<string, Handler>();
  // This registrar fixture checks payload routing only. Sender authorization
  // remains main.ts's real secureIpcHandle, not this synthetic event object.
  registerElectronWorkflowIpc((channel, handler) => { handlers.set(channel, handler); }, services);
  const call = (channel: string, payload?: unknown) => Promise.resolve().then(() => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unknown fixture handler ${channel}`);
    return Reflect.apply(handler, undefined, [{}, payload]);
  });
  return { root, paths, services, handlers, call, inspect, previewUrl, openPath };
}

function originalToolManifest(id: string) {
  return {
    schema: "editkin.plugin/v1", id, name: "Original isolated scale control", version: "1.0.0", minimumHostVersion: "0.15.0",
    publisher: { name: "Owned fixture" }, license: { spdx: "MIT", commercialUse: true }, permissions: ["project.write"],
    capabilities: [{
      id: "adjust", name: "Adjust", description: "Original bounded fixture", kind: "workflow_tool", automation: "full",
      semanticRoles: ["hook"], formats: ["shorts"], requires: [], avoidWhen: [],
      parameters: [{ id: "scale", name: "Scale", type: "number", default: 1.04, min: 1, max: 1.2 }],
      runtime: { type: "editgraph_commands", operations: [{ command: "update_clip_transform", template: { patch: { scale: "$parameter.scale" } } }] },
    }],
  };
}

async function writePlugin(root: string, id: string) {
  const pluginRoot = join(root, id);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(pluginRoot, "editkin-plugin.json"), JSON.stringify(originalToolManifest(id)));
}

describe("real Electron workflow service and payload boundary (isolated source fixtures)", () => {
  it("retains upright physical display ratio through the actual regular-file import producer", async () => {
    const f = await fixture(), selected = join(f.root, "non-square.mp4");
    await writeFile(selected, "isolated metadata-transfer fixture, not decoded media");
    f.inspect.mockResolvedValue(mediaProbeForDisplay({ duration: 9, width: 640, height: 360, encodedWidth: 640, encodedHeight: 360,
      hasVideo: true, hasAudio: true, sampleAspectRatio: 4 / 3, displayRotationDegrees: -90 }));
    const picked = await f.services.importMediaPaths([selected]);
    expect(picked[0]!.asset).toMatchObject({ uri: selected, duration: 9, width: 360, height: 640, displayAspectRatio: 27 / 64 });
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith(selected, "fixture-ffprobe-not-executed");
  });
  it("preload forwards four exact typed routes without accepting profile/plugin filesystem paths", async () => {
    vi.resetModules();
    await import("../../electron/preload");
    const [name, api] = bridge.expose.mock.calls[0]!;
    expect(name).toBe("haoDesktop");
    const paths = [join(resolve(tmpdir()), "selected.mp4")], profile = safeEmptyWorkflowProfile();
    await api.importMediaPaths(paths); await api.getWorkflowProfile();
    await api.saveWorkflowProfile(profile); await api.openPluginFolder();
    expect(bridge.invoke.mock.calls).toEqual([
      ["hao:import-media-paths", { paths }], ["hao:get-workflow-profile"],
      ["hao:save-workflow-profile", { profile }], ["hao:open-plugin-folder"],
    ]);
  });

  it("imports real isolated regular image/audio/video paths with truthful metadata and no probe overlap", async () => {
    const f = await fixture(), selected = [join(f.root, "source.MP4"), join(f.root, "voice.wav"), join(f.root, "art.png")];
    await Promise.all(selected.map(path => writeFile(path, "isolated non-decoder fixture")));
    let active = 0, maximum = 0;
    f.inspect.mockImplementation(async () => {
      active += 1; maximum = Math.max(maximum, active);
      await Promise.resolve(); active -= 1;
      return { duration: 2.5, width: 320, height: 180, hasVideo: true, hasAudio: true };
    });
    const picked = await f.services.importMediaPaths(selected);
    expect(picked.map(item => [item.asset.kind, item.asset.duration, item.asset.uri, item.previewUrl])).toEqual([
      ["video", 2.5, selected[0], `fixture-preview:${selected[0]}`],
      ["audio", 2.5, selected[1], `fixture-preview:${selected[1]}`],
      ["image", 5, selected[2], `fixture-preview:${selected[2]}`],
    ]);
    expect(new Set(picked.map(item => item.asset.id)).size).toBe(3); expect(maximum).toBe(1);
    expect(f.inspect.mock.calls.map(call => call[1])).toEqual(Array(3).fill("fixture-ffprobe-not-executed"));
  });

  it("serializes probes across two concurrent real IPC requests on the shared host service", async () => {
    const f = await fixture(), firstFile = join(f.root, "first.mp4"), secondFile = join(f.root, "second.mp4");
    await writeFile(firstFile, "fixture"); await writeFile(secondFile, "fixture");
    let active = 0, maximum = 0;
    f.inspect.mockImplementation(async () => {
      active += 1; maximum = Math.max(maximum, active);
      // Keep the isolated boundary pending across I/O turns; no actual decoder
      // is launched. The assertion is observed overlap, not a latency target.
      await new Promise<void>(done => setTimeout(done, 25));
      active -= 1;
      return { duration: 2.5, hasVideo: true, hasAudio: false };
    });
    const results = await Promise.all([
      f.call("hao:import-media-paths", { paths: [firstFile] }),
      f.call("hao:import-media-paths", { paths: [secondFile] }),
    ]);
    expect(results).toHaveLength(2); expect(f.inspect).toHaveBeenCalledTimes(2);
    expect(f.inspect.mock.calls.map(call => call[0])).toEqual([firstFile, secondFile]);
    expect(maximum).toBe(1); expect(active).toBe(0);
  });

  it("bounds eight retained media requests, bypasses empty selections and recovers only after actual settlement", async () => {
    const f = await fixture(), file = join(f.root, "selected.mp4"); await writeFile(file, "fixture");
    let release = () => {}, entered = () => {};
    const gate = new Promise<void>(done => { release = () => done(); });
    const started = new Promise<void>(done => { entered = () => done(); });
    f.inspect.mockImplementationOnce(async () => {
      entered(); await gate;
      return { duration: 2.5, hasVideo: true, hasAudio: false };
    });
    const first = f.services.importMediaPaths([file]);
    await started;
    let completed = 0;
    const queued = [first, ...Array.from({ length: ELECTRON_MEDIA_IMPORT_MAX_REQUESTS - 1 }, () => f.services.importMediaPaths([file]))];
    const observed = queued.map(request => request.then(result => { completed += 1; return result; }));
    let overflowState = "pending", emptyState = "pending", overflowError: unknown;
    const overflow = f.services.importMediaPaths([file]).then(() => { overflowState = "fulfilled"; }, error => {
      overflowState = "rejected"; overflowError = error;
    });
    const empty = f.services.importMediaPaths([]).then(result => { emptyState = "fulfilled"; return result; });
    try {
      // Observe immediate terminal requests without waiting on a broken queue
      // while the first probe is deliberately held. Finally always releases it.
      await Promise.resolve(); await Promise.resolve();
      expect(overflowState).toBe("rejected"); expect(overflowError).toBeInstanceOf(Error);
      expect(String(overflowError)).toMatch(/佇列/); expect(emptyState).toBe("fulfilled");
      expect(completed).toBe(0); expect(f.inspect).toHaveBeenCalledTimes(1);
    } finally {
      release(); await Promise.all([...observed, overflow, empty]);
    }
    await expect(empty).resolves.toEqual([]);
    expect(completed).toBe(8); expect(f.inspect).toHaveBeenCalledTimes(8);
    await expect(f.services.importMediaPaths([file])).resolves.toHaveLength(1);
    expect(f.inspect).toHaveBeenCalledTimes(9);
  });

  it.each([
    { name: "non-array", value: null }, { name: "non-string", value: [1] },
    { name: "relative", value: ["relative.mp4"] }, { name: "URL", value: ["https://example.invalid/source.mp4"] },
    { name: "UNC", value: ["\\\\unreachable.invalid\\share\\source.mp4"] },
    { name: "device", value: ["\\\\.\\C:\\source.mp4"] },
    { name: "embedded NUL", value: [join(resolve(tmpdir()), "bad\0.mp4")] },
    { name: "overlong", value: [join(resolve(tmpdir()), "x".repeat(4097) + ".mp4")] },
    { name: "oversized batch", value: Array(257).fill(join(resolve(tmpdir()), "source.mp4")) },
  ])("rejects $name before a probe or preview URL can be approved", async ({ value }) => {
    const f = await fixture();
    await expect(f.services.importMediaPaths(value)).rejects.toThrow();
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.previewUrl).not.toHaveBeenCalled();
  });

  it("validates the complete batch before any probe, including unsupported, directory and missing paths", async () => {
    const f = await fixture(), valid = join(f.root, "valid.mp4"), unsupported = join(f.root, "bad.exe"), directory = join(f.root, "directory.mp4");
    await writeFile(valid, "fixture"); await writeFile(unsupported, "fixture"); await mkdir(directory);
    for (const invalid of [unsupported, directory, join(f.root, "missing.mp4")]) {
      await expect(f.services.importMediaPaths([valid, invalid])).rejects.toThrow();
    }
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.previewUrl).not.toHaveBeenCalled();
  });

  it("rejects a real owned ancestor junction with an otherwise regular selected file before probing", async () => {
    const f = await fixture(), target = join(f.root, "target"), alias = join(f.root, "ancestor-alias");
    await mkdir(target); await writeFile(join(target, "selected.mp4"), "fixture");
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    const selected = join(alias, "selected.mp4");
    // A leaf-only lstat really sees an ordinary file here. The new rejection
    // must come from its ancestor, not borrowed from a leaf-link control.
    expect((await lstat(selected)).isFile()).toBe(true);
    await expect(f.services.importMediaPaths([selected])).rejects.toThrow(/祖先/);
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.previewUrl).not.toHaveBeenCalled();
  });

  it("blocks ancestor replacement during a probe while allowing unrelated sibling changes", async () => {
    const f = await fixture(), parent = join(f.root, "ordinary"), selected = join(parent, "selected.mp4");
    await mkdir(parent); await writeFile(selected, "fixture");
    f.inspect.mockImplementationOnce(async () => {
      await writeFile(join(parent, "unrelated.txt"), "ordinary sibling mutation");
      return { duration: 2.5, hasVideo: true, hasAudio: false };
    });
    await expect(f.services.importMediaPaths([selected])).resolves.toHaveLength(1);
    f.previewUrl.mockClear();
    f.inspect.mockImplementationOnce(async () => {
      await rename(parent, join(f.root, "retained-old-parent"));
      await mkdir(parent); await writeFile(selected, "fixture");
      return { duration: 2.5, hasVideo: true, hasAudio: false };
    });
    await expect(f.services.importMediaPaths([selected])).rejects.toThrow(/祖先.*替換/);
    expect(f.previewUrl).not.toHaveBeenCalled();
  });

  it("bounds ancestor depth before touching a nonexistent deep path", async () => {
    const f = await fixture(), selected = join(f.root, ...Array(ELECTRON_MEDIA_IMPORT_MAX_ANCESTORS).fill("nested"), "selected.mp4");
    await expect(f.services.importMediaPaths([selected])).rejects.toThrow(/目錄鏈/);
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.previewUrl).not.toHaveBeenCalled();
  });

  it("includes queue wait in the cooperative deadline and keeps the actual probe slot until settlement", async () => {
    let clock = 0;
    const f = await fixture(() => clock), selected = join(f.root, "selected.mp4"); await writeFile(selected, "fixture");
    let release = () => {}, entered = () => {}, settled = 0;
    const gate = new Promise<void>(done => { release = () => done(); });
    const started = new Promise<void>(done => { entered = () => done(); });
    f.inspect.mockImplementationOnce(async () => {
      entered(); await gate;
      return { duration: 2.5, hasVideo: true, hasAudio: false };
    });
    const first = f.services.importMediaPaths([selected]).then(() => { settled += 1; return undefined; }, error => { settled += 1; return error; });
    await started;
    const queued = f.services.importMediaPaths([selected]).then(() => { settled += 1; return undefined; }, error => { settled += 1; return error; });
    clock = ELECTRON_MEDIA_IMPORT_DEADLINE_MS;
    try {
      await Promise.resolve();
      expect(settled).toBe(0); expect(f.inspect).toHaveBeenCalledTimes(1);
    } finally { release(); }
    const results = await Promise.all([first, queued]);
    for (const error of results) { expect(error).toBeInstanceOf(Error); expect(String(error)).toMatch(/120 秒/); }
    expect(f.inspect).toHaveBeenCalledTimes(1); expect(f.previewUrl).not.toHaveBeenCalled();
    clock += 1;
    await expect(f.services.importMediaPaths([selected])).resolves.toHaveLength(1);
    expect(f.inspect).toHaveBeenCalledTimes(2);
  });

  it("rejects a request already expired at entry before filesystem validation or a probe", async () => {
    const clock = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValue(ELECTRON_MEDIA_IMPORT_DEADLINE_MS);
    const f = await fixture(clock);
    await expect(f.services.importMediaPaths([join(f.root, "nonexistent.mp4")])).rejects.toThrow(/120 秒/);
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.previewUrl).not.toHaveBeenCalled();
  });

  it("honors the 256-path bound and an empty canceled selection without launching concurrent probes", async () => {
    const f = await fixture(), file = join(f.root, "selected.mp4"); await writeFile(file, "fixture");
    await expect(f.services.importMediaPaths([])).resolves.toEqual([]);
    const picked = await f.services.importMediaPaths(Array(ELECTRON_MEDIA_IMPORT_MAX_PATHS).fill(file));
    expect(picked).toHaveLength(256); expect(new Set(picked.map(item => item.asset.id)).size).toBe(256);
    expect(f.inspect).toHaveBeenCalledTimes(256);
  });

  it("propagates a probe failure or invalid duration without inventing a successful asset", async () => {
    const f = await fixture(), file = join(f.root, "selected.mp4"); await writeFile(file, "fixture");
    f.inspect.mockRejectedValueOnce(new Error("actual probe failed"));
    await expect(f.services.importMediaPaths([file])).rejects.toThrow("actual probe failed");
    f.inspect.mockResolvedValueOnce({ duration: Number.NaN, hasVideo: true, hasAudio: false });
    await expect(f.services.importMediaPaths([file])).rejects.toThrow("duration");
    expect(f.previewUrl).not.toHaveBeenCalled();
    await expect(f.services.importMediaPaths([file])).resolves.toHaveLength(1);
  });

  it("rejects injected path/extra-field/malformed payloads before filesystem or shell work", async () => {
    const f = await fixture(), profile = safeEmptyWorkflowProfile();
    for (const [channel, payload] of [
      ["hao:get-workflow-profile", { path: join(f.root, "injected.json") }],
      ["hao:open-plugin-folder", { path: f.root }],
      ["hao:save-workflow-profile", { profile, path: join(f.root, "injected.json") }],
      ["hao:save-workflow-profile", { unrelated: profile }],
      ["hao:import-media-paths", { paths: [], extra: true }],
      ["hao:import-media-paths", []],
    ]) await expect(f.call(String(channel), payload)).rejects.toThrow();
    expect(await readdir(dirname(f.paths.userPluginRoot))).toEqual([]);
    expect(f.openPath).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled();
  });

  it("atomically saves and reopens the fixed private profile with serialized requests", async () => {
    const f = await fixture(), first = { ...safeEmptyWorkflowProfile(), revision: 2 }, second = { ...safeEmptyWorkflowProfile(), revision: 3 };
    expect(await f.services.getWorkflowProfile()).toEqual({ configured: true, path: f.paths.workflowProfilePath, profile: safeEmptyWorkflowProfile() });
    const [savedFirst, savedSecond] = await Promise.all([f.services.saveWorkflowProfile(first), f.services.saveWorkflowProfile(second)]);
    expect(savedFirst.profile).toEqual(first); expect(savedSecond.profile).toEqual(second);
    expect(await f.services.getWorkflowProfile()).toEqual({ configured: true, path: f.paths.workflowProfilePath, profile: second });
    expect(JSON.parse(await readFile(f.paths.workflowProfilePath, "utf8"))).toEqual(second);
    expect(await readdir(dirname(f.paths.workflowProfilePath))).toEqual(["workflow-profile.json"]);
  });

  it("uses the same actual bundled/user registry for discovery, compilation and exact profile grants", async () => {
    const f = await fixture();
    await writePlugin(f.paths.pluginRoots[0]!, "test.original.bundled");
    await writePlugin(f.paths.userPluginRoot, "test.original.user");
    const registry = await f.services.readPluginRegistry(), user = registry.plugins.find(plugin => plugin.manifest.id === "test.original.user");
    if (!user) throw new Error("Actual user plugin fixture was not discovered");
    expect(registry.plugins.map(plugin => plugin.manifest.id)).toEqual(["test.original.bundled", "test.original.user"]);
    expect(await f.services.compilePluginTool(user.manifest.id, "adjust", "clip-original", { scale: 1.12 })).toEqual([
      { type: "update_clip_transform", clipId: "clip-original", patch: { scale: 1.12 } },
    ]);
    const profile = { ...safeEmptyWorkflowProfile(), pluginGrants: [{ pluginId: user.manifest.id,
      manifestSha256: user.manifestSha256, capabilityIds: ["adjust"], permissions: ["project.write"] }] };
    await expect(f.services.saveWorkflowProfile(profile)).resolves.toMatchObject({ configured: true, profile });
    const saved = await readFile(f.paths.workflowProfilePath, "utf8");
    await expect(f.services.saveWorkflowProfile({ ...profile, pluginGrants: [{ ...profile.pluginGrants[0], manifestSha256: "0".repeat(64) }] })).rejects.toThrow(/identity/);
    await expect(f.services.saveWorkflowProfile({ ...profile, enabledSkills: ["unknown.skill"], priority: ["unknown.skill"] })).rejects.toThrow();
    expect(await readFile(f.paths.workflowProfilePath, "utf8")).toBe(saved);
    await expect(f.services.compilePluginTool(user.manifest.id, "adjust", "clip-original", { scale: 99 })).rejects.toThrow();
  });

  it("bounds the profile operation queue and retains ordinary operations after rejection", async () => {
    const f = await fixture(), queued = Array.from({ length: 32 }, () => f.services.getWorkflowProfile());
    await expect(f.services.getWorkflowProfile()).rejects.toThrow(/佇列/);
    await Promise.all(queued);
    await expect(f.services.saveWorkflowProfile({ ...safeEmptyWorkflowProfile(), revision: 2 })).resolves.toMatchObject({ configured: true });
  });

  it("opens only the actual fixed user folder and retains shell errors as failures", async () => {
    const f = await fixture();
    expect(await f.call("hao:open-plugin-folder")).toEqual({ path: f.paths.userPluginRoot, opened: true });
    expect((await lstat(f.paths.userPluginRoot)).isDirectory()).toBe(true);
    expect(f.openPath).toHaveBeenCalledWith(f.paths.userPluginRoot);
    f.openPath.mockResolvedValueOnce("OS refused folder");
    await expect(f.services.openPluginFolder()).rejects.toThrow("OS refused folder");
  });

  it("rejects an owned user-folder junction/symlink rather than opening its redirected target", async () => {
    const f = await fixture(), redirected = join(f.root, "redirected"); await mkdir(redirected);
    await symlink(redirected, f.paths.userPluginRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(f.services.openPluginFolder()).rejects.toThrow(/一般資料夾/);
    expect(f.openPath).not.toHaveBeenCalled();
  });
});
