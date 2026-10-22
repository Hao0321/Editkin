import type { ColorManagementSettings, MediaAsset } from "../domain/types";
import { usesOpaqueAces16V1 } from "./acesOpaque16V1";

/** Private working transport; this is never a public transparent delivery profile. */
export function usesAces16PrecompositionV1(management?: ColorManagementSettings): boolean {
  return usesOpaqueAces16V1(management);
}

export function aces16PrecompositionEncoderArgsV1(): string[] {
  return ["-c:v", "ffv1", "-level", "3"];
}

export function aces16PrecompositionMetadataArgsV1(): string[] {
  // ACEScct is working data. Do not stamp a display transfer or Rec.709 YUV matrix.
  return ["-color_range", "pc", "-colorspace", "rgb"];
}

export function aces16PrecompositionAssetV1(asset: MediaAsset, uri: string): MediaAsset {
  return {
    ...structuredClone(asset), uri, compositionId: undefined, alphaMode: "straight",
    color: { interpretation: "acescct", range: "pc" },
  };
}
