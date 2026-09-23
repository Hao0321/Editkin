import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";
import { acesOutputFilter, acesPrecisionBlockReason, gradeRgb, inputNormalizationFilters, primaryGradeFilters, resolveAcesInput, resolveInputColorSpace } from "./primaryGrade";

const asset = (transfer?: string): MediaAsset => ({
  id: "asset", name: "camera", kind: "video", uri: "camera.mp4", duration: 10,
  color: { interpretation: "auto", transfer,
    ...(["arib-std-b67", "smpte2084"].includes(transfer ?? "")
      ? { primaries: "bt2020", matrix: "bt2020nc", range: "tv" } : {}) },
});

describe("primary grade pipeline", () => {
  it("resolves HDR metadata and emits a single explicit normalization chain", () => {
    expect(resolveInputColorSpace(asset("arib-std-b67"))).toBe("hlg");
    expect(resolveInputColorSpace(asset("smpte2084"))).toBe("pq");
    expect(inputNormalizationFilters(asset("smpte2084"))).toEqual(expect.arrayContaining([expect.stringContaining("tonemap=hable")]));
    expect(inputNormalizationFilters(asset("arib-std-b67"))).toEqual(expect.arrayContaining([expect.stringContaining("tonemap=hable")]));
  });

  it("blocks unknown Log rather than silently applying Rec.709", () => {
    const log = asset("logc3");
    expect(resolveInputColorSpace(log)).toBe("blocked_log");
    expect(() => inputNormalizationFilters(log)).toThrow(/未解讀 Log/);
  });

  it("keeps scene-linear EXR out of the unmeasured SDR FFmpeg path", () => {
    const exr = { ...asset(), name: "beauty.exr", kind: "image" as const, color: { interpretation: "linear_rec709" as const } };
    expect(resolveInputColorSpace(exr)).toBe("linear_rec709");
    expect(() => inputNormalizationFilters(exr)).toThrow(/scene-linear EXR.*產品 gate/);
  });

  it("resolves named camera logs and requires explicit ACES resources", () => {
    const sony = { ...asset(), name: "A001 Sony S-Log3.mov" };
    const aces = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" as const };
    expect(resolveAcesInput(sony)).toBe("sony_slog3_cine");
    expect(() => inputNormalizationFilters(sony, aces)).toThrow(/色彩資源未載入/);
    expect(inputNormalizationFilters(sony, aces, "D:/color")).toEqual(expect.arrayContaining([expect.stringContaining("input-sony_slog3_cine-to-acescct.cube")]));
    expect(acesOutputFilter(aces, "D:/color")).toContain("output-acescct-to-rec709_sdr.cube");
  });

  it("fails closed for LUT paths that miss the frozen HDR precision gate", () => {
    const panasonic = { ...asset(), color: { interpretation: "panasonic_vlog" as const } };
    const pq = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" as const, outputTransform: "rec2100_pq_1000" as const };
    expect(acesPrecisionBlockReason(panasonic, pq)).toMatch(/精度不足/);
    expect(() => inputNormalizationFilters(panasonic, pq, "D:/color")).toThrow(/精度不足/);
    expect(acesPrecisionBlockReason(panasonic, { ...pq, outputTransform: "rec2100_hlg_1000" })).toBeUndefined();
  });

  it("keeps tonal curves monotonic and RGB output bounded", () => {
    const filters = primaryGradeFilters({ ...DEFAULT_COLOR, exposure: 1, shadows: 1, highlights: -1, blacks: 1, whites: -1, temperature: 0.5 });
    const curve = filters[0].match(/master='([^']+)'/)?.[1].split(" ").map((point) => Number(point.split("/")[1])) ?? [];
    expect(curve).toHaveLength(5);
    expect(curve.every((value, index) => index === 0 || value > curve[index - 1])).toBe(true);
    expect(filters).toEqual(expect.arrayContaining(["exposure=exposure=1:black=0"]));
    expect(gradeRgb(255, 200, 10, { ...DEFAULT_COLOR, exposure: 3, saturation: 3 })).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(gradeRgb(255, 200, 10, { ...DEFAULT_COLOR, exposure: 3, saturation: 3 }).every((channel) => channel >= 0 && channel <= 255)).toBe(true);
  });
});
