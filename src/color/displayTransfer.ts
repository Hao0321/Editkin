/** HLG reference-display linear light (100-nit units, 1000-nit reference).
 * Disable zimg's per-channel approximation: BT.2100's OOTF couples RGB by
 * scene luminance. This is not scene radiometry or a creative SDR tone curve.
 */
export const HLG_DISPLAY_LINEAR_FILTER = "zscale=t=linear:npl=100:agamma=0";

/**
 * SDR shoulder selected against an actual rejected daylight HLG frame.
 * Hable retained materially more highlight separation than Mobius while the
 * exact BT.2100 display decode above stayed unchanged.
 */
export const HLG_SDR_TONEMAP_FILTER = "tonemap=tonemap=hable:desat=0";

/**
 * Viewing-only transform from display-referred Rec.709 to an sRGB image.
 * zimg's non-scene-referred BT.709 interpretation is ideal BT.1886 (V^2.4).
 * Never use this on radiometric measurements, already-sRGB photos or HDR codes.
 * Convert YUV using its real matrix/range before assigning RGB input metadata.
 */
export function rec709DisplayToSrgbFilters(): string[] {
  return [
    "format=gbrpf32le",
    "zscale=pin=bt709:tin=bt709:min=gbr:rin=full:p=bt709:t=iec61966-2-1:m=gbr:r=full",
    "format=rgb24",
  ];
}
