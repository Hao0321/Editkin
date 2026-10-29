import { contrastRatio, mostContrasting, relativeLuminance } from "../svg/color";
import { createSvgDocument, fmt, type Point2, type SvgDocument } from "../svg/document";
import { energyProfile, type EnergyProfile } from "../svg/easing";
import { fitFontSize, layoutTextBlock, type GlyphBox, type MotionFontSelector, type TextBlockLayout } from "../svg/glyphs";
import { parseAbsolutePathD } from "../svg/pathOps";
import type { MotionEnergy, MotionFrameSize, MotionPalette, MotionTextFontRole, MotionTransitionDirection, TextMotionParams } from "../types";

/**
 * Small conventions shared by item generators. Amplitudes are authored at 1080
 * units (Motion Language v1) and scale with min(width, height); the reference
 * demos were 720 px wide, so reference pixel figures are multiplied by 1.5
 * when they relate to the frame (or scaled with the text when they relate to it).
 */

/** Pixels per authored unit: min(width, height) / 1080. */
export function frameUnit(size: MotionFrameSize): number {
  return Math.min(size.width, size.height) / 1080;
}

export interface FrameBox {
  readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number;
  readonly width: number; readonly height: number; readonly cx: number; readonly cy: number;
}

/** Title-safe box: the frame inset by `margin` (default 5%) on every side. */
export function titleSafeBox(size: MotionFrameSize, margin = 0.05): FrameBox {
  const x0 = size.width * margin, y0 = size.height * margin, x1 = size.width - x0, y1 = size.height - y0;
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0, cx: size.width / 2, cy: size.height / 2 };
}

/**
 * The plate colour a text item paints first (ART_DIRECTION §9), or undefined for
 * "none": a text clip is transparent unless a plate is requested.
 */
export function textPlateColor(params: Pick<TextMotionParams, "plate" | "palette">): string | undefined {
  switch (params.plate) {
    case "bg": return params.palette.bg;
    case "accent": return params.palette.accent;
    case "paper": return params.palette.paper;
    default: return undefined;
  }
}

/** What the text is read against: the plate colour when a plate is drawn, the palette bg otherwise. */
export function textBackdrop(params: Pick<TextMotionParams, "plate" | "palette">): string {
  return textPlateColor(params) ?? params.palette.bg;
}

/** The text role (paper or ink) that reads best over `backdrop` (normally textBackdrop(params)). */
export function textOnBackground(palette: MotionPalette, backdrop: string): string {
  return mostContrasting(backdrop, [palette.paper, palette.ink]);
}

// ---------------------------------------------------------------------------
// Reference colour and type rules (ART_DIRECTION §0)
// ---------------------------------------------------------------------------

/**
 * The first candidate that reads on `backdrop` at minContrast (default 3:1, the
 * large-text threshold), else the most contrasting candidate.
 */
export function readableColor(backdrop: string, candidates: readonly string[], minContrast = 3): string {
  if (!candidates.length) throw new Error("readableColor needs at least one candidate");
  return candidates.find(color => contrastRatio(color, backdrop) >= minContrast) ?? mostContrasting(backdrop, candidates);
}

/** What a backdrop is in palette terms: the accent card, a dark card (luminance ≤ 0.2) or a light (cream) card. */
export function backdropTone(palette: MotionPalette, backdrop: string): "dark" | "accent" | "light" {
  if (backdrop.toUpperCase() === palette.accent.toUpperCase()) return "accent";
  return relativeLuminance(backdrop) <= 0.2 ? "dark" : "light";
}

/**
 * The second tone of a two-tone word (ART_DIRECTION §0); the first is
 * textOnBackground. One accent per item plus its own deep shade, never a second hue:
 * - dark card → accent (paper + accent, e.g. 爆発四散 white/lime);
 * - accent card → accent2, the deep shade (ink + accent2, e.g. ゆらゆら black/deep teal);
 * - cream card → the accent when it reads at 3:1, else accent2 (ink + accent2, e.g. 表か裏か black/olive).
 * A tone that would not read at 3:1 falls back to the next one, and finally to the text colour itself.
 */
export function secondaryTone(palette: MotionPalette, backdrop: string): string {
  const primary = textOnBackground(palette, backdrop);
  switch (backdropTone(palette, backdrop)) {
    case "dark": return readableColor(backdrop, [palette.accent, primary]);
    case "accent": return readableColor(backdrop, [palette.accent2, primary]);
    default: return readableColor(backdrop, [palette.accent, palette.accent2, primary]);
  }
}

