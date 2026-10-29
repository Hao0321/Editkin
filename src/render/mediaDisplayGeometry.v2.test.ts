import { describe, expect, it } from "vitest";
import { assertMediaAssetDisplayGeometry, mediaDisplayAspectRatio, mediaProbeForDisplay, mediaSampleAspectRatio } from "./mediaDisplayGeometry";
import { createBatchSourceProject } from "../application/batchAutoEdit";

const video = { duration: 9, width: 640, height: 360, encodedWidth: 640, encodedHeight: 360, hasVideo: true, hasAudio: true };
describe("physical SAR and upright display ratio metadata", () => {
  it("parses positive physical SAR and derives DAR without replacing encoded dimensions", () => {
    expect(mediaSampleAspectRatio("4:3")).toBe(4 / 3);
    expect(mediaSampleAspectRatio("1:1")).toBe(1);
    const result = mediaProbeForDisplay({ ...video, sampleAspectRatio: mediaSampleAspectRatio("4:3") });
    expect(result.displayAspectRatio).toBe(64 / 27);
    expect([result.width, result.height, result.encodedWidth, result.encodedHeight]).toEqual([640, 360, 640, 360]);
  });
  it("keeps legal unknown SAR distinct from a verified square-pixel display ratio", () => {
    for (const raw of [undefined, "N/A", "N:A", "0:1"]) {
      const sar = mediaSampleAspectRatio(raw), result = mediaProbeForDisplay({ ...video, sampleAspectRatio: sar });
      expect(sar).toBeUndefined(); expect(result.displayAspectRatio).toBeUndefined();
    }
    expect(mediaDisplayAspectRatio({ ...video, sampleAspectRatio: 1 })).toBe(16 / 9);
  });
  it("rejects malformed SAR rather than silently assuming square pixels", () => {
    for (const raw of [null, "", " 1:1 ", "1/1", "1:0", "0:0", "-1:1", "1.5:1", "Infinity:1", "9007199254740992:1", 1, {}]) {
      expect(() => mediaSampleAspectRatio(raw)).toThrow(/SAR/);
    }
  });
  it("applies non-square SAR before quarter-turn rotation and remains idempotent", () => {
    const source = { ...video, sampleAspectRatio: 4 / 3, displayRotationDegrees: -90 }, before = structuredClone(source);
    const result = mediaProbeForDisplay(source);
    expect(result.displayAspectRatio).toBe(27 / 64);
    expect([result.width, result.height]).toEqual([360, 640]);
    expect(result.displayRotationDegrees).toBe(-90); expect(source).toEqual(before);
    expect(mediaProbeForDisplay(result)).toEqual(result);
  });
  it("rejects non-finite numeric SAR, unsupported rotation and conflicting precomputed DAR", () => {
    for (const sampleAspectRatio of [0, -1, NaN, Infinity]) expect(() => mediaProbeForDisplay({ ...video, sampleAspectRatio })).toThrow(/SAR/);
    expect(() => mediaProbeForDisplay({ ...video, sampleAspectRatio: 1, displayRotationDegrees: 45 })).toThrow(/展示旋轉/);
    expect(() => mediaProbeForDisplay({ ...video, sampleAspectRatio: 1, displayAspectRatio: 1 })).toThrow(/矛盾/);
  });
  it("binds saved physical geometry to the actual probe and permits known square-pixel legacy assets", () => {
    expect(assertMediaAssetDisplayGeometry({ width: 640, height: 360, displayAspectRatio: 64 / 27 }, { ...video, sampleAspectRatio: 4 / 3 }))
      .toEqual({ width: 64 / 27, height: 1 });
    expect(assertMediaAssetDisplayGeometry({ width: 640, height: 360 }, { ...video, sampleAspectRatio: 1 }))
      .toEqual({ width: 640, height: 360 });
  });
  it("blocks changed source orientation, legacy non-square contradictions and unverified explicit ratios", () => {
    const asset = { width: 640, height: 360 };
    expect(() => assertMediaAssetDisplayGeometry(asset, { ...video, sampleAspectRatio: 1, displayRotationDegrees: 90 })).toThrow(/尺寸/);
    expect(() => assertMediaAssetDisplayGeometry(asset, { ...video, sampleAspectRatio: 4 / 3 })).toThrow(/比例/);
    expect(() => assertMediaAssetDisplayGeometry({ ...asset, displayAspectRatio: 16 / 9 }, video)).toThrow(/已知 SAR/);
    expect(() => assertMediaAssetDisplayGeometry({ ...asset, width: undefined }, { ...video, sampleAspectRatio: 1 })).toThrow(/尺寸/);
  });
  it("carries actual display ratio into a batch asset and chooses its upright physical orientation", () => {
    const built = createBatchSourceProject({ sourcePath: "owned.mp4", jobId: "physical", duration: 9, width: 640, height: 360,
      displayAspectRatio: .75, sourceSha256: "a".repeat(64), now: new Date(0) });
    expect([built.project.width, built.project.height]).toEqual([1080, 1920]);
    expect(built.project.assets[0]!.displayAspectRatio).toBe(.75);
    expect([built.project.assets[0]!.width, built.project.assets[0]!.height, built.project.assets[0]!.uri, built.clip.sourceStart])
      .toEqual([640, 360, "owned.mp4", 0]);
  });
});
