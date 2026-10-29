import { relativeLuminance } from "../motionLibrary/svg/color";

/**
 * Measured readability (design §4): every caption must reach the template's
 * contrast (4.5:1) against the actual footage behind it.
 *
 * The compiler samples the footage under a candidate text box over the beat's
 * frames (BackgroundStats) and evaluates the text colours against it. Light text
 * is threatened by the brightest pixels behind it and dark text by the darkest,
 * so contrast is taken against both the 80th and the 20th luminance percentile
 * and the worse one counts. A busy background (high texture) fails the plain
 * treatment whatever its mean, and glow is allowed only on a dark, calm one.
 *
 * A dark scrim or plate of display opacity α maps a display value c to c·(1−α),
 * so relative luminance scales by (1−α)^2.2 (γ ≈ 2.2). The scrim model assumes
 * the text lies inside the scrim's full-opacity core.
 */

export interface BackgroundStats {
  /** Relative (linear) luminance of the footage behind the text: mean and 80th / 20th percentiles over pixels and frames. */
  readonly mean: number;
  readonly high: number;
  readonly low: number;
  /** Standard deviation of display luma (0..1), averaged over frames: how busy the background is. */
  readonly texture: number;
}

/** Display-luma deviation above which a background is busy: plain text (and any glow) is not admitted there. */
export const STYLE_BUSY_TEXTURE = 0.12;

const wcag = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

export function darkenFactor(alpha: number): number {
  return (1 - Math.max(0, Math.min(1, alpha))) ** 2.2;
}

/** Worst WCAG contrast of a text colour against the sampled background, after a dark scrim/plate of display opacity `darken`. */
export function contrastAgainstBackground(textHex: string, stats: BackgroundStats, darken = 0): number {
  const text = relativeLuminance(textHex), factor = darkenFactor(darken);
  return Math.min(wcag(text, stats.high * factor), wcag(text, stats.low * factor));
}

export interface CaptionColours {
  readonly lead: string;
  /** Colours the keyword glyphs are drawn in over the footage (both stops of a gradient). */
  readonly keyword?: readonly string[];
  /** A keyword drawn on an opaque box: its text and box colours (the footage does not matter then). */
  readonly keywordOnBox?: { readonly text: string; readonly box: string };
  /** Glow needs a dark, calm background. */
  readonly glow?: boolean;
  /** Lead lines drawn on an opaque box (boxAll). */
  readonly leadOnBox?: { readonly text: string; readonly box: string };
}

export interface CaptionReadabilityResult {
  readonly lead: number;
  readonly keyword?: number;
  readonly texture: number;
  readonly pass: boolean;
}

export function evaluateCaptionReadability(colours: CaptionColours, stats: BackgroundStats, options: {
  readonly minContrast: number; readonly darken: number; readonly plain: boolean;
}): CaptionReadabilityResult {
  const lead = colours.leadOnBox ? wcag(relativeLuminance(colours.leadOnBox.text), relativeLuminance(colours.leadOnBox.box))
    : contrastAgainstBackground(colours.lead, stats, options.darken);
  let keyword: number | undefined;
  if (colours.keywordOnBox) keyword = wcag(relativeLuminance(colours.keywordOnBox.text), relativeLuminance(colours.keywordOnBox.box));
  else if (colours.keyword?.length) keyword = Math.min(...colours.keyword.map(colour => contrastAgainstBackground(colour, stats, options.darken)));
  const busy = stats.texture > STYLE_BUSY_TEXTURE;
  const pass = lead >= options.minContrast && (keyword === undefined || keyword >= options.minContrast)
    && !(options.plain && busy) && !(colours.glow && busy);
  return { lead, ...(keyword === undefined ? {} : { keyword }), texture: stats.texture, pass };
}
