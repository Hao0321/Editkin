import type { TimeRemapClockV1 } from "../domain/timeRemapClockV1";
import { timeRemapVfrBlendSampleV1 } from "../domain/timeRemapClockV1";
import type { DecodedPtsIndexV1 } from "./decodedPtsIndexV1";
import { readRgbaPtsBatchV1 } from "./rgbaPtsBatchReaderV1";
import { assertRenderActive } from "./renderLifetime";

/** Shared byte-exact preview/export blend in the explicit decoded encoded-RGBA8 candidate space.
 * Scene-linear/HDR consumers must supply their working-space implementation; this does not impersonate ACES. */
export function blendRgbaFrameV1(left: Uint8Array, right: Uint8Array, mix: number, output: Uint8Array) {
  if (left.length !== right.length || left.length !== output.length || left.length % 4 || !Number.isFinite(mix) || mix < 0 || mix > 1) throw Error("CURVE_RGBA_BLEND_SHAPE_INVALID");
  if (!mix) { output.set(left); return; } if (mix === 1) { output.set(right); return; }
  // Canonical half-up byte rounding: two equivalent clock expressions must not flicker across a half-value.
  const byte = (value: number) => { const half = Math.floor(value) + .5; return Math.abs(value - half) <= 1e-9 ? Math.ceil(value) : Math.round(value); };
  for (let at = 0; at < output.length; at += 4) {
    const a0 = left[at + 3] / 255, a1 = right[at + 3] / 255, alpha = a0 * (1 - mix) + a1 * mix;
    for (let c = 0; c < 3; c++) output[at + c] = alpha ? byte((left[at + c] * a0 * (1 - mix) + right[at + c] * a1 * mix) / alpha) : 0;
    output[at + 3] = byte(alpha * 255);
  }
}

export function createTimeRemapFrameConsumerV1(input: { clock: TimeRemapClockV1; index: DecodedPtsIndexV1; width: number; height: number;
  ffmpegPath: string; sourcePath: string; timeoutMs: number; signal?: AbortSignal; maximumCacheBytes?: number;
  readBatch?: typeof readRgbaPtsBatchV1 }) {
  const frameBytes = input.width * input.height * 4, budget = input.maximumCacheBytes ?? 64 * 1024 ** 2;
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 4 || !Number.isSafeInteger(budget) || budget < frameBytes * 2 || budget > 64 * 1024 ** 2) throw Error("CURVE_FRAME_CACHE_BUDGET_INVALID");
  const capacity = Math.min(64, Math.floor(budget / frameBytes)); let cache: { low: number; high: number; pixels: Buffer } | undefined, busy = false, closed = false;
  const output = Buffer.alloc(frameBytes), decoderReceipts: unknown[] = [];
  const receipt = { framesSampled: 0, decoderLoads: 0, maximumCacheFrames: 0, maximumCacheBytes: 0,
    sourceMetadataBytes: input.index.metadataBytes, metadataPageCacheMaximumBytes: 0, outputFrameBytes: frameBytes, moviePixelsStaged: 0,
    decodedSpace: "encoded_rgba8_candidate" as const, sceneLinearHdrReady: false };
  return {
    receipt, decoderReceipts,
    /** Borrowed output is valid until the next sample; the sink must finish its write first. */
    async sample(frameIndex: number) {
      assertRenderActive(); input.signal?.throwIfAborted(); if (busy || closed) throw Error("CURVE_FRAME_CONSUMER_STATE_INVALID"); busy = true;
      try {
        await input.index.assertIdentity(); const sample = timeRemapVfrBlendSampleV1(input.clock, frameIndex, input.index);
        if (!cache || sample.lowerFrame < cache.low || sample.upperFrame > cache.high) {
          let low: number, high: number;
          if (input.clock.direction === "reverse") { high = sample.upperFrame; low = Math.max(0, high - capacity + 1); }
          else { low = sample.lowerFrame; high = Math.min(input.index.decodedFrameCount - 1, low + capacity - 1); }
          const batch = await (input.readBatch ?? readRgbaPtsBatchV1)({ ffmpegPath: input.ffmpegPath, sourcePath: input.sourcePath, index: input.index,
            width: input.width, height: input.height, low, high, maximumBytes: budget, timeoutMs: input.timeoutMs, signal: input.signal,
            onTerminal: r => decoderReceipts.push(r) });
          if (batch.pixels.length !== (high - low + 1) * frameBytes) throw Error("CURVE_FRAME_CACHE_INCOMPLETE");
          cache = { low, high, pixels: batch.pixels }; receipt.decoderLoads++;
          receipt.maximumCacheFrames = Math.max(receipt.maximumCacheFrames, high - low + 1); receipt.maximumCacheBytes = Math.max(receipt.maximumCacheBytes, batch.pixels.length);
        }
        const at = (index: number) => cache!.pixels.subarray((index - cache!.low) * frameBytes, (index - cache!.low + 1) * frameBytes);
        blendRgbaFrameV1(at(sample.lowerFrame), at(sample.upperFrame), sample.mix, output);
        receipt.framesSampled++; receipt.metadataPageCacheMaximumBytes = input.index.receipt.maximumCachedBytes;
        return { bytes: output, sample, pixelSpace: "encoded_rgba8_candidate" as const };
      } finally { busy = false; }
    },
    close() { if (busy) throw Error("CURVE_FRAME_CONSUMER_BUSY"); cache = undefined; closed = true; },
  };
}
