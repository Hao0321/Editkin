import { ellipse, fmt, g, line, path, tf } from "../../svg/document";
import { energyProfile, loopPhase, quadOut } from "../../svg/easing";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, frameUnit, heroTextBox, layoutFittedText, readableColor, secondaryTone, textBackdrop, textFace,
  textOnBackground, titleSafeBox,
} from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T57 Water Reflection (水面倒影), PHYSICS: the word sits on a waterline (the readable light
 * tone, 1.5 px at 1080 units, 50%) across the title-safe width. Below it, a mirrored copy in
 * the second tone (violet on the dark card, ART_DIRECTION §0) fades from 70% at the line to
 * nothing at 0.9 × the glyph height. The reflection is cut into horizontal slices 3% of the
 * glyph height tall (pixel-aligned, so neighbouring slices meet without seams); each slice is
 * shifted sideways by 2.5% of the glyph height × sin(k·y − ωt), growing with depth, a ripple
 * running down and away from the line. Slicing is geometry: the mirrored outline is clipped
 * into bands once and cached (no feTurbulence / feDisplacementMap, which librsvg renders at
 * about 1.7 s a frame). Every 0.8 s a small ripple ellipse (40%) opens on the waterline at a
 * seeded spot under the word and fades within 0.7 s.
 *
 * The word and its reflection are sized together (heroTextBox, tight displayTracking) and
 * centred in the 5% title-safe box. A seamless 2.4 s loop (catalog loopSeconds): the ripple
 * runs two waves per loop and the three ripple rings repeat each loop. Energy scales the
 * ripple amplitude.
 */

const ID = "T57";
const REVISION = 1;
export const T57_LOOP_SECONDS = 2.4;
/** Reflection depth (× glyph height), its opacity at the line, slice height and sway (× glyph height). */
export const T57_DEPTH = 0.9, T57_TOP_OPACITY = 0.7, T57_SLICE = 0.03, T57_SWAY = 0.025;
/** Ripple wave: waves per loop, wavelength (× glyph height); sway grows from SWAY_NEAR at the line to 1 at the bottom. */
const WAVES = 2, WAVELENGTH = 0.34, SWAY_NEAR = 0.4;
/** Waterline (px at 1080 units) and its opacity; ripple rings: interval, life, opacity, width (× glyph height), stroke (px). */
const WATERLINE = 1.5, WATERLINE_OPACITY = 0.5;
const RING_EVERY = 0.8, RING_LIFE = 0.7, RING_OPACITY = 0.4, RING_WIDTH = 0.42, RING_STROKE = 2.2;
const LINE_HEIGHT = 1.04;

export interface ReflectionBand {
  /** Band top and bottom (frame px, integers below the waterline). */
  readonly y0: number;
  readonly y1: number;
  /** The mirrored outline clipped to the band (absolute path data, frame px). */
  readonly pathD: string;
  readonly opacity: number;
}

export interface ReflectionLayout {
  readonly wordPathD: string;
  readonly wordTransform: { readonly dx: number; readonly dy: number };
  /** Word ink box (frame px) and the tallest glyph's ink height. */
  readonly box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  readonly glyphHeight: number;
  readonly waterline: number;
  readonly bands: readonly ReflectionBand[];
  readonly sway: number;
  readonly colors: { readonly word: string; readonly reflection: string; readonly line: string };
  readonly lineX0: number;
  readonly lineX1: number;
  readonly unit: number;
  readonly rings: ReadonlyArray<{ readonly start: number; readonly x: number }>;
}

/** Clip a closed polygon to the band y0 ≤ y ≤ y1 (Sutherland–Hodgman on two horizontal half-planes). */
function clipToBand(points: readonly FlatPoint[], y0: number, y1: number): FlatPoint[] {
  const clip = (input: readonly FlatPoint[], inside: (p: FlatPoint) => boolean, y: number): FlatPoint[] => {
    const output: FlatPoint[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index], previous = input[(index + input.length - 1) % input.length];
      const cin = inside(current), pin = inside(previous);
      if (cin !== pin) {
        const t = (y - previous[1]) / (current[1] - previous[1]);
        output.push([previous[0] + (current[0] - previous[0]) * t, y]);
      }
      if (cin) output.push(current);
    }
    return output;
  };
  const upper = clip(points, p => p[1] >= y0, y0);
  return upper.length >= 3 ? clip(upper, p => p[1] <= y1, y1) : [];
}

const bandCache = new Map<string, ReflectionBand[]>();

