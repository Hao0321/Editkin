/**
 * sRGB hex colour helpers for palette-driven frames. Mixing happens on the
 * 8-bit sRGB values (what the palette author picked), rounded to integers, so
 * a mix is deterministic and identical in Chromium and librsvg.
 */

export interface Rgb { readonly r: number; readonly g: number; readonly b: number }

export function parseHexColor(hex: string): Rgb {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (!match) throw new Error(`Expected #RRGGBB colour, got ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0").toUpperCase();

export function rgbToHex(color: Rgb): string {
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Linear mix in sRGB: t = 0 gives a, t = 1 gives b. */
export function mixHex(a: string, b: string, t: number): string {
  const from = parseHexColor(a), to = parseHexColor(b), k = Math.max(0, Math.min(1, t));
  return rgbToHex({ r: from.r + (to.r - from.r) * k, g: from.g + (to.g - from.g) * k, b: from.b + (to.b - from.b) * k });
}

/** A lighter tint of `hex`: mixed `amount` (0..1) toward `light` (default white; items pass palette.paper). */
export function tint(hex: string, amount: number, light = "#FFFFFF"): string {
  return mixHex(hex, light, amount);
}

/** A deeper shade of `hex`: mixed `amount` (0..1) toward `dark` (default black; items pass palette.ink). */
export function shade(hex: string, amount: number, dark = "#000000"): string {
  return mixHex(hex, dark, amount);
}

/** Relative luminance (WCAG, linearized sRGB). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex);
  const linear = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Pick the candidate with the highest contrast against `against`. */
export function mostContrasting(against: string, candidates: readonly string[]): string {
  if (!candidates.length) throw new Error("mostContrasting needs at least one candidate");
  let best = candidates[0], bestRatio = -1;
  for (const candidate of candidates) {
    const ratio = contrastRatio(against, candidate);
    if (ratio > bestRatio + 1e-9) { best = candidate; bestRatio = ratio; }
  }
  return best;
}
