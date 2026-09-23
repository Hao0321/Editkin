import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, type MediaAsset, type MediaColorMetadata } from "../domain/types";
import { autoWhiteBalanceReferencePlan } from "../application/autoColorFrame";
import { compositorSourceColorPlan } from "./sourceColorFilters";
import { sourceLinearWhiteBalancePlan } from "./sourceLinearWhiteBalance";

const ffmpeg = resolve(fileURLToPath(new URL("../../", import.meta.url)), "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const pq: MediaAsset = { id: "owned", name: "PQ boundary engineering swatches", uri: "unused", kind: "video", duration: 1,
  color: { interpretation: "pq", transfer: "smpte2084", primaries: "bt2020", matrix: "bt2020nc", range: "tv" } };
const palette = [[.7, .5, .4, 1], [.4, .7, .4, 1], [.4, .4, .7, 1], [.5, .5, .5, 1]];
const input = Buffer.alloc(64);
[1, 2, 0, 3].forEach((channel, plane) => palette.forEach((pixel, i) => input.writeFloatLE(pixel[channel], (plane * 4 + i) * 4)));
function decoded(filters: string[]) {
  const result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "gbrapf32le", "-video_size", "2x2",
    "-color_trc", "smpte2084", "-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-color_range", "tv", "-i", "pipe:0",
    "-vf", filters.join(","), "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"],
  { input, windowsHide: true, timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stdout.length).toBe(16); return result.stdout;
}

describe("unversioned PQ physical/reference white balance fails closed", () => {
  for (const metadata of [pq.color!, { ...pq.color!, interpretation: "auto", transfer: "smpte2084" }] satisfies MediaColorMetadata[]) {
    it.each(["whiteBalanceRed", "whiteBalanceGreen", "whiteBalanceBlue"] as const)(`rejects ${metadata.interpretation}/${metadata.transfer} nonzero %s without editing values`, channel => {
      for (const value of [1e-9, -1e-9, -4, 4]) {
        const color = { ...DEFAULT_COLOR, [channel]: value }, original = structuredClone(color), source = { ...pq, color: metadata };
        expect(() => sourceLinearWhiteBalancePlan(source, color)).toThrow(/PQ.*白平衡.*尚未/);
        expect(() => compositorSourceColorPlan(source, 2, 2, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, 0, color)).toThrow(/PQ.*白平衡.*尚未/);
        expect(color).toEqual(original);
      }
    });
  }
  it.each([0, 1e-9, -.5])("rejects PQ reference-WB planning even when baseline red=%s", whiteBalanceRed => {
    expect(() => autoWhiteBalanceReferencePlan(pq, { ...DEFAULT_COLOR, whiteBalanceRed })).toThrow(/PQ.*白平衡.*尚未/);
  });
  it.each([-3, -1, 0, 1, 3])("keeps zero-WB PQ EV%s decoded bytes exactly equal to the pinned legacy literal", exposure => {
    const literal = ["zscale=t=linear:npl=100", "format=gbrpf32le", ...(exposure ? [`exposure=exposure=${exposure}:black=0`] : []),
      "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv", "format=rgba"];
    const expected = decoded(literal);
    const absent = compositorSourceColorPlan(pq, 2, 2, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, exposure);
    const zero = compositorSourceColorPlan(pq, 2, 2, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, exposure, DEFAULT_COLOR);
    expect(decoded(absent.filters).equals(expected)).toBe(true);
    expect(decoded(zero.filters).equals(expected)).toBe(true);
    expect(zero.exposureConsumed).toBe(true);
    if (exposure === 0) expect([...expected.subarray(0, 3)]).toEqual([255, 65, 52]);
  });
  it("continues to reject invalid stops rather than rounding them to zero", () => {
    for (const value of [NaN, Infinity, -Infinity, 4.01]) expect(() => sourceLinearWhiteBalancePlan(pq, { whiteBalanceRed: value })).toThrow();
  });
  it.each(["rec709", "hlg"] as const)("keeps %s physical and reference-WB planning available", interpretation => {
    const asset: MediaAsset = { ...pq, color: interpretation === "hlg"
      ? { interpretation, primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" }
      : { interpretation, primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } };
    expect(sourceLinearWhiteBalancePlan(asset, { whiteBalanceRed: .1 }).filters.some(filter => filter.startsWith("geq=r='r(X,Y)*"))).toBe(true);
    expect(autoWhiteBalanceReferencePlan(asset, { ...DEFAULT_COLOR, whiteBalanceRed: .1 }).basis).toBe("linear-rec709");
  });
});
