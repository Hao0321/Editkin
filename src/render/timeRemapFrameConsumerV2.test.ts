import { describe, expect, it, vi } from "vitest";
import { compileTimeRemapClockV1 } from "../domain/timeRemapClockV1";
import type { DecodedPtsIndexV1 } from "./decodedPtsIndexV1";
import type { startRgbaPtsStreamV1 } from "./rgbaPtsStreamReaderV1";
import { createTimeRemapFrameConsumerV2 } from "./timeRemapFrameConsumerV2";
const pts = [0, 100, 300, 500, 600, 1000, 1300, 1500];
function index(): DecodedPtsIndexV1 {
  return { timing: "vfr", timeBase: { numerator: 1, denominator: 1000 }, clockOrigin: { pts: 0, sourceSeconds: 0 }, decodedFrameCount: pts.length,
    lastFrameEndPts: 1600, metadataBytes: 192, metadataSha256: "a".repeat(64), ptsAt: n => pts[n], seekIndexAt: () => 0, assertIdentity: async () => undefined,
    receipt: { pagesRead: 1, cachedBytes: 192, maximumCachedBytes: 192, idrAnchors: 0 } };
}
function clock(speed: number, duration = 1.6) {
  return compileTimeRemapClockV1({ sourceStartSeconds: 0, sourceDurationSeconds: 1.6, timelineDurationSeconds: duration, outputRate: { numerator: 10, denominator: 1 }, direction: "forward",
    segments: [{ from: { time: 0, speed }, control1: { time: 1 / 3, speed }, control2: { time: 2 / 3, speed }, to: { time: 1, speed } }] });
}
function reader() {
  const reads: number[] = [], finish = vi.fn(async () => undefined), close = vi.fn(async () => undefined);
  const start = vi.fn(async (input: Parameters<typeof startRgbaPtsStreamV1>[0]) => {
    let cursor = input.low;
    return { readInto: async (destination: Uint8Array) => { const n = cursor++; reads.push(n); destination.set([n * 20, 0, 0, 255]); return { index: n, pts: pts[n] }; },
      finish: async () => { expect(cursor).toBe(input.high + 1); await finish(); input.onTerminal?.({ simulatedProtocolOnly: true }); }, close };
  });
  return { reads, finish, close, start };
}
function make(speed = 1, duration = 1.6) {
  const r = reader(), source = index(), consumer = createTimeRemapFrameConsumerV2({ clock: clock(speed, duration), index: source, width: 1, height: 1,
    ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000, maximumCacheBytes: 8, readStream: r.start });
  return { r, source, consumer };
}
function oracle(ticks: number) {
  let low = 0; while (low + 1 < pts.length && pts[low + 1] <= ticks) low++;
  const high = Math.min(pts.length - 1, low + 1);
  return high === low ? low * 20 : Math.round(20 * (low + (ticks - pts[low]) / (pts[high] - pts[low])));
}
describe("persistent sequential source-clock consumer protocol", () => {
  it("uses a single stream, two slots and true VFR brackets for repeated/advancing source positions", async () => {
    const f = make(); for (let n = 0; n < 16; n++) expect((await f.consumer.sample(n)).bytes[0]).toBe(oracle(n * 100));
    await f.consumer.finish(); await f.consumer.close(); expect(f.r.start).toHaveBeenCalledOnce(); expect(f.r.finish).toHaveBeenCalledOnce(); expect(f.r.close).toHaveBeenCalledOnce();
    expect(f.r.reads).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); expect(f.consumer.receipt.maximumCacheFrames).toBe(2); expect(f.consumer.receipt.maximumCacheBytes).toBe(8);
    expect(f.consumer.receipt.decoderLoads).toBe(1); expect(f.consumer.receipt.moviePixelsStaged).toBe(0);
  });
  it("freeze reads only its bracket once, fast source skipping still preserves exact two-slot brackets", async () => {
    const frozen = make(0); for (let n = 0; n < 16; n++) expect((await frozen.consumer.sample(n)).bytes[0]).toBe(0);
    await frozen.consumer.finish(); await frozen.consumer.close(); expect(frozen.r.reads).toEqual([0, 1]); expect(frozen.r.start).toHaveBeenCalledOnce();
    const fast = make(4, .4); for (let n = 0; n < 4; n++) expect((await fast.consumer.sample(n)).bytes[0]).toBe(oracle(n * 400));
    await fast.consumer.finish(); await fast.consumer.close(); expect(fast.r.reads).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("nonsequential access, early finish and closed state refuse without starting a decoder", async () => {
    const f = make(); await expect(f.consumer.sample(1)).rejects.toThrow("SEQUENTIAL_STATE"); await expect(f.consumer.finish()).rejects.toThrow("FINISH_INVALID");
    await f.consumer.close(); await expect(f.consumer.sample(0)).rejects.toThrow("SEQUENTIAL_STATE"); expect(f.r.start).not.toHaveBeenCalled();
  });
  it("abort or changed index refuses without consuming more source bytes", async () => {
    const f = make(); await f.consumer.sample(0); const reads = f.r.reads.length; f.source.assertIdentity = async () => { throw Error("INDEX_CHANGED"); };
    await expect(f.consumer.sample(1)).rejects.toThrow("INDEX_CHANGED"); expect(f.r.reads).toHaveLength(reads); await f.consumer.close();
    const r = reader(), signal = new AbortController(); signal.abort(Error("CONTROL_CANCEL"));
    const c = createTimeRemapFrameConsumerV2({ clock: clock(1), index: index(), width: 1, height: 1, ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000, signal: signal.signal, readStream: r.start });
    await expect(c.sample(0)).rejects.toThrow("CONTROL_CANCEL"); expect(r.start).not.toHaveBeenCalled(); await c.close();
  });
  it("a producer handing back another indexed frame refuses before emitting blended output", async () => {
    const c = createTimeRemapFrameConsumerV2({ clock: clock(1), index: index(), width: 1, height: 1, ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000,
      readStream: async () => ({ readInto: async destination => { destination.fill(1); return { index: 99, pts: 0 }; }, finish: async () => undefined, close: async () => undefined }) });
    await expect(c.sample(0)).rejects.toThrow("STREAM_CLOCK_CHANGED"); await c.close();
  });
  it("an undersized cache budget cannot allocate/start; concurrent sample/close refuse", async () => {
    expect(() => createTimeRemapFrameConsumerV2({ clock: clock(1), index: index(), width: 1, height: 1, ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000, maximumCacheBytes: 4 })).toThrow("BUDGET");
    let resume: () => void = () => undefined; const gate = new Promise<void>(done => { resume = done; }); let n = 0;
    const c = createTimeRemapFrameConsumerV2({ clock: clock(1), index: index(), width: 1, height: 1, ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000,
      readStream: async () => ({ readInto: async destination => { await gate; destination.set([n * 20, 0, 0, 255]); return { index: n, pts: pts[n++] }; }, finish: async () => undefined, close: async () => undefined }) });
    const pending = c.sample(0); await expect(c.sample(0)).rejects.toThrow("SEQUENTIAL_STATE"); await expect(c.close()).rejects.toThrow("BUSY"); resume(); await pending; await c.close();
  });
  it("many reverse windows retain bounded terminal samples and exact aggregate counts", async () => {
    const source: DecodedPtsIndexV1 = { ...index(), decodedFrameCount: 2000, lastFrameEndPts: 2000, metadataBytes: 48000, ptsAt: n => n };
    const reversed = compileTimeRemapClockV1({ sourceStartSeconds: 0, sourceDurationSeconds: 2, timelineDurationSeconds: 2, outputRate: { numerator: 1000, denominator: 1 }, direction: "reverse",
      segments: [{ from: { time: 0, speed: 1 }, control1: { time: 1 / 3, speed: 1 }, control2: { time: 2 / 3, speed: 1 }, to: { time: 1, speed: 1 } }] });
    let loads = 0; const c = createTimeRemapFrameConsumerV2({ clock: reversed, index: source, width: 1, height: 1, ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000, maximumCacheBytes: 8,
      readBatch: async request => { const count = request.high - request.low + 1; loads++; request.onTerminal?.({ closed: true, code: 0, signal: null, bytes: count * 4, frames: count, maximumBufferedPixelBytes: count * 4, stderrTail: "x".repeat(2048) });
        return { pixels: Buffer.concat(Array.from({ length: count }, (_, n) => Buffer.from([(request.low + n) % 256, 0, 0, 255]))), frameBytes: 4, receipt: {} as never }; } });
    for (let n = 0; n < 2000; n++) await c.sample(n); await c.finish(); await c.close();
    expect(loads).toBeGreaterThan(100); expect(c.decoderReceipts).toHaveLength(8); expect(c.decoderReceipts.every(r => (r as { stderrTail: string }).stderrTail.length === 512)).toBe(true);
    expect("decoderLifecycle" in c.receipt && c.receipt.decoderLifecycle.totalReaders).toBe(loads);
    expect("decoderLifecycle" in c.receipt && c.receipt.decoderLifecycle.closedReaders).toBe(loads);
    expect("decoderLifecycle" in c.receipt && c.receipt.decoderLifecycle.failedReaders).toBe(0);
    expect(c.receipt.maximumCacheBytes).toBe(8);
  });
});