/** The mirrored outline (contours of the word reflected about the waterline) cut into pixel-aligned bands; cached. */
function reflectionBands(blockPathD: string, dx: number, dy: number, waterline: number, glyphHeight: number): ReflectionBand[] {
  const key = `${dx}\u0000${dy}\u0000${waterline}\u0000${glyphHeight}\u0000${blockPathD}`;
  const hit = bandCache.get(key);
  if (hit) return hit;
  const contours = flattenPathD(blockPathD, { segmentLength: Math.max(1.5, glyphHeight / 120) })
    .map(contour => contour.map(([x, y]) => [x + dx, 2 * waterline - (y + dy)] as FlatPoint));
  const slice = Math.max(2, Math.round(T57_SLICE * glyphHeight)), depth = T57_DEPTH * glyphHeight;
  const top = Math.round(waterline);
  const bands: ReflectionBand[] = [];
  for (let y0 = top; y0 < waterline + depth; y0 += slice) {
    const y1 = y0 + slice;
    let d = "";
    for (const contour of contours) {
      const clipped = clipToBand(contour, y0, y1);
      if (clipped.length >= 3) d += `M${clipped.map(([x, y]) => `${fmt(x, 1)} ${fmt(y, 1)}`).join("L")}Z`;
    }
    // Opacity falls linearly from the line to nothing at the reflection depth (sampled at the band centre).
    const opacity = T57_TOP_OPACITY * Math.max(0, 1 - ((y0 + y1) / 2 - waterline) / depth);
    if (d && opacity > 0.01) bands.push({ y0, y1, pathD: d, opacity });
  }
  bandCache.set(key, bands);
  if (bandCache.size > 24) bandCache.delete(bandCache.keys().next().value!);
  return bands;
}

export function reflectionLayout(params: TextMotionParams, size: MotionFrameSize): ReflectionLayout {
  const safe = titleSafeBox(size);
  // Word plus reflection share the safe height: the block may take at most 1 / (1 + depth) of 90% of it.
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { heightFill: Math.min(0.62, 0.9 / (1 + T57_DEPTH)) }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  let glyphHeight = 0;
  for (const placed of text.block.lines) for (const glyph of placed.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  const inkHeight = text.ink.y1 - text.ink.y0;
  // The waterline under the ink; the span from the word's top to the reflection's end is centred in the safe box.
  const waterline = Math.round(safe.cy + (inkHeight - T57_DEPTH * glyphHeight) / 2);
  const dx = safe.cx - (text.ink.x0 + text.ink.x1) / 2, dy = waterline - text.ink.y1;
  const backdrop = textBackdrop(params);
  const rng = createSeededRng(ID, params.seed, "rings");
  const box = { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy };
  const rings = Array.from({ length: Math.round(T57_LOOP_SECONDS / RING_EVERY) }, (_, index) => ({
    start: index * RING_EVERY, x: box.x0 + (box.x1 - box.x0) * (0.12 + 0.76 * rng.next()),
  }));
  return {
    wordPathD: compactPathD(text.block.pathD), wordTransform: { dx, dy }, box, glyphHeight, waterline,
    bands: reflectionBands(text.block.pathD, dx, dy, waterline, glyphHeight),
    sway: T57_SWAY * glyphHeight * Math.min(1.6, energyProfile(params.energy).amplitude),
    colors: {
      word: textOnBackground(params.palette, backdrop), reflection: secondaryTone(params.palette, backdrop),
      line: readableColor(backdrop, [params.palette.paper, textOnBackground(params.palette, backdrop)]),
    },
    lineX0: safe.x0, lineX1: safe.x1, unit: frameUnit(size), rings,
  };
}

/** Sideways shift (px) of a slice centred at depth y below the waterline at loop phase (0..1). */
export function reflectionSway(layout: ReflectionLayout, y: number, phase: number): number {
  const depth = Math.max(0, y) / (T57_DEPTH * layout.glyphHeight);
  const amplitude = layout.sway * (SWAY_NEAR + (1 - SWAY_NEAR) * Math.min(1, depth));
  return amplitude * Math.sin((2 * Math.PI * y) / (WAVELENGTH * layout.glyphHeight) - 2 * Math.PI * WAVES * phase);
}

export const T57_waterReflection = defineTextMotion(ID, (params, t, size) => {
  const layout = reflectionLayout(params, size);
  const doc = createTextDocument(size, params);
  const phase = loopPhase(t, T57_LOOP_SECONDS);
  const bands = layout.bands.map(band => {
    const shift = reflectionSway(layout, (band.y0 + band.y1) / 2 - layout.waterline, phase);
    return path(band.pathD, { "fill-opacity": band.opacity, transform: Math.abs(shift) >= 0.05 ? tf.translate(shift, 0) : undefined });
  });
  const u = phase * T57_LOOP_SECONDS;
  const rings = layout.rings.map(ring => {
    const age = u - ring.start;
    if (age < 0 || age >= RING_LIFE) return "";
    const p = age / RING_LIFE, rx = RING_WIDTH * layout.glyphHeight * (0.15 + 0.85 * quadOut(p));
    return ellipse(ring.x, layout.waterline, rx, rx * 0.16, {
      fill: "none", stroke: layout.colors.line, "stroke-width": RING_STROKE * layout.unit, opacity: RING_OPACITY * (1 - p),
    });
  });
  const word = path(layout.wordPathD, { fill: layout.colors.word, transform: tf.translate(layout.wordTransform.dx, layout.wordTransform.dy) });
  return doc.render(
    g({ fill: layout.colors.reflection }, bands),
    line(layout.lineX0, layout.waterline, layout.lineX1, layout.waterline, { stroke: layout.colors.line, "stroke-width": WATERLINE * layout.unit, opacity: WATERLINE_OPACITY }),
    g(undefined, rings), word,
  );
}, { revision: REVISION });

