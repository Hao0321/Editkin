import type { TimeRemapClockV1 } from "../domain/timeRemapClockV1";
import { timeRemapVfrBlendSampleV1 } from "../domain/timeRemapClockV1";
import type { DecodedPtsIndexV1 } from "./decodedPtsIndexV1";
import { createTimeRemapFrameConsumerV1, blendRgbaFrameV1 } from "./timeRemapFrameConsumerV1";
import { startRgbaPtsStreamV1 } from "./rgbaPtsStreamReaderV1";
import { readRgbaPtsBatchV1 } from "./rgbaPtsBatchReaderV1";
import { assertRenderActive } from "./renderLifetime";
import { resolveTimeRemapFrameWindowV1, type TimeRemapFrameWindowV1 } from "./timeRemapFrameWindowV1";

/** Sequential export consumer: one forward decoder and two source slots; reverse retains the proved bounded-window reader. */
export function createTimeRemapFrameConsumerV2(input: {
  clock: TimeRemapClockV1; index: DecodedPtsIndexV1; width: number; height: number; ffmpegPath: string; sourcePath: string;
  timeoutMs: number; signal?: AbortSignal; maximumCacheBytes?: number; readStream?: typeof startRgbaPtsStreamV1; readBatch?: typeof readRgbaPtsBatchV1;
  outputFrameWindow?: TimeRemapFrameWindowV1;
}) {
  const window = resolveTimeRemapFrameWindowV1(input.clock, input.outputFrameWindow);
  if (input.clock.direction === "reverse") {
    const samples: unknown[] = [], lifecycle = { totalReaders: 0, closedReaders: 0, failedReaders: 0, decodedBytes: 0, decodedFrames: 0,
      maximumBufferedPixelBytes: 0, maximumRetainedTerminalSamples: 8, maximumRetainedStderrCharsPerSample: 512 };
    const legacy = createTimeRemapFrameConsumerV1({ ...input, readBatch: async request => {
      // The legacy fullreceipt array is deliberately not fed. It otherwise grows once per decode window.
      return (input.readBatch ?? readRgbaPtsBatchV1)({ ...request, onTerminal: value => {
        const r = value as { closed?: boolean; code?: number | null; signal?: unknown; bytes?: number; frames?: number; maximumBufferedPixelBytes?: number; stderrTail?: string };
        lifecycle.totalReaders++; if (r.closed) lifecycle.closedReaders++; if (!r.closed || r.code !== 0 || r.signal) lifecycle.failedReaders++;
        lifecycle.decodedBytes += r.bytes ?? 0; lifecycle.decodedFrames += r.frames ?? 0;
        if (!Number.isSafeInteger(lifecycle.decodedBytes) || !Number.isSafeInteger(lifecycle.decodedFrames)) throw Error("CURVE_FRAME_DECODER_COUNTER_UNSAFE");
        lifecycle.maximumBufferedPixelBytes = Math.max(lifecycle.maximumBufferedPixelBytes, r.maximumBufferedPixelBytes ?? 0);
        samples.push({ ...r, stderrTail: (r.stderrTail ?? "").slice(-512) }); if (samples.length > 8) samples.shift();
      } });
    } });
    let next = window.firstFrame, windowFinished = false, windowClosed = false;
    return { ...legacy, decoderReceipts: samples, receipt: Object.assign(legacy.receipt, { decoderStrategy: "reverse_bounded_windows" as const, decoderLifecycle: lifecycle }),
      ...(input.outputFrameWindow ? { sample: async (frameIndex: number) => {
        if (windowFinished || windowClosed || frameIndex !== next || frameIndex >= window.endFrame) throw Error("CURVE_FRAME_WINDOW_SEQUENTIAL_STATE_INVALID");
        const result = await legacy.sample(frameIndex); next++; return result;
      } } : {}),
      finish: async () => { if (input.outputFrameWindow) { if (windowClosed || windowFinished || next !== window.endFrame) throw Error("CURVE_FRAME_WINDOW_FINISH_INCOMPLETE"); windowFinished = true; } }, close: async () => { legacy.close(); windowClosed = true; } };
  }
  const frameBytes = input.width * input.height * 4, budget = input.maximumCacheBytes ?? 64 * 1024 ** 2;
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 4 || !Number.isSafeInteger(budget) || budget < frameBytes * 2 || budget > 64 * 1024 ** 2) throw Error("CURVE_FRAME_CACHE_BUDGET_INVALID");
  const first = timeRemapVfrBlendSampleV1(input.clock, window.firstFrame, input.index), last = timeRemapVfrBlendSampleV1(input.clock, window.endFrame - 1, input.index);
  const slots = [{ index: -1, pixels: Buffer.alloc(frameBytes) }, { index: -1, pixels: Buffer.alloc(frameBytes) }], output = Buffer.alloc(frameBytes);
  let reader: Awaited<ReturnType<typeof startRgbaPtsStreamV1>> | undefined, cursor = first.lowerFrame, expectedOutput = window.firstFrame, busy = false, closed = false, finished = false;
  const decoderReceipts: unknown[] = [], receipt = {
    decoderStrategy: "forward_persistent_two_frame_slots" as const, framesSampled: 0, decoderLoads: 0, maximumCacheFrames: 2, maximumCacheBytes: frameBytes * 2,
    sourceMetadataBytes: input.index.metadataBytes, metadataPageCacheMaximumBytes: 0, outputFrameBytes: frameBytes, moviePixelsStaged: 0,
    sourceFramesRead: 0, decodedSpace: "encoded_rgba8_candidate" as const, sceneLinearHdrReady: false,
  };
  return {
    receipt, decoderReceipts,
    async sample(frameIndex: number) {
      assertRenderActive(); input.signal?.throwIfAborted();
      if (busy || closed || finished || frameIndex !== expectedOutput || frameIndex >= window.endFrame) throw Error("CURVE_FRAME_SEQUENTIAL_STATE_INVALID"); busy = true;
      try {
        await input.index.assertIdentity(); const sample = timeRemapVfrBlendSampleV1(input.clock, frameIndex, input.index);
        if (!reader) {
          reader = await (input.readStream ?? startRgbaPtsStreamV1)({ ...input, low: first.lowerFrame, high: last.upperFrame,
            onTerminal: r => decoderReceipts.push(r) }); receipt.decoderLoads++;
        }
        while (cursor <= sample.upperFrame) {
          const slot = slots[cursor % 2], decoded = await reader.readInto(slot.pixels);
          if (decoded.index !== cursor || decoded.pts !== input.index.ptsAt(cursor)) throw Error("CURVE_FRAME_STREAM_CLOCK_CHANGED");
          slot.index = cursor++; receipt.sourceFramesRead++;
        }
        const left = slots[sample.lowerFrame % 2], right = slots[sample.upperFrame % 2];
        if (left.index !== sample.lowerFrame || right.index !== sample.upperFrame) throw Error("CURVE_FRAME_STREAM_BRACKET_MISSING");
        blendRgbaFrameV1(left.pixels, right.pixels, sample.mix, output); expectedOutput++; receipt.framesSampled++;
        receipt.metadataPageCacheMaximumBytes = input.index.receipt.maximumCachedBytes;
        return { bytes: output, sample, pixelSpace: "encoded_rgba8_candidate" as const };
      } finally { busy = false; }
    },
    async finish() {
      assertRenderActive(); input.signal?.throwIfAborted();
      if (busy || closed || finished || expectedOutput !== window.endFrame || !reader) throw Error("CURVE_FRAME_SEQUENTIAL_FINISH_INVALID");
      busy = true; try { await reader.finish(); finished = true; } finally { busy = false; }
    },
    async close() {
      if (busy) throw Error("CURVE_FRAME_CONSUMER_BUSY"); if (closed) return; await reader?.close(); closed = true;
    },
  };
}
