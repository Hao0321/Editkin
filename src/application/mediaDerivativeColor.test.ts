import { describe, expect, it } from "vitest";
import { BROWSER_PROXY_COLOR_CONTRACT, browserProxyColorPlan, browserProxyFilters, browserThumbnailFilters } from "./mediaDerivativeColor";
import { mediaProbeForDisplay } from "../render/mediaDisplayGeometry";
import { compositorSourceColorPlan } from "../render/sourceColorFilters";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";

const hdr = { colorPrimaries: "bt2020", colorTransfer: "arib-std-b67", colorMatrix: "bt2020nc", colorRange: "tv" };
describe("browser display proxies preserve original interpretation boundaries", () => {
  it.each(["arib-std-b67", "smpte2084"])("normalizes %s before 8-bit and declares truthful display output", transfer => {
    const probe = { ...hdr, colorTransfer: transfer }, before = structuredClone(probe);
    const plan = browserProxyColorPlan(probe), filters = browserProxyFilters(plan, 540);
    expect(filters.indexOf("tonemap=")).toBeLessThan(filters.indexOf("format=yuv420p"));
    expect(plan.outputColor).toEqual({ interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" });
    // Count filter stages, not the filter's own `tonemap=` option name.
    expect(filters.split(",").filter(stage => stage.startsWith("tonemap="))).toHaveLength(1);
    expect(`${filters},tonemap=tonemap=hable`.split(",").filter(stage => stage.startsWith("tonemap="))).toHaveLength(2);
    expect(probe).toEqual(before);
    const asset: MediaAsset = { id: "original", name: "HDR.MOV", uri: "D:/original.MOV", kind: "video", duration: 5,
      color: { interpretation: "auto", primaries: probe.colorPrimaries, transfer, matrix: probe.colorMatrix, range: "tv" } };
    const sourcePlan = compositorSourceColorPlan(asset, 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT);
    expect(sourcePlan.filters.slice(0, plan.normalization.length)).toEqual(plan.normalization);
  });
  it("HLG gamut conversion precedes tone mapping", () => {
    const filters = browserProxyFilters(browserProxyColorPlan(hdr), 540);
    expect(filters.indexOf("zscale=p=bt709")).toBeLessThan(filters.indexOf("tonemap="));
  });
  it("large HLG preview scales tagged YUV early, then keeps float gamut and tone mapping", () => {
    const stages = browserProxyFilters(browserProxyColorPlan(hdr), 540, undefined, 1920).split(",");
    const reduce = stages.indexOf("zscale=w=-2:h=1080:filter=bilinear");
    expect(reduce).toBe(0);
    expect(reduce).toBeLessThan(stages.indexOf("zscale=t=linear:npl=100:agamma=0"));
    expect(stages.indexOf("format=gbrpf32le")).toBeLessThan(stages.indexOf("zscale=p=bt709"));
    expect(reduce).toBeLessThan(stages.findIndex(stage => stage.startsWith("tonemap=")));
    expect(stages.at(-1)).toBe("format=yuv420p");
    expect(browserProxyFilters(browserProxyColorPlan(hdr), 540, undefined, 720)).not.toContain("w=-2:h=1080");
    expect(browserProxyFilters(browserProxyColorPlan({ ...hdr, colorTransfer: "smpte2084" }), 540, undefined, 1920)).not.toContain("w=-2:h=1080");
  });
  it("overlay consumes already-normalized proxy without double tone mapping", () => {
    const plan = browserProxyColorPlan(hdr);
    const filters = browserProxyFilters({ ...plan, normalization: [], treatment: "source-transfer-preserved" }, 216, 15);
    expect(filters).toBe("fps=15,scale=-2:216:reset_sar=1,setsar=1,format=yuv420p");
    expect(plan.outputArgs).toContain("bt709");
  });
  it("unclassified input remains unclassified instead of being relabelled Rec709", () => {
    const plan = browserProxyColorPlan({});
    expect(plan.outputColor.interpretation).toBe("auto");
    expect(plan.outputColor.transfer).toBeUndefined();
    expect(plan.outputArgs).toEqual([]);
    expect(browserProxyFilters(plan, 360)).not.toContain("tonemap");
    expect(BROWSER_PROXY_COLOR_CONTRACT).toBe("editkin.browser-display-proxy/v1");
  });
  it.each([
    { angle: 0, ratio: 5 / 3, width: 720, height: 576 },
    { angle: 90, ratio: 3 / 5, width: 576, height: 720 },
    { angle: -90, ratio: 3 / 5, width: 576, height: 720 },
  ])("requests square-pixel DAR-preserving main and overlay resize for SAR4:3 at $angle degrees", fixture => {
    const original = { duration: 2, width: 720, height: 576, hasVideo: true, hasAudio: false,
      sampleAspectRatio: 4 / 3, displayRotationDegrees: fixture.angle }, before = structuredClone(original);
    const displayed = mediaProbeForDisplay(original), plan = browserProxyColorPlan(displayed);
    expect(displayed.displayAspectRatio).toBeCloseTo(fixture.ratio, 12);
    expect([displayed.width, displayed.height]).toEqual([fixture.width, fixture.height]);
    for (const [height, fps] of [[540, undefined], [216, 15]] as const) {
      const stages = browserProxyFilters(plan, height, fps).split(",");
      expect(stages.filter(stage => stage.startsWith("scale="))).toEqual([`scale=-2:${height}:reset_sar=1`]);
      expect(stages.indexOf(`scale=-2:${height}:reset_sar=1`)).toBeLessThan(stages.indexOf("setsar=1"));
      expect(stages.join(",")).not.toContain("transpose");
      // The retired resize loses known SAR when its final tag is reset. This
      // literal control observes production filter wiring, not decoded pixels.
      expect(stages).not.toContain(`scale=-2:${height}`);
    }
    expect(original).toEqual(before);
  });
  it("preserves DAR in original and proxy thumbnails while retaining display color order", () => {
    const plan = browserProxyColorPlan(hdr);
    for (const fromProxy of [false, true]) {
      const stages = browserThumbnailFilters(plan, fromProxy);
      expect(stages.filter(stage => stage.startsWith("scale="))).toEqual([
        "scale=480:-2:reset_sar=1:in_range=full:out_range=full:out_color_matrix=bt601",
      ]);
      expect(stages.indexOf("setsar=1")).toBeGreaterThan(stages.findIndex(stage => stage.startsWith("scale=")));
      expect(stages.filter(stage => stage.startsWith("tonemap="))).toHaveLength(fromProxy ? 0 : 1);
      expect(stages.at(-1)).toBe("format=yuvj444p");
    }
    expect(browserThumbnailFilters(browserProxyColorPlan({}), false)).toEqual(["scale=480:-2:reset_sar=1", "setsar=1"]);
  });
  it.each(["log", "slog3", "linear"])("does not pretend to support unresolved %s", transfer => {
    expect(() => browserProxyColorPlan({ colorTransfer: transfer })).toThrow(/顯示轉換/);
  });
  it.each([{}, { colorPrimaries: "unknown", colorMatrix: "bt2020nc" }, { colorPrimaries: "bt2020" }])("rejects incomplete HDR colour metadata %j", extra => {
    expect(() => browserProxyColorPlan({ ...extra, colorTransfer: "arib-std-b67" })).toThrow(/HDR/);
  });
  it.each([0, 3, Infinity, NaN])("rejects unsafe proxy height %s", height => {
    expect(() => browserProxyFilters(browserProxyColorPlan({}), height)).toThrow();
  });
});
