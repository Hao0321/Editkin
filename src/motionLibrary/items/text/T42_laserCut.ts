import { circle, ellipse, g, path, rect, transform, tf } from "../../svg/document";
import { backOut, clamp01, energyProfile, expoInOut, sineInOut, smoothstep, wrap } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  backdropTone, createTextDocument, displayTracking, frameUnit, heroTextBox, layoutFittedText, readableColor, secondaryTone, textBackdrop, textFace,
  textOnBackground, titleSafeBox, type FittedText,
} from "../shared";

/**
 * T42 Laser Cut (雷射切割), DRAMA, shown on the bg plate: paper glyphs and a lime
 * (accent) laser with a paper core (ART_DIRECTION §0; on an accent or cream plate the
 * glyphs turn ink and the glow takes accent2, via secondaryTone). A seamless 1.8 s
 * loop (catalog loopSeconds); the whole word shows 0.0–0.25 s.
 * - Laser, 0.25–0.55 s: a head (paper dot in a radial glow with a
 *   horizontal flare streak) sweeps left to right across the frame along the word's
 *   vertical middle (sineInOut), trailing a beam back to the frame's left edge: a
 *   paper core 4 units thick (the reference's 2 px at 720, a touch heavier so it
 *   survives phone size) inside a 64-unit glow band (a vertical gradient,
 *   no filter).
 * - Cut at 0.55 s: every glyph is clipped (clipPath halves) along the beam. In
 *   0.2 s (backOut) the top half slides 6% of the word width right and 3% up, the
 *   bottom half 6% left and 3% down; the beam fades to a 20% line.
 * - Hold split 0.75–1.5 s, then the halves rejoin in 0.2 s (expoInOut) while the
 *   line fades out; whole again from 1.7 s until the loop wraps.
 * Energy scales the offsets (amplitude) and the pace (time), always inside the
 * 1.8 s loop.
 */

const ID = "T42";
/** Art revision (part of the clip cache key): 1 = first render; 2 = ART_DIRECTION §0 (bg plate, lime laser with a paper core, hero size, tight tracking). */
const REVISION = 2;
export const T42_LOOP_SECONDS = 1.8;
const LASER_AT = 0.25, LASER = 0.3, SPLIT = 0.2, REJOIN_AT = 1.5, REJOIN = 0.2;
const SHIFT_X = 0.06, SHIFT_Y = 0.03, LINGER = 0.2;
/** Beam core and glow band thickness, head dot and glow radius, head flare half-length and half-height, in 1080 units. */
const CORE_UNITS = 4, BAND_UNITS = 64, HEAD_UNITS = 14, HEAD_GLOW_UNITS = 120, FLARE_UNITS = 260, FLARE_HEIGHT_UNITS = 16;

export interface LaserCutLayout {
  readonly text: FittedText;
  /** Ink box of the whole word at rest, frame px. */
  readonly box: GlyphBox;
  /** The cut line (frame px). */
  readonly cutY: number;
  readonly timeScale: number;
  readonly amplitude: number;
  /** Phase boundaries inside the loop (seconds). */
  readonly laserStart: number;
  readonly cutAt: number;
  readonly splitEnd: number;
  readonly rejoinStart: number;
  readonly rejoinEnd: number;
}

/** Word fit and loop timing (shared by the generator and its tests). */
export function laserCutLayout(params: TextMotionParams, size: MotionFrameSize): LaserCutLayout {
  const energy = energyProfile(params.energy);
  const safe = titleSafeBox(size);
  // Room for the split: the halves move 6% sideways each way at the energy's amplitude.
  const spread = 1 + 2 * SHIFT_X * energy.amplitude;
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom: spread }), lineHeight: 1.04, tracking: displayTracking(params.lines),
  });
  const { ink, inkCenter } = text;
  const box = { x0: safe.cx + ink.x0 - inkCenter[0], y0: safe.cy + ink.y0 - inkCenter[1], x1: safe.cx + ink.x1 - inkCenter[0], y1: safe.cy + ink.y1 - inkCenter[1] };
  // Energy paces the beats but every phase stays inside the loop (the default program spans 0.25–1.7 s).
  const timeScale = Math.min(energy.time, (T42_LOOP_SECONDS - 0.1) / (REJOIN_AT + REJOIN));
  const laserStart = LASER_AT * timeScale, cutAt = (LASER_AT + LASER) * timeScale;
  return {
    text, box, cutY: (box.y0 + box.y1) / 2, timeScale, amplitude: energy.amplitude,
    laserStart, cutAt, splitEnd: cutAt + SPLIT * timeScale, rejoinStart: REJOIN_AT * timeScale, rejoinEnd: (REJOIN_AT + REJOIN) * timeScale,
  };
}

/** How far apart the halves are (0 = whole, 1 = fully split; backOut overshoots a little) at loop time u. */
export function laserSplitAmount(u: number, layout: LaserCutLayout): number {
  if (u < layout.cutAt || u >= layout.rejoinEnd) return 0;
  if (u < layout.splitEnd) return backOut((u - layout.cutAt) / (layout.splitEnd - layout.cutAt));
  if (u < layout.rejoinStart) return 1;
  return 1 - expoInOut((u - layout.rejoinStart) / (layout.rejoinEnd - layout.rejoinStart));
}

