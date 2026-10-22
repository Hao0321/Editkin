import { circle, g, line, path, tf, transform } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type MotionPalette, type TextMotionParams } from "../../types";
import {
  backdropTone, createTextDocument, displayTracking, heroTextBox, layoutFittedText, placeWordGlyphs, readableColor, secondaryTone, textBackdrop,
  textFace, textOnBackground, titleSafeBox, type WordGlyph,
} from "../shared";

/**
 * T59 Text Flag (迎風旗幟), PHYSICS, shown on the paper plate: the characters are
 * a flag flying from a slim pole on the left. Each character rides
 * y = A(x)·sin(2πt/1.6 − k·x), with x measured from the pole; the amplitude grows
 * from 0 at the pole to 22% of the glyph height at the free end (∝ (x/L)^1.25, so
 * the cloth near the pole stays taut), and k fits about one wavelength along the
 * flag, so the wave travels out from the pole to the free end. Each character tilts
 * with the cloth's slope (×0.8) and narrows (scaleX = 1 − 0.08·|slope|), so the
 * folds read as cloth turning away. The pole (the text colour, 7% of the glyph
 * height wide, round caps) rises a quarter glyph above the flag and runs a glyph
 * below it; a small finial in the second tone tops it.
 *
 * A seamless 1.6 s loop (catalog loopSeconds): the wave is a function of the loop
 * phase. Energy scales the amplitude (and with it the tilt), never the period.
 *
 * Colours: ink characters with every other one in the accent on the cream card, as
 * in the reference (violet reads at 2.7:1 on cream, enough for type this large; a
 * palette whose accent fails 2.5:1 falls back to the deep shade); elsewhere the
 * readable text role and the §0 second tone (cream and violet on the dark card).
 * The flag and its pole fill about 85% of the title-safe width (the fit leaves room
 * for the free end's tilted corners), and the pole, the swing and the tilted corners
 * all stay inside the safe box.
 */

const ID = "T59";
const REVISION = 1;
export const T59_LOOP_SECONDS = 1.6;
/** Free-end amplitude (× glyph height), tilt factor, narrowing factor, amplitude growth exponent. */
export const T59_AMPLITUDE = 0.22, T59_TILT = 0.8, T59_NARROW = 0.08, T59_GROWTH = 1.25;
/** Pole: gap to the first glyph, width, rise above and run below the flag (× glyph height); finial radius. */
const POLE_GAP = 0.2, POLE_WIDTH = 0.07, POLE_ABOVE = 0.25, POLE_BELOW = 1.0, FINIAL = 0.09;
/** The finial's centre sits this many radii above the pole top. */
const FINIAL_LIFT = 0.6;
/** Word fill of the safe width (the pole takes the rest of the 80–90% band). */
const FILL = 0.83, LINE_HEIGHT = 1.12;

export interface FlagGlyph extends WordGlyph {
  readonly color: string;
  /** Distance from the pole to the ink centre (px). */
  readonly along: number;
}

export interface TextFlagPlan {
  readonly glyphs: readonly FlagGlyph[];
  readonly glyphHeight: number;
  /** Pole axis x and its top / bottom (frame px), stroke width, finial radius. */
  readonly poleX: number;
  readonly poleTop: number;
  readonly poleBottom: number;
  readonly poleWidth: number;
  readonly finial: number;
  /** Flag length L (pole → last ink centre), free-end amplitude (px), wavenumber k (rad/px). */
  readonly length: number;
  readonly amplitude: number;
  readonly k: number;
  readonly poleColor: string;
  readonly finialColor: string;
  /** Ink box of the flag at rest (frame px). */
  readonly box: GlyphBox;
}

/** Ink and the accent on a cream card when the accent reads at 2.5:1 (the reference); otherwise the §0 pair. */
export function flagTones(palette: MotionPalette, backdrop: string): readonly [string, string] {
  const first = textOnBackground(palette, backdrop);
  if (backdropTone(palette, backdrop) === "light") return [first, readableColor(backdrop, [palette.accent, palette.accent2, first], 2.5)];
  return [first, secondaryTone(palette, backdrop)];
}

