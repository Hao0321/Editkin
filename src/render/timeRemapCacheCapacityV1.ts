import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { ownedTreeBytesV2 } from "./longRenderGuardV2";
import { TIME_REMAP_CACHE_MAX_BYTES_V1 } from "./timeRemapCacheContractV1";
import { timeRemapCacheProducerIdentityV1 } from "./timeRemapCacheStoreV1";
import { inspectTimeRemapCacheEntryV1, retireTimeRemapCacheEntryUnderLeaseV1, timeRemapCacheHasPinsV1, type TimeRemapCacheEntryV1 } from "./timeRemapCacheRetirementV1";

export const TIME_REMAP_CACHE_EVICTION_POLICY_V1 = "owned-oldest/v1" as const;
export const TIME_REMAP_CACHE_METADATA_RESERVE_V1 = 1024 ** 2;
export interface TimeRemapCacheCapacityReceiptV1 {
  schema: "editkin.time-remap-cache-reclaim/v1"; policy: typeof TIME_REMAP_CACHE_EVICTION_POLICY_V1;
  state: "complete" | "refused" | "partial"; quotaBytes: number; reservedBytes: number;
  requestedOutputBytes: number; availableOutputBytes: number; usedBeforeBytes: number; usedAfterBytes?: number;
  inventoryScanned: boolean; retired: Array<{ key: string; bytes: number }>;
  protected: Array<{ key: string; reason: string }>;
}
export class TimeRemapCacheCapacityErrorV1 extends Error {
  constructor(message: string, readonly receipt: TimeRemapCacheCapacityReceiptV1, cause: unknown) { super(message, { cause }); this.name = "TimeRemapCacheCapacityErrorV1"; }
}
function prefix(entries: TimeRemapCacheEntryV1[], used: number, quota: number, requested: number) {
  const reclaimable = entries.reduce((sum, e) => sum + e.bytes, 0);
  const target = Math.min(requested, quota - TIME_REMAP_CACHE_METADATA_RESERVE_V1 - (used - reclaimable));
  if (target < 1024 ** 2) throw Error("TIME_REMAP_CACHE_CAPACITY_FULL");
  let need = used + target + TIME_REMAP_CACHE_METADATA_RESERVE_V1 - quota;
  const selected: TimeRemapCacheEntryV1[] = [];
  for (const entry of entries) { if (need <= 0) break; selected.push(entry); need -= entry.bytes; }
  return selected;
}
/** Optional bounded reclamation in the existing producer, never a separate cache/index or author-file sweep. */
export async function ensureTimeRemapCacheCapacityV1(input: { root: string; keepKey: string; quotaBytes: number; requestedOutputBytes: number; signal?: AbortSignal }) {
  const { root, keepKey, quotaBytes, requestedOutputBytes, signal } = input;
  if (!/^[a-f0-9]{64}$/.test(keepKey) || ![quotaBytes, requestedOutputBytes].every(n => Number.isSafeInteger(n) && n >= 1024 ** 2 && n <= TIME_REMAP_CACHE_MAX_BYTES_V1)
    || requestedOutputBytes > quotaBytes) throw Error("TIME_REMAP_CACHE_CAPACITY_INPUT_INVALID");
  signal?.throwIfAborted(); const lease = await timeRemapCacheProducerIdentityV1(root), used = await ownedTreeBytesV2([root]);
  const receipt: TimeRemapCacheCapacityReceiptV1 = { schema: "editkin.time-remap-cache-reclaim/v1", policy: TIME_REMAP_CACHE_EVICTION_POLICY_V1, state: "refused",
    quotaBytes, reservedBytes: TIME_REMAP_CACHE_METADATA_RESERVE_V1, requestedOutputBytes, availableOutputBytes: 0, usedBeforeBytes: used,
    inventoryScanned: false, retired: [], protected: [] };
  let attempted = false;
  try {
    if (used + requestedOutputBytes + receipt.reservedBytes > quotaBytes) {
      receipt.inventoryScanned = true; let entries: TimeRemapCacheEntryV1[] = [];
      const names = await readdir(root), pinnedKeys = new Set(names.filter(n => n.slice(64, 69) === ".pin-").map(n => n.slice(0, 64)));
      for (const key of names.filter(n => /^[a-f0-9]{64}$/.test(n)).sort()) {
        signal?.throwIfAborted();
        if (key === keepKey || pinnedKeys.has(key)) { receipt.protected.push({ key, reason: key === keepKey ? "requested-entry" : "pinned-or-unverified-pin" }); continue; }
        try {
          const entry = await inspectTimeRemapCacheEntryV1(root, key, signal, false);
          if (!entry || entry.owner.host !== hostname() || !Number.isSafeInteger(entry.owner.pid) || entry.owner.pid! < 1) throw Error("TIME_REMAP_CACHE_OWNER_FOREIGN_OR_UNVERIFIED");
          entries.push(entry);
        } catch (error) { signal?.throwIfAborted(); receipt.protected.push({ key, reason: String(error) }); }
      }
      entries.sort((a, b) => Date.parse(a.receipt.createdAt) - Date.parse(b.receipt.createdAt) || a.key.localeCompare(b.key));
      // Hash only a sufficient oldest prefix. Discovering invalid media protects it and replans before any deletion.
      let selected: TimeRemapCacheEntryV1[];
      const verified = new Set<string>();
      for (;;) {
        selected = prefix(entries, used, quotaBytes, requestedOutputBytes); let invalid = false;
        for (const entry of selected) {
          if (verified.has(entry.key)) continue;
          try {
            const full = await inspectTimeRemapCacheEntryV1(root, entry.key, signal);
            if (!full || full.identity !== entry.identity || await timeRemapCacheHasPinsV1(root, entry.key)) throw Error("TIME_REMAP_CACHE_ENTRY_CHANGED_OR_PINNED");
            verified.add(entry.key);
          } catch (error) {
            signal?.throwIfAborted(); receipt.protected.push({ key: entry.key, reason: String(error) });
            entries = entries.filter(e => e.key !== entry.key); invalid = true; break;
          }
        }
        if (!invalid) break;
      }
      for (const entry of selected) {
        await timeRemapCacheProducerIdentityV1(root, lease); signal?.throwIfAborted(); attempted = true;
        const outcome = await retireTimeRemapCacheEntryUnderLeaseV1(root, entry.key, lease, { expected: entry, protectEveryPin: true, signal });
        if (outcome.retired) receipt.retired.push({ key: entry.key, bytes: outcome.storedBytes });
      }
    }
    signal?.throwIfAborted(); await timeRemapCacheProducerIdentityV1(root, lease);
    receipt.usedAfterBytes = await ownedTreeBytesV2([root]);
    receipt.availableOutputBytes = Math.min(requestedOutputBytes, quotaBytes - receipt.reservedBytes - receipt.usedAfterBytes);
    if (receipt.availableOutputBytes < 1024 ** 2) throw Error("TIME_REMAP_CACHE_CAPACITY_FULL");
    receipt.state = "complete"; return receipt;
  } catch (error) {
    receipt.state = attempted ? "partial" : "refused";
    receipt.usedAfterBytes = await ownedTreeBytesV2([root]).catch(() => undefined);
    throw new TimeRemapCacheCapacityErrorV1(`TIME_REMAP_CACHE_CAPACITY_FAILED:${String(error)}`, receipt, error);
  }
}
