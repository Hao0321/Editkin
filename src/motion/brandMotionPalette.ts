export interface BrandMotionPaletteRoles {
  readonly primary: string; readonly background: string; readonly ink: string; readonly grid: string;
}
export interface ResolvedBrandMotionPalette {
  readonly schema: "editkin.brand-motion-palette/v1";
  readonly roles: BrandMotionPaletteRoles;
  readonly tokens: Readonly<BrandMotionPaletteRoles & { onPrimary: string; surface: string; muted: string; quiet: string;
    faint: string; line: string; lineStrong: string; soft: string; tint: string; accent: string; shadow: string; shadowLight: string }>;
  readonly surfaceBackgroundWeight: number;
  readonly advisory: { readonly scope: "main-text/background-only"; readonly contrast: number; readonly lowContrast: boolean };
}
const ROLE_KEYS = ["primary", "background", "ink", "grid"] as const;
function color(value: string): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Brand motion roles require #RRGGBB sRGB colors");
  return value.toLowerCase();
}
function channels(value: string): number[] { return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16)); }
function luminance(value: string): number {
  const [r, g, b] = channels(value).map(byte => { const n = byte / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
  return r * .2126 + g * .7152 + b * .0722;
}
function byte(value: number): string { return Math.round(value).toString(16).padStart(2, "0"); }
/** Opaque CSS color-mix(in srgb) equivalents, resolved once for both adapters. */
function mix(a: string, b: string, weightA: number): string {
  const aa = channels(a), bb = channels(b);
  return `#${aa.map((n, i) => byte(n * weightA + bb[i] * (1 - weightA))).join("")}`;
}
export function brandMotionContrast(a: string, b: string): number {
  const x = luminance(color(a)), y = luminance(color(b));
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

/** Original pure four-role resolver. No DOM/CSS engine/localStorage state.
 * This keeps the peer's role/contrast contract, not its specific blue/presets.
 * The advisory certifies neither every token combination nor artistic quality. */
export function resolveBrandMotionPalette(raw: BrandMotionPaletteRoles): ResolvedBrandMotionPalette {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== ROLE_KEYS.length
    || Object.keys(raw).some(key => !(ROLE_KEYS as readonly string[]).includes(key))) throw new Error("Brand motion palette requires exactly four roles");
  const roles = Object.freeze({ primary: color(raw.primary), background: color(raw.background), ink: color(raw.ink), grid: color(raw.grid) });
  const onPrimary = brandMotionContrast(roles.primary, "#000000") >= brandMotionContrast(roles.primary, "#ffffff") ? "#000000" : "#ffffff";
  const surfaceBackgroundWeight = luminance(roles.background) > .35 ? 0 : .88;
  const surface = mix(roles.background, "#ffffff", surfaceBackgroundWeight);
  const tokens = Object.freeze({ ...roles, onPrimary, surface,
    muted: mix(roles.ink, surface, .78), quiet: mix(roles.ink, surface, .67), faint: mix(roles.ink, surface, .56),
    line: mix(roles.primary, surface, .14), lineStrong: mix(roles.primary, surface, .25), soft: mix(roles.primary, surface, .04),
    tint: mix(roles.primary, surface, .08), accent: mix(roles.primary, surface, .62),
    shadow: `${roles.primary}${byte(.08 * 255)}`, shadowLight: `${roles.primary}${byte(.03 * 255)}` });
  const contrast = brandMotionContrast(roles.ink, roles.background);
  return Object.freeze({ schema: "editkin.brand-motion-palette/v1", roles, tokens, surfaceBackgroundWeight,
    advisory: Object.freeze({ scope: "main-text/background-only", contrast, lowContrast: contrast < 4.5 }) });
}
