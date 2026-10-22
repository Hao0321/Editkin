import { g, path, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase, smoothstep } from "../../svg/easing";
import { layoutLine, type MotionFontSelector } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, secondaryTone, textBackdrop, textFace, textOnBackground } from "../shared";
import { layoutRingText, ringGlyphsPathD, type RingTextLayout } from "./ringText";

/**
 * T21 Ring Text Tunnel (リングトンネル), DEPTH: concentric rings of text fly
 * toward the viewer. Six rings of the line (repeated with 「・」 to close the
 * circle, glyph tops outward) sit at radii a constant ratio (1.72) apart; every
 * ring's radius grows exponentially with its depth phase s (r = rMin · G^s), so
 * the tunnel streams outward at a constant perceived speed, and a ring that has
 * passed the frame corners respawns, fogged out, at the vanishing point. The
 * text grows with its ring (perspective): its em is about 0.32 × the radius, the
 * exact value chosen so the repeats close the circle at a tight gap with
 * no seam (fitRing). The outermost rings carry huge partial glyphs that bleed
 * off the frame edges (the effect bleeds by definition, ART_DIRECTION §2). Rings
 * alternate the readable text colour and the second tone (cream and aqua on the
 * dark card, ART_DIRECTION §0) and alternate their spin direction; a new ring fades
 * in out of the vanishing point (depth fog).
 *
 * The ring generator (fitRing + textRingPathD + drawTextRing: one cached merged
 * outline per ring, animated with a group transform, never re-laid out per frame)
 * is shared with T56 Circle Text, which is this tunnel without the expansion.
 *
 * A seamless 2 s loop (catalog loopSeconds): every ring's depth phase is a
 * function of the loop phase and its index (s = frac(u + k/6)), and its spin is a
 * function of s, so frame 0 equals the frame at 2 s. Each ring travels the whole
 * tunnel once per loop (a new ring every 1/3 s). Energy scales the spin, never
 * the period. Several lines alternate between rings.
 */

const ID = "T21";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T21_LOOP_SECONDS = 2;
/** Rings in flight (even, so the colours and spins alternate across the respawn too). */
export const T21_RING_COUNT = 6;
/** Target and largest glyph em as a fraction of the ring radius (the exact value closes the ring with whole repeats). */
export const T21_EM_RATIO = 0.32;
export const T21_EM_RATIO_MAX = 0.36;
/** Radius ratio between neighbouring rings (the glyph bands of neighbours would touch at about 1.37). */
export const T21_RING_RATIO = 1.72;
/** Spin per pass (degrees, alternating direction), scaled by energy. */
export const T21_SPIN = 100;
/** Depth fog: a ring fades in over the first part of its pass. */
const FADE_IN = 0.3;
/** Reference radius of the cached ring outline (px); rings are drawn by scaling it. */
const REFERENCE_RADIUS = 400;
const MIN_OPACITY = 0.002;

// ---------------------------------------------------------------------------
// Ring generator (shared with T56)
// ---------------------------------------------------------------------------

/** Smallest space between neighbouring ring glyphs on the centre line, in em (tight, poster-like). */
export const RING_MIN_GAP = 0.06;
/** A CJK glyph's ink is about 0.92 em wide and tall (Noto Sans TC 900), centred on the em-box middle. */
const RING_INK = 0.92;
const RING_SEPARATOR = "・";

/**
 * Centre-line gap (em) that keeps neighbouring glyphs apart at their inner edge.
 * The inner edge of a ring band (radius − 0.46 em) has a shorter circumference
 * than the centre line, so a tight ring (big glyphs on a small radius) needs more
 * space on the centre line: at least 0.06 em, and enough for 0.04 em of air
 * between the inner corners of neighbours.
 */
export function ringGapEm(radius: number, size: number): number {
  const inner = radius - 0.5 * RING_INK * size;
  if (!(inner > 0)) return 1;
  return Math.max(RING_MIN_GAP, (RING_INK * radius) / inner - 1 + 0.04);
}

export interface RingFit {
  /** Glyph em in px. */
  readonly size: number;
  /** Centre-line gap per glyph in em (pass it to textRingPathD). */
  readonly minGap: number;
}

