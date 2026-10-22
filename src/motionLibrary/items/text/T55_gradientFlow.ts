import { mixHex } from "../../svg/color";
import { g, path, tf } from "../../svg/document";
import { loopPhase, smoothstep } from "../../svg/easing";
import { defineTextMotion, type MotionFrameSize, type MotionPalette, type TextMotionParams } from "../../types";
import {
  backdropTone, createTextDocument, displayTracking, heroTextBox, layoutFittedText, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T55 Gradient Flow (流光漸層), PLAY, designed on the paper plate: the word (display 900,
 * heroTextBox, tight displayTracking) is filled with a repeating gradient that reads as flowing
 * light (流光): a coral word (CATALOG T55) crossed by a firm ink band and, half a period later,
 * a soft cream specular streak whose core is nearly the paper colour and whose edges fall off
 * smoothly (a smoothstep profile sampled into stops). Both lean like a glint (/, LEAN degrees)
 * and scroll left to right by exactly one period (1.2 × the word's ink width) per loop, along the
 * gradient's own axis, so frame 0 equals the frame at 2.4 s (catalog loopSeconds; spreadMethod
 * repeat tiles it seamlessly).
 *
 * Revision 2 (Claude review 2026-10-22: the r1 deep-shade band read as muddy brown): no deep
 * shade at all. The colours per backdrop: on cream and on the dark card the word is coral, the
 * band is the readable text role (ink on cream, paper on the dark card) and the streak is coral
 * lifted toward paper; on the coral card the word turns ink (never accent on accent), the band
 * paper, the streak ink lifted toward paper. The word is static and inside the 5% title-safe
 * box; only the light moves.
 */

const ID = "T55";
const REVISION = 2;
export const T55_LOOP_SECONDS = 2.4;
/** Gradient period as a multiple of the word's ink width. */
export const T55_PERIOD = 1.2;
/** Lean of the band and streak (degrees from vertical, top to the right). */
export const T55_LEAN = 18;
/** The streak's core: the word colour lifted this far toward paper. */
export const T55_LIGHT = 0.88;
/** Band and streak centres, the band's firm hold and ramp, and the streak's core and soft reach (shares of the period). */
const BAND_AT = 0.25, BAND_HOLD = 0.07, BAND_RAMP = 0.012;
const STREAK_AT = 0.75, STREAK_CORE = 0.006, STREAK_REACH = 0.075;
/** Sample distances of the streak's soft falloff (between its core and its reach). */
const STREAK_SAMPLES: readonly number[] = [0.02, 0.036, 0.054];
const LINE_HEIGHT = 1.04;

export interface FlowColors {
  /** The word colour. */
  readonly base: string;
  /** The firm band. */
  readonly band: string;
  /** The specular streak's core. */
  readonly light: string;
}

/** The word, band and streak colours for this backdrop (no deep shade). */
export function flowColors(palette: MotionPalette, backdrop: string): FlowColors {
  const accentCard = backdropTone(palette, backdrop) === "accent";
  const base = accentCard ? palette.ink : palette.accent;
  return { base, band: accentCard ? palette.paper : textOnBackground(palette, backdrop), light: mixHex(base, palette.paper, T55_LIGHT) };
}

/** The gradient stops over one period: the word colour, the firm band, the word colour, the soft streak, back to the word colour. */
export function flowStops(colors: FlowColors): Array<{ offset: number; color: string }> {
  const { base, band, light } = colors;
  const streak = (distance: number) => mixHex(base, light, 1 - smoothstep(STREAK_CORE, STREAK_REACH, distance));
  const falloff = STREAK_SAMPLES.map(distance => ({ distance, color: streak(distance) }));
  return [
    { offset: 0, color: base },
    { offset: BAND_AT - BAND_HOLD - BAND_RAMP, color: base }, { offset: BAND_AT - BAND_HOLD, color: band },
    { offset: BAND_AT + BAND_HOLD, color: band }, { offset: BAND_AT + BAND_HOLD + BAND_RAMP, color: base },
    { offset: STREAK_AT - STREAK_REACH, color: base },
    ...[...falloff].reverse().map(sample => ({ offset: STREAK_AT - sample.distance, color: sample.color })),
    { offset: STREAK_AT - STREAK_CORE, color: light }, { offset: STREAK_AT + STREAK_CORE, color: light },
    ...falloff.map(sample => ({ offset: STREAK_AT + sample.distance, color: sample.color })),
    { offset: STREAK_AT + STREAK_REACH, color: base },
    { offset: 1, color: base },
  ];
}

export interface GradientFlowLayout {
  readonly pathD: string;
  /** Translation that centres the ink box in the safe box. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Ink box in frame px. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly period: number;
  readonly colors: FlowColors;
}

export function gradientFlowLayout(params: TextMotionParams, size: MotionFrameSize): GradientFlowLayout {
  const safe = titleSafeBox(size);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const offsetX = safe.cx - (text.ink.x0 + text.ink.x1) / 2, offsetY = safe.cy - (text.ink.y0 + text.ink.y1) / 2;
  return {
    pathD: compactPathD(text.block.pathD), offsetX, offsetY,
    x0: text.ink.x0 + offsetX, y0: text.ink.y0 + offsetY, x1: text.ink.x1 + offsetX, y1: text.ink.y1 + offsetY,
    period: T55_PERIOD * (text.ink.x1 - text.ink.x0), colors: flowColors(params.palette, textBackdrop(params)),
  };
}

const AXIS: readonly [number, number] = [Math.cos((T55_LEAN * Math.PI) / 180), Math.sin((T55_LEAN * Math.PI) / 180)];

export const T55_gradientFlow = defineTextMotion(ID, (params, t, size) => {
  const layout = gradientFlowLayout(params, size);
  const doc = createTextDocument(size, params);
  // One period scrolls by per loop along the gradient axis (right and slightly down, so the bands lean /). The gradient is in
  // userSpaceOnUse, i.e. the path's own (block) coordinates inside the centring translate; it starts one period before the
  // ink box's left-centre and reaches it at the loop's end.
  const shift = layout.period * (loopPhase(t, T55_LOOP_SECONDS) - 1);
  const x = layout.x0 - layout.offsetX + shift * AXIS[0], y = (layout.y0 + layout.y1) / 2 - layout.offsetY + shift * AXIS[1];
  const fill = doc.linearGradient({
    x1: x, y1: y, x2: x + layout.period * AXIS[0], y2: y + layout.period * AXIS[1], spread: "repeat", stops: flowStops(layout.colors),
  });
  return doc.render(g({ transform: tf.translate(layout.offsetX, layout.offsetY) }, path(layout.pathD, { fill })));
}, { revision: REVISION });