/**
 * Display tracking (ART_DIRECTION §0, tight and poster-like): −0.04 em when the
 * longest line has 3+ visible characters, −0.02 em for 1–2 huge glyphs.
 */
export function displayTracking(lines: readonly string[]): number {
  const longest = Math.max(0, ...lines.map(text => [...text].filter(character => character.trim()).length));
  return longest >= 3 ? -0.04 : -0.02;
}

export interface HeroTextBoxOptions {
  /** Share of the title-safe width the widest line fills at rest (default 0.86, inside the 80–90% band). */
  readonly fill?: number;
  /** Share of the title-safe height the block may take (default 0.62): the cap that binds for 1–2 character words in landscape. */
  readonly heightFill?: number;
  /** Peak scale above the hold (punch, breathe): the rest box shrinks only as much as needed for the peak to stay inside 98% of the safe box. Default 1. */
  readonly headroom?: number;
  /** Title-safe margin (default 0.05). */
  readonly margin?: number;
}

export interface HeroTextBox {
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Large enough never to bind: the width (or heightFill) decides the size. */
  readonly maxSize: number;
}

/**
 * Fit box for an item's main word (ART_DIRECTION §0): it fills 80–90% of the
 * title-safe width in landscape and in portrait, with the height capped so a short
 * word cannot fill a landscape frame top to bottom. Use it with layoutFittedText:
 *   layoutFittedText(lines, textFace(font, 900), { ...heroTextBox(size, { headroom: 1.1 }), lineHeight: 1.04, tracking: displayTracking(lines) })
 */
export function heroTextBox(size: MotionFrameSize, options: HeroTextBoxOptions = {}): HeroTextBox {
  const fill = options.fill ?? 0.86, heightFill = options.heightFill ?? 0.62, headroom = options.headroom ?? 1;
  if (!(fill > 0 && fill <= 1) || !(heightFill > 0 && heightFill <= 1) || !(headroom >= 1)) {
    throw new Error("heroTextBox needs 0 < fill ≤ 1, 0 < heightFill ≤ 1 and headroom ≥ 1");
  }
  const safe = titleSafeBox(size, options.margin);
  return {
    maxWidth: safe.width * Math.min(fill, 0.98 / headroom),
    maxHeight: safe.height * Math.min(heightFill, 0.98 / headroom),
    maxSize: Math.max(size.width, size.height),
  };
}

/**
 * A text frame document: transparent for plate "none", otherwise with the
 * full-frame plate painted first. The plate never changes geometry or timing.
 */
export function createTextDocument(size: MotionFrameSize, params: Pick<TextMotionParams, "plate" | "palette">): SvgDocument {
  const plate = textPlateColor(params);
  return createSvgDocument(size, plate ? { background: plate } : {});
}

/** Map the text item's font param to a glyph face selector (with the item's preferred display weight). */
export function textFace(font: MotionTextFontRole, displayWeight = 900): MotionFontSelector {
  switch (font) {
    case "display": return { font: "display", weight: displayWeight };
    case "serif": return { font: "serif", weight: Math.min(900, Math.max(200, displayWeight)) };
    case "hand": return { font: "hand" };
    case "latin": return { font: "latin" };
  }
}

export interface ItemTiming {
  readonly energy: EnergyProfile;
  /** Multiply authored (standard-energy) seconds by this. */
  readonly timeScale: number;
}

/**
 * Energy timing with compression: authored seconds are scaled by the energy's
 * time factor, and squeezed further when the clip is shorter than the
 * authored program needs (naturalSeconds at standard energy).
 */
export function itemTiming(energy: MotionEnergy, durationSeconds: number, naturalSeconds: number): ItemTiming {
  const profile = energyProfile(energy);
  const timeScale = profile.time * Math.min(1, durationSeconds / (naturalSeconds * profile.time));
  return { energy: profile, timeScale };
}

/** White in a transition matte shows B; black (the document background) shows A. */
export const MATTE_SHOW_B = "#FFFFFF";
export const MATTE_SHOW_A = "#000000";

