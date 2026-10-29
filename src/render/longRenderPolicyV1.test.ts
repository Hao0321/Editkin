import { describe, expect, it } from "vitest";
import { defaultLongRenderPolicyV1, longRenderFrameQueueDepthV1, longRenderRamBudgetBytesV1, resolveLongRenderPolicyV1 } from "./longRenderPolicyV1";
import { isLongRenderRefusalV1 } from "./longRenderContractsV1";

const MIB = 1024 ** 2, GIB = 1024 ** 3;

describe("long-render policy v1", () => {
  it("carries the design C1 values", () => {
    const policy = defaultLongRenderPolicyV1(32 * GIB);
    expect(policy).toMatchObject({ schema: "editkin.long-render-policy/v1", minLongSeconds: 1800, stagingCapBytes: 2 * GIB, ramBudgetBytes: 8 * GIB,
      outputReserveBytes: GIB, workReserveBytes: GIB, systemReserveBytes: 2 * GIB, measureIntervalMs: 2000, measureBytes: 64 * MIB,
      stopLatencyMs: 5000, releaseMs: 10_000, frameQueueFrames: 8, frameQueueBytes: 256 * MIB, maxOwnedChildren: 5,
      residentStreamV2MaxAudioClips: 64, maxFloatingFramesPerClip: 36_000, diskEstimateMargin: 1.15 });
  });

  it("sizes the Q007 RAM budget as min(40 % of RAM, 8 GiB)", () => {
    expect(longRenderRamBudgetBytesV1(16 * GIB)).toBe(Math.floor(.4 * 16 * GIB));
    expect(longRenderRamBudgetBytesV1(20 * GIB)).toBe(8 * GIB);
    expect(longRenderRamBudgetBytesV1(64 * GIB)).toBe(8 * GIB);
    expect(longRenderRamBudgetBytesV1(0)).toBe(0);
  });

  it("accepts validated overrides and refuses anything else instead of clamping", () => {
    expect(resolveLongRenderPolicyV1({ minLongSeconds: 60, outputReserveBytes: 0, diskEstimateMargin: 1.5 }, 16 * GIB)).toMatchObject({ minLongSeconds: 60, outputReserveBytes: 0, diskEstimateMargin: 1.5 });
    const invalid: Array<Record<string, unknown>> = [
      { schema: "x" }, { unknownMember: 1 }, { minLongSeconds: 0 }, { minLongSeconds: 1.5 }, { stagingCapBytes: -1 }, { measureIntervalMs: 10 },
      { measureBytes: "64" }, { diskEstimateMargin: .9 }, { diskEstimateMargin: Number.NaN }, { frameQueueFrames: 0 }, { releaseMs: 1 },
    ];
    for (const override of invalid) {
      let error: unknown;
      try { resolveLongRenderPolicyV1(override as never); } catch (caught) { error = caught; }
      expect(isLongRenderRefusalV1(error, "LONG_RENDER_POLICY_INVALID"), JSON.stringify(override)).toBe(true);
    }
  });

  it("bounds the frame queue by frames and bytes, never below one frame", () => {
    const policy = defaultLongRenderPolicyV1();
    expect(longRenderFrameQueueDepthV1(policy, 1920 * 1080 * 4)).toBe(8);
    expect(longRenderFrameQueueDepthV1(policy, 3840 * 2160 * 8)).toBe(4);
    expect(longRenderFrameQueueDepthV1(policy, 300 * MIB)).toBe(1);
    expect(() => longRenderFrameQueueDepthV1(policy, 0)).toThrow(/LONG_RENDER_POLICY_INVALID/);
  });
});
