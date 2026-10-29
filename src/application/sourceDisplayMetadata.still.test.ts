import { describe, expect, it } from "vitest";
import { sourceDisplayColorMetadata, stillImageDisplayColorV1 } from "./sourceDisplayMetadata";

const png = (patch: Record<string, unknown> = {}) => ({ codec_name: "png", pix_fmt: "rgb24", color_range: "pc", color_space: "gbr", ...patch });
const jpeg = (patch: Record<string, unknown> = {}) => ({ codec_name: "mjpeg", pix_fmt: "yuvj420p", color_range: "pc", color_space: "bt470bg", ...patch });
const webp = (patch: Record<string, unknown> = {}) => ({ codec_name: "webp", pix_fmt: "yuv420p", color_range: "tv", color_space: "bt470bg", ...patch });
const reason = (run: () => unknown) => { try { run(); } catch (error) { return (error as Error).message; } return "ADMITTED"; };

describe("still image display admission (screenshots as sRGB display images)", () => {
  it.each([
    ["untagged PNG", png(), "srgb_assumed_untagged_image", "rgb"],
    ["'unknown'-tagged PNG", png({ color_transfer: "unknown", color_primaries: "unknown" }), "srgb_assumed_untagged_image", "rgb"],
    ["sRGB-tagged PNG", png({ color_transfer: "iec61966-2-1", color_primaries: "bt709" }), "srgb_tagged", "rgb"],
    ["palette PNG", png({ pix_fmt: "pal8" }), "srgb_assumed_untagged_image", "rgb"],
    ["RGBA PNG", png({ pix_fmt: "rgba" }), "srgb_assumed_untagged_image", "rgb"],
    ["JPEG 4:2:0", jpeg(), "srgb_assumed_untagged_image", "yuv-bt601-full"],
    ["JPEG 4:4:4", jpeg({ pix_fmt: "yuvj444p" }), "srgb_assumed_untagged_image", "yuv-bt601-full"],
    ["lossy WebP", webp(), "srgb_assumed_untagged_image", "yuv-bt601-limited"],
    ["full-range lossy WebP", webp({ color_range: "pc" }), "srgb_assumed_untagged_image", "yuv-bt601-full"],
    ["lossless WebP", webp({ pix_fmt: "argb", color_space: undefined, color_range: undefined }), "srgb_assumed_untagged_image", "rgb"],
  ])("admits a %s and records its provenance", (_label, stream, colorInterpretation, encoding) => {
    expect(stillImageDisplayColorV1(stream)).toEqual({ interpretation: "srgb", colorInterpretation, encoding });
  });

  it.each([
    ["a BT.709-transfer still (that is the strict path's)", png({ color_transfer: "bt709", color_primaries: "bt709" }), "still-color-tags-not-srgb"],
    ["an HLG still", png({ color_transfer: "arib-std-b67", color_primaries: "bt2020" }), "still-color-tags-not-srgb"],
    ["wide-gamut primaries", png({ color_transfer: "iec61966-2-1", color_primaries: "bt2020" }), "still-color-tags-not-srgb"],
    ["a gamma-2.2-only PNG", png({ color_transfer: "gamma22" }), "still-color-tags-not-srgb"],
    ["a YCbCr matrix on RGB samples", png({ color_space: "bt709" }), "still-color-tags-not-srgb"],
    ["a JPEG that claims studio range", jpeg({ color_range: "tv" }), "still-color-tags-not-srgb"],
    ["a JPEG with a BT.709 matrix", jpeg({ color_space: "bt709" }), "still-color-tags-not-srgb"],
    ["a video codec", { codec_name: "h264", pix_fmt: "yuv420p" }, "unsupported-still-codec"],
    ["an unsupported PNG layout", png({ pix_fmt: "rgb48le" }), "unsupported-still-pixel-format"],
  ])("refuses %s", (_label, stream, expected) => {
    expect(reason(() => stillImageDisplayColorV1(stream))).toBe(expected);
  });

  it("an authored interpretation other than auto/srgb, or a contradicting authored tag, is refused", () => {
    expect(reason(() => stillImageDisplayColorV1(png(), { interpretation: "rec709" }))).toBe("contradictory-color-interpretation");
    expect(reason(() => stillImageDisplayColorV1(png(), { interpretation: "auto", transfer: "bt709" }))).toBe("contradictory-color-interpretation");
    expect(stillImageDisplayColorV1(png(), { interpretation: "srgb" }).colorInterpretation).toBe("srgb_assumed_untagged_image");
    expect(stillImageDisplayColorV1(png({ color_transfer: "iec61966-2-1" }), { interpretation: "auto", transfer: "iec61966-2-1" }).colorInterpretation).toBe("srgb_tagged");
  });

  it("leaves the strict video admission untouched for the same untagged streams", () => {
    expect(reason(() => sourceDisplayColorMetadata(png()))).toBe("unknown-or-incomplete-color-tags");
    expect(reason(() => sourceDisplayColorMetadata(jpeg()))).toBe("unsupported-or-alpha-pixel-format");
    expect(sourceDisplayColorMetadata(png({ color_transfer: "bt709", color_primaries: "bt709" })).interpretation).toBe("rec709");
  });
});
