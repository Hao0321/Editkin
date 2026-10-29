import { fe, fmt, type SvgDocument } from "../motionLibrary/svg/document";

/**
 * Small SVG filter helpers for style components (browser-safe). Regions are
 * userSpaceOnUse boxes in the coordinates of the element the filter is put on;
 * keep them tight (librsvg pays per filtered pixel).
 */

export interface FxBox { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

export const growBox = (box: FxBox, pad: number): FxBox => ({ x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad });

export function filterRegion(box: FxBox): { x: number; y: number; width: number; height: number } {
  return { x: Number(fmt(box.x0, 1)), y: Number(fmt(box.y0, 1)), width: Number(fmt(box.x1 - box.x0, 1)), height: Number(fmt(box.y1 - box.y0, 1)) };
}

/** A soft drop shadow under the source graphic (blurred alpha, offset, flooded with `color` at `opacity`). Returns url(#id). */
export function dropShadow(doc: SvgDocument, options: { readonly box: FxBox; readonly sigma: number; readonly dx?: number; readonly dy?: number;
  readonly color: string; readonly opacity: number }): string {
  const dx = options.dx ?? 0, dy = options.dy ?? 0, sigma = Math.max(0.05, options.sigma);
  return doc.filter([
    fe.blur({ in: "SourceAlpha", stdDeviation: Number(fmt(sigma, 2)), result: "b" }),
    fe.offset({ in: "b", dx: Number(fmt(dx, 2)), dy: Number(fmt(dy, 2)), result: "o" }),
    fe.flood({ color: options.color, opacity: options.opacity, result: "c" }),
    fe.composite({ in: "c", in2: "o", operator: "in", result: "s" }),
    fe.merge(["s", "SourceGraphic"]),
  ], filterRegion(growBox(options.box, sigma * 3 + Math.max(Math.abs(dx), Math.abs(dy)) + 4)));
}

/** A Gaussian blur of the source graphic (undefined when σ is too small to matter). Returns url(#id). */
export function blurFilter(doc: SvgDocument, sigma: number, box: FxBox): string | undefined {
  if (!(sigma >= 0.05)) return undefined;
  return doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: Number(fmt(sigma, 2)) }), filterRegion(growBox(box, sigma * 3 + 2)));
}
