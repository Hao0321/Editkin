import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HaoDesktopApi } from "./types";

const ipc = vi.hoisted(() => ({
  tauriInvoke: vi.fn(), electronInvoke: vi.fn(), readFont: vi.fn(), expose: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ready: undefined as (() => Promise<void>) | undefined,
  app: { isPackaged: true, getAppPath: vi.fn(), getPath: vi.fn(), getVersion: vi.fn(), quit: vi.fn(), on: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.tauriInvoke, convertFileSrc: (path: string) => path, Channel: class {} }));
vi.mock("../render/bundledFontSource", () => ({ readBundledFontFace: ipc.readFont }));
vi.mock("../../electron/batchIpc", () => ({ registerBatchIpc: vi.fn() }));
vi.mock("../../electron/updateIpc", () => ({ registerUpdateIpc: vi.fn(), launchRollbackInstaller: vi.fn() }));
vi.mock("../application/updateManager", async importOriginal => ({
  ...await importOriginal<typeof import("../application/updateManager")>(), readUpdateTransaction: vi.fn(async () => undefined),
}));
vi.mock("electron", () => ({
  app: { ...ipc.app, whenReady: () => ({ then: (callback: () => Promise<void>) => { ipc.ready = callback; } }) },
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), session: { setPermissionRequestHandler: vi.fn() } };
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async () => undefined);
  },
  dialog: {}, net: {}, protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  ipcMain: { handle: (channel: string, callback: (...args: unknown[]) => unknown) => { ipc.handlers.set(channel, callback); } },
  ipcRenderer: { invoke: ipc.electronInvoke }, contextBridge: { exposeInMainWorld: ipc.expose },
}));

const appPath = resolve("selected-font-electron-fixture-not-written");
const resourceRoot = join(appPath, "resources");
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const authenticBinaryShape = new Uint8Array([0, 1, 127, 255]);
beforeEach(() => {
  vi.clearAllMocks(); vi.resetModules(); ipc.handlers.clear(); ipc.ready = undefined;
  ipc.app.getAppPath.mockReturnValue(appPath); ipc.app.getPath.mockReturnValue(join(appPath, "userdata")); ipc.app.getVersion.mockReturnValue("fixture-only");
  ipc.readFont.mockResolvedValue(authenticBinaryShape); ipc.tauriInvoke.mockResolvedValue(undefined); ipc.electronInvoke.mockResolvedValue(authenticBinaryShape);
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: resourceRoot });
  vi.stubEnv("HAO_EDITOR_SMOKE", ""); vi.stubEnv("HAO_EDITOR_DEV_URL", "");
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  else Reflect.deleteProperty(process, "resourcesPath");
});

function sender(url = pathToFileURL(join(appPath, "dist", "index.html")).href) {
  return { senderFrame: { url }, sender: { getURL: () => url } };
}
async function registeredElectronHandler() {
  await import("../../electron/main");
  expect(ipc.ready).toBeTypeOf("function");
  await ipc.ready!();
  const handler = ipc.handlers.get("hao:read-bundled-font-face");
  expect(handler).toBeTypeOf("function");
  return handler!;
}

