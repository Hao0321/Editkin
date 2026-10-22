import type { MediaAsset } from "../domain/types";

/** Derivatives retain the source declaration; this never supplies or grants missing rights. */
export function inheritClipMediaSource(asset: MediaAsset, source: MediaAsset): MediaAsset {
  return { ...asset,license:source.license,provenance:source.provenance,redistributable:source.redistributable,
    rightsBasis:source.rightsBasis,distributionScope:source.distributionScope,color:source.color,alphaMode:source.alphaMode };
}
