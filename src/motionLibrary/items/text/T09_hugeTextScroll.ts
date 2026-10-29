import { contrastRatio, mostContrasting } from "../../svg/color";
import { fe, fmt, g, path, rect, tf, type SvgDocument } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { assertMotionText, layoutLine, MotionLibraryGlyphError, translatePathD, type GlyphBox, type MotionFontSelector } from "../../svg/glyphs";
import { parseAbsolutePathD } from "../../svg/pathOps";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, secondaryTone, textBackdrop, textFace, textOnBackground } from "../shared";

/**
 * T09 Huge Text Scroll (巨大スクロール): line 1 as giant type, about 1.2× the
 * frame height (it bleeds off the top and bottom in landscape), runs as an
 * infinite marquee with 緩急: its speed swings between 0.3× and 1.8× of a base
 * speed over a 2 s period (slowest at t = 0, when the first character sits
 * centred). In portrait the giant cells are capped at 0.92 of the frame width,
 * so about one character fills the frame as it passes. Separators (・) in the
 * giant line are drawn in the accent. During the fast phase the giant line gets a
 * horizontal speed smear (Gaussian blur along x, about a 1/60 s shutter; none when
 * slow). A small ticker band (accent, text by the contrast rule; lines 2–4 joined,
 * line 1 when alone) scrolls the other way at a constant speed below the giant
 * line (overlapping its cropped foot in landscape, inside the title-safe box).
 * The effect bleeds by definition (ART_DIRECTION §2), so the giant line is never
 * title-safe; the ticker band is.
 *
 * A seamless 4 s loop (catalog loopSeconds): the giant line advances exactly one
 * repeat per loop and the ticker a whole number of repeats, and every position is
 * a function of the loop phase, so frame 0 equals the frame at 4 s. Energy deepens
 * the 緩急 swing (never the period); very long lines are set smaller so the mean
 * speed stays under 1.25 frame widths per second.
 *
 * Shared with T12, T14 and T16: marqueeUnitText / marqueeUnit lay out one repeat
 * (text plus a joiner) with text and separator outlines apart, marqueeRepeatStarts
 * lists the repeats a strip needs, and pickReadable / distinctFrom choose colours.
 */

const ID = "T09";
const REVISION = 1;
export const T09_LOOP_SECONDS = 4;
/** Giant ink height as a fraction of the frame height, average giant cell as a fraction of the frame width (cap). */
const GIANT_INK_HEIGHT = 1.2, GIANT_CELL_MAX = 0.92, GIANT_TRACKING = -0.04;
/** Mean giant speed cap, frame widths per second (long lines get smaller instead of faster). */
const MAX_MEAN_SPEED = 1.25;
/** 緩急: 0.3× … 1.8× of the base speed is a ±0.714 swing around the mean (1.05×); 2 s per swing. */
const EASE_DEPTH = 0.75 / 1.05, EASE_DEPTH_MAX = 0.92, SWING_SECONDS = 2;
/** Speed smear: σ = speed × SMEAR (px per px/s), shown from SMEAR_MIN px, capped at SMEAR_MAX of the giant size. */
const SMEAR = 1 / 200, SMEAR_MIN = 3, SMEAR_MAX = 0.012;
/** Ticker: ink height and band height (× short side), target speed (short sides per second). */
const TICKER_INK = 0.055, TICKER_BAND = 2.0, TICKER_SPEED = 0.28, TICKER_LATIN_TRACKING = 0.08;
/** Portrait: gap between the giant line and the ticker band (× short side). */
const STACK_GAP = 0.04;

// ---------------------------------------------------------------------------
// Shared marquee helpers (T09, T12, T14, T16)
// ---------------------------------------------------------------------------

/** Characters drawn as separators (in the separator colour) inside a marquee unit. */
const SEPARATORS: ReadonlySet<string> = new Set(["・", "•", "·", "／", "/", "|", "｜", "—", "–", "●", "◆", "◇", "★", "☆", "＊", "*"]);
/** Full-width separators already carry their own spacing. */
const FULL_WIDTH_SEPARATORS: ReadonlySet<string> = new Set(["・", "／", "｜", "●", "◆", "◇", "★", "☆", "＊"]);

export function isMarqueeSeparator(character: string): boolean {
  return SEPARATORS.has(character);
}

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
 * (rounded) point, so rounding never accumulates: every point stays within half a
 * unit in the last place of its source. Glyph outlines are the bulk of these
 * frames and librsvg's number parsing dominates their raster time: on T15 frames
 * this measured 44% smaller and 36–64% faster to rasterize, with identical pixels
 * (PSNR 50.8 dB at 1 decimal). Cached; deterministic.
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

