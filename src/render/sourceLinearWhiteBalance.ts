import type { MediaAsset, MediaColorMetadata } from "../domain/types";
import { HLG_DISPLAY_LINEAR_FILTER } from "../color/displayTransfer";
import { hasLinearWhiteBalance, linearWhiteBalanceFilters, rec709OetfDecodeFilters, type LinearWhiteBalanceColor } from "../color/linearWhiteBalance";
import { strictMediaColorInterpretation } from "../application/sourceDisplayMetadata";

export type LinearWhiteBalanceInputConvention = "rec709-oetf" | "hlg-linear" | "pq-display-linear";
const PQ_WHITE_BALANCE_UNAVAILABLE = "PQ 線性／參考白平衡尚未完成版本化與輸出驗證；已停止套用並保留原有參數，零白平衡與一般曝光不受影響";

/** Only the new linear correction opts into this strict interpretation boundary.
 * Missing metadata is not used to override an explicit input transform. Unknown,
 * contradictory and camera-Log transforms cannot silently become Rec709.
 */
export function linearWhiteBalanceInput(asset: MediaAsset): "rec709" | "hlg" | "pq" {
  const metadata = asset.color, selected = metadata?.interpretation ?? "auto";
  const transfer = metadata?.transfer?.toLowerCase();
  const hdrSelected = selected === "hlg" || selected === "pq";
  const hdrTagged = transfer !== undefined && ["arib-std-b67", "hlg", "smpte2084", "pq"].includes(transfer);
  if (hdrSelected || hdrTagged) {
    try {
      if (!metadata) throw Error("missing-color-metadata");
      return strictMediaColorInterpretation(metadata);
    } catch {
      throw Error("線性白平衡的 HDR 色彩標記不完整或彼此矛盾；不能猜測 BT.2100 Input Transform");
    }
  }
  if (transfer && transfer !== "bt709") throw Error("線性白平衡尚未驗證此 Transfer；請保留原調整，不能當作 Rec.709 套用");
  if (selected !== "auto" && selected !== "rec709") throw Error("線性白平衡的 Input Transform 不支援或與來源標記矛盾");
  if ((metadata?.primaries && metadata.primaries !== "bt709")
    || (metadata?.matrix && !["bt709", "gbr", "rgb"].includes(metadata.matrix))
    || (metadata?.range && !["full", "limited", "pc", "tv"].includes(metadata.range))) {
    throw Error("線性白平衡尚未驗證此原色／矩陣／範圍組合");
  }
  if (selected === "auto" && transfer !== "bt709") throw Error("線性白平衡缺少可驗證的 Rec.709 Input Transform");
  return "rec709";
}

/** A zero-start reference request must not authorise the unversioned PQ gain
 * route. Identification and zero-gain source decoding remain available.
 */
export function assertReferenceWhiteBalanceInput(asset: MediaAsset): "rec709" | "hlg" {
  const input = linearWhiteBalanceInput(asset);
  if (input === "pq") throw Error(PQ_WHITE_BALANCE_UNAVAILABLE);
  return input;
}

/** Bind discovered render metadata without hiding a conflicting project override. */
export function whiteBalanceAssetWithMetadata(asset: MediaAsset, discovered: Omit<MediaColorMetadata, "interpretation">): MediaAsset {
  for (const key of ["primaries", "transfer", "matrix", "range"] as const) {
    const authored = asset.color?.[key], actual = discovered[key];
    const normalizedRange = (value: string) => value === "tv" ? "limited" : value === "pc" ? "full" : value;
    if (authored && actual && (key === "range" ? normalizedRange(authored) !== normalizedRange(actual) : authored !== actual)) {
      throw Error(`線性白平衡的來源 ${key} 已變更或與專案解讀不一致`);
    }
  }
  const color: MediaColorMetadata = { interpretation: asset.color?.interpretation ?? "auto", ...discovered, ...asset.color };
  const result = { ...asset, color };
  linearWhiteBalanceInput(result);
  return result;
}

function straightFloatAlphaFilters(asset: MediaAsset): string[] {
  if (asset.alphaMode === "premultiplied") return ["unpremultiply=inplace=1"];
  // lut=a=255 is an integer filter and would silently quantize a FLOAT stream.
  if (asset.alphaMode === "opaque") return ["geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a=1:i=nearest"];
  return [];
}

/** Source-derived normalized FLOAT RGBA, before exposure, tone map, look or text.
 * PQ is display-linear at the existing npl=100 convention, not reconstructed
 * scene radiometry. HLG uses exact luminance-coupled BT.2100 OOTF at the
 * 1000-nit reference display, in 100-nit units; not reconstructed scene light.
 * No crop, resize, quantization, creative adjustment or alpha multiplication.
 */
export function sourceLinearWhiteBalancePlan(asset: MediaAsset, color: LinearWhiteBalanceColor) {
  const input = linearWhiteBalanceInput(asset);
  // The legacy zero-PQ and corrected paths use different tone/gamut order.
  // Any nonzero gain (including tiny values) is unsafe until that contract is
  // versioned. Never reset authored controls or reroute the zero-PQ output.
  if (hasLinearWhiteBalance(color) && input === "pq") throw Error(PQ_WHITE_BALANCE_UNAVAILABLE);
  const decode = input === "rec709" ? rec709OetfDecodeFilters()
    : [input === "hlg" ? HLG_DISPLAY_LINEAR_FILTER : "zscale=t=linear:npl=100", "zscale=p=bt709"];
  return {
    basis: "linear-rec709" as const,
    inputConvention: (input === "rec709" ? "rec709-oetf" : input === "hlg" ? "hlg-linear" : "pq-display-linear") as LinearWhiteBalanceInputConvention,
    filters: ["format=gbrapf32le", ...straightFloatAlphaFilters(asset), ...decode, ...linearWhiteBalanceFilters(color),
      "setparams=range=full:color_primaries=bt709:color_trc=linear:colorspace=gbr"],
  };
}