/** A matte frame: opaque black (all A) to draw white (B) shapes on. */
export function createMatteDocument(size: MotionFrameSize): SvgDocument {
  return createSvgDocument(size, { background: MATTE_SHOW_A, idPrefix: "mt" });
}

export interface TravelFrame {
  /** Extent along the travel direction (px). */
  readonly length: number;
  /** Extent across it (px). */
  readonly cross: number;
  /** Travel coordinates to frame px: u along the wipe from its start edge, v across it. */
  readonly toFrame: (u: number, v: number) => Point2;
}

/**
 * A wipe's travel axis in frame px, so one geometry serves all four directions
 * (the X02 / X04 / X07 pattern): draw in (u, v) with u running from the start
 * edge (0) to the far edge (length) and v across, then map every point with toFrame.
 *   const frame = travelFrame(params.direction ?? "left_to_right", size);
 *   polygonPathD(points.map(([u, v]) => frame.toFrame(u, v)))
 */
export function travelFrame(direction: MotionTransitionDirection, size: MotionFrameSize): TravelFrame {
  const { width, height } = size;
  switch (direction) {
    case "left_to_right": return { length: width, cross: height, toFrame: (u, v) => [u, v] };
    case "right_to_left": return { length: width, cross: height, toFrame: (u, v) => [width - u, v] };
    case "top_to_bottom": return { length: height, cross: width, toFrame: (u, v) => [v, u] };
    case "bottom_to_top": return { length: height, cross: width, toFrame: (u, v) => [v, height - u] };
    default: throw new Error(`Unknown transition direction ${String(direction)}`);
  }
}

export interface FittedText {
  readonly block: TextBlockLayout;
  readonly fontSize: number;
  /** Ink box in block coordinates (falls back to the em box for blank text). */
  readonly ink: GlyphBox;
  /** Centre of the ink box in block coordinates: translate(-cx, -cy) puts it on the origin. */
  readonly inkCenter: readonly [number, number];
}

/**
 * Lay out lines at the largest size that fits (ink extents) inside maxWidth ×
 * maxHeight, capped at maxSize. Centre it with
 * translate(targetX, targetY) scale(s) translate(-inkCenter).
 */
export function layoutFittedText(lines: readonly string[], face: MotionFontSelector, box: {
  readonly maxWidth: number; readonly maxHeight: number; readonly maxSize: number; readonly minSize?: number;
  readonly lineHeight?: number; readonly tracking?: number; readonly align?: "start" | "center" | "end";
}): FittedText {
  const lineHeight = box.lineHeight ?? 1.15, tracking = box.tracking ?? 0;
  const fontSize = fitFontSize(lines, { ...face, lineHeight, tracking },
    { maxWidth: box.maxWidth, maxHeight: box.maxHeight, maxSize: box.maxSize, minSize: box.minSize ?? 8 });
  const block = layoutTextBlock(lines, { ...face, size: fontSize, lineHeight, tracking, align: box.align });
  const ink = block.inkBox ?? { x0: 0, y0: 0, x1: block.width, y1: block.height };
  // block.size is the canonical (3-decimal) size the layout actually used.
  return { block, fontSize: block.size, ink, inkCenter: [(ink.x0 + ink.x1) / 2, (ink.y0 + ink.y1) / 2] };
}

// ---------------------------------------------------------------------------
// Per-glyph placement (promoted from T58, 2026-10-22; users T58–T60, T65–T67, T70–T80)
// ---------------------------------------------------------------------------

const compactCache = new Map<string, string>();

function compactNumber(value: number, decimals: 0 | 1 | 2): string {
  const text = fmt(value, decimals);
  if (text.startsWith("0.")) return text.slice(1);
  if (text.startsWith("-0.")) return `-${text.slice(2)}`;
  return text;
}

/**
 * Absolute M/L/H/V/Q/C/Z path data (glyphs.ts and pathOps output) as compact
 * relative path data: m/l/q/c/z with `decimals` places, repeated commands
 * implicit, no leading zeros. Each step is measured from the previously emitted
 * (rounded) point, so rounding never accumulates. Byte-identical to T09's
 * compactPathD (the original; T09 and the items that import it from there keep
 * their own copy until they switch to this one). Cached; deterministic.
 */
