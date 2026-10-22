import {
  MOTION_PALETTE_ROLES,
  MOTION_PALETTE_THEMES,
  motionPaletteInputSchema,
  motionPaletteSchema,
  type MotionPalette,
  type MotionPaletteInput,
  type MotionPaletteTheme,
} from "./types";

/** The reference card colours shared by every ref_* theme (ART_DIRECTION §0, measured at t = 1.2 s). */
const REFERENCE_CARD = Object.freeze({ bg: "#15191F", ink: "#121214", paper: "#F5F1E6" });
const reference = (accent: string, accent2: string): MotionPalette => Object.freeze({ ...REFERENCE_CARD, accent, accent2 });

/**
 * Theme presets for the motion library. Every role stays overridable:
 * resolveMotionPalette starts from a theme (or the item's default palette) and
 * replaces any role the caller supplies.
 *
 * ref_* themes reproduce the reference showcase (ART_DIRECTION §0): one dark
 * card, one cream, one ink, one accent and its own deep shade as accent2 (never a
 * second hue). They are the catalog defaults, one per category. Hao's themes
 * (hao_impact, swiss_blue, travel_note, tech_spec, esports_hud) stay selectable.
 */
export const MOTION_PALETTES: Readonly<Record<MotionPaletteTheme, MotionPalette>> = Object.freeze({
  /** DRAMA T41–T48 (measured olive accent2). */
  ref_lime: reference("#C7FF3E", "#435A08"),
  /** PLAY T49–T56. */
  ref_coral: reference("#FF7054", "#7C2E1E"),
  /** PHYSICS T57–T64. */
  ref_violet: reference("#9C7EFF", "#46339A"),
  /** RHYTHM T65–T72 (measured accent2). */
  ref_teal: reference("#2DDAC4", "#016B63"),
  /** MOOD T73–T80 (measured accent2). */
  ref_gold: reference("#FFC93D", "#7C5501"),
  /** IMPACT T01–T08 (accent measured on the set A slide 1 cover frame). */
  ref_red: reference("#FD4E4B", "#7A1E1E"),
  /** FLOW T09–T16; FLUID & IMPACT transitions; line backgrounds (accent measured, ART_DIRECTION §10). */
  ref_yellow: reference("#FECB2C", "#845400"),
  /** DEPTH T17–T24; SHAPE transitions; grid backgrounds (measured, ART_DIRECTION §10). */
  ref_aqua: reference("#1AD4C4", "#016B65"),
  /** SWITCH T25–T32; PANEL transitions; shape backgrounds (accent measured, ART_DIRECTION §10). */
  ref_lavender: reference("#B895FF", "#4A3A99"),
  /** STYLE T33–T40; MOSAIC transitions; minimal backgrounds (accent measured, ART_DIRECTION §10). */
  ref_orange: reference("#FE8A3E", "#7A3A0E"),
  /** SWEEP transitions; halftone backgrounds (accent measured, ART_DIRECTION §10). */
  ref_pink: reference("#FD4F89", "#7A1F3B"),
  /** Hao Impact coral: charcoal, cream, coral + amber. */
  hao_impact: Object.freeze({ bg: "#121216", ink: "#121216", paper: "#F3EFE6", accent: "#FF5A4E", accent2: "#FFB03A" }),
  /** Swiss blue for teaching and podcasts. */
  swiss_blue: Object.freeze({ bg: "#F4F4F0", ink: "#111316", paper: "#FFFFFF", accent: "#2457F5", accent2: "#9DB4FF" }),
  /** Travel notebook warm, for travel and food. */
  travel_note: Object.freeze({ bg: "#FBF3E4", ink: "#2B2118", paper: "#FFFDF7", accent: "#E86A3A", accent2: "#3B8C7E" }),
  /** Tech spec for unboxing and product detail. */
  tech_spec: Object.freeze({ bg: "#0E1116", ink: "#0E1116", paper: "#E8EDF2", accent: "#2ED3C0", accent2: "#B39DFF" }),
  /** Esports HUD for games. */
  esports_hud: Object.freeze({ bg: "#0B0B12", ink: "#0B0B12", paper: "#EAF6FF", accent: "#39FF88", accent2: "#FF2E88" }),
});

export function motionPaletteTheme(theme: MotionPaletteTheme): MotionPalette {
  const palette = MOTION_PALETTES[theme];
  if (!palette) throw new Error(`Unknown motion palette theme: ${String(theme)}`);
  return palette;
}

/**
 * Resolve a caller palette. `base` is the starting palette when the input names
 * no theme (normally the item's default palette). Unknown keys and malformed
 * colours are rejected; the result is a frozen, uppercase, complete palette.
 */
export function resolveMotionPalette(input: MotionPaletteInput | undefined, base: MotionPalette): MotionPalette {
  const parsed = motionPaletteInputSchema.parse(input ?? {});
  const start = parsed.theme ? motionPaletteTheme(parsed.theme) : motionPaletteSchema.parse(base);
  const merged: Record<string, string> = {};
  for (const role of MOTION_PALETTE_ROLES) merged[role] = parsed[role] ?? start[role];
  return Object.freeze(motionPaletteSchema.parse(merged));
}

export function isMotionPaletteTheme(value: unknown): value is MotionPaletteTheme {
  return typeof value === "string" && (MOTION_PALETTE_THEMES as readonly string[]).includes(value);
}
