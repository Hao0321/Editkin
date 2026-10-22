import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { acquireProjectLock, ProjectLockBusyError } from "./projectFiles";

export const BATCH_EXECUTION_SLOTS_V1 = 4;
export class BatchExecutionBusyErrorV1 extends Error {
  constructor(readonly reason: "operation" | "capacity") { super(reason === "operation" ? "BATCH_OPERATION_ALREADY_RUNNING" : "BATCH_CAPACITY_REACHED"); this.name = "BatchExecutionBusyErrorV1"; }
}
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
async function plainDirectory(path: string) {
  if (!isAbsolute(path) || !samePath(resolve(path), path) || path.includes("\0")) throw new Error("BATCH_OWNER_HOST_PATH_REQUIRED");
  assertLocalMediaPath(path);
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current).catch(error => { if (error.code === "ENOENT") return; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("BATCH_OWNER_LINK_REFUSED");
    if (dirname(current) === current) break;
  }
  await mkdir(path, { recursive: true });
  if (!samePath(await realpath(path), path)) throw new Error("BATCH_OWNER_LINK_REFUSED");
}

/** Admission only: existing SQLite/OS project locks own the lease. No queue, job store, scheduler or PID expiry.
 * Both desktop CLI and VA must use the host's EDITKIN_CACHE_ROOT. Process death releases the OS handles. */
export async function withBatchExecutionOwnerV1<T>(cacheRoot: string, operationPath: string, execute: () => Promise<T>): Promise<T> {
  const slots = join(cacheRoot, "batch-execution-owner-v1");
  await plainDirectory(slots);
  if (!isAbsolute(operationPath) || operationPath.includes("\0")) throw new Error("BATCH_OWNER_OPERATION_PATH_REQUIRED");
  await plainDirectory(dirname(operationPath));
  let releaseOperation: () => Promise<void>;
  try { releaseOperation = await acquireProjectLock(`${operationPath}.batch-admission-v1`, { maximumAttempts: 1 }); }
  catch (error) { if (error instanceof ProjectLockBusyError) throw new BatchExecutionBusyErrorV1("operation"); throw error; }
  let releaseSlot: (() => Promise<void>) | undefined;
  try {
    for (let index = 0; index < BATCH_EXECUTION_SLOTS_V1; index++) {
      try { releaseSlot = await acquireProjectLock(join(slots, `slot-${index}`), { maximumAttempts: 1 }); break; }
      catch (error) { if (!(error instanceof ProjectLockBusyError)) throw error; }
    }
    if (!releaseSlot) throw new BatchExecutionBusyErrorV1("capacity");
    return await execute();
  } finally { try { await releaseSlot?.(); } finally { await releaseOperation(); } }
}
