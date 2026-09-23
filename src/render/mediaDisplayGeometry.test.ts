import { describe, expect, it } from "vitest";
import { mediaDisplayRotation, mediaProbeForDisplay } from "./mediaDisplayGeometry";
import type { MediaProbe } from "./ffmpegContracts";

const video = { duration: 1, width: 1920, height: 1080, hasVideo: true, hasAudio: false };
describe("display geometry: explicit metadata, not another baked clip rotation", () => {
  it.each([0, 90, 180, 270, -90, -180, -270, 360, 450])("keeps raw %s angle and swaps only quarter turns", rotation => {
    const probe = { ...video, displayRotationDegrees: rotation };
    const before = structuredClone(probe), result = mediaProbeForDisplay(probe);
    expect(result.displayRotationDegrees).toBe(rotation);
    expect([result.width, result.height]).toEqual(Math.abs(rotation % 180) === 90 ? [1080, 1920] : [1920, 1080]);
    expect([result.encodedWidth, result.encodedHeight]).toEqual([1920, 1080]);
    expect(probe).toEqual(before);
    expect(mediaProbeForDisplay(result)).toEqual(result);
  });
  it("keeps legacy/no-rotation dimensions and leaves audio/EXR callers valid", () => {
    expect(mediaProbeForDisplay(video)).toEqual({ ...video, encodedWidth: 1920, encodedHeight: 1080 });
    const audio = { duration: 2, hasVideo: false, hasAudio: true };
    expect(mediaProbeForDisplay(audio)).toBe(audio);
    expect(mediaDisplayRotation(undefined)).toBeUndefined();
  });
  it("prefers display matrix over legacy rotate tag, preserving raw angle", () => {
    expect(mediaDisplayRotation({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }], tags: { rotate: "90" } })).toBe(-90);
    expect(mediaDisplayRotation({ tags: { rotate: "270" } })).toBe(270);
  });
  it.each([45, 89, NaN, Infinity, -Infinity])("rejects unsupported/invalid %s instead of guessing dimensions", displayRotationDegrees => {
    expect(() => mediaProbeForDisplay({ ...video, displayRotationDegrees })).toThrow(/展示旋轉/);
  });
  it.each(["", "wrong", null, {}, Infinity])("rejects malformed matrix rotation %s", rotation => {
    expect(() => mediaDisplayRotation({ side_data_list: [{ side_data_type: "Display Matrix", rotation }] })).toThrow(/旋轉/);
  });
  it("rejects conflicting/missing matrix evidence without accepting a fallback tag", () => {
    expect(() => mediaDisplayRotation({ side_data_list: [{ side_data_type: "Display Matrix", rotation: 0 }, { side_data_type: "Display Matrix", rotation: 90 }] })).toThrow(/矛盾/);
    expect(() => mediaDisplayRotation({ side_data_list: [{ side_data_type: "Display Matrix" }], tags: { rotate: "90" } })).toThrow(/不合法/);
  });
  it.each([{ width: undefined }, { height: 0 }, { width: NaN }, { height: 1.5 }])("does not bless invalid geometry %s", override => {
    expect(() => mediaProbeForDisplay({ ...video, ...override } as MediaProbe)).toThrow(/編碼尺寸/);
  });
});