export function textFlagPlan(params: TextMotionParams, size: MotionFrameSize): TextFlagPlan {
  const safe = titleSafeBox(size), hero = heroTextBox(size, { fill: FILL });
  const energy = Math.min(1.5, energyProfile(params.energy).amplitude);
  const block = POLE_ABOVE + (1 + FINIAL_LIFT) * FINIAL + 1 + POLE_BELOW;
  // The free end tilts up to θ = 0.8·atan(A·k) at the shortest wavelength (2.4 glyph heights); its outer corners then reach
  // e = (cos θ + sin θ − 1) / 2 glyph heights past the rest edge. With the flag k glyph heights wide, the pole, flag and
  // that swing fit 98% of the safe width: maxWidth = 0.98·safe width·k / (k + pole span + e).
  const face = textFace(params.font, 900), tracking = displayTracking(params.lines);
  const probeText = layoutFittedText(params.lines, face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: 100, lineHeight: LINE_HEIGHT, tracking });
  const probeH = placeWordGlyphs(probeText, 0, 0).glyphHeight, k = (probeText.ink.x1 - probeText.ink.x0) / probeH;
  const tilt = T59_TILT * Math.atan((T59_AMPLITUDE * energy * 2 * Math.PI) / 2.4);
  const swing = Math.max(0, (Math.cos(tilt) + Math.sin(tilt) - 1) / 2), poleShare = POLE_GAP + POLE_WIDTH / 2;
  const text = layoutFittedText(params.lines, face, {
    maxWidth: Math.min(hero.maxWidth, (0.98 * safe.width * k) / (k + poleShare + swing)),
    maxHeight: Math.min(hero.maxHeight, (0.94 * safe.height) / block), maxSize: hero.maxSize, lineHeight: LINE_HEIGHT, tracking,
  });
  const probe = placeWordGlyphs(text, 0, 0);
  const h = probe.glyphHeight;
  const inkW = text.ink.x1 - text.ink.x0, inkH = text.ink.y1 - text.ink.y0;
  const poleSpan = poleShare * h;
  // Centre the pole + flag (+ the free end's swing) horizontally and the pole's full run vertically.
  const totalW = poleSpan + inkW + swing * h;
  const dx = safe.cx - totalW / 2 + poleSpan - text.ink.x0;
  const top = -(POLE_ABOVE + (1 + FINIAL_LIFT) * FINIAL) * h, bottom = inkH + POLE_BELOW * h;
  const dy = safe.cy - (top + bottom) / 2 - text.ink.y0;
  const { glyphs, glyphHeight } = placeWordGlyphs(text, dx, dy);
  const poleX = text.ink.x0 + dx - POLE_GAP * h;
  const [first, second] = flagTones(params.palette, textBackdrop(params));
  const flag = glyphs.map((glyph, index) => ({ ...glyph, color: index % 2 === 0 ? first : second, along: glyph.cx - poleX }));
  const length = Math.max(...flag.map(glyph => glyph.along), h);
  // About one wavelength along the flag, kept between 2.4 and 4 glyph heights (cloth folds have a physical size).
  const wavelength = clamp(0.95 * length, 2.4 * h, 4 * h);
  const inkTop = text.ink.y0 + dy;
  return {
    glyphs: flag, glyphHeight, poleX, poleTop: inkTop - POLE_ABOVE * h, poleBottom: inkTop + inkH + POLE_BELOW * h,
    poleWidth: POLE_WIDTH * h, finial: FINIAL * h, length, amplitude: T59_AMPLITUDE * glyphHeight * energy, k: (2 * Math.PI) / wavelength,
    poleColor: first, finialColor: second,
    box: { x0: text.ink.x0 + dx, y0: inkTop, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
  };
}

export interface FlagPose {
  readonly dy: number;
  /** Clockwise degrees about the ink centre. */
  readonly rotation: number;
  readonly scaleX: number;
}

/** Cloth pose of a point `along` px from the pole at loop phase u. */
export function flagPose(plan: TextFlagPlan, along: number, u: number): FlagPose {
  const x = Math.max(0, along), share = Math.min(1, x / plan.length);
  const a = plan.amplitude * share ** T59_GROWTH;
  const da = share > 0 ? (plan.amplitude * T59_GROWTH * share ** (T59_GROWTH - 1)) / plan.length : 0;
  const phase = 2 * Math.PI * u - plan.k * x;
  const slope = da * Math.sin(phase) - a * plan.k * Math.cos(phase);
  return { dy: a * Math.sin(phase), rotation: (T59_TILT * Math.atan(slope) * 180) / Math.PI, scaleX: 1 - T59_NARROW * Math.abs(slope) };
}

export const T59_textFlag = defineTextMotion(ID, (params, t, size) => {
  const plan = textFlagPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T59_LOOP_SECONDS);
  const pole = [
    line(plan.poleX, plan.poleTop, plan.poleX, plan.poleBottom, { stroke: plan.poleColor, "stroke-width": plan.poleWidth, "stroke-linecap": "round" }),
    circle(plan.poleX, plan.poleTop - plan.finial * FINIAL_LIFT, plan.finial, { fill: plan.finialColor }),
  ];
  const parts = plan.glyphs.map(glyph => {
    const pose = flagPose(plan, glyph.along, u);
    return path(glyph.pathD, {
      fill: glyph.color,
      transform: transform(tf.translate(glyph.cx, glyph.cy + pose.dy), tf.rotate(pose.rotation), tf.scale(pose.scaleX, 1), tf.translate(glyph.x - glyph.cx, glyph.y - glyph.cy)),
    });
  });
  return doc.render(g(undefined, pole), g(undefined, parts));
}, { revision: REVISION });
