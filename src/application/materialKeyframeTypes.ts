import type { MaterialColorRequest } from "./materialColorSamplingTypes";

/** Explicit inspection uses clip-relative source seconds, not timeline seconds.
 * Never sort, deduplicate, round or replace a caller's requested evidence. */
export function validateExplicitKeyframeTimes(value: unknown, duration: number, maximum: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 12
    || !Array.isArray(value) || value.length < 1 || value.length > maximum
    || value.some((time, index) => typeof time !== "number" || !Number.isFinite(time) || time < 0 || time >= duration
      || (index > 0 && time <= value[index - 1]))) throw Error("invalid-explicit-keyframe-times");
  return [...value];
}

export type MaterialKeyframeSample = MaterialColorRequest["samples"][number];
export interface MaterialKeyframeAnalysis {
  schema: "editkin.material-keyframe-analysis/v1";
  state: "ready" | "partial" | "blocked" | "not_applicable";
  policy: "neutral-srgb-display-v1";
  runtimeIdentitySha256: string;
  requestedSamples: MaterialKeyframeSample[];
  omitted: Array<{ id: string; reason: string }>;
}
/** A single-frame PNG/JPEG/WebP shown as the sRGB display image it is tagged as, or is
 * assumed to be when untagged. It is never recorded as measured Rec.709 video. */
export interface MaterialKeyframeStillNormalizationV1 {
  interpretation: "srgb";
  colorInterpretation: "srgb_tagged" | "srgb_assumed_untagged_image";
  sourceEncoding: "rgb" | "yuv-bt601-full" | "yuv-bt601-limited";
  alpha: "flattened-over-black";
  filters: string[]; purpose: "neutral-display-proxy"; transfer: "srgb"; primaries: "bt709"; range: "full"; exposure: 0; creativeLook: false; maximumDimension: 1280;
}
export interface MaterialKeyframeDisplay {
  schema: "editkin.material-keyframe-display/v1";
  receiptSha256: string;
  runtimeIdentitySha256: string;
  source: { sha256: string; start: number; duration: number };
  requested: MaterialKeyframeSample;
  decoded: { pts: number; timeBase: { numerator: number; denominator: number }; sourceTime: number; relativeTime: number; width: number; height: number; timelineOrigin: number; sceneIndex: number; sceneAttributionVerified: boolean };
  probe: { sha256: string; metadata: { stream: Record<string, unknown>; format: Record<string, unknown> } };
  normalization: { interpretation: "rec709" | "hlg" | "pq"; filters: string[]; intermediateTransfer: "bt709"; displayEotf: "bt1886-ideal"; purpose: "neutral-display-proxy"; transfer: "srgb"; primaries: "bt709"; range: "full"; exposure: 0; creativeLook: false; maximumDimension: 1280 }
    | MaterialKeyframeStillNormalizationV1;
  jpeg: { sha256: string; bytes: number; mimeType: "image/jpeg" };
}
