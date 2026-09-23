import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";
import { compositorSourceColorPlan } from "./sourceColorFilters";
import { linearWhiteBalanceInput, sourceLinearWhiteBalancePlan, whiteBalanceAssetWithMetadata } from "./sourceLinearWhiteBalance";

const ffmpeg = process.platform === "win32" ? resolve(fileURLToPath(new URL("../../", import.meta.url)), "vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg";
const source = (input: "rec709" | "hlg" | "pq"): MediaAsset => ({ id: "source", name: "explicit-input", uri: "source", kind: "video", duration: 1,
  color: { interpretation: input, primaries: input === "rec709" ? "bt709" : "bt2020", transfer: input === "rec709" ? "bt709" : input === "hlg" ? "arib-std-b67" : "smpte2084",
    matrix: input === "rec709" ? "gbr" : "bt2020nc", range: input === "rec709" ? "full" : "tv" } });
const wb = { ...DEFAULT_COLOR, whiteBalanceRed: -.15, whiteBalanceGreen: .03, whiteBalanceBlue: .22 };
const inputPixels = [[.54, .50, .47, 0], [.04, .12, .30, .25], [.8, .7, .6, .75], [1, 1, 1, 1]];
function render(pixels: number[][], asset: MediaAsset, filters: string[], format = "gbrapf32le") {
  const input = Buffer.alloc(4 * 4 * 4);
  [1, 2, 0, 3].forEach((channel, plane) => pixels.forEach((p, i) => input.writeFloatLE(p[channel], (plane * 4 + i) * 4)));
  const result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "gbrapf32le", "-video_size", "2x2",
    "-color_trc", asset.color!.transfer!, "-color_primaries", asset.color!.primaries!, "-colorspace", "0", "-color_range", "pc", "-i", "pipe:0",
    "-vf", [...filters, `format=${format}`].join(","), "-frames:v", "1", "-pix_fmt", format, "-f", "rawvideo", "pipe:1"],
  { input, windowsHide: true, timeout: 15000, maxBuffer: 2 ** 20 });
  if (result.error || result.status !== 0) throw Error(`Source linear pixel regression: ${result.error ?? result.stderr.toString()}`);
  return { input, output: result.stdout, values: format === "gbrapf32le" ? pixels.map((_, i) => [2, 0, 1, 3].map(plane => result.stdout.readFloatLE((plane * 4 + i) * 4))) : [] };
}
const inverse = (v: number) => v < .081 ? v / 4.5 : ((v + .099) / 1.099) ** (1 / .45);
const forward = (v: number) => v < .018 ? v * 4.5 : 1.099 * v ** .45 - .099;