export interface TextRingOptions {
  /** One repeat unit; 「・」 is appended unless it already ends with the separator. */
  readonly text: string;
  readonly face: MotionFontSelector;
  /** Glyph em in px at `radius`. */
  readonly size: number;
  /** Radius of the text's centre line in px. */
  readonly radius: number;
  /** Minimum gap per glyph in em (default RING_MIN_GAP); fitRing gives the one that closes the ring. */
  readonly minGap?: number;
}

export interface TextRing {
  readonly layout: RingTextLayout;
  /** Every glyph merged into one outline, centred on (0, 0) with the first glyph at the top. */
  readonly pathD: string;
  readonly radius: number;
  readonly size: number;
}

const ringPathCache = new WeakMap<RingTextLayout, string>();
const unitCache = new Map<string, { readonly advance: number; readonly characters: number }>();

/** Advance of one repeat unit (text + 「・」) in em, and its character count. */
function ringUnit(text: string, face: MotionFontSelector): { readonly advance: number; readonly characters: number } {
  const key = `${face.font}\u0000${face.weight ?? ""}\u0000${text}`;
  const hit = unitCache.get(key);
  if (hit) return hit;
  const unit = text.endsWith(RING_SEPARATOR) ? text : text + RING_SEPARATOR;
  const reference = 100;
  const value = { advance: layoutLine(unit, { ...face, size: reference, kerning: false }).width / reference, characters: [...unit].length };
  unitCache.set(key, value);
  if (unitCache.size > 64) unitCache.delete(unitCache.keys().next().value!);
  return value;
}

/**
 * The ring glyph size (px) and gap that close a circle of `radius` with a whole
 * number of repeats: the gap is ringGapEm at the target size; of the sizes
 * C / (n · unit), fitRing takes the one nearest `target` that does not exceed `max`
 * (a hair under the exact value, so layoutRingText finds the same n repeats and the
 * leftover arc is negligible).
 */
export function fitRing(text: string, face: MotionFontSelector, radius: number, target: number, max: number): RingFit {
  if (!(radius > 0) || !(target > 0) || !(max >= target)) throw new Error("fitRing needs radius > 0 and 0 < target ≤ max");
  const minGap = ringGapEm(radius, target);
  const unit = ringUnit(text, face);
  const perRepeat = (2 * Math.PI * radius) / (unit.advance + unit.characters * minGap);
  let best = 0;
  for (let repeats = 1; repeats <= 512; repeats += 1) {
    const size = (perRepeat / repeats) * 0.998;
    if (size > max) continue;
    if (!best || Math.abs(size - target) < Math.abs(best - target)) best = size;
    if (size < target) break;
  }
  return { size: best || max, minGap };
}

/** Lay a line out around a circle centred on (0, 0) (layoutRingText) and merge it into one outline (cached). */
export function textRingPathD(options: TextRingOptions): TextRing {
  const layout = layoutRingText({ text: options.text, font: options.face.font, weight: options.face.weight, size: options.size, radius: options.radius,
    cx: 0, cy: 0, separator: RING_SEPARATOR, minGap: options.minGap ?? RING_MIN_GAP });
  let pathD = ringPathCache.get(layout);
  if (pathD === undefined) {
    pathD = ringGlyphsPathD(layout.glyphs);
    ringPathCache.set(layout, pathD);
  }
  return { layout, pathD, radius: options.radius, size: options.size };
}

export interface TextRingPlacement {
  readonly cx: number;
  readonly cy: number;
  /** Clockwise degrees about the ring centre. */
  readonly rotation: number;
  /** Uniform scale about the ring centre (1 = the ring's own radius). */
  readonly scale?: number;
  readonly fill: string;
  readonly opacity?: number;
}

/** One ring as a single <path>: translate(cx cy) rotate(r) scale(s) on the cached outline. */
export function drawTextRing(ring: TextRing, at: TextRingPlacement): string {
  const scale = at.scale ?? 1, opacity = at.opacity ?? 1;
  if (opacity <= MIN_OPACITY || !(scale > 0)) return "";
  return path(ring.pathD, {
    fill: at.fill,
    opacity: opacity < 1 ? opacity : undefined,
    transform: transform(tf.translate(at.cx, at.cy), at.rotation ? tf.rotate(at.rotation) : false, scale !== 1 ? tf.scale(scale) : false),
  });
}

