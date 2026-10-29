import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import fixture from "./__fixtures__/timeRemapCacheReceiptV1.fixture.json";
import { createOwnedDirectoryV1, LONG_RENDER_OWNER_FILE } from "./longRenderOwnerJournalV1";
import { parseTimeRemapCacheReceiptV1, timeRemapCacheDigestV1, timeRemapCacheKeyV1 } from "./timeRemapCacheContractV1";
const control = vi.hoisted(() => ({ hashes: [] as string[], beforeHash: undefined as ((path: string) => Promise<void>) | undefined,
  afterRemoval: undefined as (() => void) | undefined }));
vi.mock("./timeRemapCacheIdentityV1", async () => {
  const actual = await vi.importActual<typeof import("./timeRemapCacheIdentityV1")>("./timeRemapCacheIdentityV1");
  return { ...actual, timeRemapSha256V1: async (path: string, signal?: AbortSignal) => {
    control.hashes.push(path); await control.beforeHash?.(path); return actual.timeRemapSha256V1(path, signal);
  } };
});
vi.mock("./longRenderOwnerJournalV1", async () => {
  const actual = await vi.importActual<typeof import("./longRenderOwnerJournalV1")>("./longRenderOwnerJournalV1");
  return { ...actual, removeJournaledPathV1: async (record: Parameters<typeof actual.removeJournaledPathV1>[0]) => {
    const result = await actual.removeJournaledPathV1(record); control.afterRemoval?.(); return result;
  } };
});
import { timeRemapFingerprintV1 } from "./timeRemapCacheIdentityV1";
import { pinTimeRemapCacheEntryV1, timeRemapCacheRootV1, withTimeRemapCacheProducerV1, timeRemapCacheProducerIdentityV1 } from "./timeRemapCacheStoreV1";
import { inspectTimeRemapCacheEntryV1, retireTimeRemapCacheEntryUnderLeaseV1 } from "./timeRemapCacheRetirementV1";
import { ensureTimeRemapCacheCapacityV1, TimeRemapCacheCapacityErrorV1 } from "./timeRemapCacheCapacityV1";
import { ownedTreeBytesV2 } from "./longRenderGuardV2";

