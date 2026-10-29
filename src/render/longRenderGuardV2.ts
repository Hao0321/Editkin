// LONG-render space guard v2 (design C2; LV-05). renderVolumeWatchV1 stays frozen for its existing callers.
// - Rows are the output, work and system volumes (source volumes only when they are also one of those).
// - A full measure runs every `measureIntervalMs`, and as soon as 64 MiB more were written: either the free space
//   of a watched volume fell by `measureBytes` (any writer, including a foreign one) or the owned writers grew by it.
// - Per volume: burst = max(measureBytes, its peak write rate * (interval + stop latency)); stop when free < reserve + burst.
// - Owned staging (the run work directory, never the encoded output) stays <= the staging cap; links are refused.
// - Unknown volumes fail closed. A projected shortfall is a visible warning, never a silent quality change.
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { probeVolumeSpace, type DiskSpaceProbe } from "./renderDiskSpace";
import { LongRenderRefusalV1, type LongGuardReceiptV1, type LongRenderPolicyV1, type LongRenderSpaceGuardHandleV1 } from "./longRenderContractsV1";

export type LongGuardRoleV1 = "output" | "work" | "system";
export interface LongGuardRowInputV1 { path: string; role: LongGuardRoleV1 }

const MAX_TREE_ENTRIES = 4_096;

/**
 * Bytes of regular files under owned roots; a link/junction or special file anywhere is an error (never followed).
 * Transient entries removed by their owner during the walk (stream frames, finished workspaces) are skipped: unlike
 * renderVolumeWatchV1.ownedStagingBytesV1, a vanished entry is not a staging failure.
 */
