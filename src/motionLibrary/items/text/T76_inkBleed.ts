import { circle, g, gooFilter, path, tf } from "../../svg/document";
import { clamp01, cubicIn, cubicOut, quadIn, smoothstep } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  compactPathD, createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, placeWordGlyphs, textBackdrop, textFace, textOnBackground,
  titleSafeBox,
} from "../shared";

/**
 * T76 Ink Bleed (墨跡暈開), MOOD, on the dark card: the word condenses out of
 * pooled ink, holds crisp, and bleeds back into ink. A "gooey ink" filter (DESIGN §8
 * gooFilter: a Gaussian blur σ, then an alpha threshold alpha × 18 − 7) runs on the
 * word and a few seeded ink droplets, so whatever lies within about σ melts together
 * with rounded necks.
 * - Form 0.0–0.6 s: σ falls from 9% of the glyph height to 0 (quadratic, quick at
 *   first), the word fades in over the first 0.15 s, and seven droplets around the
 *   word are drawn into its letters and absorbed: ink pools sharpen into letters.
 * - Hold crisp 0.6–1.6 s (it grows with longer clips): no filter at all.
 * - Bleed 1.6–2.2 s: σ rises back to 9% (quadIn), the droplets seep out again and the
 *   letters merge into ink, then everything fades out by 2.4 s.
 * Below σ ≈ 2% of the glyph height a threshold leaves aliased edges (HELPERS_API), so
 * the crisp word is cross-faded in on top between 2.2% and 1.2%, and below 1.2% the
 * filter is dropped. The filter region hugs the word and droplets (± 3σ).
 *
 * One flat colour, as the goo needs: the readable text role (cream on the dark card,
 * ink on cream or gold). The word is hero-sized (heroTextBox, tight displayTracking)
 * inside the 5% title-safe box; the droplets stay inside it too. Times are
 * standard-energy seconds, scaled by energy and squeezed into short clips (itemTiming);
 * energy never changes the blur depth.
 */

const ID = "T76";
const REVISION = 1;
/** Standard-energy seconds: form, bleed start (from the end), bleed, fade-out. */
export const T76_FORM = 0.6, T76_FADE_IN = 0.15, T76_BLEED = 0.6, T76_FADE_OUT = 0.2, T76_MIN_HOLD = 0.4;
const NATURAL_SECONDS = T76_FORM + T76_MIN_HOLD + T76_BLEED + T76_FADE_OUT;
/** Peak σ (× glyph height); the cross-fade band where the crisp word takes over (× glyph height). */
export const T76_SIGMA = 0.09, T76_CRISP: readonly [number, number] = [0.012, 0.022];
/** Droplets: count, radius range and reach outside the word (× glyph height). */
export const T76_DROPLETS = 7;
/** A droplet must be wider than about σ to survive the blur and threshold at the peak σ (9%), so they are 12–20%. */
const DROP_RADIUS: readonly [number, number] = [0.12, 0.2], DROP_REACH: readonly [number, number] = [0.2, 0.45];
const LINE_HEIGHT = 1.08;

export interface InkDroplet {
  /** Home (inside a letter) and the pooled position outside the word (frame px), radius at the pool. */
  readonly homeX: number;
  readonly homeY: number;
  readonly poolX: number;
  readonly poolY: number;
  readonly radius: number;
}

export interface InkBleedPlan {
  readonly pathD: string;
  readonly x: number;
  readonly y: number;
  readonly glyphHeight: number;
  readonly color: string;
  readonly droplets: readonly InkDroplet[];
  /** Word ink box (frame px) and the box that holds the word and every droplet. */
  readonly box: GlyphBox;
  readonly reach: GlyphBox;
  /** Phase times (s, energy applied). */
  readonly formEnd: number;
  readonly fadeInEnd: number;
  readonly bleedStart: number;
  readonly bleedEnd: number;
  readonly end: number;
}