// ---------------------------------------------------------------------------
// T21
// ---------------------------------------------------------------------------

export interface TunnelRing {
  readonly index: number;
  /** Depth phase 0 (vanishing point) … 1 (past the frame corners). */
  readonly s: number;
  readonly radius: number;
  /** Glyph em in px. */
  readonly size: number;
  readonly rotation: number;
  readonly opacity: number;
  readonly color: string;
  readonly text: string;
}

export interface RingTunnelPlan {
  readonly cx: number;
  readonly cy: number;
  /** Radius at s = 0 and s = 1. */
  readonly minRadius: number;
  readonly maxRadius: number;
  /** Rings ordered far (small) to near (large): the paint order. */
  readonly rings: readonly TunnelRing[];
}

/** A line's ring at the reference radius: closes with whole repeats (fitRing) at an em of about T21_EM_RATIO × the radius. */
export function tunnelRing(text: string, face: MotionFontSelector): TextRing {
  const fit = fitRing(text, face, REFERENCE_RADIUS, T21_EM_RATIO * REFERENCE_RADIUS, T21_EM_RATIO_MAX * REFERENCE_RADIUS);
  return textRingPathD({ text, face, size: fit.size, radius: REFERENCE_RADIUS, minGap: fit.minGap });
}

/** The tunnel at time t: the radius span reaches past the frame corners, so a ring leaves the frame before it respawns. */
export function ringTunnelPlan(params: TextMotionParams, size: MotionFrameSize, t: number): RingTunnelPlan {
  const cx = size.width / 2, cy = size.height / 2, halfDiagonal = Math.hypot(cx, cy);
  // At s = 1 even the inner edge of the largest glyph band (radius − 0.5 em) is past the frame corners.
  const maxRadius = (halfDiagonal / (1 - 0.5 * T21_EM_RATIO_MAX)) * 1.02;
  const growth = T21_RING_RATIO ** T21_RING_COUNT;
  const minRadius = maxRadius / growth;
  const backdrop = textBackdrop(params);
  const colors = [textOnBackground(params.palette, backdrop), secondaryTone(params.palette, backdrop)];
  const face = textFace(params.font, 900);
  const spin = T21_SPIN * energyProfile(params.energy).amplitude;
  const u = loopPhase(t, T21_LOOP_SECONDS);
  const rings: TunnelRing[] = [];
  for (let index = 0; index < T21_RING_COUNT; index += 1) {
    // (u·N + k) mod N over N: s = k/N exactly at t = 0 and at the loop.
    const s = ((u * T21_RING_COUNT + index) % T21_RING_COUNT) / T21_RING_COUNT;
    const radius = minRadius * growth ** s;
    const direction = index % 2 === 0 ? 1 : -1;
    const text = params.lines[index % params.lines.length];
    rings.push({
      index, s, radius, size: (tunnelRing(text, face).size / REFERENCE_RADIUS) * radius,
      rotation: (index % 2) * 9 + direction * spin * s,
      opacity: smoothstep(0, FADE_IN, s),
      color: colors[index % 2],
      text,
    });
  }
  rings.sort((a, b) => a.s - b.s || a.index - b.index);
  return { cx, cy, minRadius, maxRadius, rings };
}

export const T21_ringTextTunnel = defineTextMotion(ID, (params, t, size) => {
  const plan = ringTunnelPlan(params, size, t);
  const face = textFace(params.font, 900);
  const halfDiagonal = Math.hypot(plan.cx, plan.cy);
  const parts = plan.rings.map(ring => {
    // A ring whose glyph band lies wholly outside the frame corners draws nothing.
    if (ring.radius - 0.5 * ring.size > halfDiagonal) return "";
    return drawTextRing(tunnelRing(ring.text, face), { cx: plan.cx, cy: plan.cy, rotation: ring.rotation, scale: ring.radius / REFERENCE_RADIUS, fill: ring.color, opacity: ring.opacity });
  });
  return createTextDocument(size, params).render(g(undefined, parts));
}, { revision: REVISION });