/**
 * The repeat unit of a marquee: the trimmed text plus a joiner, so repeats never
 * run together. A text that already ends with a full-width separator is used as
 * is; a half-width one gets a space; otherwise "・" (CJK faces) or " • " (Latin).
 */
export function marqueeUnitText(text: string, face: MotionFontSelector): string {
  const trimmed = text.trim();
  const last = [...trimmed].pop() ?? "";
  if (FULL_WIDTH_SEPARATORS.has(last)) return trimmed;
  if (SEPARATORS.has(last)) return `${trimmed} `;
  return face.font === "latin" ? `${trimmed} • ` : `${trimmed}・`;
}

export interface MarqueeUnit {
  readonly text: string;
  readonly size: number;
  readonly tracking: number;
  /** Distance from one repeat to the next: the pen advance plus the tracking between repeats. */
  readonly period: number;
  /** Outlines in unit coordinates (pen start of the repeat on the baseline): text glyphs and separator glyphs apart. */
  readonly textPathD: string;
  readonly separatorPathD: string;
  /** Ink box of the whole repeat (unit coordinates). */
  readonly ink: GlyphBox;
  /** Ink centre x of the first drawn glyph (unit coordinates). */
  readonly firstCenter: number;
  /** Drawn (non-blank) glyphs per repeat. */
  readonly glyphCount: number;
}

const unitCache = new Map<string, MarqueeUnit>();

/** Lay out one marquee repeat once (cached): outlines are split into text and separators so they can take different colours. */
export function marqueeUnit(text: string, face: MotionFontSelector, size: number, tracking = 0): MarqueeUnit {
  const line = layoutLine(text, { ...face, size, tracking });
  const key = `${line.faceId}\u0000${line.size}\u0000${line.tracking}\u0000${text}`;
  const hit = unitCache.get(key);
  if (hit) return hit;
  let textPathD = "", separatorPathD = "", glyphCount = 0, firstCenter = Number.NaN;
  for (const glyph of line.glyphs) {
    if (glyph.whitespace || !glyph.pathD || !glyph.bbox) continue;
    const placed = translatePathD(glyph.pathD, glyph.x, 0);
    if (SEPARATORS.has(glyph.char)) separatorPathD += placed; else textPathD += placed;
    if (Number.isNaN(firstCenter)) firstCenter = glyph.x + (glyph.bbox.x0 + glyph.bbox.x1) / 2;
    glyphCount += 1;
  }
  const ink = line.inkBox ?? { x0: 0, y0: -0.8 * line.size, x1: Math.max(line.width, 1), y1: 0 };
  const unit: MarqueeUnit = Object.freeze({
    text, size: line.size, tracking: line.tracking, period: Math.max(1, line.width + line.tracking * line.size),
    textPathD: compactPathD(textPathD), separatorPathD: compactPathD(separatorPathD), ink: Object.freeze({ ...ink }),
    firstCenter: Number.isNaN(firstCenter) ? line.width / 2 : firstCenter, glyphCount,
  });
  unitCache.set(key, unit);
  if (unitCache.size > 96) unitCache.delete(unitCache.keys().next().value!);
  return unit;
}

/** Fractional part in [0, 1). */
export function fraction(value: number): number {
  return value - Math.floor(value);
}

/**
 * Pen x of every repeat that reaches [from, to] (strip coordinates), for a strip
 * scrolled by `travel` repeats: repeat 0 starts at `anchor` when travel is a whole
 * number. Positive travel moves the content toward −x. Only the fractional part of
 * travel is used, so a whole-repeat advance gives the same list (seamless loops).
 */
export function marqueeRepeatStarts(unit: MarqueeUnit, anchor: number, travel: number, from: number, to: number): number[] {
  const start = anchor - fraction(travel) * unit.period;
  const first = Math.ceil((from - unit.ink.x1 - start) / unit.period - 1e-9);
  const last = Math.floor((to - unit.ink.x0 - start) / unit.period + 1e-9);
  const starts: number[] = [];
  for (let repeat = first; repeat <= last; repeat += 1) starts.push(start + repeat * unit.period);
  return starts;
}

/** One strip of repeats on a baseline (strip coordinates): text in `color`, separators in `separatorColor`. */
export function marqueeStrip(unit: MarqueeUnit, starts: readonly number[], baseline: number, color: string, separatorColor: string): string[] {
  return starts.map(x => g({ transform: tf.translate(x, baseline) },
    path(unit.textPathD, { fill: color }), unit.separatorPathD && path(unit.separatorPathD, { fill: separatorColor })));
}

