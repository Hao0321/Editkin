import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";
import { compositorSourceColorPlan, compositorSourceFilters } from "./sourceColorFilters";

const source = (interpretation: "hlg" | "pq" | "rec709"): MediaAsset => ({
  id: "source", name: "camera.mov", uri: "camera.mov", kind: "video", duration: 3,
  color: interpretation === "rec709"
    ? { interpretation }
    : {
        interpretation,
        primaries: "bt2020",
        transfer: interpretation === "hlg" ? "arib-std-b67" : "smpte2084",
        matrix: "bt2020nc",
        range: "tv",
      },
});
const filters = (asset: MediaAsset) => compositorSourceFilters(asset, 720, 1280, "rgba", 255, DEFAULT_COLOR_MANAGEMENT);

describe("source HDR precision before composition", () => {
  it.each([0, -0.4, -0.5, -0.22, 1])("consumes HLG static EV %s once before tone mapping and quantization", exposure => {
    const asset = source("hlg");
    const original = structuredClone(asset);
    const result = compositorSourceColorPlan(asset, 720, 1280, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, exposure);
    const chain = result.filters;
    expect(result.exposureConsumed).toBe(true);
    expect(chain.indexOf("zscale=p=bt709")).toBeLessThan(chain.findIndex(value => value.startsWith("tonemap=")));
    const ev = chain.filter(value => value.startsWith("exposure="));
    expect(ev).toHaveLength(exposure === 0 ? 0 : 1);
    if (exposure !== 0) {
      expect(chain.indexOf(ev[0])).toBeGreaterThan(chain.indexOf("format=gbrpf32le"));
      expect(chain.indexOf(ev[0])).toBeLessThan(chain.findIndex(value => value.startsWith("tonemap=")));
      expect(chain.indexOf(ev[0])).toBeLessThan(chain.indexOf("format=rgba"));
    }
    expect(asset).toEqual(original);
  });
  it.each(["rec709"] as const)("does not consume or relocate %s exposure", interpretation => {
    const result = compositorSourceColorPlan(source(interpretation), 720, 1280, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, -0.5);
    expect(result.exposureConsumed).toBe(false);
    expect(result.filters.some(value => value.startsWith("exposure="))).toBe(false);
    expect(result.filters).toEqual(filters(source(interpretation)));
  });
  it.each([-3, -1, 0, 1, 3])("consumes PQ static EV %s once before Hable without changing zero-EV normalization", exposure => {
    const result = compositorSourceColorPlan(source("pq"), 720, 1280, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, exposure);
    expect(result.exposureConsumed).toBe(true);
    const ev = result.filters.filter(value => value.startsWith("exposure="));
    expect(ev).toHaveLength(exposure === 0 ? 0 : 1);
    if (exposure !== 0) {
      expect(result.filters.indexOf(ev[0])).toBeGreaterThan(result.filters.indexOf("format=gbrpf32le"));
      expect(result.filters.indexOf(ev[0])).toBeLessThan(result.filters.findIndex(value => value.startsWith("tonemap=")));
    } else expect(result.filters).toEqual([
      "zscale=t=linear:npl=100", "format=gbrpf32le", "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv", "format=rgba",
      "scale=720:1280:force_original_aspect_ratio=decrease", "format=rgba",
    ]);
  });
  it("preserves ACES normalization and its display-referred exposure ownership", () => {
    const result = compositorSourceColorPlan(source("hlg"), 720, 1280, "rgba", 255, { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" }, "D:/color", -0.5);
    expect(result.exposureConsumed).toBe(false);
    expect(result.filters.some(value => value.startsWith("tonemap=") || value.startsWith("exposure="))).toBe(false);
    expect(result.filters.join(",")).toContain("input-hlg-to-acescct.cube");
  });
  it.each([NaN, Infinity, -Infinity])("rejects nonfinite static EV %s", value => {
    expect(() => compositorSourceColorPlan(source("hlg"), 720, 1280, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, value)).toThrow(/finite/);
  });
  it.each(["hlg", "pq"] as const)("normalizes %s before scale and rgba8 conversion", interpretation => {
    const chain = filters(source(interpretation));
    expect(chain[0]).toBe(interpretation === "hlg" ? "zscale=t=linear:npl=100:agamma=0" : "zscale=t=linear:npl=100");
    const tone = chain.findIndex(value => value.startsWith("tonemap="));
    expect(tone).toBeGreaterThan(chain.indexOf("format=gbrpf32le"));
    expect(tone).toBeLessThan(chain.indexOf("format=rgba"));
    expect(tone).toBeLessThan(chain.findIndex(value => value.startsWith("scale=")));
    expect(chain.filter(value => value.startsWith("tonemap="))).toHaveLength(1);
  });
  it("also respects discovered HLG transfer metadata", () => {
    expect(filters({ ...source("hlg"), color: { interpretation: "auto", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" } })[0]).toContain("zscale=t=linear");
  });
  it("does not add a transform to SDR or drop premultiplied alpha normalization", () => {
    const chain = filters({ ...source("rec709"), alphaMode: "premultiplied" });
    expect(chain).toEqual(["scale=720:1280:force_original_aspect_ratio=decrease", "format=rgba", "unpremultiply=inplace=1"]);
  });
  it("retains the calibrated ACES resource requirement", () => {
    expect(() => compositorSourceFilters(source("hlg"), 720, 1280, "rgba", 255, { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" })).toThrow(/色彩資源/);
  });
});
