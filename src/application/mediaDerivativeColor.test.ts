import { describe, expect, it } from "vitest";
import { BROWSER_PROXY_COLOR_CONTRACT, browserProxyColorPlan, browserProxyFilters } from "./mediaDerivativeColor";
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
  it("large HLG preview uses a float 2x intermediate, never full reduction to 8-bit before tone mapping", () => {
    const stages = browserProxyFilters(browserProxyColorPlan(hdr), 540, undefined, 1920).split(",");
    const reduce = stages.indexOf("zscale=w=-2:h=1080:p=bt709:filter=bilinear");
    expect(reduce).toBeGreaterThan(stages.indexOf("format=gbrpf32le"));
    expect(stages[reduce + 1]).toBe("format=gbrpf32le");
    expect(reduce).toBeLessThan(stages.findIndex(stage => stage.startsWith("tonemap=")));
    expect(browserProxyFilters(browserProxyColorPlan(hdr), 540, undefined, 720)).not.toContain("w=-2:h=1080");
    expect(browserProxyFilters(browserProxyColorPlan({ ...hdr, colorTransfer: "smpte2084" }), 540, undefined, 1920)).not.toContain("w=-2:h=1080");
  });
  it("overlay consumes already-normalized proxy without double tone mapping", () => {
    const plan = browserProxyColorPlan(hdr);
    const filters = browserProxyFilters({ ...plan, normalization: [], treatment: "source-transfer-preserved" }, 216, 15);
    expect(filters).toBe("fps=15,scale=-2:216,setsar=1,format=yuv420p");
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
