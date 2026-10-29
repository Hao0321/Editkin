import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { probeVolumeSpace, type DiskSpaceProbe } from "./renderDiskSpace";

export const LONG_RENDER_STAGING_LIMIT_V1 = 2 * 1024 ** 3;
export interface RenderVolumeRequirementV1 { path: string; reserveBytes: number; initialBytes: number }

/** Count only a bounded owned tree; a swapped link is an error, never a new traversal root. */
async function vanishedBelowRoot<T>(path: string, root: string, read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); } catch (error) {
    if (path !== root && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function ownedStagingBytesV1(root: string): Promise<number> {
  const pending = [root]; let bytes = 0, entries = 0;
  while (pending.length) {
    // An owner (stream v2) may delete a staged entry between our readdir and lstat: a vanished entry below the root is
    // not a staging failure. A missing root still throws (a misconfigured work root must fail loudly).
    const path = pending.pop()!, info = await vanishedBelowRoot(path, root, () => lstat(path));
    if (!info) continue;
    if (info.isSymbolicLink()) throw Error("RENDER_WORK_REPARSE_REFUSED");
    if (++entries > 4_096) throw Error("RENDER_WORK_ENTRY_LIMIT");
    if (info.isDirectory()) for (const name of await vanishedBelowRoot(path, root, () => readdir(path)) ?? []) pending.push(join(path, name));
    else if (info.isFile()) bytes += info.size;
    else throw Error("RENDER_WORK_SPECIAL_FILE_REFUSED");
    if (!Number.isSafeInteger(bytes)) throw Error("RENDER_WORK_SIZE_INVALID");
  }
  return bytes;
}

export function createRenderVolumeWatchV1(input: { requirements: readonly RenderVolumeRequirementV1[];
  workRoot: string; stagingLimitBytes: number; onFailure: (error: unknown) => void; probe?: DiskSpaceProbe;
  sampleWork?: () => Promise<number> }) {
  const probe = input.probe ?? probeVolumeSpace;
  if (input.requirements.length < 2) throw Error("RENDER_VOLUME_REQUIREMENTS_MISSING");
  let pending: Promise<void> | undefined, failure: unknown, initial = true, stopped = false, lastBytes = 0, peakWorkBytes = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const check = () => {
    if (failure !== undefined) return Promise.reject(failure);
    if (pending) return pending;
    pending = (async () => {
      const volumes = new Map<string, { available: number; reserve: number; initialBytes: number }>();
      for (const item of input.requirements) {
        if (![item.reserveBytes, item.initialBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw Error("RENDER_VOLUME_BUDGET_INVALID");
        const volume = await probe(item.path);
        if (!volume || !Number.isFinite(volume.availableBytes) || volume.availableBytes < 0) throw Error("RENDER_VOLUME_SPACE_UNKNOWN");
        const row = volumes.get(volume.key) ?? { available: volume.availableBytes, reserve: 0, initialBytes: 0 };
        row.available = Math.min(row.available, volume.availableBytes); row.reserve = Math.max(row.reserve, item.reserveBytes);
        row.initialBytes += item.initialBytes; volumes.set(volume.key, row);
      }
      for (const row of volumes.values()) if (row.available < row.reserve + (initial ? row.initialBytes : 0)) throw Error("RENDER_VOLUME_SPACE_SHORT");
      const bytes = await (input.sampleWork?.() ?? ownedStagingBytesV1(input.workRoot));
      if (!Number.isSafeInteger(input.stagingLimitBytes) || input.stagingLimitBytes < 1 || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > input.stagingLimitBytes) throw Error("RENDER_STAGING_LIMIT_EXCEEDED");
      peakWorkBytes = Math.max(peakWorkBytes, bytes); initial = false;
    })().catch(error => { failure = error; input.onFailure(error); throw error; }).finally(() => { pending = undefined; });
    return pending;
  };
  return {
    check,
    start() { if (!timer && !stopped) timer = setInterval(() => { void check().catch(() => undefined); }, 2_000); },
    observeOutputBytes(bytes: number) {
      if (Number.isSafeInteger(bytes) && bytes - lastBytes >= 64 * 1024 ** 2) {
        lastBytes = bytes; void check().catch(() => undefined);
      }
    },
    async stop() { stopped = true; clearInterval(timer); await pending?.catch(() => undefined); },
    get receipt() { return { peakWorkBytes, stagingLimitBytes: input.stagingLimitBytes, intervalMs: 2_000, writtenByteInterval: 64 * 1024 ** 2 }; },
  };
}
