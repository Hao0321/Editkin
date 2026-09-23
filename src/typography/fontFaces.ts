import index from "../generated/fontFaceIndex.json";

type FontFamilyEntry = readonly [family: string, id: string, weights: readonly number[]];

/** Numeric tokens in physical aliases (e.g. "... 850") are not valid unquoted
 * CSS family identifiers. ASS uses the raw name; CSS consumers need a string. */
export function cssFontFamily(family: string | undefined): string | undefined {
  return family === undefined ? undefined : `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n\f]/g, " ")}"`;
}

export interface ResolvedFontFace {
  fontFamily: string;
  fontWeight: number;
  fontFile: string;
  faceId: string;
  requestedWeight: number;
  weightSubstituted: boolean;
}

/** Generated index is gate-bound to the canonical, licensed physical font pack. */
export function resolveBundledFontFace(family: string, requestedWeight: number): ResolvedFontFace | undefined {
  if (!Number.isFinite(requestedWeight) || requestedWeight < 100 || requestedWeight > 900) {
    throw new Error("字重必須介於 100 與 900。");
  }
  // JSON tuple shape is produced and independently validated by open-font-gate.
  const entry = (index as unknown as readonly FontFamilyEntry[]).find(([name]) => name === family);
  if (!entry) return undefined; // Custom font paths retain their separate, unverified contract.
  const [, id, weights] = entry;
  let resolved = weights[0];
  if (resolved === undefined) throw new Error(`字型未提供實體字重：${family}`);
  for (const weight of weights) {
    const delta = Math.abs(weight - requestedWeight);
    if (delta < Math.abs(resolved - requestedWeight) || (delta === Math.abs(resolved - requestedWeight) && weight < resolved)) resolved = weight;
  }
  const faceId = `EditkinFace-${id}-${resolved}`;
  return {
    fontFamily: `EditkinFace ${id} ${resolved}`,
    fontWeight: resolved,
    fontFile: `render/${faceId}.ttf`,
    faceId,
    requestedWeight,
    weightSubstituted: resolved !== requestedWeight,
  };
}