export async function ownedTreeBytesV2(roots: readonly string[]): Promise<number> {
  let bytes = 0, entries = 0;
  for (const root of roots) {
    const pending = [root];
    while (pending.length) {
      const path = pending.pop()!;
      let info;
      try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (info.isSymbolicLink()) throw new LongRenderRefusalV1("LONG_RENDER_WORK_ROOT_REPARSE", "a link or junction appeared inside owned render staging", { path });
      if (++entries > MAX_TREE_ENTRIES) throw new LongRenderRefusalV1("LONG_RENDER_STAGING_LIMIT", "owned staging holds more entries than the bounded walk allows", { root, limit: MAX_TREE_ENTRIES });
      if (info.isDirectory()) {
        let names: string[];
        try { names = await readdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        for (const name of names) pending.push(join(path, name));
      }
      else if (info.isFile()) bytes += info.size;
      else throw new LongRenderRefusalV1("LONG_RENDER_WORK_ROOT_REPARSE", "a special file appeared inside owned render staging", { path });
    }
  }
  if (!Number.isSafeInteger(bytes)) throw new LongRenderRefusalV1("LONG_RENDER_STAGING_LIMIT", "owned staging size is not a safe integer");
  return bytes;
}

interface VolumeState {
  key: string; root: string; roles: Set<LongGuardRoleV1>; probePath: string; reserveBytes: number;
  lastFullFree: number; minFree: number; peakRate: number;
  /** Recent (time, free) samples; the write rate is measured over at least `rateWindowMs`, never between two jittery polls. */
  samples: Array<{ at: number; free: number }>;
}

export interface LongRenderSpaceGuardV2 extends LongRenderSpaceGuardHandleV1 {
  /** Final-size admission: refuse when estimate * margin + reserve exceeds the free space of a volume. */
  admit(estimate: { outputBytes: number; workBytes: number }): Promise<{ volumes: Array<{ root: string; freeBytes: number; neededBytes: number }> }>;
  start(): void;
  stop(): Promise<void>;
}

export function createLongRenderSpaceGuardV2(input: {
  rows: readonly LongGuardRowInputV1[];
  policy: LongRenderPolicyV1;
  /** Owned staging roots (work files) bounded by policy.stagingCapBytes. */
  stagingRoots: readonly string[];
  /** Owned roots that hold the growing encoded output; their growth is writer progress, not staging. */
  outputRoots?: readonly string[];
  onFailure: (error: LongRenderRefusalV1) => void;
  onWarning?: (message: string) => void;
  /** Projected bytes the output still has to write, given the bytes the owned writers wrote so far (shortfall warning). */
  remainingOutputBytes?: (writtenOutputBytes: number) => number | undefined;
  probe?: DiskSpaceProbe;
  now?: () => number;
}): LongRenderSpaceGuardV2 {
  const policy = input.policy, probe = input.probe ?? probeVolumeSpace, now = input.now ?? (() => performance.now());
  const reserveFor = (role: LongGuardRoleV1) => role === "system" ? policy.systemReserveBytes : role === "work" ? policy.workReserveBytes : policy.outputReserveBytes;
  if (!input.rows.some(row => row.role === "output") || !input.rows.some(row => row.role === "work")) {
    throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "the guard needs at least an output row and a work row");
  }
  const volumes = new Map<string, VolumeState>();
  let initialized = false, stopped = false, failure: LongRenderRefusalV1 | undefined, pending: Promise<void> | undefined;
  let fastTimer: ReturnType<typeof setInterval> | undefined, fullTimer: ReturnType<typeof setInterval> | undefined;
  let fullMeasures = 0, fastPolls = 0, triggeredByBytes = 0, peakStagingBytes = 0, peakBurstBytes = 0, warnedShortfall = false;
  let lastFullWriterBytes = 0, latestWriterBytes = 0, stopReason: string | undefined;
  const reported = new Map<string, number>();
  const warnings: string[] = [];

  const fail = (error: LongRenderRefusalV1) => {
    if (failure) return failure;
    failure = error; stopReason = error.message;
    clearInterval(fastTimer); clearInterval(fullTimer);
    try { input.onFailure(error); } catch { /* the owner decides how to stop */ }
    return error;
  };

  const measureRows = async () => {
    const seen = new Map<string, { free: number; root: string }>();
    for (const row of input.rows) {
      const space = await probe(row.path);
      if (!space || !Number.isFinite(space.availableBytes) || space.availableBytes < 0) {
        throw new LongRenderRefusalV1("LONG_RENDER_VOLUME_UNKNOWN", `free space of ${row.path} cannot be measured; a LONG render never runs on an unmeasured volume`, { path: row.path, role: row.role });
      }
      const state = volumes.get(space.key);
      if (!state) {
        if (initialized) throw new LongRenderRefusalV1("LONG_RENDER_VOLUME_UNKNOWN", `the volume of ${row.path} changed during the render`, { path: row.path });
        volumes.set(space.key, { key: space.key, root: space.root, roles: new Set([row.role]), probePath: row.path, reserveBytes: reserveFor(row.role),
          lastFullFree: space.availableBytes, minFree: space.availableBytes, peakRate: 0, samples: [{ at: now(), free: space.availableBytes }] });
      } else if (!initialized) { state.roles.add(row.role); state.reserveBytes = Math.max(state.reserveBytes, reserveFor(row.role)); }
      const previous = seen.get(space.key);
      seen.set(space.key, { free: Math.min(previous?.free ?? Infinity, space.availableBytes), root: space.root });
    }
    initialized = true;
    return seen;
  };

  // Rate over a window of at least 200 ms (up to 1 s): timer jitter between two fast polls cannot inflate the burst.
  const rateWindowMs = Math.max(200, Math.min(1_000, Math.floor(policy.measureIntervalMs / 2)));
  const updateRate = (state: VolumeState, free: number, at: number) => {
    state.minFree = Math.min(state.minFree, free);
    let reference: { at: number; free: number } | undefined;
    for (const sample of state.samples) if (at - sample.at >= rateWindowMs) reference = sample;
    if (reference && reference.free > free) state.peakRate = Math.max(state.peakRate, (reference.free - free) / ((at - reference.at) / 1000));
    state.samples.push({ at, free });
    while (state.samples.length > 2 && at - state.samples[1].at >= rateWindowMs) state.samples.shift();
    if (state.samples.length > 512) state.samples.splice(0, state.samples.length - 512);
  };

  // Per volume: writes to one volume (e.g. other programs on the system volume) never inflate another volume's burst.
  const burstBytes = (state: VolumeState) => Math.max(policy.measureBytes, Math.ceil(state.peakRate * (policy.measureIntervalMs + policy.stopLatencyMs) / 1000));

  const fullCheck = (reason: string): Promise<void> => {
    if (failure) return Promise.reject(failure);
    if (pending) return pending;
    pending = (async () => {
      const at = now();
      const measured = await measureRows();
      for (const [key, value] of measured) updateRate(volumes.get(key)!, value.free, at);
      const staging = await ownedTreeBytesV2(input.stagingRoots);
      peakStagingBytes = Math.max(peakStagingBytes, staging);
      if (staging > policy.stagingCapBytes) throw new LongRenderRefusalV1("LONG_RENDER_STAGING_LIMIT", `owned staging reached ${staging} bytes, above the ${policy.stagingCapBytes}-byte cap`, { stagingBytes: staging, capBytes: policy.stagingCapBytes });
      for (const [key, value] of measured) {
        const state = volumes.get(key)!, burst = burstBytes(state);
        peakBurstBytes = Math.max(peakBurstBytes, burst);
        state.lastFullFree = value.free;
        if (value.free < state.reserveBytes + burst) {
          throw new LongRenderRefusalV1("LONG_RENDER_SPACE_SHORT", `${state.root} has ${value.free} bytes free, below the reserve ${state.reserveBytes} plus the write burst ${burst}; the render stopped before the disk filled`,
            { root: state.root, roles: [...state.roles], freeBytes: value.free, reserveBytes: state.reserveBytes, burstBytes: burst, reason });
        }
      }
      const remaining = input.remainingOutputBytes?.(latestWriterBytes);
      if (remaining !== undefined && Number.isFinite(remaining) && remaining > 0) {
        const output = [...volumes.values()].find(state => state.roles.has("output"));
        const projected = output ? output.lastFullFree - remaining * policy.diskEstimateMargin : Infinity;
        if (output && projected < output.reserveBytes && !warnedShortfall) {
          warnedShortfall = true;
          const message = `LONG_RENDER_SPACE_PROJECTED_SHORTFALL: ${output.root} may run short before the end (projected ${Math.floor(projected)} bytes left vs reserve ${output.reserveBytes}); the render continues at unchanged quality and stops safely if the reserve is reached.`;
          warnings.push(message);
          try { input.onWarning?.(message); } catch { /* warnings never change the render */ }
        }
      }
      lastFullWriterBytes = latestWriterBytes;
      fullMeasures += 1;
    })().catch(error => { throw fail(error instanceof LongRenderRefusalV1 ? error : new LongRenderRefusalV1("LONG_RENDER_VOLUME_UNKNOWN", error instanceof Error ? error.message : String(error))); })
      .finally(() => { pending = undefined; });
    return pending;
  };

  const fastPoll = async () => {
    if (failure || stopped) return;
    fastPolls += 1;
    try {
      const at = now();
      let trigger = false;
      for (const state of volumes.values()) {
        const space = await probe(state.probePath);
        if (!space || space.key !== state.key) { trigger = true; continue; }
        updateRate(state, space.availableBytes, at);
        if (state.lastFullFree - space.availableBytes >= policy.measureBytes) trigger = true;
      }
      if (input.outputRoots?.length) {
        latestWriterBytes = Math.max(latestWriterBytes, await ownedTreeBytesV2(input.outputRoots).catch(() => latestWriterBytes));
      }
      const reportedTotal = [...reported.values()].reduce((sum, value) => sum + value, 0);
      latestWriterBytes = Math.max(latestWriterBytes, reportedTotal);
      if (latestWriterBytes - lastFullWriterBytes >= policy.measureBytes) trigger = true;
      if (trigger && !pending) { triggeredByBytes += 1; await fullCheck("64-MiB-written").catch(() => undefined); }
    } catch { /* a failed fast poll is retried; the full measure decides */ }
  };

  return {
    async admit(estimate) {
      const measured = await measureRows().catch(error => { throw fail(error instanceof LongRenderRefusalV1 ? error : new LongRenderRefusalV1("LONG_RENDER_VOLUME_UNKNOWN", String(error))); });
      const rows: Array<{ root: string; freeBytes: number; neededBytes: number }> = [];
      for (const [key, value] of measured) {
        const state = volumes.get(key)!;
        const output = state.roles.has("output") ? estimate.outputBytes : 0, work = state.roles.has("work") ? estimate.workBytes : 0;
        const needed = Math.ceil((output + work) * policy.diskEstimateMargin) + state.reserveBytes;
        rows.push({ root: state.root, freeBytes: value.free, neededBytes: needed });
        if (value.free < needed) {
          throw fail(new LongRenderRefusalV1("LONG_RENDER_SPACE_SHORT", `${state.root} has ${value.free} bytes free; this LONG render needs about ${needed} bytes (output ${output}, staging ${work}, reserve ${state.reserveBytes}) before it starts`,
            { root: state.root, freeBytes: value.free, neededBytes: needed, outputBytes: output, workBytes: work, reserveBytes: state.reserveBytes, admission: true }));
        }
      }
      return { volumes: rows };
    },
    start() {
      if (fastTimer || stopped || failure) return;
      fastTimer = setInterval(() => { void fastPoll(); }, policy.fastPollMs);
      fullTimer = setInterval(() => { void fullCheck("interval").catch(() => undefined); }, policy.measureIntervalMs);
    },
    check(reason: string) { return fullCheck(reason); },
    observeWrittenBytes(source: string, cumulativeBytes: number) {
      if (!Number.isSafeInteger(cumulativeBytes) || cumulativeBytes < 0) return;
      reported.set(source, Math.max(reported.get(source) ?? 0, cumulativeBytes));
      const total = [...reported.values()].reduce((sum, value) => sum + value, 0);
      if (total - lastFullWriterBytes >= policy.measureBytes && !pending && !failure) { triggeredByBytes += 1; latestWriterBytes = Math.max(latestWriterBytes, total); void fullCheck("writer-64-MiB").catch(() => undefined); }
    },
    async stop() {
      stopped = true; clearInterval(fastTimer); clearInterval(fullTimer);
      await pending?.catch(() => undefined);
    },
    get receipt(): LongGuardReceiptV1 {
      return {
        schema: "editkin.long-render-guard/v2",
        volumes: [...volumes.values()].map(state => ({ key: state.key, root: state.root, roles: [...state.roles], reserveBytes: state.reserveBytes,
          minFreeBytes: state.minFree, peakWriteBytesPerSecond: Math.round(state.peakRate) })),
        fullMeasures, fastPolls, triggeredByBytes, peakStagingBytes, stagingCapBytes: policy.stagingCapBytes, peakBurstBytes,
        intervalMs: policy.measureIntervalMs, measureBytes: policy.measureBytes, warnings: [...warnings], ...(stopReason ? { stopReason } : {}),
      };
    },
  };
}
