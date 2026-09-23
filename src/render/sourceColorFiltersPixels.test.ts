import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";
import { compositorSourceColorPlan } from "./sourceColorFilters";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = process.platform === "win32" ? resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg";
const width = 16, height = 4;
const asset: MediaAsset = {
  id: "synthetic-hlg", name: "synthetic", uri: "synthetic", kind: "video", duration: 1,
  color: { interpretation: "hlg", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" },
};
// Authored HLG RGB codes: neutral ramp, warm paper/skin-like and saturated
// colours. These are mathematical controls, not camera white-balance targets.
const pixels = Buffer.alloc(width * height * 3 * 4);
for (let plane = 0; plane < 3; plane++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const code = y === 0 ? x / 15 : y === 1 ? [0.72, 0.66, 0.78][plane]
    : y === 2 ? [0.55, 0.43, 0.68][plane] : [0.65, 0.10, 0.98][plane];
  pixels.writeFloatLE(code, ((plane * height + y) * width + x) * 4);
}
function render(filters: string[]) {
  const result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "gbrpf32le", "-video_size", `${width}x${height}`,
    "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "0", "-color_range", "pc", "-i", "pipe:0",
    "-vf", [...filters, "format=rgb24"].join(","), "-frames:v", "1", "-f", "rawvideo", "pipe:1"],
  { input: pixels, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Real HLG pixel control failed: ${result.error ?? result.stderr.toString()}`);
  expect(result.stdout.length).toBe(width * height * 3);
  return result.stdout;
}
// Exact HLG OOTF is independently anchored in hlgDisplayReference.test.ts.
const normalize = ["zscale=t=linear:npl=100:agamma=0", "format=gbrpf32le"];
const tone = ["tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv", "format=rgba", "scale=16:4:force_original_aspect_ratio=decrease", "format=rgba"];

describe("real HLG linear EV pixel regression", () => {
  it.each([0, -0.4, -0.5, -0.22])("matches independent pre-tone EV %s without changing authored input", exposure => {
    const before = Buffer.from(pixels);
    const result = compositorSourceColorPlan(asset, width, height, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, exposure);
    const reference = render([...normalize, "zscale=p=bt709", ...(exposure ? [`exposure=exposure=${exposure}:black=0`] : []), ...tone]);
    expect(result.exposureConsumed).toBe(true);
    const actual = render(result.filters);
    expect(actual.equals(reference)).toBe(true);
    expect(pixels.equals(before)).toBe(true);
    if (exposure !== 0) {
      const oldPost = render([...normalize, ...tone, `exposure=exposure=${exposure}:black=0`]);
      const double = render([...result.filters, `exposure=exposure=${exposure}:black=0`]);
      expect(oldPost.equals(reference), "old post-quantization EV must fail this oracle").toBe(false);
      expect(double.equals(reference), "double exposure must fail this oracle").toBe(false);
    }
    // Neutral grey ramp must retain equal channels (rounding at most one code).
    for (let x = 0; x < width; x++) {
      const rgb = [...actual.subarray(x * 3, x * 3 + 3)];
      expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThanOrEqual(1);
      if (x > 0) expect(actual[x * 3]).toBeGreaterThanOrEqual(actual[(x - 1) * 3]);
    }
  });
});
