import type { ColorManagementSettings, MediaAsset } from "../domain/types";
import { inputNormalizationFilters, primaryExposureFilter, resolveInputColorSpace } from "../color/primaryGrade";
import { sourceAlphaNormalizationFilters } from "./ffmpegExpressions";
import { hasLinearWhiteBalance, rec709OetfEncodeFilters, type LinearWhiteBalanceColor } from "../color/linearWhiteBalance";
import { sourceLinearWhiteBalancePlan } from "./sourceLinearWhiteBalance";
import { HLG_SDR_TONEMAP_FILTER } from "../color/displayTransfer";

export type CompositorSourceFit = "canvas-contain" | "raw-source";

/** Keep camera HDR precision until the SDR transform, before an 8-bit RGB surface. */
export function compositorSourceFilters(
  asset: MediaAsset, width: number, height: number, rgba: string, grayMaximum: number,
  management: ColorManagementSettings, colorRoot?: string, sourceFit: CompositorSourceFit = "canvas-contain",
): string[] {
  return compositorSourceColorPlan(asset, width, height, rgba, grayMaximum, management, colorRoot, 0, {}, sourceFit).filters;
}

/** Static HDR EV is consumed in linear light, never again by the display-referred grade. */
export function compositorSourceColorPlan(
  asset: MediaAsset, width: number, height: number, rgba: string, grayMaximum: number,
  management: ColorManagementSettings, colorRoot?: string, exposure = 0, whiteBalance: LinearWhiteBalanceColor = {},
  sourceFit: CompositorSourceFit = "canvas-contain",
): { filters: string[]; exposureConsumed: boolean } {
  if (!Number.isFinite(exposure)) throw new Error("Source exposure must be finite");
  if (sourceFit !== "canvas-contain" && sourceFit !== "raw-source") throw new Error("Unsupported compositor source fit");
  // Explicit upright DAR can differ from raster dimensions for anamorphic
  // input. Resolve it before padding and later setsar=1, otherwise the canvas
  // layout uses physical proportions while its actual pixels remain squashed.
  // Keep absent-DAR and square-pixel saved graphs on their existing filter path.
  let physicalCanvasContain = false;
  if (sourceFit === "canvas-contain" && asset.displayAspectRatio !== undefined) {
    if (!Number.isFinite(asset.displayAspectRatio) || asset.displayAspectRatio <= 0
      || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height)
      || asset.width! <= 0 || asset.height! <= 0) throw new Error("Canvas contain requires valid upright display geometry");
    physicalCanvasContain = Math.abs(asset.displayAspectRatio / (asset.width! / asset.height!) - 1) > 1e-6;
  }
  // Floating media is fitted directly from its source display aspect later.
  // Retain SAR here; the panel scale owns square-pixel conversion.
  const spatial = [
    ...(sourceFit === "canvas-contain" ? [`scale=${width}:${height}:force_original_aspect_ratio=decrease${physicalCanvasContain ? ":force_divisible_by=2:reset_sar=1" : ""}`] : []),
    `format=${rgba}`,
  ];
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
      ...spatial,
    ], exposureConsumed: hdr };
  }
  const normalization = inputNormalizationFilters(asset, management, colorRoot);
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
