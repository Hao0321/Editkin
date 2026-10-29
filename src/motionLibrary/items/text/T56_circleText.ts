import { g } from "../../svg/document";
import { loopPhase } from "../../svg/easing";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { drawTextRing, fitRing, textRingPathD, type TextRing } from "./T21_ringTextTunnel";

/**
 * T56 Circle Text (圓環字), PLAY: three concentric rings of characters, each
 * glyph standing upright on its ring (tops outward, reading clockwise), the line
 * repeated with 「・」 so it closes the circle evenly with no seam. Radii 42%, 30%
 * and 18% of the short side; the outer and inner rings take the second tone and
 * the middle ring the text colour (coral, cream, coral on the dark card,
 * ART_DIRECTION §0). The outer ring turns +45°/s, the middle −45°/s and the inner
 * +90°/s (clockwise positive). This is T21's ring generator without the tunnel
 * expansion (fitRing / textRingPathD / drawTextRing, one cached outline per
 * ring turned with a group rotate).
 *
 * Type: every ring's glyph em is about 10.5% of the short side (ink ≥ 9%), the
 * exact size per ring chosen so whole repeats close the circle (the gap widens on the
 * small inner ring so neighbours never touch at their inner corners). The
 * outer ring's ink must stay inside the 5% title-safe box, which the 42% radius
 * alone would overrun by half a glyph in landscape; the three radii are scaled
 * together (keeping 42 : 30 : 18) just enough for the outer ink to fit.
 *
 * A seamless 8 s loop (catalog loopSeconds): the rotations are whole turns per
 * loop (one, one and two), computed from the loop phase. Lines 2+ (if any) go to
 * the middle and inner rings; with one line every ring repeats it.
 */

const ID = "T56";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T56_LOOP_SECONDS = 8;
/** Ring radii (× short side), spins (degrees per second, clockwise positive) and tones, outer to inner. */
export const T56_RADII = [0.42, 0.3, 0.18] as const;
export const T56_SPINS = [45, -45, 90] as const;
/** Target and largest glyph em (× short side). */
export const T56_EM = 0.105, T56_EM_MAX = 0.12;
/** Ink half-height of a CJK glyph as a fraction of its em (Noto Sans TC 900 ink is about 0.88 em). */
const INK_HALF = 0.46;

export interface CircleRing {
  readonly index: number;
  readonly radius: number;
  /** Glyph em (px). */
  readonly size: number;
  /** Degrees per second. */
  readonly spin: number;
  readonly color: string;
  readonly text: string;
  readonly ring: TextRing;
}

export interface CircleTextPlan {
  readonly cx: number;
  readonly cy: number;
  /** Radius scale applied to T56_RADII so the outer ink fits the title-safe box (≤ 1). */
  readonly fit: number;
  readonly rings: readonly CircleRing[];
}

export function circleTextPlan(params: TextMotionParams, size: MotionFrameSize): CircleTextPlan {
  const short = Math.min(size.width, size.height), safe = titleSafeBox(size);
  const face = textFace(params.font, 900);
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop), secondary = secondaryTone(params.palette, backdrop);
  const colors = [secondary, primary, secondary];
  const texts = T56_RADII.map((_, index) => params.lines[Math.min(index, params.lines.length - 1)]);
  const fitAt = (index: number, fit: number) => fitRing(texts[index], face, T56_RADII[index] * fit * short, T56_EM * short, T56_EM_MAX * short);
  const sizeAt = (index: number, fit: number) => fitAt(index, fit).size;
  // The outer ink edge (radius + ink half-height) must stay inside the safe half of the short side.
  const room = Math.min(safe.width, safe.height) / 2;
  let fit = 1;
  for (let pass = 0; pass < 8; pass += 1) {
    const allowed = (room - INK_HALF * sizeAt(0, fit)) / (T56_RADII[0] * short);
    if (allowed >= fit) break;
    fit = allowed * 0.999;
  }
  const rings = T56_RADII.map((ratio, index) => {
    const radius = ratio * fit * short, ringFit = fitAt(index, fit);
    return { index, radius, size: ringFit.size, spin: T56_SPINS[index], color: colors[index], text: texts[index],
      ring: textRingPathD({ text: texts[index], face, size: ringFit.size, radius, minGap: ringFit.minGap }) };
  });
  return { cx: size.width / 2, cy: size.height / 2, fit, rings };
}

export const T56_circleText = defineTextMotion(ID, (params, t, size) => {
  const plan = circleTextPlan(params, size);
  const elapsed = loopPhase(t, T56_LOOP_SECONDS) * T56_LOOP_SECONDS;
  const parts = plan.rings.map(ring => drawTextRing(ring.ring, {
    cx: plan.cx, cy: plan.cy, rotation: (((ring.spin * elapsed) % 360) + 360) % 360, fill: ring.color,
  }));
  return createTextDocument(size, params).render(g(undefined, parts));
}, { revision: REVISION });