/** The first candidate with at least `minimum` contrast against the backdrop, else the most contrasting one. */
export function pickReadable(backdrop: string, candidates: readonly string[], minimum = 2): string {
  for (const candidate of candidates) if (contrastRatio(candidate, backdrop) >= minimum) return candidate;
  return mostContrasting(backdrop, candidates);
}

/** A colour that stays visible against the backdrop: `preferred` unless it nearly vanishes there (contrast < 1.5). */
export function distinctFrom(backdrop: string, preferred: string, fallbacks: readonly string[]): string {
  return contrastRatio(preferred, backdrop) >= 1.5 ? preferred : pickReadable(backdrop, fallbacks, 1.5);
}

/** Latin role when every character has a Bebas Neue glyph, else the display face at `fallbackWeight`. */
export function latinOrDisplay(text: string, fallbackWeight: number): MotionFontSelector {
  try {
    assertMotionText(text, { font: "latin" });
    return { font: "latin" };
  } catch (error) {
    if (error instanceof MotionLibraryGlyphError) return { font: "display", weight: fallbackWeight };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// T09
// ---------------------------------------------------------------------------

export interface HugeTextScrollPlan {
  readonly giant: MarqueeUnit;
  readonly giantBaseline: number;
  /** Pen x of repeat 0 at loop phase 0 (puts the first character's ink centre on the frame centre). */
  readonly giantAnchor: number;
  readonly giantColor: string;
  readonly giantSeparatorColor: string;
  /** 緩急 swing (fraction of the mean speed) and swings per loop. */
  readonly easeDepth: number;
  readonly swings: number;
  readonly ticker: MarqueeUnit;
  readonly tickerBaseline: number;
  readonly tickerRepeatsPerLoop: number;
  readonly band: { readonly y0: number; readonly y1: number; readonly color: string };
  readonly tickerColor: string;
}

export function hugeTextScrollPlan(params: TextMotionParams, size: MotionFrameSize): HugeTextScrollPlan {
  const short = Math.min(size.width, size.height);
  const backdrop = textBackdrop(params);
  const palette = params.palette;
  const giantColor = textOnBackground(palette, backdrop);
  const giantFace = textFace(params.font, 900);
  const giantText = marqueeUnitText(params.lines[0], giantFace);

  // Size: 1.2× the frame height in ink, capped by the cell width (portrait) and by the mean speed (long lines).
  const probe = marqueeUnit(giantText, giantFace, 100, GIANT_TRACKING);
  const probeInk = Math.max(1, probe.ink.y1 - probe.ink.y0);
  const probeCell = probe.period / Math.max(1, probe.glyphCount);
  const sizeByHeight = (GIANT_INK_HEIGHT * size.height / probeInk) * 100;
  const sizeByCell = (GIANT_CELL_MAX * size.width / probeCell) * 100;
  const sizeBySpeed = (MAX_MEAN_SPEED * size.width * T09_LOOP_SECONDS / probe.period) * 100;
  const giant = marqueeUnit(giantText, giantFace, Math.min(sizeByHeight, sizeByCell, sizeBySpeed, 8000), GIANT_TRACKING);
  const giantInk = giant.ink.y1 - giant.ink.y0;

  // Ticker: lines 2–4 joined (line 1 when alone), Bebas Neue when it can draw every character.
  const tickerSource = params.lines.length > 1 ? params.lines.slice(1).map(line => line.trim()).join("  •  ") : params.lines[0];
  const tickerFace = latinOrDisplay(`${tickerSource} • `, 700);
  const tickerText = marqueeUnitText(tickerSource, tickerFace);
  const tickerTracking = tickerFace.font === "latin" ? TICKER_LATIN_TRACKING : 0;
  const tickerProbe = marqueeUnit(tickerText, tickerFace, 100, tickerTracking);
  const tickerSize = (TICKER_INK * short / Math.max(1, tickerProbe.ink.y1 - tickerProbe.ink.y0)) * 100;
  const ticker = marqueeUnit(tickerText, tickerFace, tickerSize, tickerTracking);
  const tickerInk = ticker.ink.y1 - ticker.ink.y0;
  const bandHeight = TICKER_BAND * tickerInk;
  const safeBottom = size.height * 0.95, safeTop = size.height * 0.05;

  let giantBaseline: number, bandTop: number;
  if (giantInk + STACK_GAP * short + bandHeight <= size.height * 0.9) {
    // Portrait: giant line and ticker band stacked and centred as a group.
    const groupHeight = giantInk + STACK_GAP * short + bandHeight;
    const top = (size.height - groupHeight) / 2;
    giantBaseline = top - giant.ink.y0;
    bandTop = top + giantInk + STACK_GAP * short;
  } else {
    // Landscape: the giant line is centred and bleeds; the band sits on its cropped foot, on the safe bottom.
    giantBaseline = size.height / 2 - (giant.ink.y0 + giant.ink.y1) / 2;
    bandTop = safeBottom - bandHeight;
  }
  bandTop = Math.min(Math.max(bandTop, safeTop), safeBottom - bandHeight);
  const bandColor = distinctFrom(backdrop, palette.accent, [giantColor, palette.paper, palette.ink]);
  const tickerColor = textOnBackground(palette, bandColor);
  const tickerBaseline = bandTop + bandHeight / 2 - (ticker.ink.y0 + ticker.ink.y1) / 2;
  const tickerRepeatsPerLoop = Math.max(1, Math.round((TICKER_SPEED * short * T09_LOOP_SECONDS) / ticker.period));

  return {
    giant, giantBaseline, giantAnchor: size.width / 2 - giant.firstCenter, giantColor,
    giantSeparatorColor: secondaryTone(palette, backdrop),
    easeDepth: Math.min(EASE_DEPTH_MAX, EASE_DEPTH * energyProfile(params.energy).amplitude ** 0.6),
    swings: Math.max(1, Math.round(T09_LOOP_SECONDS / SWING_SECONDS)),
    ticker, tickerBaseline, tickerRepeatsPerLoop,
    band: { y0: bandTop, y1: bandTop + bandHeight, color: bandColor }, tickerColor,
  };
}

/**
 * 緩急 travel of the giant line in repeats at loop phase u (0 at u = 0, 1 at u = 1):
 * the integral of 1 + a·sin(2π m u − π/2), slowest at u = 0.
 */
export function hugeScrollTravel(u: number, depth: number, swings: number): number {
  const phase = -Math.PI / 2;
  return u - (depth / (2 * Math.PI * swings)) * (Math.cos(2 * Math.PI * swings * u + phase) - Math.cos(phase));
}

/** Instantaneous giant speed in repeats per loop (the derivative of hugeScrollTravel). */
export function hugeScrollRate(u: number, depth: number, swings: number): number {
  return 1 + depth * Math.sin(2 * Math.PI * swings * u - Math.PI / 2);
}

function smearFilter(doc: SvgDocument, sigma: number, y0: number, y1: number, width: number): string {
  const pad = 3 * sigma;
  return doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: [sigma, 0] }),
    { x: -pad, y: y0, width: width + 2 * pad, height: Math.max(1, y1 - y0) });
}

