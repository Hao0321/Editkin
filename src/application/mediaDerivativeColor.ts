import type { MediaColorMetadata, MediaDerivatives } from "../domain/types";
import type { MediaProbe } from "../render/ffmpegContracts";
import { HLG_DISPLAY_LINEAR_FILTER, HLG_SDR_TONEMAP_FILTER, rec709DisplayToSrgbFilters } from "../color/displayTransfer";
import { strictDisplayColorInterpretation } from "./sourceDisplayMetadata";

export const BROWSER_PROXY_COLOR_CONTRACT = "editkin.browser-display-proxy/v1" as const;
// Encoding interpretation and generation freshness are deliberately separate:
// an old baked SDR proxy must never be mistaken for unconverted camera HDR.
export const CURRENT_MEDIA_PREVIEW_RECIPE = "editkin.browser-proxy-bt2100-hable-thumbnail-srgb/2026-09-01-r3" as const;
export function isMediaPreviewCurrent(derivatives: MediaDerivatives | undefined): boolean {
  return derivatives?.previewRecipe === CURRENT_MEDIA_PREVIEW_RECIPE
    && derivatives.proxyColorContract === BROWSER_PROXY_COLOR_CONTRACT
    && Boolean(derivatives.proxyUri && derivatives.thumbnailUri);
}

export interface BrowserProxyColorPlan {
  normalization: string[];
  outputColor: MediaColorMetadata;
  outputArgs: string[];
  treatment: "hlg-to-sdr" | "pq-to-sdr" | "source-transfer-preserved";
}

/** Preview-only display transform. Original HDR media and metadata are untouched. */
export function browserProxyColorPlan(probe: Pick<MediaProbe, "colorPrimaries" | "colorTransfer" | "colorMatrix" | "colorRange" | "pixelFormat">): BrowserProxyColorPlan {
  const transfer = probe.colorTransfer?.toLowerCase();
  const hlg = transfer === "arib-std-b67";
  const pq = transfer === "smpte2084";
  if (hlg || pq) {
    try {
      const input = strictDisplayColorInterpretation({
        primaries: probe.colorPrimaries,
        transfer: probe.colorTransfer,
        matrix: probe.colorMatrix,
        range: probe.colorRange,
        pixelFormat: probe.pixelFormat,
      });
      if (input !== (hlg ? "hlg" : "pq")) throw Error("contradictory-color-interpretation");
    } catch {
      throw new Error("HDR 影片缺少完整 BT.2100 標記，或色域／傳遞／矩陣／範圍彼此矛盾，無法建立正確預覽；原片未變更。");
    }
    return {
      // Match the bounded source-render curves: HLG gamut conversion precedes
      // tone mapping. Keep float precision until the SDR output transform.
      normalization: [hlg ? HLG_DISPLAY_LINEAR_FILTER : "zscale=t=linear:npl=100", "format=gbrpf32le", ...(hlg ? ["zscale=p=bt709"] : []),
        hlg ? HLG_SDR_TONEMAP_FILTER : "tonemap=tonemap=hable:desat=0",
        "zscale=p=bt709:t=bt709:m=bt709:r=tv"],
      outputColor: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
      outputArgs: ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"],
      treatment: hlg ? "hlg-to-sdr" : "pq-to-sdr",
    };
  }
  if (transfer?.includes("log") || transfer === "linear") {
    throw new Error("此素材需要明確的 Log／線性顯示轉換，不能用一般影片代理假裝預覽成功；原片未變更。");
  }
  // Unknown tags stay unknown. Quantizing a proxy is not evidence of Rec.709.
  return {
    normalization: [],
    outputColor: { interpretation: "auto", primaries: probe.colorPrimaries, transfer: probe.colorTransfer, matrix: probe.colorMatrix, range: probe.colorRange },
    outputArgs: [],
    treatment: "source-transfer-preserved",
  };
}

export function browserProxyFilters(plan: BrowserProxyColorPlan, targetHeight: number, fps?: number, sourceHeight?: number): string {
  if (!Number.isSafeInteger(targetHeight) || targetHeight < 2 || targetHeight % 2 !== 0) throw new Error("預覽高度必須為正偶數");
  // A conservative 2x intermediate limits work before the HLG display curve.
  // It remains float linear RGB, never an 8-bit retag. Small inputs are not
  // enlarged. PQ keeps its separately verified full-resolution curve path.
  const reduceHlg = plan.treatment === "hlg-to-sdr" && Number.isFinite(sourceHeight) && sourceHeight! > targetHeight * 2;
  const normalization = plan.normalization.flatMap(stage => reduceHlg && stage === "zscale=p=bt709"
    ? [`zscale=w=-2:h=${targetHeight * 2}:p=bt709:filter=bilinear`, "format=gbrpf32le"] : [stage]);
  const scale = plan.treatment === "source-transfer-preserved"
    ? `scale=-2:${targetHeight}`
    : `scale=-2:${targetHeight}:out_color_matrix=bt709:out_range=tv`;
  return [...(fps ? [`fps=${fps}`] : []), ...normalization, scale, "setsar=1", "format=yuv420p"].join(",");
}

/** JPEG is a viewing surface, not Rec.709 video or material-analysis RGB. */
export function browserThumbnailFilters(plan: BrowserProxyColorPlan, fromProxy: boolean): string[] {
  const color = plan.outputColor;
  const knownRec709 = color.primaries === "bt709" && color.transfer === "bt709"
    && ["bt709", "gbr", "rgb"].includes(color.matrix ?? "")
    && ["tv", "limited", "pc", "full"].includes(color.range ?? "");
  return [
    // A main proxy has already been tone mapped. Images without one still
    // need their input normalization, if known; never normalize a proxy twice.
    ...(fromProxy ? [] : plan.normalization),
    ...(knownRec709 ? rec709DisplayToSrgbFilters() : []),
    knownRec709 ? "scale=480:-2:in_range=full:out_range=full:out_color_matrix=bt601" : "scale=480:-2",
    "setsar=1",
    ...(knownRec709 ? ["format=yuvj444p"] : []),
  ];
}
