import { describe, expect, it } from "vitest";
import { prepareAudioInputGroupsV2, addQuadPcmF32LeV2 } from "./globalAudioGroupPlanV2";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";
import { runRawVideoProcessV1 } from "./rawVideoProcessV1";

describe("bounded grouped PCM planning and shared backing storage", () => {
  it("preserves every source in order while limiting each decoder group to64", () => {
    const sources = Array.from({ length: 129 }, (_, i) => i), groups = prepareAudioInputGroupsV2(sources, group => [...group]);
    expect(groups.map(group => group.length)).toEqual([64, 64, 1]); expect(groups.flat()).toEqual(sources);
    expect(prepareAudioInputGroupsV2([], group => group.length)).toEqual([0]);
  });
  it("splits only a typed argv-size failure, and preserves other refusals", () => {
    const groups = prepareAudioInputGroupsV2([0, 1, 2, 3, 4, 5, 6], group => {
      if (group.length > 3) throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "argv", { reason: "audio-window-argument-budget" });
      return [...group];
    });
    expect(groups.map(group => group.length)).toEqual([3, 2, 2]); expect(groups.flat()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const refusal = new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "actual source failure");
    expect(() => prepareAudioInputGroupsV2([1, 2], () => { throw refusal; })).toThrow(refusal);
    const oversized = new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "one path too long", { reason: "audio-window-argument-budget" });
    expect(() => prepareAudioInputGroupsV2([1], () => { throw oversized; })).toThrow(oversized);
  });
  it("adds disjoint views of one buffer without swapping voice/music lanes", () => {
    const storage = Buffer.alloc(32), target = storage.subarray(0, 16), source = storage.subarray(16);
    [1, 2, 3, 4].forEach((value, i) => { target.writeFloatLE(value / 8, i * 4); source.writeFloatLE(value / 16, i * 4); });
    addQuadPcmF32LeV2(target, source);
    expect(Array.from({ length: 4 }, (_, i) => target.readFloatLE(i * 4))).toEqual([.1875, .375, .5625, .75]);
  });
  it("refuses aliasing, partial quad samples, unaligned and nonfinite PCM", () => {
    const target = Buffer.alloc(16);
    expect(() => addQuadPcmF32LeV2(target, target)).toThrow("PCM_VIEW_INVALID");
    expect(() => addQuadPcmF32LeV2(target, Buffer.alloc(12))).toThrow("PCM_VIEW_INVALID");
    expect(() => addQuadPcmF32LeV2(target, Buffer.alloc(17).subarray(1))).toThrow("PCM_VIEW_INVALID");
    const invalid = Buffer.alloc(16); invalid.writeFloatLE(NaN, 8);
    expect(() => addQuadPcmF32LeV2(target, invalid)).toThrow("PCM_NONFINITE");
  });
  it("uses the caller's one-frame storage and closes the real stdout producer", async () => {
    const borrowed = Buffer.alloc(32, 0), observed: Uint8Array[] = [];
    const result = await runRawVideoProcessV1({ executable: process.execPath, args: ["-e", "process.stdout.write(Buffer.alloc(32,61))"],
      timeoutMs: 10_000, frameBytes: 32, expectedFrames: 1, oneFrameBuffer: borrowed,
      sink: { async onFrame(frame) { observed.push(frame); expect(frame).toBe(borrowed); } } });
    expect(result).toMatchObject({ frames: 1, bytes: 32, closed: true }); expect(observed).toHaveLength(1); expect(borrowed).toEqual(Buffer.alloc(32, 61));
  });
  it("refuses borrowed storage for multiple frames or the wrong size before spawning", async () => {
    const base = { executable: "must-not-launch", args: [], timeoutMs: 1000, frameBytes: 32, oneFrameBuffer: Buffer.alloc(32), sink: { async onFrame() {} } };
    await expect(runRawVideoProcessV1({ ...base, expectedFrames: 2 })).rejects.toThrow("BORROWED_BUFFER_INVALID");
    await expect(runRawVideoProcessV1({ ...base, expectedFrames: 1, oneFrameBuffer: Buffer.alloc(31) })).rejects.toThrow("BORROWED_BUFFER_INVALID");
  });
});
