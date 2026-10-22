import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { probeVolumeSpace } from "../render/renderDiskSpace";
import { assertRotoHoldoutLocalPathV1, rotoHoldoutFileIdentityV1 } from "./rotoHoldoutIoV1";
export { assertRotoHoldoutLocalPathV1 as assertRotoV2LocalPath, rotoHoldoutFileIdentityV1 as rotoV2FileIdentity } from "./rotoHoldoutIoV1";

export function rotoV2Deadline(signal?: AbortSignal, timeoutMs = 240000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw Error("ROTO_V2_INVALID_DEADLINE");
  const end = performance.now() + timeoutMs;
  return () => { signal?.throwIfAborted(); const remaining = end - performance.now(); if (remaining <= 0) throw Error("ROTO_V2_DEADLINE_EXCEEDED"); return remaining; };
}
export async function assertRotoV2Space(path: string, pending: number) {
  const space = await probeVolumeSpace(path);
  if (!Number.isSafeInteger(pending) || pending < 0 || !space || space.availableBytes < 1024 ** 3 + pending) throw Error("ROTO_V2_ONE_GIB_RESERVE_REQUIRED");
}
export async function createRotoV2Workspace(path: string, pending: number, check: () => number) {
  check(); await assertRotoHoldoutLocalPathV1(dirname(path)); await assertRotoV2Space(dirname(path), pending);
  await mkdir(path); return assertRotoHoldoutLocalPathV1(path);
}
export async function measureRotoV2Tree(root: string, maximum: number, check: () => number) {
  let bytes = 0, files = 0;
  async function walk(path: string) {
    check(); await assertRotoHoldoutLocalPathV1(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error("ROTO_V2_OUTPUT_LINK_REFUSED");
      const p = join(path, entry.name); if (entry.isDirectory()) await walk(p);
      else { const info = await stat(p); if (!info.isFile()) throw Error("ROTO_V2_OUTPUT_NOT_REGULAR"); bytes += info.size; files++;
        if (bytes > maximum || files > 4096) throw Error("ROTO_V2_OUTPUT_BUDGET_EXCEEDED"); }
    }
  }
  await walk(root); return { bytes, files };
}
export async function assertRotoV2IdentityUnchanged(identity: { path: string; bytes: number; sha256: string }, check: () => number) {
  const now = await rotoHoldoutFileIdentityV1(identity.path, check);
  if (now.bytes !== identity.bytes || now.sha256 !== identity.sha256) throw Error("ROTO_V2_INPUT_IDENTITY_CHANGED");
}