export function inkBleedPlan(params: TextMotionParams, size: MotionFrameSize): InkBleedPlan {
  const safe = titleSafeBox(size);
  // Room for the droplets beside the word: the fit leaves a margin of the largest reach plus a droplet.
  const margin = DROP_REACH[1] + DROP_RADIUS[1];
  const hero = heroTextBox(size);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    maxWidth: Math.min(hero.maxWidth, safe.width / (1 + 2 * margin * 0.3)), maxHeight: Math.min(hero.maxHeight, safe.height / (1 + 2 * margin)),
    maxSize: hero.maxSize, lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const x = safe.cx - text.inkCenter[0], y = safe.cy - text.inkCenter[1];
  const { glyphs, glyphHeight } = placeWordGlyphs(text, x, y);
  const box = { x0: text.ink.x0 + x, y0: text.ink.y0 + y, x1: text.ink.x1 + x, y1: text.ink.y1 + y };
  const rng = createSeededRng(ID, params.seed, "droplets");
  const droplets: InkDroplet[] = Array.from({ length: T76_DROPLETS }, (_, index) => {
    const r = rng.fork(index), glyph = glyphs[index % glyphs.length];
    // A droplet pools above or below its letter, a little to the side, and seeps from the letter's centre.
    const below = r.chance(0.5), reach = r.range(DROP_REACH[0], DROP_REACH[1]) * glyphHeight;
    const poolX = Math.min(safe.x1, Math.max(safe.x0, glyph.cx + r.range(-0.45, 0.45) * (glyph.box.x1 - glyph.box.x0)));
    const poolY = below ? box.y1 + reach : box.y0 - reach;
    return { homeX: glyph.cx, homeY: glyph.cy, poolX, poolY, radius: r.range(DROP_RADIUS[0], DROP_RADIUS[1]) * glyphHeight };
  });
  const reach = {
    x0: Math.min(box.x0, ...droplets.map(drop => drop.poolX - drop.radius)), y0: Math.min(box.y0, ...droplets.map(drop => drop.poolY - drop.radius)),
    x1: Math.max(box.x1, ...droplets.map(drop => drop.poolX + drop.radius)), y1: Math.max(box.y1, ...droplets.map(drop => drop.poolY + drop.radius)),
  };
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS);
  const end = params.durationSeconds, bleedEnd = end - T76_FADE_OUT * timeScale;
  return {
    pathD: compactPathD(text.block.pathD), x, y, glyphHeight, color: textOnBackground(params.palette, textBackdrop(params)), droplets, box, reach,
    formEnd: T76_FORM * timeScale, fadeInEnd: T76_FADE_IN * timeScale, bleedStart: bleedEnd - T76_BLEED * timeScale, bleedEnd, end,
  };
}

export interface InkState {
  /** Blur σ (px), the word's opacity, droplet progress (0 = home, absorbed; 1 = pooled outside). */
  readonly sigma: number;
  readonly opacity: number;
  readonly pool: number;
}

export function inkState(plan: InkBleedPlan, t: number): InkState {
  const peak = T76_SIGMA * plan.glyphHeight;
  if (t < plan.formEnd) {
    const p = clamp01(t / plan.formEnd);
    return { sigma: peak * (1 - p) ** 2, opacity: cubicOut(clamp01(t / plan.fadeInEnd)), pool: 1 - cubicOut(clamp01(p / 0.85)) };
  }
  if (t < plan.bleedStart) return { sigma: 0, opacity: 1, pool: 0 };
  if (t < plan.bleedEnd) {
    const p = clamp01((t - plan.bleedStart) / (plan.bleedEnd - plan.bleedStart));
    return { sigma: peak * quadIn(p), opacity: 1, pool: quadIn(p) };
  }
  const p = clamp01((t - plan.bleedEnd) / Math.max(1e-6, plan.end - plan.bleedEnd));
  return { sigma: peak, opacity: 1 - cubicIn(p), pool: 1 };
}

/** Share of the crisp word drawn over the goo: 1 below 1.2% of the glyph height, 0 above 2.2%. */
export function crispShare(plan: InkBleedPlan, sigma: number): number {
  return 1 - smoothstep(T76_CRISP[0] * plan.glyphHeight, T76_CRISP[1] * plan.glyphHeight, sigma);
}

export const T76_inkBleed = defineTextMotion(ID, (params, t, size) => {
  const plan = inkBleedPlan(params, size);
  const doc = createTextDocument(size, params);
  const state = inkState(plan, t);
  if (state.opacity <= 0.002) return doc.render();
  const word = path(plan.pathD, { fill: plan.color, transform: tf.translate(plan.x, plan.y) });
  const crisp = crispShare(plan, state.sigma);
  const opacity = state.opacity < 1 ? Number(state.opacity.toFixed(3)) : undefined;
  if (crisp >= 1) return doc.render(g({ opacity }, word));
  // A droplet shrinks away as it reaches its letter (absorbed), so none is left sitting in a counter.
  const droplets = plan.droplets.map(drop => {
    const k = state.pool, radius = drop.radius * (0.4 + 0.6 * k) * smoothstep(0, 0.25, k);
    return radius < 0.5 ? "" : circle(drop.homeX + (drop.poolX - drop.homeX) * k, drop.homeY + (drop.poolY - drop.homeY) * k, radius, { fill: plan.color });
  });
  const goo = gooFilter(doc, state.sigma, plan.reach);
  const crispWord = crisp > 0 ? path(plan.pathD, { fill: plan.color, opacity: Number(crisp.toFixed(3)), transform: tf.translate(plan.x, plan.y) }) : "";
  return doc.render(g({ opacity }, g({ filter: goo }, word, droplets), crispWord));
}, { revision: REVISION });
