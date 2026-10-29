import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "../shared/canonicalJson";
import { probeVolumeSpace } from "./renderDiskSpace";
import { assertTimeRemapLocalPathV1, timeRemapFingerprintV1 } from "./timeRemapCacheIdentityV1";
import { declaredHelperTemporaryRootV1 } from "./helperProcessEnvironmentV1";
import type { TimeRemapFingerprintV1 } from "./timeRemapCacheContractV1";

const queues = new Map<string, Promise<void>>();
const localHost = hostname(), policy = { schema: "editkin.time-remap-cache-root/v1", policy: "lossless-source-clock-cache-rgba8/v1" };
const producerSchema = "editkin.time-remap-cache-producer/v1";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
export async function readTimeRemapCacheJsonV1(path: string, maximumBytes = 4 * 1024 ** 2) {
  const s = await timeRemapFingerprintV1(path); if (BigInt(s.size) > BigInt(maximumBytes)) throw Error("TIME_REMAP_CACHE_JSON_BUDGET");
  const result = JSON.parse(await readFile(path, "utf8"));
  if (canonicalJson(s) !== canonicalJson(await timeRemapFingerprintV1(path))) throw Error("TIME_REMAP_CACHE_JSON_CHANGED");
  return result as unknown;
}
export async function removeTimeRemapOwnedFileV1(path: string, identity: TimeRemapFingerprintV1) {
  await assertTimeRemapLocalPathV1(path);
  const current = await timeRemapFingerprintV1(path);
  if (canonicalJson(identity) !== canonicalJson(current)) throw Error("TIME_REMAP_CACHE_OWNER_FILE_CHANGED");
  await unlink(path);
}
export async function timeRemapCacheRootV1(projectRoot: string, helperTemporaryRoot: string) {
  await assertTimeRemapLocalPathV1(projectRoot); await assertTimeRemapLocalPathV1(helperTemporaryRoot);
  if (!(await lstat(projectRoot)).isDirectory() || !(await lstat(helperTemporaryRoot)).isDirectory()) throw Error("TIME_REMAP_CACHE_PROJECT_AND_HELPER_ROOT_REQUIRED");
  // Helper processes must use this root as TEMP/TMP: either the whole process already does, or the current operation
  // declared it for its own helper spawns (withHelperTemporaryRootV1), leaving process.env untouched.
  const envTemp = process.env.TEMP, envTmp = process.env.TMP;
  const processWide = Boolean(envTemp && envTmp && resolve(envTemp) === helperTemporaryRoot && resolve(envTmp) === helperTemporaryRoot);
  if (!processWide && declaredHelperTemporaryRootV1() !== resolve(helperTemporaryRoot)) throw Error("TIME_REMAP_CACHE_HELPER_TEMP_ENV_MUST_MATCH_OWNED_ROOT");
  const [projectVolume, helperVolume] = await Promise.all([probeVolumeSpace(projectRoot), probeVolumeSpace(helperTemporaryRoot)]);
  if (!projectVolume || !helperVolume || projectVolume.key !== helperVolume.key) throw Error("TIME_REMAP_CACHE_PROJECT_VOLUME_REQUIRED");
  const root = join(projectRoot, ".editkin", "time-remap-v1"); await assertTimeRemapLocalPathV1(root); await mkdir(root, { recursive: true }); await assertTimeRemapLocalPathV1(root);
  const marker = join(root, "policy.json");
  try { await writeFile(marker, canonicalJson(policy), { flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  if (canonicalJson(await readTimeRemapCacheJsonV1(marker, 4096)) !== canonicalJson(policy)) throw Error("TIME_REMAP_CACHE_ROOT_POLICY_DIFFERS");
  return root;
}
async function waitForTurn(turn: Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted(); let abort: (() => void) | undefined;
  try { await Promise.race([turn, new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); signal?.addEventListener("abort", abort, { once: true });
  })]); } finally { if (abort) signal?.removeEventListener("abort", abort); }
}
/** One producer per project cache; queued cancellation does not abort a different caller's work. */
export async function withTimeRemapCacheProducerV1<T>(root: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve(); let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; }), queued = previous.then(() => barrier); queues.set(root, queued);
  try {
    await waitForTurn(previous, signal); signal?.throwIfAborted(); await assertTimeRemapLocalPathV1(root);
    const path = join(root, ".producer.lock");
    const present = await lstat(path).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
    if (present) {
      const before = await timeRemapFingerprintV1(path), owner = await readTimeRemapCacheJsonV1(path, 4096) as Record<string, unknown>;
      if (owner.schema !== producerSchema || owner.host !== localHost || !Number.isSafeInteger(owner.pid)
        || (owner.pid as number) < 1 || alive(owner.pid as number)) throw Error("TIME_REMAP_CACHE_PRODUCER_BUSY_OR_FOREIGN");
      await removeTimeRemapOwnedFileV1(path, before);
    }
    const file = await open(path, "wx"), owner = { schema: producerSchema, pid: process.pid, host: localHost, token: randomUUID() };
    let identity: TimeRemapFingerprintV1;
    try { await file.writeFile(canonicalJson(owner)); await file.sync(); identity = await timeRemapFingerprintV1(path); }
    finally { await file.close(); }
    let failed = false, failure: unknown;
    try { signal?.throwIfAborted(); return await operation(); }
    catch (error) { failed = true; failure = error; throw error; }
    finally {
      try { await removeTimeRemapOwnedFileV1(path, identity!); }
      catch (cleanup) {
        if (failed) throw new AggregateError([failure, cleanup], "TIME_REMAP_CACHE_OPERATION_AND_LEASE_RELEASE_FAILED");
        throw cleanup;
      }
    }
  } finally {
    release(); void queued.then(() => { if (queues.get(root) === queued) queues.delete(root); });
  }
}
/** A capacity operation must remain within this exact producer lease, even across awaits. */
export async function timeRemapCacheProducerIdentityV1(root: string, expected?: TimeRemapFingerprintV1) {
  const path = join(root, ".producer.lock"), before = await timeRemapFingerprintV1(path);
  const owner = await readTimeRemapCacheJsonV1(path, 4096) as Record<string, unknown>;
  if (owner.schema !== producerSchema || owner.pid !== process.pid || owner.host !== localHost || typeof owner.token !== "string"
    || !/^[a-f0-9-]{36}$/.test(owner.token) || canonicalJson(before) !== canonicalJson(await timeRemapFingerprintV1(path))
    || (expected && canonicalJson(before) !== canonicalJson(expected))) throw Error("TIME_REMAP_CACHE_PRODUCER_LEASE_CHANGED_OR_FOREIGN");
  return before;
}
export async function pinTimeRemapCacheEntryV1(root: string, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error("TIME_REMAP_CACHE_KEY_INVALID");
  const token = randomUUID(), path = join(root, `${key}.pin-${process.pid}-${token}.json`);
  await writeFile(path, canonicalJson({ schema: "editkin.time-remap-cache-pin/v1", key, token, pid: process.pid, host: localHost }), { flag: "wx" });
  const identity = await timeRemapFingerprintV1(path); let removal: Promise<void> | undefined;
  return () => {
    if (!removal) removal = removeTimeRemapOwnedFileV1(path, identity).catch(error => { removal = undefined; throw error; });
    return removal;
  };
}
/** Explicit eviction may remove only a validated completed entry after all local pins have gone. */
export async function assertTimeRemapCacheUnpinnedV1(root: string, key: string) {
  for (const name of (await readdir(root)).filter(n => n.startsWith(`${key}.pin-`))) {
    const path = join(root, name), before = await timeRemapFingerprintV1(path), pin = await readTimeRemapCacheJsonV1(path, 4096) as Record<string, unknown>;
    if (pin.schema !== "editkin.time-remap-cache-pin/v1" || pin.key !== key || pin.host !== localHost || !Number.isSafeInteger(pin.pid)
      || (pin.pid as number) < 1 || alive(pin.pid as number)) throw Error("TIME_REMAP_CACHE_ENTRY_PINNED_OR_PIN_UNVERIFIED");
    await removeTimeRemapOwnedFileV1(path, before);
  }
}
