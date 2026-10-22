import { g, line, rect, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, textBackdrop, textFace, textOnBackground } from "../shared";
import { distinctFrom, marqueeRepeatStarts, marqueeStrip, marqueeUnit, marqueeUnitText, type MarqueeUnit } from "./T09_hugeTextScroll";

/**
 * T16 Tape Cross (テープ交差): two caution tapes cross in an X through the frame
 * centre at ±15° (±20° and 20% thicker tapes in portrait, so the X fills the tall
 * frame). One tape is the readable text colour (cream over a dark
 * backdrop, ink over a light one), the other the accent, laid on top; each carries
 * the line repeated with bullets (「禁止進入・KEEP OUT・」) in the colour that reads
 * on it, between thin hem lines, and the two tapes scroll in opposite directions.
 * The tapes run edge to edge by definition; their text is at least 9% of the
 * short side.
 *
 * A seamless 4 s loop (catalog loopSeconds): each tape advances a whole number of
 * repeats per loop. Energy scales the speeds (whole repeats only).
 */

const ID = "T16";
const REVISION = 1;
export const T16_LOOP_SECONDS = 4;
/** Cross angle: ±15° (the reference), opened to ±20° in tall frames so the X fills more of a portrait frame. */
export const T16_ANGLE = 15, T16_PORTRAIT_ANGLE = 20;
/** Tape thickness (× short side), text ink (× thickness), hem inset and stroke (× thickness), speed (short sides per second). */
const THICKNESS = 0.165, PORTRAIT_THICKNESS = 0.2, TEXT_INK = 0.56, HEM_INSET = 0.1, HEM_STROKE = 0.022, SPEED = 0.3, TRACKING = -0.02;

export interface Tape {
  readonly angle: number;
  readonly color: string;
  readonly textColor: string;
  readonly unit: MarqueeUnit;
  readonly baseline: number;
  readonly repeatsPerLoop: number;
}

export interface TapeCrossPlan {
  readonly thickness: number;
  readonly halfLength: number;
  /** Drawing order: the text-colour tape first, the accent tape on top. */
  readonly tapes: readonly Tape[];
}

export function tapeCrossPlan(params: TextMotionParams, size: MotionFrameSize): TapeCrossPlan {
  const short = Math.min(size.width, size.height);
  const portrait = size.height > size.width * 1.2;
  const thickness = (portrait ? PORTRAIT_THICKNESS : THICKNESS) * short, angle = portrait ? T16_PORTRAIT_ANGLE : T16_ANGLE;
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const accent = distinctFrom(backdrop, params.palette.accent, [params.palette.accent2, primary]);
  const face = textFace(params.font, 900);
  const text = marqueeUnitText(params.lines[0], face);
  const probe = marqueeUnit(text, face, 100, TRACKING);
  const unit = marqueeUnit(text, face, (TEXT_INK * thickness / Math.max(1, probe.ink.y1 - probe.ink.y0)) * 100, TRACKING);
  const repeats = Math.max(1, Math.round((SPEED * short * energyProfile(params.energy).amplitude * T16_LOOP_SECONDS) / unit.period));
  const second = params.lines.length > 1 ? marqueeUnit(marqueeUnitText(params.lines[1], face), face, unit.size, TRACKING) : unit;
  const tape = (tapeAngle: number, color: string, tapeUnit: MarqueeUnit, direction: 1 | -1): Tape => ({
    angle: tapeAngle, color, textColor: textOnBackground(params.palette, color), unit: tapeUnit,
    baseline: -(tapeUnit.ink.y0 + tapeUnit.ink.y1) / 2, repeatsPerLoop: direction * Math.max(1, Math.round((repeats * unit.period) / tapeUnit.period)),
  });
  return {
    thickness, halfLength: Math.hypot(size.width, size.height) / 2 + thickness,
    tapes: [tape(-angle, primary, second, -1), tape(angle, accent, unit, 1)],
  };
}

export const T16_tapeCross = defineTextMotion(ID, (params, t, size) => {
  const plan = tapeCrossPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T16_LOOP_SECONDS);
  const half = plan.halfLength, thick = plan.thickness;
  const hem = thick / 2 - HEM_INSET * thick, hemWidth = HEM_STROKE * thick;
  const tapes = plan.tapes.map(tape => {
    const starts = marqueeRepeatStarts(tape.unit, -half, tape.repeatsPerLoop * u, -half, half);
    return g({ transform: transform(tf.translate(size.width / 2, size.height / 2), tf.rotate(tape.angle)) },
      rect(-half, -thick / 2, 2 * half, thick, { fill: tape.color }),
      [hem, -hem].map(y => line(-half, y, half, y, { stroke: tape.textColor, "stroke-width": hemWidth })),
      marqueeStrip(tape.unit, starts, tape.baseline, tape.textColor, tape.textColor));
  });
  return doc.render(tapes);
}, { revision: REVISION });
