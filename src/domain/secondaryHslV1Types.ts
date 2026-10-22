import type { ColorGradeNodeV2 } from "./visualTypes";

export interface SecondaryHslBandV1 {
  minimum: number;
  maximum: number;
  /** Smooth transition outside the closed selected interval, in the same units. */
  softness?: number;
}

export interface SecondaryHslQualifierV1 {
  /** Circular hue degrees; achromatic colours have no hue and fail an explicit hue selection. */
  hue?: { centerDegrees: number; halfWidthDegrees: number; softnessDegrees?: number };
  saturation?: SecondaryHslBandV1;
  lightness?: SecondaryHslBandV1;
}

/** Only pointwise black/white remapping. Spatial blur and morphology are not part of an RGB LUT. */
export interface SecondaryHslCleanupV1 {
  blackPoint?: number;
  whitePoint?: number;
}

/** Same bounded grade controls as inside; the containing node owns enable and final mix. */
export type SecondaryHslOutsideGradeV1 = Pick<ColorGradeNodeV2,
  "lut" | "offset" | "lift" | "gamma" | "gain" | "log" | "contrast" | "pivot" |
  "saturation" | "colorBoost" | "curves" | "hueVsHue" | "hueVsSat" | "hueVsLum" |
  "lumVsSat" | "skinProtection" | "skyProtection" | "gamutLimit" | "softClip">;

/** Optional, explicitly versioned nonspatial selection on the node's input working RGB code values. */
export interface SecondaryHslV1 {
  schema: "editkin.secondary-hsl/v1";
  selectorSpace: "working_rgb_code";
  enabled?: boolean;
  qualifier: SecondaryHslQualifierV1;
  cleanup?: SecondaryHslCleanupV1;
  inverted?: boolean;
  /** Omitted outside means unchanged node input, not a second application of the inside grade. */
  outside?: SecondaryHslOutsideGradeV1;
}
