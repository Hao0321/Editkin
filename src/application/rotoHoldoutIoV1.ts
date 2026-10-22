import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { readBoundedFile } from "../shared/boundedFile";
import { probeVolumeSpace } from "../render/renderDiskSpace";
import { runAnalysisProcess } from "./analysisProcess";
import { ROTO_HOLDOUT_MAX_BYTES_V1 } from "./rotoHoldoutLabelKitV1";

export const rotoHoldoutDigestV1 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
export interface RotoHoldoutRuntimeV1 {
  ffmpegPath: string; ffprobePath: string; signal?: AbortSignal; timeoutMs?: number;
  onProgress?: (progress: { clipId: string; frame: number; completed: number; total: number }) => void;
}
export function rotoHoldoutBudgetV1(runtime: Pick<RotoHoldoutRuntimeV1, "signal" | "timeoutMs">) {
  const limit = runtime.timeoutMs ?? 120000;
  if (!Number.isFinite(limit) || limit <= 0 || limit > 120000) throw Error("ROTO_HOLDOUT_BUDGET_INVALID");
  const end = performance.now() + limit;
  return () => {
    runtime.signal?.throwIfAborted(); const remaining = end - performance.now();
    if (remaining <= 0) throw Error("ROTO_HOLDOUT_DEADLINE_EXCEEDED"); return remaining;
  };
}
export async function assertRotoHoldoutLocalPathV1(path: string) {
  if (!isAbsolute(path)) throw Error("ROTO_HOLDOUT_ABSOLUTE_PATH_REQUIRED"); assertLocalMediaPath(path);
  const resolved = resolve(path); let cursor = resolved;
  for (;;) {
    if ((await lstat(cursor)).isSymbolicLink()) throw Error("ROTO_HOLDOUT_LINK_REFUSED");
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const actual = await realpath(resolved);
  if ((process.platform === "win32" ? actual.toLowerCase() !== resolved.toLowerCase() : actual !== resolved)) throw Error("ROTO_HOLDOUT_PATH_ALIAS_REFUSED");
  return resolved;
}
export async function rotoHoldoutFileIdentityV1(path: string, check: () => number) {
  check(); path = await assertRotoHoldoutLocalPathV1(path); const before = await lstat(path);
  if (!before.isFile() || before.size <= 0) throw Error("ROTO_HOLDOUT_REGULAR_FILE_REQUIRED");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bound = await handle.stat();
    if (bound.ino !== before.ino || bound.dev !== before.dev || bound.size !== before.size) throw Error("ROTO_HOLDOUT_SOURCE_CHANGED");
    const hash = createHash("sha256"); let count = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) { check(); count += chunk.length; hash.update(chunk); }
    const after = await lstat(path), end = await handle.stat(); check();
    if (after.isSymbolicLink() || after.size !== count || end.size !== count || before.size !== count || before.mtimeMs !== after.mtimeMs
      || before.mtimeMs !== end.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) throw Error("ROTO_HOLDOUT_SOURCE_CHANGED");
    return { path, bytes: count, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}
export async function readRotoHoldoutFileV1(path: string, maxBytes: number) {
  return readBoundedFile(await assertRotoHoldoutLocalPathV1(path), maxBytes);
}
export async function rotoHoldoutProcessV1(path: string, args: string[], maximumStdout: number, runtime: RotoHoldoutRuntimeV1, check: () => number) {
  const result = await runAnalysisProcess(path, args, { timeoutMs: Math.min(30000, check()), signal: runtime.signal,
    maximumStdout, maximumStderr: 131072, label: "ROTO_HOLDOUT_PROCESS" });
  check(); return result;
}
export async function createRotoHoldoutOutputV1(path: string, check: () => number, maximumBytes = ROTO_HOLDOUT_MAX_BYTES_V1) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024 || maximumBytes > ROTO_HOLDOUT_MAX_BYTES_V1) throw Error("ROTO_HOLDOUT_BYTE_BUDGET_INVALID");
  if (!isAbsolute(path)) throw Error("ROTO_HOLDOUT_ABSOLUTE_PATH_REQUIRED"); assertLocalMediaPath(path); path = resolve(path);
  await assertRotoHoldoutLocalPathV1(dirname(path)); check(); await mkdir(path); const actual = await assertRotoHoldoutLocalPathV1(path);
  let written = 0;
  async function destination(name: string) {
    check(); const target = resolve(actual, name), scope = relative(actual, target);
    if (!scope || scope.startsWith("..") || isAbsolute(scope) || name.includes("\\") || name.includes(":")) throw Error("ROTO_HOLDOUT_OUTPUT_ESCAPE");
    await assertRotoHoldoutLocalPathV1(actual); let parent = actual;
    for (const part of relative(actual, dirname(target)).split(/[\\/]/).filter(Boolean)) {
      parent = join(parent, part);
      try { await mkdir(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await assertRotoHoldoutLocalPathV1(parent);
    }
    return target;
  }
  async function reserve(size: number) {
    check();
    if (written + size > maximumBytes) throw Error("ROTO_HOLDOUT_BYTE_BUDGET_EXCEEDED");
    const space = await probeVolumeSpace(actual);
    if (!space || space.availableBytes < 1024 ** 3 + size) throw Error("ROTO_HOLDOUT_VOLUME_RESERVE_REQUIRED");
  }
  return { path: actual, get writtenBytes() { return written; }, async write(name: string, bytes: Uint8Array | string) {
    const size = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength; await reserve(size);
    const target = await destination(name);
    await writeFile(target, bytes, { flag: "wx" }); written += size; check(); return target;
  }, async sequence(name: string, expectedBytes: number, chunks: AsyncIterable<Uint8Array>) {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw Error("ROTO_HOLDOUT_SEQUENCE_SIZE_INVALID");
    await reserve(expectedBytes); const target = await destination(name);
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); let count = 0;
    try {
      for await (const chunk of chunks) {
        if (count + chunk.byteLength > expectedBytes) throw Error("ROTO_HOLDOUT_SEQUENCE_OVERFLOW");
        await reserve(chunk.byteLength); let offset = 0;
        while (offset < chunk.byteLength) {
          check(); const result = await handle.write(chunk, offset, chunk.byteLength - offset, count + offset);
          if (!result.bytesWritten) throw Error("ROTO_HOLDOUT_SEQUENCE_WRITE_FAILED"); offset += result.bytesWritten;
        }
        count += chunk.byteLength; written += chunk.byteLength;
      }
      if (count !== expectedBytes) throw Error("ROTO_HOLDOUT_SEQUENCE_INCOMPLETE");
      await handle.sync(); check(); return target;
    } finally { await handle.close(); }
  } };
}
export function rotoHoldoutCandidateDigestV1(artifacts: Array<{ id: string; sha256: string }>) {
  return rotoHoldoutDigestV1(JSON.stringify(artifacts.map(({ id, sha256 }) => ({ id, sha256 })).sort((a, b) => a.id.localeCompare(b.id, "en"))));
}
export function rotoHoldoutOwnedPathV1(root: string, path: string) {
  const actual = resolve(root, path), scope = relative(resolve(root), actual);
  if (!scope || scope.startsWith("..") || isAbsolute(scope) || path.includes("\\") || path.includes(":")) throw Error("ROTO_HOLDOUT_INPUT_ESCAPE");
  return join(root, scope);
}