const temp = resolve(process.env.TEMP!), MiB = 1024 ** 2, keepKey = "f".repeat(64);
let folder: string, root: string;
beforeEach(async () => {
  control.hashes = []; control.beforeHash = undefined; control.afterRemoval = undefined;
  folder = await mkdtemp(join(temp, "tm-cache-capacity-")); root = await timeRemapCacheRootV1(folder, temp);
  await writeFile(join(folder, "author.txt"), "author source retained");
});
afterEach(async () => { if (!folder.startsWith(temp + sep)) throw Error("test cleanup outside owned root"); await rm(folder, { recursive: true }); });
async function entry(index: number, date = "2026-01-01T00:00:00.000Z") {
  const r = parseTimeRemapCacheReceiptV1(structuredClone(fixture)); r.keyInputs.sourceStart = index; r.key = timeRemapCacheKeyV1(r.keyInputs); r.createdAt = date;
  const path = join(root, r.key); await createOwnedDirectoryV1(path, `owned-cache-${index}`);
  const media = Buffer.alloc(64, index); await writeFile(join(path, "clip.mkv"), media);
  const f = await timeRemapFingerprintV1(join(path, "clip.mkv"));
  r.media = { ...r.media, bytes: media.length, sha256: createHash("sha256").update(media).digest("hex"), dev: f.dev, ino: f.ino };
  const { digest: _old, ...body } = r; r.digest = timeRemapCacheDigestV1(body); await writeFile(join(path, "receipt.json"), JSON.stringify(r));
  return { key: r.key, path, receipt: r, bytes: (await inspectTimeRemapCacheEntryV1(root, r.key, undefined, false))!.bytes };
}
async function capacity(need: number, requestedOutputBytes = MiB, signal?: AbortSignal, kept = keepKey) {
  const used = await ownedTreeBytesV2([root]);
  return ensureTimeRemapCacheCapacityV1({ root, keepKey: kept, quotaBytes: used + MiB + requestedOutputBytes - need, requestedOutputBytes, signal });
}
const leased = <T>(operation: () => Promise<T>, signal?: AbortSignal) => withTimeRemapCacheProducerV1(root, signal, operation);
const present = async (key: string) => (await readdir(root)).includes(key);
async function ownerChange(path: string, changes: Record<string, unknown>) {
  const file = join(path, LONG_RENDER_OWNER_FILE), v = JSON.parse(await readFile(file, "utf8")); await writeFile(file, JSON.stringify({ ...v, ...changes }));
}
describe("optional capacity control on real owned filesystem entries", () => {
  it("does no inventory or full-media hashing when the requested budget fits", async () => {
    const a = await entry(1); const report = await leased(() => capacity(0));
    expect(report).toMatchObject({ state: "complete", inventoryScanned: false, retired: [], availableOutputBytes: MiB });
    expect(control.hashes).toEqual([]); expect(await present(a.key)).toBe(true);
  });
  it("reclaims a sufficient oldest prefix, including metadata, while retaining newer entries and originals", async () => {
    const newer = await entry(1, "2026-02-01T00:00:00.000Z"), older = await entry(2);
    const report = await leased(() => capacity(older.bytes));
    expect(report.retired).toEqual([{ key: older.key, bytes: older.bytes }]); expect(report.usedBeforeBytes - report.usedAfterBytes!).toBe(older.bytes);
    expect(report.availableOutputBytes).toBe(MiB); expect(await present(older.key)).toBe(false); expect(await present(newer.key)).toBe(true);
    expect(control.hashes).toEqual([join(older.path, "clip.mkv"), join(older.path, "clip.mkv")]);
    expect(await readFile(join(folder, "author.txt"), "utf8")).toBe("author source retained");
  });
  it("uses the key to break equal receipt-date ties deterministically", async () => {
    const values = [await entry(1), await entry(2)].sort((a, b) => a.key.localeCompare(b.key));
    const report = await leased(() => capacity(1)); expect(report.retired.map(e => e.key)).toEqual([values[0].key]);
    expect(await present(values[1].key)).toBe(true);
  });
  it.each(["live", "foreign", "malformed", "stale"])("protects every %s pin from automatic reclamation", async kind => {
    const a = await entry(1), pin = join(root, `${a.key}.pin-controlled.json`);
    if (kind === "live") { const release = await pinTimeRemapCacheEntryV1(root, a.key); try { await expect(leased(() => capacity(1))).rejects.toThrow("CAPACITY_FULL"); } finally { await release(); } }
    else {
      await writeFile(pin, kind === "malformed" ? "bad-json" : JSON.stringify({ schema: "editkin.time-remap-cache-pin/v1", key: a.key, pid: 2147483647, host: kind === "foreign" ? "foreign" : hostname() }));
      await expect(leased(() => capacity(1))).rejects.toThrow("CAPACITY_FULL"); expect(await readFile(pin, "utf8")).not.toBe("");
    }
    expect(await present(a.key)).toBe(true); expect(control.hashes).toEqual([]);
  });
  it("protects the requested entry even without a pin", async () => {
    const a = await entry(1); await expect(leased(() => capacity(1, MiB, undefined, a.key))).rejects.toThrow("CAPACITY_FULL"); expect(await present(a.key)).toBe(true);
  });
  it.each(["foreign-host", "unknown-pid", "owner-schema", "owner-run", "partial", "extra", "receipt-digest", "receipt-key", "media-size", "media-hash", "media-inode"])("retains %s entries and refuses when no verified capacity remains", async kind => {
    const a = await entry(1);
    if (kind === "foreign-host") await ownerChange(a.path, { host: "another-host" });
    if (kind === "unknown-pid") await ownerChange(a.path, { pid: "unknown" });
    if (kind === "owner-schema") await ownerChange(a.path, { schema: "user-file" });
    if (kind === "owner-run") await ownerChange(a.path, { runId: "../outside" });
    if (kind === "partial") await unlink(join(a.path, "receipt.json"));
    if (kind === "extra") await writeFile(join(a.path, "keep-user-file"), "keep");
    if (kind === "receipt-digest" || kind === "receipt-key" || kind === "media-inode") {
      const r = a.receipt; if (kind === "receipt-digest") r.digest = "0".repeat(64); if (kind === "receipt-key") r.key = keepKey;
      if (kind === "media-inode") { r.media.ino = "0"; const { digest: _d, ...body } = r; r.digest = timeRemapCacheDigestV1(body); }
      await writeFile(join(a.path, "receipt.json"), JSON.stringify(r));
    }
    if (kind === "media-size") await writeFile(join(a.path, "clip.mkv"), "changed");
    if (kind === "media-hash") await writeFile(join(a.path, "clip.mkv"), Buffer.alloc(64, 99));
    const before = await ownedTreeBytesV2([root]); let failure: unknown;
    try { await leased(() => capacity(1)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TimeRemapCacheCapacityErrorV1);
    const report = (failure as TimeRemapCacheCapacityErrorV1).receipt;
    expect(report).toMatchObject({ state: "refused", retired: [] }); expect(report.usedAfterBytes).toBe(report.usedBeforeBytes);
    expect(await present(a.key)).toBe(true); expect(await ownedTreeBytesV2([root])).toBe(before);
  });
  it("replans around bad oldest media before deleting a newer verified entry", async () => {
    const bad = await entry(1), good = await entry(2, "2026-02-01T00:00:00.000Z"); await writeFile(join(bad.path, "clip.mkv"), Buffer.alloc(64, 9));
    const report = await leased(() => capacity(1)); expect(report.retired.map(e => e.key)).toEqual([good.key]);
    expect(report.protected.some(e => e.key === bad.key)).toBe(true); expect(await present(bad.key)).toBe(true);
  });
  it("refuses an impossible protected-space budget before any otherwise eligible deletion", async () => {
    const a = await entry(1); await writeFile(join(root, "unknown-author-data"), Buffer.alloc(64));
    await expect(leased(() => capacity(a.bytes + 1))).rejects.toThrow("CAPACITY_FULL"); expect(await present(a.key)).toBe(true); expect(control.hashes).toEqual([]);
  });
  it("maximizes an available smaller output cap without reducing codec quality", async () => {
    const a = await entry(1); const report = await leased(() => capacity(a.bytes + 32, MiB + 64));
    expect(report.retired.map(e => e.key)).toEqual([a.key]); expect(report.availableOutputBytes).toBe(MiB + 32);
  });
  it("rejects a junction anywhere in the root before deletion and leaves its target intact", async () => {
    const a = await entry(1), target = join(folder, "target"), link = join(root, "link"); await mkdir(target); await writeFile(join(target, "keep"), "keep");
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    try {
      await expect(leased(() => ensureTimeRemapCacheCapacityV1({ root, keepKey, quotaBytes: 3 * MiB, requestedOutputBytes: 2 * MiB }))).rejects.toThrow();
      expect(await present(a.key)).toBe(true); expect(await readFile(join(target, "keep"), "utf8")).toBe("keep");
    } finally { await unlink(link); }
  });
  it("requires an actual owned producer lease instead of trusting a caller's root", async () => {
    const a = await entry(1); await expect(capacity(1)).rejects.toThrow(); expect(await present(a.key)).toBe(true);
  });
  it("preserves everything when cancellation arrives before reclamation", async () => {
    const a = await entry(1), abort = new AbortController(); abort.abort(Error("cancel-before"));
    await expect(leased(() => capacity(1, MiB, abort.signal))).rejects.toThrow("cancel-before"); expect(await present(a.key)).toBe(true);
  });
  it("reports exactly the first completed retirement when cancelled between two entries", async () => {
    const a = await entry(1), b = await entry(2, "2026-02-01T00:00:00.000Z"), abort = new AbortController(); control.afterRemoval = () => abort.abort(Error("cancel-after-first"));
    let failure: unknown; try { await leased(() => capacity(a.bytes + b.bytes, MiB, abort.signal)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TimeRemapCacheCapacityErrorV1); const report = (failure as TimeRemapCacheCapacityErrorV1).receipt;
    expect(report.state).toBe("partial"); expect(report.retired).toEqual([{ key: a.key, bytes: a.bytes }]);
    expect(report.usedBeforeBytes - report.usedAfterBytes!).toBe(a.bytes); expect(await present(a.key)).toBe(false); expect(await present(b.key)).toBe(true);
  });
  it("rechecks pins after selected media verification and refuses before any deletion", async () => {
    const a = await entry(1); control.beforeHash = async () => { control.beforeHash = undefined; await pinTimeRemapCacheEntryV1(root, a.key); };
    await expect(leased(() => capacity(1))).rejects.toThrow("CAPACITY_FULL"); expect(await present(a.key)).toBe(true);
  });
  it("refuses a selected entry modified after the reclamation plan was made", async () => {
    const a = await entry(1); let calls = 0;
    control.beforeHash = async () => { if (++calls === 2) await ownerChange(a.path, { runId: "different-owner" }); };
    await expect(leased(() => capacity(1))).rejects.toThrow("ENTRY_CHANGED"); expect(await present(a.key)).toBe(true);
  });
  it("uses one canonical retirement helper for the explicit path and still returns media bytes", async () => {
    const a = await entry(1); const result = await leased(async () => retireTimeRemapCacheEntryUnderLeaseV1(root, a.key, await timeRemapCacheProducerIdentityV1(root)));
    expect(result).toEqual({ retired: true, bytes: a.receipt.media.bytes, storedBytes: a.bytes }); expect(await present(a.key)).toBe(false);
  });
  it("preserves the capacity failure and exact-lease cleanup failure together when the lease changes", async () => {
    const a = await entry(1); control.beforeHash = async () => {
      control.beforeHash = undefined; const path = join(root, ".producer.lock"), owner = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...owner, token: "b".repeat(36) }));
    };
    let failure: unknown; try { await leased(() => capacity(1)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError); const errors = (failure as AggregateError).errors;
    expect(errors[0]).toBeInstanceOf(TimeRemapCacheCapacityErrorV1); expect(errors[0].receipt.retired).toEqual([]);
    expect(String(errors[0].cause)).toContain("LEASE_CHANGED"); expect(String(errors[1])).toContain("OWNER_FILE_CHANGED");
    expect(await present(a.key)).toBe(true); expect((await readdir(root)).includes(".producer.lock")).toBe(true);
  });
  it("also preserves a thrown undefined operation error when releasing a modified lease fails", async () => {
    let failure: unknown;
    try { await leased(async () => { await writeFile(join(root, ".producer.lock"), "changed-owned-lease"); throw undefined; }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors[0]).toBeUndefined();
    expect(String((failure as AggregateError).errors[1])).toContain("OWNER_FILE_CHANGED");
  });
  it.each([0, -1, MiB - 1, Number.NaN, Number.POSITIVE_INFINITY, 2 * 1024 ** 3 + 1])("rejects quota %s before mutation", async quotaBytes => {
    const a = await entry(1); await expect(leased(() => ensureTimeRemapCacheCapacityV1({ root, keepKey, quotaBytes, requestedOutputBytes: MiB }))).rejects.toThrow("INPUT_INVALID"); expect(await present(a.key)).toBe(true);
  });
});
