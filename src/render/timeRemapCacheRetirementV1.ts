import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../shared/canonicalJson";
import { LONG_RENDER_OWNER_FILE, removeJournaledPathV1 } from "./longRenderOwnerJournalV1";
import { parseTimeRemapCacheReceiptV1, type TimeRemapFingerprintV1 } from "./timeRemapCacheContractV1";
import { assertTimeRemapLocalPathV1, timeRemapFingerprintV1, timeRemapSha256V1 } from "./timeRemapCacheIdentityV1";
import { assertTimeRemapCacheUnpinnedV1, readTimeRemapCacheJsonV1, timeRemapCacheProducerIdentityV1 } from "./timeRemapCacheStoreV1";

const names = [LONG_RENDER_OWNER_FILE, "clip.mkv", "receipt.json"].sort();
export interface TimeRemapCacheEntryV1 {
  key: string; directory: string; bytes: number; identity: string; dev: string; ino: string;
  owner: { schema: string; runId: string; pid?: number; host?: string };
  receipt: ReturnType<typeof parseTimeRemapCacheReceiptV1>;
}
async function snapshot(directory: string) {
  await assertTimeRemapLocalPathV1(directory);
  const s = await lstat(directory, { bigint: true });
  if (!s.isDirectory() || (await readdir(directory)).sort().join() !== names.join()) throw Error("TIME_REMAP_CACHE_ENTRY_PARTIAL_OR_FOREIGN");
  const files = await Promise.all(names.map(n => timeRemapFingerprintV1(join(directory, n))));
  return { dev: String(s.dev), ino: String(s.ino), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), files };
}
/** Metadata-only inventory is cheap; deletion always also verifies the selected media's complete SHA. */
export async function inspectTimeRemapCacheEntryV1(root: string, key: string, signal?: AbortSignal, hashMedia = true): Promise<TimeRemapCacheEntryV1 | undefined> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error("TIME_REMAP_CACHE_KEY_INVALID");
  signal?.throwIfAborted(); const directory = join(root, key);
  await assertTimeRemapLocalPathV1(directory);
  if (!await lstat(directory).catch(e => { if (e.code === "ENOENT") return undefined; throw e; })) return undefined;
  const before = await snapshot(directory);
  const receipt = parseTimeRemapCacheReceiptV1(await readTimeRemapCacheJsonV1(join(directory, "receipt.json")));
  const media = before.files[names.indexOf("clip.mkv")];
  if (receipt.key !== key || Number(media.size) !== receipt.media.bytes || media.dev !== receipt.media.dev || media.ino !== receipt.media.ino
    || (hashMedia && await timeRemapSha256V1(join(directory, "clip.mkv"), signal) !== receipt.media.sha256)) throw Error("TIME_REMAP_CACHE_MEDIA_CHANGED");
  const owner = await readTimeRemapCacheJsonV1(join(directory, LONG_RENDER_OWNER_FILE), 4096) as TimeRemapCacheEntryV1["owner"];
  if (owner?.schema !== "editkin.long-render-owner/v1" || typeof owner.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(owner.runId)) throw Error("TIME_REMAP_CACHE_OWNER_INVALID");
  signal?.throwIfAborted(); const identity = canonicalJson(before);
  if (identity !== canonicalJson(await snapshot(directory))) throw Error("TIME_REMAP_CACHE_ENTRY_CHANGED");
  return { key, directory, bytes: before.files.reduce((sum, f) => sum + Number(f.size), 0), identity, dev: before.dev, ino: before.ino, owner, receipt };
}
export async function timeRemapCacheHasPinsV1(root: string, key: string) {
  return (await readdir(root)).some(name => name.startsWith(`${key}.pin-`));
}
/** Canonical explicit/automatic retirement. Call only inside withTimeRemapCacheProducerV1. */
export async function retireTimeRemapCacheEntryUnderLeaseV1(root: string, key: string, lease: TimeRemapFingerprintV1,
  options: { signal?: AbortSignal; expected?: TimeRemapCacheEntryV1; protectEveryPin?: boolean } = {}) {
  await timeRemapCacheProducerIdentityV1(root, lease); options.signal?.throwIfAborted();
  if (options.protectEveryPin) {
    if (await timeRemapCacheHasPinsV1(root, key)) throw Error("TIME_REMAP_CACHE_ENTRY_PINNED_OR_PIN_UNVERIFIED");
  } else await assertTimeRemapCacheUnpinnedV1(root, key);
  const entry = await inspectTimeRemapCacheEntryV1(root, key, options.signal);
  if (!entry) return { retired: false, bytes: 0, storedBytes: 0 };
  if (options.expected && entry.identity !== options.expected.identity) throw Error("TIME_REMAP_CACHE_ENTRY_CHANGED");
  if (await timeRemapCacheHasPinsV1(root, key)) throw Error("TIME_REMAP_CACHE_ENTRY_PINNED_OR_PIN_UNVERIFIED");
  await timeRemapCacheProducerIdentityV1(root, lease); options.signal?.throwIfAborted();
  const outcome = await removeJournaledPathV1({ path: entry.directory, kind: "run-work-dir", dev: entry.dev, ino: entry.ino, runId: entry.owner.runId });
  if (outcome.status === "leftover") throw Error(`TIME_REMAP_CACHE_RETIREMENT_REFUSED:${outcome.reason}`);
  return { retired: outcome.status === "removed", bytes: entry.receipt.media.bytes, storedBytes: outcome.status === "removed" ? entry.bytes : 0 };
}
