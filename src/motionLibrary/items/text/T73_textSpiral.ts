import { g, path, tf, transform } from "../../svg/document";
import { loopPhase, smoothstep } from "../../svg/easing";
import { layoutLine, motionFaceMetrics } from "../../svg/glyphs";
import { spiralPath, type FollowPath } from "../../svg/pathFollow";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { compactPathD, createTextDocument, isSeparatorCharacter, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";

/**
 * T73 Text Spiral (漩渦吸入), MOOD, on the dark card: the line, repeated with 「・」,
 * streams along the two arms of an Archimedean spiral (path follow: svg/pathFollow
 * spiralPath, 1.25 turns from the outer rim to near the centre) and is drawn in
 * toward the middle, like water into a drain. Characters stand upright along the arm
 * (tops outward),
 * shrink in proportion to their radius as they go in (so their spacing shrinks with
 * them: they sit at equal angle steps), fade in at the rim and out near the centre,
 * and a character that reaches the centre respawns at the rim as the stream goes on.
 * The whole spiral turns clockwise at 120°/s.
 *
 * A seamless 3 s loop (catalog loopSeconds): the spiral turns once and each arm
 * advances exactly one repeat of the text (the slots carry the repeating line, so a
 * shift by one repeat is the same picture). About 22 characters ride each arm (44 in
 * all, inside the catalog's 40–70 for the default line); the outermost are about 12%
 * of the short side, and the two arms never touch (characters are 85% of the radial
 * gap between arms). Everything stays inside the 5% title-safe box.
 *
 * Colours alternate cream and gold along the text (the separators gold), on the dark
 * card; ink and the deep shade on the gold card. Energy does not change the drift:
 * the loop is the effect.
 */

const ID = "T73";
const REVISION = 1;
export const T73_LOOP_SECONDS = 3;
/** Turns (rim → centre), arms, spin (degrees per second, clockwise), inner radius (× outer). */
export const T73_TURNS = 1.25, T73_ARMS = 2, T73_SPIN = 120, T73_INNER = 0.06;
/** Glyph em at the rim as a share of the radial gap between the arms; spacing along the arm in em at the rim. */
const GLYPH_OF_GAP = 0.85, SPACING = 1.12;
/** Fade in over the first slot at the rim; fade out below this share of the outer radius. */
const FADE_OUT: readonly [number, number] = [0.12, 0.24];

export interface SpiralSlotGlyph {
  readonly char: string;
  readonly pathD: string;
  /** Pen offset that centres the glyph's em box on the arm (glyph units at em s0). */
  readonly penDx: number;
  readonly penDy: number;
  readonly color: string;
}

export interface TextSpiralPlan {
  readonly cx: number;
  readonly cy: number;
  /** Outer and inner radius of the glyph centre line (px), total sweep (rad), em at the rim (px). */
  readonly outer: number;
  readonly inner: number;
  readonly sweep: number;
  readonly em: number;
  /** Angle step between slots (rad) and slots per arm (fractional; the visible window is [0, slots)). */
  readonly step: number;
  readonly slots: number;
  /** The repeat unit (text + separator), one entry per slot of the unit. */
  readonly unit: readonly SpiralSlotGlyph[];
  /** One arc-length path per arm, distance 0 at the rim (svg/pathFollow). */
  readonly arms: readonly FollowPath[];
}

export function textSpiralPlan(params: TextMotionParams, size: MotionFrameSize): TextSpiralPlan {
  const safe = titleSafeBox(size);
  const face = textFace(params.font, 900);
  const text = params.lines.join("").trim();
  const unitText = isSeparatorCharacter([...text].pop() ?? "") ? text : `${text}・`;
  // Rim radius: the outermost glyph (em s0 = c·outer, any angle) must stay inside half the safe short side.
  const c = (GLYPH_OF_GAP * (1 - T73_INNER)) / (T73_ARMS * T73_TURNS);
  const outer = (0.5 * Math.min(safe.width, safe.height)) / (1 + Math.SQRT1_2 * c);
  const inner = T73_INNER * outer, em = Math.floor(c * outer * 1000) / 1000;
  const line = layoutLine(unitText, { ...face, size: em, kerning: false });
  const metrics = motionFaceMetrics(face, em);
  const backdrop = textBackdrop(params);
  const first = textOnBackground(params.palette, backdrop), second = secondaryTone(params.palette, backdrop);
  let letter = 0;
  const unit = line.glyphs.map(glyph => {
    const separator = isSeparatorCharacter(glyph.char);
    return {
      char: glyph.char, pathD: glyph.whitespace ? "" : compactPathD(glyph.pathD),
      penDx: -glyph.advance / 2, penDy: -(metrics.emTop + metrics.emBottom) / 2,
      color: separator ? second : letter++ % 2 === 0 ? first : second,
    };
  });
  const sweep = 2 * Math.PI * T73_TURNS, step = (SPACING * em) / outer;
  // Path follow (DESIGN §8): each arm is an arc-length spiral starting at the rim; it winds clockwise going in, so
  // its outward winding is counter-clockwise. Arm 0 starts at the top, arm 1 at the bottom.
  const arms = Array.from({ length: T73_ARMS }, (_, arm) => spiralPath(safe.cx, safe.cy, {
    innerRadius: inner, outerRadius: outer, turns: T73_TURNS, arms: T73_ARMS, arm, clockwise: false, startDegrees: -90, from: "outer", steps: 1440,
  }));
  return { cx: safe.cx, cy: safe.cy, outer, inner, sweep, em, step, slots: sweep / step, unit, arms };
}

export interface SpiralPlacement {
  readonly x: number;
  readonly y: number;
  /** Tangent angle (degrees, clockwise travel → tops outward), scale (r / outer) and opacity. */
  readonly angle: number;
  readonly scale: number;
  readonly opacity: number;
}

/**
 * Arc length from the rim to the angle θ (rad) along an arm: for r = R − b·θ the length is
 * (F(R) − F(r)) / b with F(r) = (r·√(r² + b²) + b²·ln(r + √(r² + b²))) / 2.
 */
export function spiralDistance(plan: TextSpiralPlan, theta: number): number {
  const b = (plan.outer - plan.inner) / plan.sweep, r = plan.outer - b * theta;
  const F = (value: number) => (value * Math.sqrt(value * value + b * b) + b * b * Math.log(value + Math.sqrt(value * value + b * b))) / 2;
  return (F(plan.outer) - F(r)) / b;
}

/**
 * Where a slot sits: `position` slots in from the rim on arm `arm` (before the spin). Slots are equal angle steps, so
 * their spacing shrinks with the radius like the glyphs do; the point and its tangent come from the arm's arc-length
 * path (path follow), the scale from the radius.
 */
export function slotPlacement(plan: TextSpiralPlan, arm: number, position: number): SpiralPlacement | null {
  if (position < 0 || position >= plan.slots) return null;
  const theta = position * plan.step;
  const radius = plan.outer - ((plan.outer - plan.inner) * theta) / plan.sweep;
  const sample = plan.arms[arm](spiralDistance(plan, theta));
  const share = radius / plan.outer;
  const opacity = Math.min(1, position) * smoothstep(FADE_OUT[0], FADE_OUT[1], share);
  return { x: sample.x, y: sample.y, angle: sample.angle, scale: share, opacity };
}

export const T73_textSpiral = defineTextMotion(ID, (params, t, size) => {
  const plan = textSpiralPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T73_LOOP_SECONDS);
  const flow = u * plan.unit.length;
  const parts: string[] = [];
  for (let arm = 0; arm < T73_ARMS; arm += 1) {
    // Slot k carries unit[k mod U]; its position grows by one repeat per loop.
    const first = Math.ceil(-flow), last = Math.floor(plan.slots - flow);
    for (let k = last; k >= first; k -= 1) {
      const glyph = plan.unit[((k % plan.unit.length) + plan.unit.length) % plan.unit.length];
      const place = glyph.pathD ? slotPlacement(plan, arm, k + flow) : null;
      if (!place || place.opacity <= 0.004) continue;
      parts.push(path(glyph.pathD, {
        fill: glyph.color, opacity: place.opacity < 1 ? Number(place.opacity.toFixed(3)) : undefined,
        transform: transform(tf.translate(place.x, place.y), tf.rotate(place.angle), tf.scale(place.scale), tf.translate(glyph.penDx, glyph.penDy)),
      }));
    }
  }
  return doc.render(g({ transform: tf.rotate(T73_SPIN * T73_LOOP_SECONDS * u, plan.cx, plan.cy) }, parts));
}, { revision: REVISION });