export function compactPathD(d: string, decimals: 0 | 1 | 2 = 1): string {
  if (!d) return "";
  const key = `${decimals}\u0000${d}`;
  const hit = compactCache.get(key);
  if (hit !== undefined) return hit;
  const scale = 10 ** decimals;
  let out = "", last = "", x = 0, y = 0, startX = 0, startY = 0;
  const emit = (command: string, values: readonly string[]) => {
    const implicit = command === last && command !== "m";
    let text = implicit ? "" : command;
    for (const token of values) {
      const gap = !token.startsWith("-") && (text.length ? !/[a-z]$/.test(text) : implicit);
      text += gap ? ` ${token}` : token;
    }
    out += text;
    last = command;
  };
  // Relative step from the emitted point, rounded, as the token the renderer will read back.
  const step = (to: number, from: number) => compactNumber(Math.round((to - from) * scale) / scale, decimals);
  for (const segment of parseAbsolutePathD(d, "compactPathD")) {
    if (segment.type === "Z") { out += "z"; last = "z"; x = startX; y = startY; continue; }
    const tokens: string[] = [];
    if (segment.type === "Q") tokens.push(step(segment.x1, x), step(segment.y1, y));
    if (segment.type === "C") tokens.push(step(segment.x1, x), step(segment.y1, y), step(segment.x2, x), step(segment.y2, y));
    const dx = step(segment.x, x), dy = step(segment.y, y);
    tokens.push(dx, dy);
    emit(segment.type === "M" ? "m" : segment.type.toLowerCase(), tokens);
    x += Number(dx); y += Number(dy);
    if (segment.type === "M") { startX = x; startY = y; }
  }
  compactCache.set(key, out);
  if (compactCache.size > 256) compactCache.delete(compactCache.keys().next().value!);
  return out;
}

/** Characters treated as separators (「・」 and friends): the same set as T09's marquee separators. */
const SEPARATOR_CHARACTERS: ReadonlySet<string> = new Set(["・", "•", "·", "／", "/", "|", "｜", "—", "–", "●", "◆", "◇", "★", "☆", "＊", "*"]);

export function isSeparatorCharacter(character: string): boolean {
  return SEPARATOR_CHARACTERS.has(character);
}

export interface WordGlyph {
  /** Running index over every drawn (non-blank) glyph of every line. */
  readonly index: number;
  readonly char: string;
  readonly line: number;
  /** Compact relative outline (compactPathD), drawn at translate(x, y). */
  readonly pathD: string;
  /** Pen origin on the baseline (frame px). */
  readonly x: number;
  readonly y: number;
  /** Ink centre (frame px). */
  readonly cx: number;
  readonly cy: number;
  /** Ink box at rest (frame px). */
  readonly box: GlyphBox;
  readonly separator: boolean;
}

/**
 * Every drawn glyph of a fitted block, moved by (dx, dy) from block to frame px,
 * with the tallest glyph ink height (the item's "glyph size"; falls back to
 * 0.88 em for blank text). Blanks are skipped; separators are flagged.
 *   const text = layoutFittedText(params.lines, face, box);
 *   const { glyphs, glyphHeight } = placeWordGlyphs(text, safe.cx - text.inkCenter[0], safe.cy - text.inkCenter[1]);
 *   glyphs.map(glyph => path(glyph.pathD, { transform: tf.translate(glyph.x, glyph.y) }))
 */
export function placeWordGlyphs(text: FittedText, dx: number, dy: number): { readonly glyphs: readonly WordGlyph[]; readonly glyphHeight: number } {
  const glyphs: WordGlyph[] = [];
  let glyphHeight = 0;
  text.block.lines.forEach((placed, line) => {
    for (const glyph of placed.layout.glyphs) {
      if (glyph.whitespace || !glyph.bbox) continue;
      const x = dx + placed.x + glyph.x, y = dy + placed.baselineY;
      glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
      glyphs.push({
        index: glyphs.length, char: glyph.char, line, pathD: compactPathD(glyph.pathD), x, y,
        cx: x + (glyph.bbox.x0 + glyph.bbox.x1) / 2, cy: y + (glyph.bbox.y0 + glyph.bbox.y1) / 2,
        box: { x0: x + glyph.bbox.x0, y0: y + glyph.bbox.y0, x1: x + glyph.bbox.x1, y1: y + glyph.bbox.y1 },
        separator: isSeparatorCharacter(glyph.char),
      });
    }
  });
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  return { glyphs, glyphHeight };
}
