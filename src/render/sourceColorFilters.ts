import type { ColorManagementSettings, MediaAsset } from "../domain/types";
import { inputNormalizationFilters, primaryExposureFilter, resolveInputColorSpace } from "../color/primaryGrade";
import { sourceAlphaNormalizationFilters } from "./ffmpegExpressions";
import { hasLinearWhiteBalance, rec709OetfEncodeFilters, type LinearWhiteBalanceColor } from "../color/linearWhiteBalance";
import { sourceLinearWhiteBalancePlan } from "./sourceLinearWhiteBalance";
import { HLG_SDR_TONEMAP_FILTER } from "../color/displayTransfer";

/** Keep camera HDR precision until the SDR transform, before an 8-bit RGB surface. */
export function compositorSourceFilters(
  asset: MediaAsset, width: number, height: number, rgba: string, grayMaximum: number,
  management: ColorManagementSettings, colorRoot?: string,
): string[] {
  return compositorSourceColorPlan(asset, width, height, rgba, grayMaximum, management, colorRoot).filters;
}

/** Static HDR EV is consumed in linear light, never again by the display-referred grade. */
export function compositorSourceColorPlan(
  asset: MediaAsset, width: number, height: number, rgba: string, grayMaximum: number,
  management: ColorManagementSettings, colorRoot?: string, exposure = 0, whiteBalance: LinearWhiteBalanceColor = {},
): { filters: string[]; exposureConsumed: boolean } {
  if (!Number.isFinite(exposure)) throw new Error("Source exposure must be finite");
  const corrected = hasLinearWhiteBalance(whiteBalance);
  if (corrected) {
    if (management.mode !== "rec709") throw Error("非零線性白平衡的 ACES 輸出需要已驗證的原生 v2 processor；不能套入舊版 LUT 調色路徑");
    const linear = sourceLinearWhiteBalancePlan(asset, whiteBalance);
    const hdr = linear.inputConvention !== "rec709-oetf";
    return { filters: [...linear.filters,
      ...(hdr && exposure !== 0 ? [primaryExposureFilter(exposure)] : []),
      ...(hdr ? [linear.inputConvention === "hlg-linear" ? HLG_SDR_TONEMAP_FILTER : "tonemap=tonemap=hable:desat=0",
        "zscale=p=bt709:t=bt709:m=bt709:r=tv"] : [...rec709OetfEncodeFilters(),
        "setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=gbr"]),
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`, `format=${rgba}`,
    ], exposureConsumed: hdr };
  }
  const normalization = inputNormalizationFilters(asset, management, colorRoot);
  const spatial = [`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `format=${rgba}`];
  const alpha = sourceAlphaNormalizationFilters(asset, grayMaximum);
  const input = resolveInputColorSpace(asset);
  if (management.mode === "rec709" && input === "hlg") {
    // Convert the linear gamut before mapping its peak; a later narrow-gamut
    // conversion can otherwise create >1 channels which rgba irreversibly clips.
    // Retain the verified HLG SDR shoulder and EV limits. This is not a full
    // floating-point grade, Dolby Vision processor or animated-exposure path.
    return { filters: [
      ...normalization.slice(0, 2), "zscale=p=bt709",
      ...(exposure !== 0 ? [primaryExposureFilter(exposure)] : []),
      ...normalization.slice(2), ...spatial, ...alpha,
    ], exposureConsumed: true };
  }
  if (management.mode === "rec709" && input === "pq") {
    // PQ retains source-linear values above SDR white until exposure and Hable.
    // Do not change the neutral curve/gamut order or quantize before static EV.
    return { filters: [
      ...normalization.slice(0, 2),
      ...(exposure !== 0 ? [primaryExposureFilter(exposure)] : []),
      ...normalization.slice(2), ...spatial, ...alpha,
    ], exposureConsumed: true };
  }
  // Preserve existing SDR/alpha and separately calibrated ACES paths.
  return { filters: [...spatial, ...alpha, ...normalization], exposureConsumed: false };
}