describe("selected font desktop binary adapters (source wiring, not actual native IPC)", () => {
  it("Tauri forwards only faceId and converts an actual ArrayBuffer without JSON/base64 or a service child", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    await import("./tauriBridge");
    const api = (window as unknown as { haoDesktop: HaoDesktopApi }).haoDesktop;
    ipc.tauriInvoke.mockClear(); ipc.tauriInvoke.mockResolvedValueOnce(authenticBinaryShape.slice().buffer);
    const bytes = await api.readBundledFontFace!("EditkinFace-noto-sans-tc-700");
    expect(bytes).toBeInstanceOf(Uint8Array); expect([...bytes]).toEqual([...authenticBinaryShape]);
    expect(ipc.tauriInvoke.mock.calls).toEqual([["read_bundled_font_face", { faceId: "EditkinFace-noto-sans-tc-700" }]]);
    ipc.tauriInvoke.mockResolvedValueOnce(new ArrayBuffer(1)); await api.readMesh3dFont!(900);
    expect(ipc.tauriInvoke).toHaveBeenLastCalledWith("read_mesh_3d_font", { weight: 900 });
  });

  it.each([{ label: "JSON array", response: [1, 2] }, { label: "base64", response: "AAE=" },
    { label: "null", response: null }, { label: "typed view", response: new Uint8Array([1, 2]) },
    { label: "empty", response: new ArrayBuffer(0) }, { label: "oversized", response: new ArrayBuffer(16 * 1024 * 1024 + 1) }])("Tauri refuses a non-ArrayBuffer or unbounded result ($label)", async ({ response }) => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }); await import("./tauriBridge");
    ipc.tauriInvoke.mockResolvedValueOnce(response);
    await expect((window as unknown as { haoDesktop: HaoDesktopApi }).haoDesktop.readBundledFontFace!("EditkinFace-bebas-neue-400")).rejects.toThrow(/binary bytes/);
  });

  it("Electron preload copies Uint8Array and keeps the old 3D request unchanged", async () => {
    await import("../../electron/preload");
    const [name, api] = ipc.expose.mock.calls[0] as [string, HaoDesktopApi];
    expect(name).toBe("haoDesktop");
    const bytes = await api.readBundledFontFace!("EditkinFace-fredoka-700");
    expect(bytes).toBeInstanceOf(Uint8Array); expect(bytes).not.toBe(authenticBinaryShape);
    expect([...bytes]).toEqual([...authenticBinaryShape]);
    expect(ipc.electronInvoke).toHaveBeenLastCalledWith("hao:read-bundled-font-face", { faceId: "EditkinFace-fredoka-700" });
    await api.readMesh3dFont!(700);
    expect(ipc.electronInvoke).toHaveBeenLastCalledWith("hao:read-mesh-3d-font", { weight: 700 });
  });

  it("Electron copies only a Buffer view's bytes and retains neither its pool nor later changes", async () => {
    const backing = Buffer.from([99, 0, 1, 127, 255, 99]), view = backing.subarray(1, 5);
    ipc.electronInvoke.mockResolvedValueOnce(view); await import("../../electron/preload");
    const api = ipc.expose.mock.calls[0][1] as HaoDesktopApi;
    const bytes = await api.readBundledFontFace!("EditkinFace-bebas-neue-400");
    expect(bytes).toBeInstanceOf(Uint8Array); expect(Buffer.isBuffer(bytes)).toBe(false);
    expect([...bytes]).toEqual([0, 1, 127, 255]); expect(bytes.buffer.byteLength).toBe(4);
    backing.fill(42); expect([...bytes]).toEqual([0, 1, 127, 255]);
  });

  it("Electron accepts a genuine foreign-realm byte view without relying on instanceof at the IPC boundary", async () => {
    const foreign: unknown = runInNewContext("new Uint8Array([0, 1, 127, 255])");
    expect(foreign instanceof Uint8Array).toBe(false); expect(ArrayBuffer.isView(foreign)).toBe(true);
    ipc.electronInvoke.mockResolvedValueOnce(foreign); await import("../../electron/preload");
    const api = ipc.expose.mock.calls[0][1] as HaoDesktopApi;
    const bytes = await api.readBundledFontFace!("EditkinFace-bebas-neue-400");
    expect(bytes).toBeInstanceOf(Uint8Array); expect([...bytes]).toEqual([...authenticBinaryShape]);
  });

  it.each([{ label: "JSON array", response: [1, 2] }, { label: "base64", response: "AAE=" },
    { label: "null", response: null }, { label: "empty", response: new Uint8Array() },
    { label: "wrong element type", response: new Uint16Array([1, 2]) },
    { label: "DataView", response: new DataView(new ArrayBuffer(4)) },
    { label: "oversized", response: new Uint8Array(16 * 1024 * 1024 + 1) },
    { label: "spoofed view", response: { [Symbol.toStringTag]: "Uint8Array", buffer: new ArrayBuffer(2), byteOffset: 0, byteLength: 2 } }])(
    "Electron rejects non-binary or unbounded result ($label)", async ({ response }) => {
      ipc.electronInvoke.mockResolvedValueOnce(response); await import("../../electron/preload");
      const api = ipc.expose.mock.calls[0][1] as HaoDesktopApi;
      await expect(api.readBundledFontFace!("EditkinFace-bebas-neue-400")).rejects.toThrow(/bounded binary bytes/);
    });

  it("Electron main uses its packaged resource root and the shared reader for a trusted packaged UI", async () => {
    const handler = await registeredElectronHandler();
    expect(await handler(sender(), { faceId: "EditkinFace-bebas-neue-400" })).toBe(authenticBinaryShape);
    expect(ipc.readFont.mock.calls).toEqual([[join(resourceRoot, "font-packs", "editkin-open-fonts"), "EditkinFace-bebas-neue-400"]]);
  });

  it.each(["https://example.test/index.html", pathToFileURL(join(appPath, "outside.html")).href])(
    "Electron rejects untrusted sender %s before selected-font I/O", async url => {
      const handler = await registeredElectronHandler();
      expect(() => handler(sender(url), { faceId: "EditkinFace-bebas-neue-400" })).toThrow(/拒絕/);
      expect(ipc.readFont).not.toHaveBeenCalled();
    });

  it.each(["root", "path", "url", "sha256"])("Electron rejects request-supplied %s even from its trusted UI", async key => {
    const handler = await registeredElectronHandler();
    await expect(handler(sender(), { faceId: "EditkinFace-bebas-neue-400", [key]: "caller-controlled" })).rejects.toThrow(/only faceId/);
    expect(ipc.readFont).not.toHaveBeenCalled();
  });

  it.each([{ label: "null", payload: null }, { label: "empty", payload: {} },
    { label: "number", payload: { faceId: 700 } }, { label: "array", payload: ["EditkinFace-bebas-neue-400"] }])("Electron rejects malformed identity payload ($label) before I/O", async ({ payload }) => {
    const handler = await registeredElectronHandler();
    await expect(handler(sender(), payload)).rejects.toThrow(/only faceId/);
    expect(ipc.readFont).not.toHaveBeenCalled();
  });
});
