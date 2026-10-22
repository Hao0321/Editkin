import { lstat, readdir, statfs } from "node:fs/promises";
import { join, parse } from "node:path";

export interface SourcePreservingVolumeSpaceV1 { key: string; root: string; availableBytes: number }
export type SourcePreservingVolumeProbeV1 = (path: string) => Promise<SourcePreservingVolumeSpaceV1 | undefined>;
const probe: SourcePreservingVolumeProbeV1 = async path => {
  try {
    const identity = await lstat(path, { bigint: true });
    if (identity.isSymbolicLink()) return undefined;
    const space = await statfs(path, { bigint: true }), root = parse(path).root;
    const availableBytes = Number(space.bavail * space.bsize);
    if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) return undefined;
    return { key: identity.dev ? `dev:${identity.dev}` : `root:${root.toLowerCase()}`, root, availableBytes };
  } catch { return undefined; }
};
/** Leaf monitor: this path never imports colour/effect renderers or stages decoded media. */
export function sourcePreservingVolumeWatchV1(input: {
  requirements: readonly { path: string; initialBytes: number; reserveBytes: number }[];
  workRoot: string; stagingLimitBytes: number; onFailure: (error: unknown) => void; probe?: SourcePreservingVolumeProbeV1;
}) {
  if (input.requirements.length < 2) throw Error("RENDER_VOLUME_REQUIREMENTS_MISSING");
  let pending: Promise<void> | undefined, failure: unknown, initial = true, stopped = false, peakWorkBytes = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const check = () => {
    if (failure !== undefined) return Promise.reject(failure);
    if (pending) return pending;
    pending = (async () => {
      const volumes = new Map<string, { available: number; reserve: number; initialBytes: number }>();
      for (const requirement of input.requirements) {
        if (![requirement.initialBytes, requirement.reserveBytes].every(v => Number.isSafeInteger(v) && v >= 0)) throw Error("RENDER_VOLUME_BUDGET_INVALID");
        const volume = await (input.probe ?? probe)(requirement.path);
        if (!volume || !Number.isSafeInteger(volume.availableBytes) || volume.availableBytes < 0) throw Error("RENDER_VOLUME_SPACE_UNKNOWN");
        const row = volumes.get(volume.key) ?? { available: volume.availableBytes, reserve: 0, initialBytes: 0 };
        row.available = Math.min(row.available, volume.availableBytes); row.reserve = Math.max(row.reserve, requirement.reserveBytes);
        row.initialBytes += requirement.initialBytes; volumes.set(volume.key, row);
      }
      for (const volume of volumes.values()) if (volume.available < volume.reserve + (initial ? volume.initialBytes : 0)) throw Error("RENDER_VOLUME_SPACE_SHORT");
      const work = await lstat(input.workRoot), names = await readdir(input.workRoot);
      if (work.isSymbolicLink() || !work.isDirectory() || names.join() !== "owner.json") throw Error("SOURCE_PRESERVING_WORK_OWNER_CHANGED");
      const owner = await lstat(join(input.workRoot, "owner.json"));
      if (owner.isSymbolicLink() || !owner.isFile()) throw Error("SOURCE_PRESERVING_WORK_OWNER_CHANGED");
      if (!Number.isSafeInteger(input.stagingLimitBytes) || input.stagingLimitBytes < 1 || owner.size > input.stagingLimitBytes) throw Error("RENDER_STAGING_LIMIT_EXCEEDED");
      peakWorkBytes = Math.max(peakWorkBytes, owner.size); initial = false;
    })().catch(error => { failure = error; input.onFailure(error); throw error; }).finally(() => { pending = undefined; });
    return pending;
  };
  return { check,
    start() { if (!timer && !stopped) timer = setInterval(() => { void check().catch(() => undefined); }, 2_000); },
    async stop() { stopped = true; clearInterval(timer); await pending?.catch(() => undefined); },
    get receipt() { return { peakWorkBytes, stagingLimitBytes: input.stagingLimitBytes, intervalMs: 2_000, writtenByteInterval: 64 * 1024 ** 2 }; },
  };
}
