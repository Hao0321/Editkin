import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StagedUpdate } from "../src/application/updateManager";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: vi.fn(), getPath: vi.fn(), quit: vi.fn() },
  showMessageBox: vi.fn(), fetch: vi.fn(), spawn: vi.fn(), stageUpdate: vi.fn(),
  verifyStagedUpdateCache: vi.fn(), createUpdateTransaction: vi.fn(), readUpdateTransaction: vi.fn(),
}));
vi.mock("electron", () => ({ app: mocks.app, dialog: { showMessageBox: mocks.showMessageBox }, ipcMain: {} }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/application/updateManager", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/application/updateManager")>(),
  stageUpdate: mocks.stageUpdate, createUpdateTransaction: mocks.createUpdateTransaction,
  readUpdateTransaction: mocks.readUpdateTransaction,
}));
vi.mock("../src/application/updateCache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/application/updateCache")>(),
  verifyStagedUpdateCache: mocks.verifyStagedUpdateCache,
}));
import { registerUpdateIpc } from "../electron/updateIpc";

type Handler = (...args: unknown[]) => Promise<Record<string, unknown>>;
type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; unref: ReturnType<typeof vi.fn> };
const handlers = new Map<string, Handler>();
const userData = join(process.cwd(), "isolated-ipc-fixture-not-written");
const cacheRoot = join(userData, "updates");
let nextVersion = "2.0.0";
let records: Record<string, StagedUpdate>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() });
}

function finishSignature(child: FakeChild, status = "Valid") {
  child.stdout.write(JSON.stringify({ Status: status, Subject: "CN=Editkin Test", CertificateSha256: "c".repeat(64) }));
  child.emit("exit", 0);
  child.emit("close", 0);
}

function defaultSpawn(path: string): FakeChild {
  const child = fakeChild();
  queueMicrotask(() => path === "powershell.exe" ? finishSignature(child) : child.emit("spawn"));
  return child;
}

function staged(version: string, digest: string): StagedUpdate {
  return { version, artifactPath: join(cacheRoot, `sha256-${digest.repeat(64)}`, "installer.exe"),
    sha256: digest.repeat(64), size: 16, cacheHit: false,
    signatureSubject: "CN=Editkin Test", signatureSha256: "c".repeat(64) };
}

function response(version = nextVersion) {
  const selected = records[version] ?? records["2.0.0"];
  return new Response(JSON.stringify({ schemaVersion: 1, version, publishedAt: "2026-08-31T00:00:00Z", minimumProjectSchema: 6,
    windowsX64: { url: "https://updates.example/installer.exe", sha256: selected.sha256, size: selected.size,
      signatureSubject: selected.signatureSubject, signatureSha256: selected.signatureSha256 } }));
}

