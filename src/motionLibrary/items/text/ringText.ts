import { fmt } from "../../svg/document";
import { circleSampler, layoutLine, motionFaceMetrics, translatePathD, type MotionFontSelector } from "../../svg/glyphs";
import { placementMatrix, transformPathD } from "../../svg/pathOps";

/**
 * Ring text (DESIGN §8): characters standing upright on a circle (glyph tops face
 * outward when reading clockwise), evenly spaced, the text repeated with a
 * separator (default 「・」) to complete the circumference. Users: T21 Ring Text
 * Tunnel, T56 Circle Text, T68 Rotating Words.
 *
 * The layout is static and cached: animate it with a group transform instead of
 * re-laying it out each frame — rotate(angle cx cy) to spin (T56), scale about
 * the centre to expand a ring (T21). Each glyph's em box is centred on the circle,
 * so `radius` is the text's centre line.
 *
 * Spacing: repeats = max(1, floor(C / (unit width + per-character minGap))), then
 * the leftover arc is shared equally between every pair of neighbours (closing the
 * ring included), so the ring has no seam. Kerning is off on rings.
 *
 * Usage (T56 outer ring, accent, +45°/s):
 *   const ring = layoutRingText({ text: line, font: "display", weight: 700, size: s, radius: 0.42 * short, cx, cy });
 *   g({ transform: tf.rotate(45 * t, cx, cy) },
 *     path(ringGlyphsPathD(ring.glyphs), { fill: palette.accent }))
 * or per glyph (alternating colours, T68): ring.glyphs.map(g => path(g.pathD, { transform: g.transform, fill: g.index % 2 ? a : b })).
 */

export interface RingTextOptions extends MotionFontSelector {
  /** One repeat unit; the separator is appended unless the text already ends with it. */
  readonly text: string;
  /** Font size in px. */
  readonly size: number;
  /** Radius of the text's centre line in px. */
  readonly radius: number;
  readonly cx: number;
  readonly cy: number;
  /** Where the first character's centre sits: degrees clockwise from the top (static offset; animate with a group rotate). */
  readonly rotationDegrees?: number;
  /** Reading direction: clockwise (default, tops outward) or counter-clockwise (tops inward). */
  readonly clockwise?: boolean;
  /** Filler between repeats (default 「・」; "" for none). */
  readonly separator?: string;
  /** Minimum extra space per character in em (default 0.1). */
  readonly minGap?: number;
}

export interface RingGlyph {
  readonly char: string;
  /** Position on the ring (0 = first character after the start angle). */
  readonly index: number;
  /** Position within the repeat unit, and which repeat. */
  readonly unitIndex: number;
  readonly repeat: number;
  readonly isSeparator: boolean;
  /** Arc length of the glyph centre from the start angle, in px. */
  readonly distance: number;
  /** Centre on the circle and tangent angle (degrees). */
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  /** Outline centred on (0, 0) (advance centre, em-box middle); place with `transform`. "" for blanks. */
  readonly pathD: string;
  readonly transform: string;
}

export interface RingTextLayout {
  readonly glyphs: readonly RingGlyph[];
  readonly unit: string;
  readonly repeats: number;
  readonly circumference: number;
  /** Space added between neighbouring glyphs, px. */
  readonly gap: number;
  readonly size: number;
  readonly radius: number;
}

const CACHE_LIMIT = 64;
const cache = new Map<string, RingTextLayout>();

export function layoutRingText(options: RingTextOptions): RingTextLayout {
  const { text, size, radius, cx, cy } = options;
  if (typeof text !== "string" || !text) throw new Error("layoutRingText needs text");
  if (!(size > 0) || !(radius > 0) || ![cx, cy, radius, size].every(Number.isFinite)) throw new Error("layoutRingText needs a positive size and radius");
  const separator = options.separator ?? "・", minGap = options.minGap ?? 0.1, clockwise = options.clockwise ?? true;
  const rotation = options.rotationDegrees ?? 0;
  if (!(minGap >= 0) || !Number.isFinite(rotation)) throw new Error("layoutRingText needs minGap ≥ 0 and a finite rotation");
  const key = JSON.stringify([text, options.font, options.weight ?? null, fmt(size), fmt(radius), fmt(cx), fmt(cy), fmt(rotation), clockwise, separator, fmt(minGap)]);
  const hit = cache.get(key);
  if (hit) return hit;

  const face = { font: options.font, weight: options.weight };
  const unit = separator && !text.endsWith(separator) ? text + separator : text;
  const unitChars = [...unit];
  // The unit always ends with the separator (when there is one): its characters are the filler.
  const firstSeparatorIndex = separator ? unitChars.length - [...separator].length : unitChars.length;
  const circumference = 2 * Math.PI * radius;
  const unitLine = layoutLine(unit, { ...face, size, kerning: false });
  const repeats = Math.max(1, Math.floor(circumference / (unitLine.width + unitChars.length * minGap * size)));
  const full = layoutLine(unit.repeat(repeats), { ...face, size, kerning: false });
  const count = full.glyphs.length;
  const gap = (circumference - full.width) / count;
  const metrics = motionFaceMetrics(face, size);
  const baselineShift = -(metrics.emTop + metrics.emBottom) / 2;
  const sample = circleSampler(cx, cy, radius, -90 + rotation, clockwise);
  const firstHalf = full.glyphs[0].advance / 2;
  let pen = 0;
  const glyphs: RingGlyph[] = full.glyphs.map((glyph, index) => {
    const distance = pen + glyph.advance / 2 - firstHalf;
    pen += glyph.advance + gap;
    const point = sample(distance);
    const unitIndex = index % unitChars.length;
    return Object.freeze({
      char: glyph.char, index, unitIndex, repeat: Math.floor(index / unitChars.length),
      isSeparator: unitIndex >= firstSeparatorIndex,
      distance, x: point.x, y: point.y, angle: point.angle,
      pathD: glyph.whitespace ? "" : translatePathD(glyph.pathD, -glyph.advance / 2, baselineShift),
      transform: `translate(${fmt(point.x)} ${fmt(point.y)}) rotate(${fmt(point.angle)})`,
    });
  });
  const layout: RingTextLayout = Object.freeze({ glyphs: Object.freeze(glyphs), unit, repeats, circumference, gap, size, radius });
  cache.set(key, layout);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return layout;
}

/** The given ring glyphs merged into one absolute path (ring coordinates), e.g. one <path> per colour. */
export function ringGlyphsPathD(glyphs: readonly RingGlyph[]): string {
  let d = "";
  for (const glyph of glyphs) if (glyph.pathD) d += transformPathD(glyph.pathD, placementMatrix(glyph.x, glyph.y, glyph.angle));
  return d;
}
