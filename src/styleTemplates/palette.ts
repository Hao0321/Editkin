import { contrastRatio, mixHex, mostContrasting, relativeLuminance, shade, tint } from "../motionLibrary/svg/color";
import { STYLE_PALETTE_ROLES, stylePaletteOverrideSchema, type StylePalette, type StylePaletteRole, type StyleTemplateV1 } from "./types";

/**
 * Palettes are editable (Hao 2026-10-07): a plan overrides any role. Derived
 * colours follow the roles, so a changed accent re-derives its box text, glow
 * core and gradient stops with no hard-coded hex in a component.
 */
export interface DerivedStyleColors {
  /** Text drawn on the accent (a highlight box): ink or paper, whichever reads. */
  readonly onAccent: string;
  /** Text drawn on the highlight colour. */
  readonly onHighlight: string;
  /** Soft text shadow (a deep shade of ink). */
  readonly shadow: string;
  /** Readability plate behind captions. */
  readonly plate: string;
  /** Hot core of a glow (the highlight pushed toward white). */
  readonly glowCore: string;
  /** Gradient keyword stops (top → bottom). */
  readonly gradientTop: string;
  readonly gradientBottom: string;
  /** A light tint of the accent for light planes. */
  readonly accentTint: string;
}

export interface ResolvedStylePalette extends StylePalette {
  readonly derived: DerivedStyleColors;
}

export function resolveStylePalette(template: StyleTemplateV1, overrides?: Partial<Record<StylePaletteRole, string>>): ResolvedStylePalette {
  const parsed = stylePaletteOverrideSchema.parse(overrides ?? {});
  const roles = Object.fromEntries(STYLE_PALETTE_ROLES.map(role => [role, parsed[role] ?? template.palette[role]])) as Record<StylePaletteRole, string>;
  const derived: DerivedStyleColors = {
    onAccent: mostContrasting(roles.accent, [roles.ink, roles.paper]),
    onHighlight: mostContrasting(roles.highlight, [roles.ink, roles.paper]),
    shadow: shade(roles.ink, 0.55),
    plate: shade(roles.ink, 0.2),
    glowCore: tint(roles.highlight, 0.45),
    gradientTop: roles.accent,
    gradientBottom: roles.accent2,
    accentTint: tint(roles.accent, 0.7, roles.paper),
  };
  return Object.freeze({ ...roles, derived: Object.freeze(derived) });
}

/** WCAG contrast of a text colour over a sampled footage luminance (relative, 0..1). */
export function contrastOverLuminance(text: string, luminance: number): number {
  const lt = relativeLuminance(text), lb = Math.max(0, Math.min(1, luminance));
  return (Math.max(lt, lb) + 0.05) / (Math.min(lt, lb) + 0.05);
}

export { contrastRatio, mixHex, relativeLuminance };
