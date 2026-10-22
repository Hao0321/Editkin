import { describe, expect, it } from "vitest";
import { compileTimeRemapClockV1 } from "../domain/timeRemapClockV1";
import { blendRgbaFrameV1, createTimeRemapFrameConsumerV1 } from "./timeRemapFrameConsumerV1";
import type { DecodedPtsIndexV1 } from "./decodedPtsIndexV1";
const pts = [0, 100, 300, 500, 600, 1000, 1300, 1500];
function index(): DecodedPtsIndexV1 { return { timing: "vfr", timeBase: { numerator: 1, denominator: 1000 }, clockOrigin: { pts: 0, sourceSeconds: 0 }, decodedFrameCount: pts.length,
  lastFrameEndPts: 1600, metadataBytes: pts.length * 24, metadataSha256: "a".repeat(64), ptsAt: n => pts[n], seekIndexAt: () => 0, assertIdentity: async () => undefined,
  receipt: { pagesRead: 1, cachedBytes: 192, maximumCachedBytes: 192, idrAnchors: 0 } }; }
function clock(direction: "forward" | "reverse", speed: number) { return compileTimeRemapClockV1({ sourceStartSeconds: 0, sourceDurationSeconds: 1.6, timelineDurationSeconds: 1.6, outputRate: { numerator: 10, denominator: 1 }, direction,
  segments: [{ from: { time: 0, speed }, control1: { time: 1 / 3, speed }, control2: { time: 2 / 3, speed }, to: { time: 1, speed } }] }); }
describe("shared bounded decoded-frame consumer", () => {
  it("premultiplied blending avoids hidden transparent RGB and validates output shape", () => {
    const out = Buffer.alloc(4); blendRgbaFrameV1(Buffer.from([255, 0, 0, 0]), Buffer.from([0, 0, 255, 255]), .5, out); expect([...out]).toEqual([0, 0, 255, 128]);
    expect(() => blendRgbaFrameV1(out, out, NaN, out)).toThrow("SHAPE");
  });
  it("equivalent near-half clock arithmetic rounds to the same exact half-up byte", () => {
    const out = Buffer.alloc(4); for (const mix of [.14 - 1e-14, .14, .14 + 1e-14]) {
      blendRgbaFrameV1(Buffer.from([57, 0, 201, 255]), Buffer.from([32, 125, 126, 255]), mix, out); expect([...out]).toEqual([54, 18, 191, 255]);
    }
  });
  it.each(["forward", "reverse"] as const)("samples genuine VFR clock with a two-frame cache in %s direction", async direction => {
    const loads: number[][] = [], consumer = createTimeRemapFrameConsumerV1({ clock: clock(direction, 1), index: index(), width: 1, height: 1, ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000, maximumCacheBytes: 8,
      readBatch: async input => { loads.push([input.low, input.high]); return { pixels: Buffer.concat(Array.from({ length: input.high - input.low + 1 }, (_, n) => Buffer.from([(input.low + n) * 20, 0, 0, 255]))), frameBytes: 4, receipt: {} as never }; } });
    for (let n = 0; n < 16; n++) { const result = await consumer.sample(n); expect(result.bytes[0]).toBe(Math.round(result.sample.lowerFrame * 20 * (1 - result.sample.mix) + result.sample.upperFrame * 20 * result.sample.mix)); }
    expect(loads.length).toBeGreaterThan(1); expect(consumer.receipt.maximumCacheBytes).toBe(8); expect(consumer.receipt.maximumCacheFrames).toBe(2); expect(consumer.receipt.moviePixelsStaged).toBe(0); consumer.close();
  });
  it("freeze reuses its cache, indexed identity changes refuse, and closed consumers cannot produce", async () => {
    const source = index(), consumer = createTimeRemapFrameConsumerV1({ clock: clock("forward", 0), index: source, width: 1, height: 1, ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000, maximumCacheBytes: 8,
      readBatch: async () => ({ pixels: Buffer.from([17, 0, 0, 255, 21, 0, 0, 255]), frameBytes: 4, receipt: {} as never }) });
    for (let n = 0; n < 16; n++) expect((await consumer.sample(n)).bytes[0]).toBe(17); expect(consumer.receipt.decoderLoads).toBe(1);
    source.assertIdentity = async () => { throw Error("INDEX_CHANGED"); }; await expect(consumer.sample(0)).rejects.toThrow("INDEX_CHANGED"); consumer.close(); await expect(consumer.sample(0)).rejects.toThrow("STATE_INVALID");
  });
  it("preabort and insufficient cache budgets do not start a decoder", async () => {
    expect(() => createTimeRemapFrameConsumerV1({ clock: clock("forward", 1), index: index(), width: 1, height: 1, ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000, maximumCacheBytes: 4 })).toThrow("BUDGET");
    const controller = new AbortController(); controller.abort(Error("CONTROL_CANCEL")); const consumer = createTimeRemapFrameConsumerV1({ clock: clock("forward", 1), index: index(), width: 1, height: 1, ffmpegPath: "unused", sourcePath: "unused", timeoutMs: 1000, signal: controller.signal });
    await expect(consumer.sample(0)).rejects.toThrow("CONTROL_CANCEL");
  });
});
