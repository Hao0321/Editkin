import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";
import { compositorSourceColorPlan, compositorSourceFilters, type CompositorSourceFit } from "./sourceColorFilters";

const asset = (interpretation: "rec709" | "hlg" | "pq" = "rec709"): MediaAsset => ({
  id: "source", name: "owned-source.mov", uri: "owned-source.mov", kind: "video", duration: 2,
  width: 1920, height: 1080,
  color: interpretation === "rec709" ? { interpretation } : {
    interpretation, primaries: "bt2020", transfer: interpretation === "hlg" ? "arib-std-b67" : "smpte2084",
    matrix: "bt2020nc", range: "tv",
  },
});
const containedScale = "scale=1080:1920:force_original_aspect_ratio=decrease";

describe("source color normalization before raw floating fit", () => {
  it("keeps the default ordinary canvas fit and premultiplied alpha byte order", () => {
    const source = { ...asset(), alphaMode: "premultiplied" as const };
    const expected = [containedScale, "format=rgba", "unpremultiply=inplace=1"];
    expect(compositorSourceFilters(source, 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT)).toEqual(expected);
    expect(compositorSourceColorPlan(source, 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT).filters).toEqual(expected);
  });

  it("retains raw source aspect and SAR while preserving premultiplied alpha normalization", () => {
    const source = { ...asset(), alphaMode: "premultiplied" as const };
    const before = structuredClone(source);
    expect(compositorSourceFilters(source, 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, "raw-source"))
      .toEqual(["format=rgba", "unpremultiply=inplace=1"]);
    expect(source).toEqual(before);
  });

  it("preserves HLG linear exposure and tone ordering while removing only canvas scale", () => {
    const ordinary = compositorSourceColorPlan(asset("hlg"), 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, -.5);
    const raw = compositorSourceColorPlan(asset("hlg"), 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, -.5, {}, "raw-source");
    expect(raw.exposureConsumed).toBe(true);
    expect(raw.filters).toEqual(ordinary.filters.filter(filter => filter !== containedScale));
    const exposure = raw.filters.indexOf("exposure=exposure=-0.5:black=0");
    expect(exposure).toBeGreaterThan(raw.filters.indexOf("format=gbrpf32le"));
    expect(exposure).toBeLessThan(raw.filters.findIndex(filter => filter.startsWith("tonemap=")));
    expect(raw.filters.filter(filter => filter.startsWith("exposure="))).toHaveLength(1);
  });

  it("preserves PQ zero-white-balance exposure ownership without a premature SAR reset", () => {
    const raw = compositorSourceColorPlan(asset("pq"), 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, .5, {}, "raw-source");
    expect(raw.exposureConsumed).toBe(true);
    expect(raw.filters.filter(filter => filter.startsWith("exposure="))).toEqual(["exposure=exposure=0.5:black=0"]);
    expect(raw.filters.indexOf("exposure=exposure=0.5:black=0")).toBeLessThan(raw.filters.findIndex(filter => filter.startsWith("tonemap=")));
    expect(raw.filters.some(filter => /^(?:scale|pad|setsar)=/.test(filter))).toBe(false);
  });

  it("retains actual linear white-balance and alpha filters for raw SDR and HLG sources", () => {
    const correction = { whiteBalanceRed: .2, whiteBalanceGreen: -.1, whiteBalanceBlue: 0 };
    for (const source of [{ ...asset(), alphaMode: "premultiplied" as const }, asset("hlg")]) {
      const ordinary = compositorSourceColorPlan(source, 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, -.3, correction);
      const raw = compositorSourceColorPlan(source, 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, -.3, correction, "raw-source");
      expect(raw.filters).toEqual(ordinary.filters.filter(filter => filter !== containedScale));
      expect(raw.filters[0]).toBe("format=gbrapf32le");
      expect(raw.filters.some(filter => filter.includes("color_trc=linear"))).toBe(true);
      expect(raw.filters.some(filter => /^(?:scale|pad|setsar)=/.test(filter))).toBe(false);
    }
  });

  it("retains opaque high-bit-depth alpha ownership in both spatial routes", () => {
    const source = { ...asset(), alphaMode: "opaque" as const };
    expect(compositorSourceFilters(source, 1080, 1920, "gbrap16le", 65535, DEFAULT_COLOR_MANAGEMENT))
      .toEqual([containedScale, "format=gbrap16le", "lut=a=65535"]);
    expect(compositorSourceFilters(source, 1080, 1920, "gbrap16le", 65535, DEFAULT_COLOR_MANAGEMENT, undefined, "raw-source"))
      .toEqual(["format=gbrap16le", "lut=a=65535"]);
  });

  it("does not bypass Log, contradictory HDR, PQ white-balance or ACES resource guards", () => {
    const raw = (source: MediaAsset, correction = {}) => compositorSourceColorPlan(source, 1080, 1920, "rgba", 255,
      DEFAULT_COLOR_MANAGEMENT, undefined, 0, correction, "raw-source");
    expect(() => raw({ ...asset(), color: { interpretation: "log_unresolved" } })).toThrow(/未解讀 Log/);
    expect(() => raw({ ...asset("hlg"), color: { ...asset("hlg").color!, transfer: "smpte2084" } })).toThrow(/HDR/);
    expect(() => raw(asset("pq"), { whiteBalanceRed: .1 })).toThrow(/PQ/);
    expect(() => compositorSourceColorPlan(asset(), 1080, 1920, "rgba", 255,
      { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" }, undefined, 0, {}, "raw-source")).toThrow(/色彩資源/);
    expect(() => compositorSourceColorPlan(asset(), 1080, 1920, "rgba", 255,
      { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" }, "owned-color", 0, { whiteBalanceRed: .1 }, "raw-source")).toThrow(/原生 v2/);
  });

  it("rejects nonfinite exposure and unknown spatial modes rather than silently selecting raw fit", () => {
    for (const exposure of [NaN, Infinity, -Infinity]) {
      expect(() => compositorSourceColorPlan(asset(), 1080, 1920, "rgba", 255,
        DEFAULT_COLOR_MANAGEMENT, undefined, exposure, {}, "raw-source")).toThrow(/finite/);
    }
    expect(() => compositorSourceColorPlan(asset(), 1080, 1920, "rgba", 255,
      DEFAULT_COLOR_MANAGEMENT, undefined, 0, {}, "raw" as CompositorSourceFit)).toThrow(/source fit/);
  });
});
