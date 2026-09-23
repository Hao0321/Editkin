import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";
import type { MediaProbe } from "../render/ffmpegContracts";
import { compositorSourceColorPlan } from "../render/sourceColorFilters";
import { browserProxyColorPlan } from "./mediaDerivativeColor";

type ProxyMetadata = Pick<MediaProbe, "colorPrimaries" | "colorTransfer" | "colorMatrix" | "colorRange">
  & Pick<MediaProbe, "pixelFormat">;
type AssetColor = NonNullable<MediaAsset["color"]>;

const canonicalHlgYuv: ProxyMetadata = {
  colorPrimaries: "bt2020",
  colorTransfer: "arib-std-b67",
  colorMatrix: "bt2020nc",
  colorRange: "tv",
  pixelFormat: "yuv420p10le",
};

const canonicalAssetColor: AssetColor = {
  interpretation: "auto",
  primaries: "bt2020",
  transfer: "arib-std-b67",
  matrix: "bt2020nc",
  range: "tv",
};

function source(color: AssetColor): MediaAsset {
  return {
    id: "canonical-hlg-yuv",
    name: "canonical-hlg-yuv.mov",
    uri: "fixture://canonical-hlg-yuv.mov",
    kind: "video",
    duration: 1,
    color,
  };
}

function formalPlan(color: AssetColor) {
  return compositorSourceColorPlan(source(color), 1920, 1080, "rgba", 255, DEFAULT_COLOR_MANAGEMENT);
}

function expectFailVisible(action: () => unknown): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure, "unsafe HDR metadata must fail instead of silently selecting an HLG transform").toBeInstanceOf(Error);
  if (failure instanceof Error) {
    expect(failure.message.trim()).toMatch(/color|colour|HDR|HLG|metadata|色彩|色域|原色|矩陣|範圍|矛盾/i);
  }
}

describe("closed-world HLG metadata contract", () => {
  it("accepts canonical BT.2020/HLG YUV metadata for the browser proxy", () => {
    const plan = browserProxyColorPlan(canonicalHlgYuv);
    expect(plan.treatment).toBe("hlg-to-sdr");
    expect(plan.normalization[0]).toBe("zscale=t=linear:npl=100:agamma=0");
    expect(plan.normalization).toContain("tonemap=tonemap=hable:desat=0");
    expect(plan.normalization.join(",")).not.toContain("mobius");
    expect(plan.outputColor).toEqual({
      interpretation: "rec709",
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      range: "tv",
    });
  });

  it("accepts canonical BT.2020/HLG YUV metadata for the formal compositor", () => {
    const plan = formalPlan(canonicalAssetColor);
    expect(plan.exposureConsumed).toBe(true);
    expect(plan.filters[0]).toBe("zscale=t=linear:npl=100:agamma=0");
    expect(plan.filters).toContain("zscale=p=bt709");
  });

  it("accepts RGB-HLG for proxy generation only when RGB pixel format, identity matrix and full range agree", () => {
    const plan = browserProxyColorPlan({ ...canonicalHlgYuv, colorMatrix: "gbr", colorRange: "pc", pixelFormat: "gbrp10le" });
    expect(plan.treatment).toBe("hlg-to-sdr");
    for (const metadata of [
      { ...canonicalHlgYuv, colorMatrix: "gbr", colorRange: "pc", pixelFormat: undefined },
      { ...canonicalHlgYuv, colorMatrix: "gbr", colorRange: "pc", pixelFormat: "yuv420p10le" },
      { ...canonicalHlgYuv, colorMatrix: "bt2020nc", colorRange: "tv", pixelFormat: "gbrp10le" },
    ]) expectFailVisible(() => browserProxyColorPlan(metadata));
  });

  it.each<[string, ProxyMetadata]>([
    ["Rec.709 primaries", { ...canonicalHlgYuv, colorPrimaries: "bt709" }],
    ["P3-D65 primaries", { ...canonicalHlgYuv, colorPrimaries: "smpte432" }],
    ["BT.709 matrix", { ...canonicalHlgYuv, colorMatrix: "bt709" }],
    ["missing primaries", { ...canonicalHlgYuv, colorPrimaries: undefined }],
    ["missing matrix", { ...canonicalHlgYuv, colorMatrix: undefined }],
    ["missing range", { ...canonicalHlgYuv, colorRange: undefined }],
  ])("browser proxy rejects HLG with %s", (_label, metadata) => {
    expectFailVisible(() => browserProxyColorPlan(metadata));
  });

  it.each<[string, AssetColor]>([
    ["Rec.709 primaries", { ...canonicalAssetColor, primaries: "bt709" }],
    ["P3-D65 primaries", { ...canonicalAssetColor, primaries: "smpte432" }],
    ["BT.709 matrix", { ...canonicalAssetColor, matrix: "bt709" }],
    ["missing primaries", { ...canonicalAssetColor, primaries: undefined }],
    ["missing matrix", { ...canonicalAssetColor, matrix: undefined }],
    ["missing range", { ...canonicalAssetColor, range: undefined }],
    ["explicit HLG interpretation with PQ transfer", {
      ...canonicalAssetColor,
      interpretation: "hlg",
      transfer: "smpte2084",
    }],
  ])("formal compositor rejects HLG with %s", (_label, color) => {
    expectFailVisible(() => formalPlan(color));
  });

  it("formal compositor rejects RGB-HLG without pixel-format evidence instead of inventing a YUV/RGB classification", () => {
    expectFailVisible(() => formalPlan({ ...canonicalAssetColor, matrix: "gbr", range: "full" }));
  });
});
