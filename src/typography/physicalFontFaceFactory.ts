import type { BundledFontFaceSpec } from "./bundledFontCatalog";

/** Binary FontFace registration uses the literal family. CSS references quote that family separately. */
export function constructPhysicalFontFace(Constructor: typeof FontFace,
  spec: Pick<BundledFontFaceSpec, "fontFamily" | "fontWeight">, source: ArrayBuffer): FontFace {
  return new Constructor(spec.fontFamily, source, {
    weight: String(spec.fontWeight), style: "normal", display: "block",
  });
}
