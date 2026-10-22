import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { timeRemapCacheRootV1, withTimeRemapCacheProducerV1, pinTimeRemapCacheEntryV1, assertTimeRemapCacheUnpinnedV1, removeTimeRemapOwnedFileV1 } from "./timeRemapCacheStoreV1";
import { assertTimeRemapLocalPathV1, timeRemapFingerprintV1 } from "./timeRemapCacheIdentityV1";
import type { DiskSpaceProbe } from "./renderDiskSpace";
const volume = vi.hoisted(() => ({ probe: undefined as DiskSpaceProbe | undefined }));
vi.mock("./renderDiskSpace", async () => {
  const actual = await vi.importActual<typeof import("./renderDiskSpace")>("./renderDiskSpace");
  return { ...actual, probeVolumeSpace: (path: string) => volume.probe ? volume.probe(path) : actual.probeVolumeSpace(path) };
});
let folder: string;
const temp = resolve(process.env.TEMP!);
beforeEach(async () => { volume.probe = undefined; folder = await mkdtemp(join(temp, "tm-cache-store-")); });
afterEach(async () => { if (!folder.startsWith(temp + sep)) throw Error("test cleanup outside owned root"); await rm(folder, { recursive: true }); });
describe("owned project cache IO", () => {
  it("creates only a namespaced root and retains its policy", async () => {
    const root = await timeRemapCacheRootV1(folder, temp);
    expect(root).toBe(join(folder, ".editkin", "time-remap-v1"));
    expect(await timeRemapCacheRootV1(folder, temp)).toBe(root);
  });
  it("refuses a foreign root marker without overwriting it", async () => {
    const root = join(folder, ".editkin", "time-remap-v1"); await mkdir(root, { recursive: true }); await writeFile(join(root, "policy.json"), '{"owner":"user"}');
    await expect(timeRemapCacheRootV1(folder, temp)).rejects.toThrow("ROOT_POLICY_DIFFERS");
    expect(await readFile(join(root, "policy.json"), "utf8")).toBe('{"owner":"user"}');
  });
  it("refuses undeclared helper TEMP rather than changing the whole process environment", async () => {
    const helper = join(folder, "helpers"); await mkdir(helper);
    await expect(timeRemapCacheRootV1(folder, helper)).rejects.toThrow("TEMP_ENV");
    expect(process.env.TEMP).toBe(temp);
  });
  it("refuses a different measured project volume before creating a cache", async () => {
    volume.probe = async path => ({ key: path === folder ? "project-volume" : "other-volume", root: path, availableBytes: 1024 ** 4 });
    await expect(timeRemapCacheRootV1(folder, temp)).rejects.toThrow("PROJECT_VOLUME_REQUIRED");
    expect(await readFile(join(folder, ".editkin", "time-remap-v1", "policy.json")).catch(() => undefined)).toBeUndefined();
  });
  it("rejects a junction ancestor without touching its target", async () => {
    const target = join(folder, "target"), link = join(folder, "link"); await mkdir(target); await writeFile(join(target, "keep"), "keep");
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    try { await expect(assertTimeRemapLocalPathV1(join(link, "new"))).rejects.toThrow("REPARSE"); expect(await readFile(join(target, "keep"), "utf8")).toBe("keep"); }
    finally { await unlink(link); }
  });
  it("serializes producers and cancels a queued caller without cancelling the active one", async () => {
    const root = await timeRemapCacheRootV1(folder, temp), order: string[] = []; let ready!: () => void, release!: () => void;
    const begun = new Promise<void>(r => { ready = r; }), held = new Promise<void>(r => { release = r; });
    const first = withTimeRemapCacheProducerV1(root, undefined, async () => { order.push("first-start"); ready(); await held; order.push("first-end"); return 1; });
    await begun; const abort = new AbortController();
    const second = withTimeRemapCacheProducerV1(root, abort.signal, async () => { order.push("never"); }); abort.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    const third = withTimeRemapCacheProducerV1(root, undefined, async () => { order.push("third"); return 3; });
    expect(order).toEqual(["first-start"]); release(); expect(await first).toBe(1); expect(await third).toBe(3);
    expect(order).toEqual(["first-start", "first-end", "third"]);
  });
  it("releases its producer lease after an operation fails", async () => {
    const root = await timeRemapCacheRootV1(folder, temp);
    await expect(withTimeRemapCacheProducerV1(root, undefined, async () => { throw Error("controlled"); })).rejects.toThrow("controlled");
    expect(await withTimeRemapCacheProducerV1(root, undefined, async () => "next")).toBe("next");
  });
  it("retains a live pin and releases only its exact owned record", async () => {
    const root = await timeRemapCacheRootV1(folder, temp), key = "a".repeat(64), release = await pinTimeRemapCacheEntryV1(root, key);
    await expect(assertTimeRemapCacheUnpinnedV1(root, key)).rejects.toThrow("PINNED"); await release(); await release();
    await expect(assertTimeRemapCacheUnpinnedV1(root, key)).resolves.toBeUndefined();
  });
  it("does not remove a replaced or modified file under an old ownership identity", async () => {
    const path = join(folder, "owned"); await writeFile(path, "before"); const identity = await timeRemapFingerprintV1(path);
    await writeFile(path, "changed-with-more-bytes"); await expect(removeTimeRemapOwnedFileV1(path, identity)).rejects.toThrow("OWNER_FILE_CHANGED");
    expect(await readFile(path, "utf8")).toBe("changed-with-more-bytes");
  });
});
