import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const control = vi.hoisted(() => ({
  unlinkTarget: "", unlinkCalls: 0, unlinkFailure: undefined as Error | undefined,
  afterSync: undefined as (() => void) | undefined, afterClose: undefined as (() => void) | undefined,
}));
// Use real files/handles; inject cancellation only after actual lease sync/close.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!String(args[0]).endsWith(`${sep}.producer.lock`) || args[1] !== "wx") return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === "sync") return async () => { await target.sync(); control.afterSync?.(); };
        if (key === "close") return async () => { await target.close(); control.afterClose?.(); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (String(path) === control.unlinkTarget) {
        control.unlinkCalls++;
        if (control.unlinkFailure) { const error = control.unlinkFailure; control.unlinkFailure = undefined; throw error; }
      }
      return actual.unlink(path);
    },
  };
});
import { pinTimeRemapCacheEntryV1, assertTimeRemapCacheUnpinnedV1, withTimeRemapCacheProducerV1 } from "./timeRemapCacheStoreV1";

const temp = resolve(process.env.TEMP!), key = "a".repeat(64);
let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(temp, "cache-lease-lifecycle-"));
  Object.assign(control, { unlinkTarget: "", unlinkCalls: 0, unlinkFailure: undefined, afterSync: undefined, afterClose: undefined });
});
afterEach(async () => {
  if (!folder.startsWith(temp + sep)) throw Error("test cleanup outside owned root");
  await rm(folder, { recursive: true });
});
async function pin() {
  const release = await pinTimeRemapCacheEntryV1(folder, key);
  control.unlinkTarget = join(folder, (await readdir(folder)).find(n => n.includes(".pin-"))!);
  return release;
}
describe("cache consumer and producer lease lifetime", () => {
  it("coalesces 32 simultaneous releases into one owned removal", async () => {
    await writeFile(join(folder, "keep"), "kept bytes");
    const release = await pin(), result = await Promise.allSettled(Array.from({ length: 32 }, () => release()));
    expect(result.every(r => r.status === "fulfilled")).toBe(true); expect(control.unlinkCalls).toBe(1);
    await release(); expect(control.unlinkCalls).toBe(1);
    await expect(assertTimeRemapCacheUnpinnedV1(folder, key)).resolves.toBeUndefined();
    expect(await readFile(join(folder, "keep"), "utf8")).toBe("kept bytes");
  });
  it("shares a failed release attempt, preserves the pin, and allows a later retry", async () => {
    const release = await pin(), error = Error("controlled first unlink failure"); control.unlinkFailure = error;
    const failed = await Promise.allSettled(Array.from({ length: 8 }, () => release()));
    expect(failed.every(r => r.status === "rejected" && r.reason === error)).toBe(true); expect(control.unlinkCalls).toBe(1);
    await expect(assertTimeRemapCacheUnpinnedV1(folder, key)).rejects.toThrow("PINNED");
    const retried = await Promise.allSettled(Array.from({ length: 8 }, () => release()));
    expect(retried.every(r => r.status === "fulfilled")).toBe(true); expect(control.unlinkCalls).toBe(2);
  });
  it("keeps a modified pin and shares the ownership refusal with concurrent callers", async () => {
    const release = await pin(); await writeFile(control.unlinkTarget, "modified record must remain");
    const failed = await Promise.allSettled(Array.from({ length: 8 }, () => release()));
    const first = failed[0]; expect(first.status).toBe("rejected");
    if (first.status !== "rejected") throw Error("Expected ownership refusal");
    expect(String(first.reason)).toContain("OWNER_FILE_CHANGED");
    expect(failed.every(r => r.status === "rejected" && r.reason === first.reason)).toBe(true);
    expect(control.unlinkCalls).toBe(0); expect(await readFile(control.unlinkTarget, "utf8")).toBe("modified record must remain");
  });
  it.each(["afterSync", "afterClose"] as const)("does not invoke work after cancellation at %s", async phase => {
    const abort = new AbortController(), reason = Error(`cancel ${phase}`), operation = vi.fn(async () => "should not run");
    control[phase] = () => abort.abort(reason);
    await expect(withTimeRemapCacheProducerV1(folder, abort.signal, operation)).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled(); expect(await readdir(folder)).not.toContain(".producer.lock");
    control[phase] = undefined;
    expect(await withTimeRemapCacheProducerV1(folder, undefined, async () => "next job")).toBe("next job");
  });
  it("preserves the accepted result if its operation itself signals cancellation after commit", async () => {
    const abort = new AbortController(), artifact = join(folder, "accepted-result");
    const result = await withTimeRemapCacheProducerV1(folder, abort.signal, async () => {
      await writeFile(artifact, "accepted bytes"); abort.abort(Error("after commit")); return "accepted";
    });
    expect(result).toBe("accepted"); expect(await readFile(artifact, "utf8")).toBe("accepted bytes");
    expect(await readdir(folder)).not.toContain(".producer.lock");
  });
  it("does not disturb an active producer while two consumer cleanup paths converge", async () => {
    let ready!: () => void, finish!: () => void;
    const started = new Promise<void>(r => { ready = r; }), held = new Promise<void>(r => { finish = r; });
    const producer = withTimeRemapCacheProducerV1(folder, undefined, async () => { ready(); await held; return "producer kept"; });
    await started;
    try {
      const marker = await readFile(join(folder, ".producer.lock")), release = await pin();
      const outcomes = await Promise.allSettled([release(), release()]);
      expect(outcomes.every(r => r.status === "fulfilled")).toBe(true);
      expect(await readFile(join(folder, ".producer.lock"))).toEqual(marker);
    } finally { finish(); expect(await producer).toBe("producer kept"); }
  });
});
