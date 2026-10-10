import { describe, expect, it } from "vitest";
import { compositorSourceColorPlan } from "./sourceColorFilters";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";

const asset: MediaAsset = { id: "own", name: "Original", uri: "D:/owned/original.mp4", kind: "video", duration: 8,
  width: 640, height: 360, color: { interpretation: "rec709" } };
const plan = (a: MediaAsset, fit: "canvas-contain" | "raw-source" = "canvas-contain") =>
  compositorSourceColorPlan(a, 360, 640, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, 0, {}, fit);

describe("physical-DAR ordinary canvas normalization", () => {
  it("resolves explicit non-square DAR before padding and square-pixel reset", () => {
    expect(plan({ ...asset, displayAspectRatio: 64 / 27 }).filters).toContain("scale=360:640:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1");
  });
  it("keeps absent-DAR and explicit square-pixel filters byte-compatible", () => {
    expect(plan({ ...asset, displayAspectRatio: 16 / 9 })).toEqual(plan(asset));
    expect(plan(asset).filters).toContain("scale=360:640:force_original_aspect_ratio=decrease");
  });
  it("keeps raw-source fitting in the actual floating plane with SAR intact", () => {
    expect(plan({ ...asset, displayAspectRatio: 64 / 27 }, "raw-source")).toEqual(plan(asset, "raw-source"));
    expect(plan(asset, "raw-source").filters.some(filter => filter.startsWith("scale="))).toBe(false);
  });
  it("rejects malformed declared geometry rather than silently using raster aspect", () => {
    for (const ratio of [0, -1, NaN, Infinity]) expect(() => plan({ ...asset, displayAspectRatio: ratio })).toThrow(/display geometry/);
    expect(() => plan({ ...asset, width: undefined, displayAspectRatio: 16 / 9 })).toThrow(/display geometry/);
  });
});
