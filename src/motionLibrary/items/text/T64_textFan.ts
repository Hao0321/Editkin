import { g, outlinedAttrs, path, tf, transform } from "../../svg/document";
import { backOut, cubicIn, energyProfile, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T64 Text Fan (摺扇展開), PHYSICS: one character (the first line; 「展」 by default)
 * repeated nine times and fanned like a folding fan around a hinge 1.6 glyph heights
 * below the glyph's centre.
 * - Opening (0.0–0.5 s): from a single stacked copy (0°) the copies swing out to their
 *   slots across −80° … +80° (20° apart) on a backOut ease, the pairs leaving the
 *   middle 0.03 s apart (the centre copy stays upright), so the outermost pair lands
 *   at 0.5 s; each copy overlaps the one before it, drawn left to right, and the
 *   copies alternate the text colour and the second tone (cream and violet on the
 *   dark card, ART_DIRECTION §0). A thin backdrop-coloured keyline separates the
 *   overlapping blades.
 * - Hold open 0.5–1.1 s; close 1.1–1.45 s (cubic ease-in) back to one upright copy;
 *   rest 1.45–1.8 s (the 1.8 s loop leaves 0.35 s of rest instead of the catalog's
 *   0.2 s: open 0.5 + hold 0.6 + close 0.35 = 1.45 s).
 * Size: the open fan, backOut overshoot included, fills the title-safe box (its widest
 * pose is fitted, then centred), so the character is far above 9% of the short side.
 * A seamless 1.8 s loop (catalog loopSeconds): every pose is a function of the loop
 * phase. Energy scales the backOut overshoot, never the period.
 */

const ID = "T64";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T64_LOOP_SECONDS = 1.8;
export const T64_COPIES = 9, T64_SPREAD = 80, T64_HINGE = 1.6;
export const T64_OPEN_END = 0.5, T64_STAGGER = 0.03, T64_CLOSE_START = 1.1, T64_CLOSE_END = 1.45;
/** backOut overshoot (Penner's s) at standard energy. */
const OVERSHOOT = 1.70158;
/** Keyline width (× em) in the backdrop colour around every blade. */
const KEYLINE = 0.045;
const FIT_MARGIN = 0.98;

export interface FanPlan {
  readonly pathD: string;
  /** Ink box of the glyph (block coordinates) and its centre. */
  readonly ink: GlyphBox;
  readonly inkCenter: readonly [number, number];
  readonly fontSize: number;
  readonly glyphHeight: number;
  /** Hinge (frame px) and the distance from the hinge to the glyph centre (px). */
  readonly hingeX: number;
  readonly hingeY: number;
  readonly radius: number;
  readonly overshoot: number;
  readonly colors: readonly [string, string];
  readonly keyline: number;
  readonly keylineColor: string;
}

/** Slot angle of copy k (degrees, clockwise): −80 … +80. */
export function fanSlot(index: number): number {
  return -T64_SPREAD + (2 * T64_SPREAD * index) / (T64_COPIES - 1);
}

/** Largest |angle| a blade reaches (the outermost slot plus the backOut overshoot). */
function peakAngle(overshoot: number): number {
  let peak = 0;
  for (let step = 0; step <= 200; step += 1) peak = Math.max(peak, backOut(step / 200, overshoot));
  return T64_SPREAD * peak;
}

export function fanPlan(params: TextMotionParams, size: MotionFrameSize): FanPlan {
  const safe = titleSafeBox(size);
  const overshoot = OVERSHOOT * Math.min(1.6, energyProfile(params.energy).amplitude);
  const face = textFace(params.font, 900), lines = [params.lines[0]];
  const tracking = displayTracking(lines);
  const reference = layoutFittedText(lines, face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: 100, tracking });
  const w = reference.ink.x1 - reference.ink.x0, h = reference.ink.y1 - reference.ink.y0;
  // Extents of every pose about the hinge (glyph centre at (0, −R)), at 100 px.
  const radius100 = T64_HINGE * h, peak = peakAngle(overshoot);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let step = 0; step <= 72; step += 1) {
    const degrees = -peak + (2 * peak * step) / 72, a = (degrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    for (const [cx, cy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]] as const) {
      const lx = cx, ly = cy - radius100;
      const x = lx * c - ly * s, y = lx * s + ly * c;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const k = Math.min(safe.width / (x1 - x0), safe.height / (y1 - y0)) * FIT_MARGIN;
  const text = layoutFittedText(lines, face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: Math.floor(100 * k * 1000) / 1000, tracking });
  const scale = text.fontSize / 100;
  const backdrop = textBackdrop(params);
  return {
    pathD: compactPathD(text.block.pathD), ink: text.ink, inkCenter: text.inkCenter, fontSize: text.fontSize, glyphHeight: text.ink.y1 - text.ink.y0,
    hingeX: safe.cx - ((x0 + x1) / 2) * scale, hingeY: safe.cy - ((y0 + y1) / 2) * scale, radius: radius100 * scale, overshoot,
    colors: [textOnBackground(params.palette, backdrop), secondaryTone(params.palette, backdrop)],
    keyline: KEYLINE * text.fontSize, keylineColor: backdrop,
  };
}

/** Angle of copy k at loop phase u (degrees, clockwise about the hinge). */
export function fanAngle(plan: FanPlan, index: number, u: number): number {
  const slot = fanSlot(index), t = u * T64_LOOP_SECONDS;
  const pair = Math.abs(index - (T64_COPIES - 1) / 2);
  if (pair === 0) return 0;
  if (t < T64_OPEN_END) {
    const start = T64_STAGGER * (pair - 1), duration = T64_OPEN_END - T64_STAGGER * ((T64_COPIES - 1) / 2 - 1);
    const p = (t - start) / duration;
    return p <= 0 ? 0 : slot * backOut(Math.min(1, p), plan.overshoot);
  }
  if (t < T64_CLOSE_START) return slot;
  if (t < T64_CLOSE_END) return slot * (1 - cubicIn((t - T64_CLOSE_START) / (T64_CLOSE_END - T64_CLOSE_START)));
  return 0;
}

export const T64_textFan = defineTextMotion(ID, (params, t, size) => {
  const plan = fanPlan(params, size);
  const u = loopPhase(t, T64_LOOP_SECONDS);
  const blades = Array.from({ length: T64_COPIES }, (_, index) => {
    const angle = fanAngle(plan, index, u);
    return path(plan.pathD, {
      ...outlinedAttrs(plan.colors[index % 2], plan.keylineColor, plan.keyline),
      transform: transform(tf.translate(plan.hingeX, plan.hingeY), angle ? tf.rotate(angle) : false,
        tf.translate(-plan.inkCenter[0], -plan.inkCenter[1] - plan.radius)),
    });
  });
  return createTextDocument(size, params).render(g(undefined, blades));
}, { revision: REVISION });