describe("source-derived linear white balance", () => {
  it("matches independent inverse709/gain/forward709 and retains all alpha bytes", () => {
    const asset = source("rec709"), plan = sourceLinearWhiteBalancePlan(asset, wb);
    const result = render(inputPixels, asset, plan.filters);
    expect(plan.inputConvention).toBe("rec709-oetf");
    result.values.forEach((p, i) => p.slice(0, 3).forEach((v, c) => expect(Math.abs(v - inverse(inputPixels[i][c]) * 2 ** [-.15, .03, .22][c])).toBeLessThan(2e-6)));
    expect(result.output.subarray(48).equals(result.input.subarray(48))).toBe(true);
    const full = compositorSourceColorPlan(asset, 2, 2, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, 0, wb);
    const output = render(inputPixels, asset, full.filters, "rgba").output;
    for (let i = 0; i < 4; i++) for (let c = 0; c < 3; c++) {
      const expected = Math.round(Math.max(0, Math.min(1, forward(inverse(inputPixels[i][c]) * 2 ** [-.15, .03, .22][c]))) * 255);
      expect(Math.abs(output[i * 4 + c] - expected)).toBeLessThanOrEqual(1);
    }
    // Float -> rgba8 uses the pinned converter's own rounding (.75 becomes 192).
    // The invariant is unchanged alpha versus that independent conversion,
    // while the FLOAT-stage assertion above remains exact byte preservation.
    expect([...output].filter((_, i) => i % 4 === 3)).toEqual([...render(inputPixels, asset, [], "rgba").output].filter((_, i) => i % 4 === 3));
  });

  it.each(["hlg", "pq"] as const)("keeps %s zero-WB HDR precision and enforces its correction boundary", input => {
    const asset = source(input), pixels = [[.5, .5, .5, 0], [.7, .7, .7, .25], [.9, .9, .9, .75], [1, 1, 1, 1]];
    const neutral = render(pixels, asset, sourceLinearWhiteBalancePlan(asset, {}).filters);
    expect(neutral.values[3][0]).toBeGreaterThan(1);
    expect(neutral.output.subarray(48).equals(neutral.input.subarray(48))).toBe(true);
    if (input === "pq") {
      // The previous corrected-pixel case is retained in the RED receipt. PQ
      // gain must now refuse instead of silently selecting another tone order.
      expect(() => sourceLinearWhiteBalancePlan(asset, wb)).toThrow(/PQ.*白平衡.*尚未/);
      expect(() => compositorSourceColorPlan(asset, 2, 2, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, -.5, wb)).toThrow(/PQ.*白平衡.*尚未/);
      return;
    }
    const corrected = render(pixels, asset, sourceLinearWhiteBalancePlan(asset, wb).filters);
    corrected.values.forEach((p, i) => p.slice(0, 3).forEach((v, c) => expect(Math.abs(v - neutral.values[i][c] * 2 ** [-.15, .03, .22][c])).toBeLessThan(3e-5)));
    expect(corrected.output.subarray(48).equals(corrected.input.subarray(48))).toBe(true);
    const full = compositorSourceColorPlan(asset, 2, 2, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, -.5, wb);
    expect(full.exposureConsumed).toBe(true);
    const gainAt = full.filters.findIndex(f => f.startsWith("geq=r='r(X,Y)*")), toneAt = full.filters.findIndex(f => f.startsWith("tonemap="));
    expect(gainAt).toBeGreaterThan(full.filters.indexOf("zscale=p=bt709"));
    expect(gainAt).toBeLessThan(toneAt);
    const output = render(pixels, asset, full.filters, "rgba").output;
    expect(output.length).toBe(16);
    expect([...output].filter((_, i) => i % 4 === 3)).toEqual([...render(pixels, asset, [], "rgba").output].filter((_, i) => i % 4 === 3));
  });

  it("normalizes premultiplication before the nonlinear inverse and preserves alpha", () => {
    const asset = { ...source("rec709"), alphaMode: "premultiplied" as const };
    const pixels = inputPixels.map(p => [p[0] * p[3], p[1] * p[3], p[2] * p[3], p[3]]);
    const actual = render(pixels, asset, sourceLinearWhiteBalancePlan(asset, wb).filters);
    actual.values.slice(1).forEach((p, i) => p.slice(0, 3).forEach((v, c) => expect(Math.abs(v - inverse(inputPixels[i + 1][c]) * 2 ** [-.15, .03, .22][c])).toBeLessThan(2e-6)));
    expect(actual.output.subarray(48).equals(actual.input.subarray(48))).toBe(true);
  });

  it("overrides opaque alpha without an integer lut or HDR clamp", () => {
    const asset = { ...source("rec709"), alphaMode: "opaque" as const }, pixels = inputPixels.map(p => [p[0] * 2, p[1] * 2, p[2] * 2, p[3]]);
    const actual = render(pixels, asset, sourceLinearWhiteBalancePlan(asset, wb).filters);
    expect(actual.values.every(p => p[3] === 1)).toBe(true);
    expect(actual.values[3][0]).toBeGreaterThan(1);
  });

  it("does not reinterpret unknown, contradictory, wide-gamut or unverified ACES inputs", () => {
    for (const color of [{ interpretation: "srgb" as const }, { interpretation: "apple_log" as const }, { interpretation: "auto" as const, transfer: "unknown" },
      { interpretation: "rec709" as const, transfer: "arib-std-b67" }, { interpretation: "rec709" as const, primaries: "bt2020" }]) {
      expect(() => linearWhiteBalanceInput({ ...source("rec709"), color })).toThrow();
    }
    expect(() => whiteBalanceAssetWithMetadata(source("rec709"), { transfer: "smpte2084" })).toThrow();
    expect(linearWhiteBalanceInput(whiteBalanceAssetWithMetadata({ ...source("rec709"), color: undefined }, { primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" }))).toBe("hlg");
    expect(() => compositorSourceColorPlan(source("rec709"), 2, 2, "rgba", 255, { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" }, "D:/color", 0, wb)).toThrow(/v2/);
  });
});