export const T09_hugeTextScroll = defineTextMotion(ID, (params, t, size) => {
  const plan = hugeTextScrollPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T09_LOOP_SECONDS);

  const giant = plan.giant;
  const travel = hugeScrollTravel(u, plan.easeDepth, plan.swings);
  const starts = marqueeRepeatStarts(giant, plan.giantAnchor, travel, 0, size.width);
  const strip = marqueeStrip(giant, starts, plan.giantBaseline, plan.giantColor, plan.giantSeparatorColor);
  const speed = (giant.period * hugeScrollRate(u, plan.easeDepth, plan.swings)) / T09_LOOP_SECONDS;
  const sigma = Math.min(SMEAR_MAX * giant.size, speed * SMEAR);
  const y0 = Math.max(0, plan.giantBaseline + giant.ink.y0 - 2), y1 = Math.min(size.height, plan.giantBaseline + giant.ink.y1 + 2);
  const giantLayer = sigma >= SMEAR_MIN ? g({ filter: smearFilter(doc, sigma, y0, y1, size.width) }, strip) : g(undefined, strip);

  // Ticker: the other way (content moves toward +x), constant speed, whole repeats per loop.
  const ticker = plan.ticker;
  const tickerStarts = marqueeRepeatStarts(ticker, 0, -plan.tickerRepeatsPerLoop * u, 0, size.width);
  const band = rect(-1, plan.band.y0, size.width + 2, plan.band.y1 - plan.band.y0, { fill: plan.band.color });
  const tickerLayer = g(undefined, band, marqueeStrip(ticker, tickerStarts, plan.tickerBaseline, plan.tickerColor, plan.tickerColor));

  return doc.render(giantLayer, tickerLayer);
}, { revision: REVISION });