const check = (options?: { download?: boolean }) => handlers.get("hao:check-updates")!({}, options);
const install = () => handlers.get("hao:install-update")!({});
const installerCalls = () => mocks.spawn.mock.calls.filter(([path]) => path !== "powershell.exe");

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubEnv("EDITKIN_UPDATE_MANIFEST_URL", "https://updates.example/stable.json");
  vi.stubEnv("HAO_EDITOR_ALLOW_UNSIGNED_UPDATES", "");
  vi.stubEnv("HAO_EDITOR_PREVIOUS_INSTALLER", "");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.app.isPackaged = true;
  mocks.app.getVersion.mockReturnValue("1.0.0");
  mocks.app.getPath.mockReturnValue(userData);
  records = { "2.0.0": staged("2.0.0", "a"), "3.0.0": staged("3.0.0", "b") };
  nextVersion = "2.0.0";
  mocks.fetch.mockImplementation(async () => response());
  mocks.stageUpdate.mockImplementation(async (input: { version: string }) => records[input.version]);
  mocks.verifyStagedUpdateCache.mockResolvedValue(undefined);
  mocks.createUpdateTransaction.mockResolvedValue({});
  mocks.readUpdateTransaction.mockResolvedValue(undefined);
  mocks.showMessageBox.mockResolvedValue({ response: 0 });
  mocks.spawn.mockImplementation(defaultSpawn);
  handlers.clear();
  registerUpdateIpc((channel, listener) => handlers.set(channel, listener as unknown as Handler));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Electron updater fixed selection and operation ownership", () => {
  it("serializes checks and refuses install while a check is pending", async () => {
    const waiting = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(waiting.promise);
    const first = check();
    expect(await check()).toMatchObject({ status: "busy" });
    expect(await install()).toMatchObject({ started: false });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    waiting.resolve(response());
    expect(await first).toMatchObject({ status: "ready", version: "2.0.0" });
    expect(mocks.stageUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(["initial-byte-check", "signature", "confirmation", "transaction", "final-byte-check"])(
    "cannot change selection or duplicate install during %s", async (phase) => {
      const selected = { ...records["2.0.0"] };
      expect(await check()).toMatchObject({ status: "ready" });
      const entered = deferred();
      const release = deferred();
      const hold = async () => { entered.resolve(); await release.promise; };
      if (phase === "initial-byte-check") mocks.verifyStagedUpdateCache.mockImplementationOnce(hold);
      if (phase === "final-byte-check") mocks.verifyStagedUpdateCache.mockResolvedValueOnce(undefined).mockImplementationOnce(hold);
      if (phase === "signature") mocks.spawn.mockImplementation((path: string) => {
        if (path !== "powershell.exe") return defaultSpawn(path);
        const child = fakeChild();
        entered.resolve();
        void release.promise.then(() => finishSignature(child));
        return child;
      });
      if (phase === "confirmation") mocks.showMessageBox.mockImplementationOnce(async () => { await hold(); return { response: 0 }; });
      if (phase === "transaction") mocks.createUpdateTransaction.mockImplementationOnce(hold);
      const installing = install();
      await entered.promise;
      nextVersion = "3.0.0";
      expect(await check()).toMatchObject({ status: "busy" });
      expect(await install()).toMatchObject({ started: false });
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(mocks.stageUpdate).toHaveBeenCalledTimes(1);
      release.resolve();
      expect(await installing).toMatchObject({ started: true });
      expect(mocks.showMessageBox.mock.calls[0][0].message).toContain("2.0.0");
      expect(mocks.spawn.mock.calls.find(([path]) => path === "powershell.exe")?.[2].env.HAO_UPDATE_SIGNATURE_TARGET).toBe(selected.artifactPath);
      expect(mocks.createUpdateTransaction.mock.calls[0][1]).toMatchObject({ toVersion: selected.version, stagedArtifact: selected.artifactPath });
      expect(mocks.verifyStagedUpdateCache).toHaveBeenCalledTimes(2);
      const snapshots = mocks.verifyStagedUpdateCache.mock.calls.map((call) => call[1]);
      expect(snapshots[0]).toEqual(selected);
      expect(snapshots[1]).toBe(snapshots[0]);
      expect(Object.isFrozen(snapshots[0])).toBe(true);
      expect(mocks.verifyStagedUpdateCache.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.createUpdateTransaction.mock.invocationCallOrder[0]);
      expect(installerCalls()).toEqual([[selected.artifactPath, ["/S"], { detached: true, stdio: "ignore", windowsHide: true }]]);
      expect(await check()).toMatchObject({ status: "busy" });
      expect(await install()).toMatchObject({ started: false });
      expect(mocks.app.quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(mocks.app.quit).toHaveBeenCalledTimes(1);
    },
  );

  it("copies staged results so later mutation of the source object cannot redirect install", async () => {
    const original = { ...records["2.0.0"] };
    await check();
    Object.assign(records["2.0.0"], records["3.0.0"]);
    expect(await install()).toMatchObject({ started: true });
    expect(installerCalls()[0][0]).toBe(original.artifactPath);
    expect(mocks.verifyStagedUpdateCache.mock.calls[1][1]).toEqual(original);
  });

  it("cancel preserves consent and releases the operation for a later changed update", async () => {
    await check();
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
    expect(await install()).toMatchObject({ started: false, message: "已取消更新。" });
    expect(mocks.createUpdateTransaction).not.toHaveBeenCalled();
    expect(installerCalls()).toEqual([]);
    expect(mocks.app.quit).not.toHaveBeenCalled();
    nextVersion = "3.0.0";
    expect(await check()).toMatchObject({ status: "ready", version: "3.0.0" });
    expect(await install()).toMatchObject({ started: true });
    expect(installerCalls()[0][0]).toBe(records["3.0.0"].artifactPath);
  });

  it.each(["initial", "final"])("rejects %s byte identity drift without launching or quitting", async (phase) => {
    await check();
    if (phase === "final") mocks.verifyStagedUpdateCache.mockResolvedValueOnce(undefined);
    mocks.verifyStagedUpdateCache.mockRejectedValueOnce(new Error("staged digest drift"));
    await expect(install()).rejects.toThrow("staged digest drift");
    expect(installerCalls()).toEqual([]);
    expect(mocks.app.quit).not.toHaveBeenCalled();
    if (phase === "initial") expect(mocks.showMessageBox).not.toHaveBeenCalled();
    else expect(mocks.createUpdateTransaction).toHaveBeenCalledTimes(1);
    expect(await check()).toMatchObject({ status: "ready" });
  });

  it("releases a failed check without replacing the previously verified pending selection", async () => {
    await check();
    mocks.fetch.mockRejectedValueOnce(new Error("offline fixture"));
    await expect(check()).rejects.toThrow("offline fixture");
    expect(await install()).toMatchObject({ started: true });
    expect(installerCalls()[0][0]).toBe(records["2.0.0"].artifactPath);
  });

  it("does not show consent or launch when the signature check fails", async () => {
    await check();
    mocks.spawn.mockImplementationOnce(() => {
      const child = fakeChild();
      queueMicrotask(() => finishSignature(child, "NotSigned"));
      return child;
    });
    await expect(install()).rejects.toThrow(/更新簽章不符合/u);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(installerCalls()).toEqual([]);
    expect(mocks.app.quit).not.toHaveBeenCalled();
    expect(await check()).toMatchObject({ status: "ready" });
  });

  it("waits for signature stdout to drain after exit before parsing on close", async () => {
    await check();
    const reachedSignature = deferred<FakeChild>();
    mocks.spawn.mockImplementation((path: string) => {
      if (path !== "powershell.exe") return defaultSpawn(path);
      const child = fakeChild();
      reachedSignature.resolve(child);
      return child;
    });
    const installing = install();
    const signature = await reachedSignature.promise;
    signature.emit("exit", 0);
    await Promise.resolve();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(installerCalls()).toEqual([]);
    signature.stdout.write(JSON.stringify({ Status: "Valid", Subject: "CN=Editkin Test", CertificateSha256: "c".repeat(64) }));
    signature.emit("close", 0);
    expect(await installing).toMatchObject({ started: true });
    expect(installerCalls()[0][0]).toBe(records["2.0.0"].artifactPath);
  });

  it.each(["dialog", "transaction"])("releases ownership after %s failure without launching", async (phase) => {
    await check();
    const operation = phase === "dialog" ? mocks.showMessageBox : mocks.createUpdateTransaction;
    operation.mockRejectedValueOnce(new Error(`${phase} fixture failure`));
    await expect(install()).rejects.toThrow(`${phase} fixture failure`);
    expect(installerCalls()).toEqual([]);
    expect(mocks.app.quit).not.toHaveBeenCalled();
    expect(await check()).toMatchObject({ status: "ready" });
  });

  it.each(["error-event", "synchronous-throw"])("does not claim started or quit on installer %s", async (failure) => {
    await check();
    mocks.spawn.mockImplementation((path: string) => {
      if (path === "powershell.exe") return defaultSpawn(path);
      if (failure === "synchronous-throw") throw new Error("installer spawn denied");
      const child = fakeChild();
      queueMicrotask(() => child.emit("error", new Error("installer spawn denied")));
      return child;
    });
    await expect(install()).rejects.toThrow("installer spawn denied");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.app.quit).not.toHaveBeenCalled();
    expect(await check()).toMatchObject({ status: "ready" });
  });

  it("waits for the installer spawn event before reporting success", async () => {
    await check();
    const reachedSpawn = deferred<FakeChild>();
    mocks.spawn.mockImplementation((path: string) => {
      if (path === "powershell.exe") return defaultSpawn(path);
      const child = fakeChild();
      reachedSpawn.resolve(child);
      return child;
    });
    let settled = false;
    const installing = install().then((result) => { settled = true; return result; });
    const child = await reachedSpawn.promise;
    expect(settled).toBe(false);
    expect(child.unref).not.toHaveBeenCalled();
    expect(mocks.app.quit).not.toHaveBeenCalled();
    expect(await install()).toMatchObject({ started: false });
    child.emit("spawn");
    expect(await installing).toMatchObject({ started: true });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("keeps unsigned-development opt-in out of the packaged install path", async () => {
    delete records["2.0.0"].signatureSubject;
    delete records["2.0.0"].signatureSha256;
    vi.stubEnv("HAO_EDITOR_ALLOW_UNSIGNED_UPDATES", "1");
    await check();
    expect(await install()).toMatchObject({ started: false });
    expect(mocks.verifyStagedUpdateCache).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    mocks.app.isPackaged = false;
    expect(await install()).toMatchObject({ started: true });
    expect(mocks.verifyStagedUpdateCache).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("clears pending state when a later check finds the current installed version", async () => {
    await check();
    nextVersion = "1.0.0";
    expect(await check()).toMatchObject({ status: "current" });
    expect(await install()).toMatchObject({ started: false });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
