// Versioned LONG-render policy (design C1 table). Adjustable through RenderOptions.longRender.policy
// (tests and MCP); the desktop uses these defaults. Invalid overrides are refused, never clamped.
import { totalmem } from "node:os";
import { LongRenderRefusalV1, type LongRenderPolicyOverrideV1, type LongRenderPolicyV1 } from "./longRenderContractsV1";

const MIB = 1024 ** 2, GIB = 1024 ** 3;

/** Q007 RAM budget: 40 % of physical memory, at most 8 GiB. */
export function longRenderRamBudgetBytesV1(totalMemoryBytes: number = totalmem()): number {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) return 0;
  return Math.floor(Math.min(.4 * totalMemoryBytes, 8 * GIB));
}

export function defaultLongRenderPolicyV1(totalMemoryBytes?: number): LongRenderPolicyV1 {
  return {
    schema: "editkin.long-render-policy/v1",
    minLongSeconds: 1800,
    stagingCapBytes: 2 * GIB,
    ramBudgetBytes: longRenderRamBudgetBytesV1(totalMemoryBytes),
    outputReserveBytes: GIB,
    workReserveBytes: GIB,
    systemReserveBytes: 2 * GIB,
    measureIntervalMs: 2_000,
    measureBytes: 64 * MIB,
    fastPollMs: 250,
    stopLatencyMs: 5_000,
    releaseMs: 10_000,
    frameQueueFrames: 8,
    frameQueueBytes: 256 * MIB,
    maxOwnedChildren: 5,
    residentStreamV2MaxAudioClips: 64,
    maxFloatingFramesPerClip: 36_000,
    diskEstimateMargin: 1.15,
  };
}

const INTEGER_RANGES: Partial<Record<keyof LongRenderPolicyV1, [number, number]>> = {
  minLongSeconds: [1, 30 * 24 * 3600],
  stagingCapBytes: [MIB, 1024 * GIB],
  ramBudgetBytes: [0, 1024 * GIB],
  outputReserveBytes: [0, 1024 * GIB],
  workReserveBytes: [0, 1024 * GIB],
  systemReserveBytes: [0, 1024 * GIB],
  measureIntervalMs: [50, 60_000],
  measureBytes: [64 * 1024, 64 * GIB],
  fastPollMs: [10, 10_000],
  stopLatencyMs: [0, 120_000],
  releaseMs: [1_000, 600_000],
  frameQueueFrames: [1, 64],
  frameQueueBytes: [MIB, 16 * GIB],
  maxOwnedChildren: [1, 64],
  residentStreamV2MaxAudioClips: [0, 4096],
  maxFloatingFramesPerClip: [1, 100_000_000],
};

/** Defaults merged with a validated override. */
export function resolveLongRenderPolicyV1(override?: LongRenderPolicyOverrideV1, totalMemoryBytes?: number): LongRenderPolicyV1 {
  const policy = defaultLongRenderPolicyV1(totalMemoryBytes);
  for (const [key, value] of Object.entries(override ?? {}) as Array<[keyof LongRenderPolicyV1, unknown]>) {
    if (key === "schema") throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "schema cannot be overridden");
    if (key === "diskEstimateMargin") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 4) throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", `${key} must be a number in [1, 4]`, { key, value });
      policy.diskEstimateMargin = value;
      continue;
    }
    const range = INTEGER_RANGES[key];
    if (!range) throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", `unknown policy member ${String(key)}`, { key });
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < range[0] || value > range[1]) {
      throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", `${key} must be an integer in [${range[0]}, ${range[1]}]`, { key, value });
    }
    (policy as unknown as Record<string, number>)[key] = value;
  }
  if (policy.frameQueueBytes < 1) throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "frame queue bytes must be positive");
  return policy;
}

/** Frames a bounded queue may hold: min(frames, floor(bytes / frameBytes)), at least 1 (C7). */
export function longRenderFrameQueueDepthV1(policy: Pick<LongRenderPolicyV1, "frameQueueFrames" | "frameQueueBytes">, frameBytes: number): number {
  if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0) throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "frame bytes must be a positive integer", { frameBytes });
  return Math.max(1, Math.min(policy.frameQueueFrames, Math.floor(policy.frameQueueBytes / frameBytes)));
}