export const T42_laserCut = defineTextMotion(ID, (params, t, size) => {
  const layout = laserCutLayout(params, size);
  const doc = createTextDocument(size, params);
  const u = wrap(t, T42_LOOP_SECONDS);
  const unit = frameUnit(size);
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  // ART_DIRECTION §0: the accent laser on a dark card (accent2 on accent or cream); a white-hot paper core on dark,
  // elsewhere the core is read against the glow colour.
  const glow = secondaryTone(params.palette, backdrop);
  const core = backdropTone(params.palette, backdrop) === "dark" ? params.palette.paper : readableColor(glow, [params.palette.paper, textColor], 1.5);
  const { text, box, cutY } = layout;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, wordWidth = box.x1 - box.x0;
  const placement = (dx: number, dy: number) =>
    transform(tf.translate(cx + dx, cy + dy), tf.translate(-text.inkCenter[0], -text.inkCenter[1]));
  const split = laserSplitAmount(u, layout);
  const parts: string[] = [];

  if (split === 0) {
    parts.push(g({ transform: placement(0, 0) }, path(text.block.pathD, { fill: textColor })));
  } else {
    // clipPath halves along the beam, in frame coordinates; each half then slides with its clip.
    const pad = 0.25 * (box.y1 - box.y0);
    const top = doc.clipPath(rect(box.x0 - wordWidth, box.y0 - pad, 3 * wordWidth, cutY - (box.y0 - pad)));
    const bottom = doc.clipPath(rect(box.x0 - wordWidth, cutY, 3 * wordWidth, box.y1 + pad - cutY));
    const dx = SHIFT_X * wordWidth * layout.amplitude * split, dy = SHIFT_Y * wordWidth * layout.amplitude * split;
    parts.push(g({ transform: transform(tf.translate(-dx, dy)) }, g({ "clip-path": bottom }, g({ transform: placement(0, 0) }, path(text.block.pathD, { fill: textColor })))));
    parts.push(g({ transform: transform(tf.translate(dx, -dy)) }, g({ "clip-path": top }, g({ transform: placement(0, 0) }, path(text.block.pathD, { fill: textColor })))));
  }

  // Beam: sweeps with the head, then lingers as a faint line that fades out over the rejoin.
  const band = BAND_UNITS * unit, coreWidth = CORE_UNITS * unit;
  let headX: number | undefined, beamEnd = 0, beamOpacity = 0;
  if (u >= layout.laserStart && u < layout.cutAt) {
    const p = (u - layout.laserStart) / (layout.cutAt - layout.laserStart);
    headX = -HEAD_GLOW_UNITS * unit + (size.width + 2 * HEAD_GLOW_UNITS * unit) * sineInOut(p);
    beamEnd = clamp01(headX / size.width) * size.width;
    beamOpacity = 1;
  } else if (u >= layout.cutAt && u < layout.rejoinEnd) {
    beamEnd = size.width;
    const fadeToLine = smoothstep(layout.cutAt, layout.splitEnd, u);
    beamOpacity = 1 - (1 - LINGER) * fadeToLine;
    if (u >= layout.rejoinStart) beamOpacity *= 1 - smoothstep(layout.rejoinStart, layout.rejoinEnd, u);
  }
  if (beamEnd > 0 && beamOpacity > 0.002) {
    const gradient = doc.linearGradient({ x1: 0, y1: cutY - band / 2, x2: 0, y2: cutY + band / 2, stops: [
      { offset: 0, color: glow, opacity: 0 }, { offset: 0.3, color: glow, opacity: 0.35 }, { offset: 0.5, color: glow, opacity: 1 },
      { offset: 0.7, color: glow, opacity: 0.35 }, { offset: 1, color: glow, opacity: 0 }] });
    parts.push(g({ opacity: beamOpacity < 1 ? beamOpacity : undefined },
      rect(0, cutY - band / 2, beamEnd, band, { fill: gradient }),
      rect(0, cutY - coreWidth / 2, beamEnd, coreWidth, { fill: core })));
  }
  if (headX !== undefined) {
    const headGlow = doc.radialGradient({ cx: headX, cy: cutY, r: HEAD_GLOW_UNITS * unit, stops: [
      { offset: 0, color: glow, opacity: 1 }, { offset: 0.25, color: glow, opacity: 0.6 }, { offset: 1, color: glow, opacity: 0 }] });
    // Flare: a horizontal streak through the head (a radial gradient squashed by the ellipse's own bounding box).
    const flare = doc.radialGradient({ cx: 0.5, cy: 0.5, r: 0.5, units: "objectBoundingBox", stops: [
      { offset: 0, color: core, opacity: 1 }, { offset: 0.4, color: glow, opacity: 0.8 }, { offset: 1, color: glow, opacity: 0 }] });
    parts.push(circle(headX, cutY, HEAD_GLOW_UNITS * unit, { fill: headGlow }),
      ellipse(headX, cutY, FLARE_UNITS * unit, FLARE_HEIGHT_UNITS * unit, { fill: flare }),
      circle(headX, cutY, HEAD_UNITS * unit, { fill: core }));
  }
  return doc.render(parts);
}, { revision: REVISION });
