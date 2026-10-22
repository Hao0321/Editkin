import { g, rect, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import type { MotionFontSelector } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, textBackdrop, textOnBackground, titleSafeBox } from "../shared";
import { distinctFrom, marqueeRepeatStarts, marqueeStrip, marqueeUnit, marqueeUnitText, type MarqueeUnit } from "./T09_hugeTextScroll";

/**
 * T12 Diagonal Text Bands (斜め帯): solid bands at −12° (rising to the right),
 * four in portrait and three in landscape, alternate the accent and the readable
 * text colour; each repeats the text (「黎明之前・」, lines cycle across bands) in the
 * colour that reads on it, and the faces alternate gothic (Noto Sans TC 900) and
 * mincho (Noto Serif TC 900). Adjacent bands scroll in opposite directions at
 * slightly different speeds. The bands run edge to edge by definition (the effect
 * bleeds along its length); band centres stay inside the 5% title-safe box and the
 * text is at least 9% of the short side.
 *
 * A seamless 4 s loop (catalog loopSeconds): each band advances a whole number of
 * repeats per loop. Energy scales the speeds (whole repeats only).
 */

const ID = "T12";
const REVISION = 1;
export const T12_LOOP_SECONDS = 4;
export const T12_ANGLE = -12;
/** Band thickness from the stack: bands + gaps (× thickness) fill this share of the safe height. */
const STACK_SHARE = 0.8, GAP = 0.36, TEXT_EM = 0.6, TRACKING = -0.04;
/** Target speed (short sides per second) and per-band variation. */
const SPEED = 0.26, SPEED_VARIATION: readonly number[] = [1, 0.8, 1.2, 0.9];

export interface DiagonalBand {
  /** Gothic (display 900) or mincho (serif 900), alternating from the first band. */
  readonly face: MotionFontSelector;
  readonly unit: MarqueeUnit;
  /** Band centre (frame px); the band runs at T12_ANGLE through it. */
  readonly cx: number;
  readonly cy: number;
  readonly thickness: number;
  readonly color: string;
  readonly textColor: string;
  readonly baseline: number;
  /** Whole repeats per loop, signed (positive moves toward −x along the band). */
  readonly repeatsPerLoop: number;
}

export interface DiagonalBandsPlan {
  readonly bands: readonly DiagonalBand[];
  /** Half the band length (px): long enough to cross the frame at the angle. */
  readonly halfLength: number;
}

export function diagonalBandsPlan(params: TextMotionParams, size: MotionFrameSize): DiagonalBandsPlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const count = size.height > size.width * 1.2 ? 4 : 3;
  const thickness = (STACK_SHARE * safe.height) / (count + (count - 1) * GAP);
  const pitch = ((1 + GAP) * thickness) / Math.cos((T12_ANGLE * Math.PI) / 180);
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const accentBand = distinctFrom(backdrop, params.palette.accent, [params.palette.accent2, primary]);
  const speedScale = energyProfile(params.energy).amplitude;
  const bands: DiagonalBand[] = [];
  for (let index = 0; index < count; index += 1) {
    const face: MotionFontSelector = index % 2 === 0 ? { font: "display", weight: 900 } : { font: "serif", weight: 900 };
    const text = marqueeUnitText(params.lines[index % params.lines.length], face);
    const probe = marqueeUnit(text, face, 100, TRACKING);
    // Size by ink height so gothic and mincho bands carry the same visual size.
    const fontSize = (TEXT_EM * thickness * 0.96 / Math.max(1, probe.ink.y1 - probe.ink.y0)) * 100;
    const unit = marqueeUnit(text, face, fontSize, TRACKING);
    const color = index % 2 === 0 ? accentBand : primary;
    const target = SPEED * short * SPEED_VARIATION[index % SPEED_VARIATION.length] * speedScale * T12_LOOP_SECONDS;
    const repeats = Math.max(1, Math.round(target / unit.period));
    bands.push({
      face, unit, cx: size.width / 2, cy: safe.cy + (index - (count - 1) / 2) * pitch, thickness, color,
      textColor: textOnBackground(params.palette, color), baseline: -(unit.ink.y0 + unit.ink.y1) / 2,
      repeatsPerLoop: (index % 2 === 0 ? 1 : -1) * repeats,
    });
  }
  return { bands, halfLength: Math.hypot(size.width, size.height) / 2 + thickness };
}

export const T12_diagonalTextBands = defineTextMotion(ID, (params, t, size) => {
  const plan = diagonalBandsPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T12_LOOP_SECONDS);
  const half = plan.halfLength;
  const bands = plan.bands.map(band => {
    const starts = marqueeRepeatStarts(band.unit, -half, band.repeatsPerLoop * u, -half, half);
    return g({ transform: transform(tf.translate(band.cx, band.cy), tf.rotate(T12_ANGLE)) },
      rect(-half, -band.thickness / 2, 2 * half, band.thickness, { fill: band.color }),
      marqueeStrip(band.unit, starts, band.baseline, band.textColor, band.textColor));
  });
  return doc.render(bands);
}, { revision: REVISION });
