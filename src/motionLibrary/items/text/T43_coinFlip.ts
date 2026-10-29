import { mixHex } from "../../svg/color";
import { g, path, transform, tf } from "../../svg/document";
import { energyProfile, smoothstep, wrap } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T43 Coin Flip (擲硬幣), DRAMA, designed on the paper plate. Each character flips
 * like a coin: rotateY 0 → 360° at a constant spin, drawn as scaleX = cos θ about
 * the glyph's centre. While cos θ < 0 the glyph shows its back face: mirrored (the
 * negative scale does that) and 15% darker (mixed toward the palette ink). Each
 * flip rides a parabolic hop of 35% of the glyph height (0.18 s up, 0.18 s down)
 * and lands with a scaleY 0.92 squash on its floor for 2 frames (0.067 s, easing
 * back over the second frame). Characters flip one after another, 0.12 s apart,
 * then rest: a seamless 1.2 s loop (catalog loopSeconds; frame 0 equals the frame
 * at 1.2 s). Long lines tighten the stagger so the last landing still fits the
 * loop. Colours alternate the readable text role and secondaryTone (ART_DIRECTION §0:
 * ink and accent2 on the paper plate, where the lime accent cannot be read; paper and
 * lime on a dark card). The word is sized with heroTextBox. Energy scales the hop height and the pace.
 */

const ID = "T43";
/** Art revision (part of the clip cache key): 1 = first render; 2 = self-review fix after the first contact sheet (larger layout budget (two-line text in landscape kept above 9% of the short side)); 3 = ART_DIRECTION §0 (hero size, tight tracking, secondaryTone). */
const REVISION = 3;
export const T43_LOOP_SECONDS = 1.2;
const FLIP = 0.36, SQUASH = 0.067, STAGGER = 0.12, REST = 0.1;
const HOP = 0.35, SQUASH_Y = 0.92, BACK_DARKEN = 0.15;

export interface CoinGlyph {
  readonly pathD: string;
  /** Pen origin (frame px, on the baseline). */
  readonly x: number;
  readonly y: number;
  /** Flip axis (ink centre x) and squash floor (ink bottom), frame px. */
  readonly axisX: number;
  readonly floorY: number;
  readonly height: number;
  readonly color: string;
  readonly backColor: string;
}

export interface CoinFlipLayout {
  readonly glyphs: readonly CoinGlyph[];
  /** Ink box at rest, frame px. */
  readonly box: GlyphBox;
  readonly fontSize: number;
  readonly flipSeconds: number;
  readonly squashSeconds: number;
  readonly staggerSeconds: number;
  readonly hop: number;
}

/** Glyphs, colours and loop timing (shared by the generator and its tests). */
export function coinFlipLayout(params: TextMotionParams, size: MotionFrameSize): CoinFlipLayout {
  const energy = energyProfile(params.energy);
  const hop = HOP * energy.amplitude;
  const safe = titleSafeBox(size);
  // Hero size (ART_DIRECTION §0); the height keeps room for the hop above each line.
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { heightFill: Math.min(0.62, 0.9 / (1 + hop)) }), lineHeight: 1.08 + hop, tracking: displayTracking(params.lines),
  });
  const { ink } = text;
  // Centre the rest word plus its hop headroom: the word sits a little below the middle.
  const lift = (hop * (ink.y1 - ink.y0)) / (2 * Math.max(1, text.block.lines.length));
  const offsetX = safe.cx - (ink.x0 + ink.x1) / 2, offsetY = safe.cy + lift - (ink.y0 + ink.y1) / 2;
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const secondary = secondaryTone(params.palette, backdrop);
  const glyphs: CoinGlyph[] = [];
  for (const line of text.block.lines) {
    for (const glyph of line.layout.glyphs) {
      if (glyph.whitespace || !glyph.bbox) continue;
      const x = offsetX + line.x + glyph.x, y = offsetY + line.baselineY;
      const color = glyphs.length % 2 === 0 ? primary : secondary;
      glyphs.push({
        pathD: glyph.pathD, x, y, axisX: x + (glyph.bbox.x0 + glyph.bbox.x1) / 2, floorY: y + glyph.bbox.y1,
        height: glyph.bbox.y1 - glyph.bbox.y0, color, backColor: mixHex(color, params.palette.ink, BACK_DARKEN),
      });
    }
  }
  const count = Math.max(1, glyphs.length);
  // Pace: energy time, tightened so that every flip (and its squash) lands inside the loop with a short rest.
  const pace = Math.min(energy.time, (T43_LOOP_SECONDS - REST) / (FLIP + SQUASH));
  const flipSeconds = FLIP * pace, squashSeconds = SQUASH * pace;
  const staggerSeconds = count > 1 ? Math.min(STAGGER * pace, (T43_LOOP_SECONDS - REST - flipSeconds - squashSeconds) / (count - 1)) : 0;
  return {
    glyphs, fontSize: text.fontSize, flipSeconds, squashSeconds, staggerSeconds, hop,
    box: { x0: ink.x0 + offsetX, y0: ink.y0 + offsetY, x1: ink.x1 + offsetX, y1: ink.y1 + offsetY },
  };
}

export interface CoinPose {
  /** Spin angle θ (radians, 0..2π); scaleX = cos θ. */
  readonly angle: number;
  /** Lift above the rest position (px, positive = up). */
  readonly lift: number;
  readonly scaleY: number;
}

/** Pose of glyph `index` at loop time u (seconds). */
export function coinPose(layout: CoinFlipLayout, index: number, u: number): CoinPose {
  const glyph = layout.glyphs[index];
  const local = u - index * layout.staggerSeconds;
  if (local <= 0 || local >= layout.flipSeconds + layout.squashSeconds) return { angle: 0, lift: 0, scaleY: 1 };
  if (local < layout.flipSeconds) {
    const p = local / layout.flipSeconds;
    return { angle: 2 * Math.PI * p, lift: 4 * layout.hop * glyph.height * p * (1 - p), scaleY: 1 };
  }
  const q = (local - layout.flipSeconds) / layout.squashSeconds;
  return { angle: 0, lift: 0, scaleY: SQUASH_Y + (1 - SQUASH_Y) * smoothstep(0.5, 1, q) };
}

export const T43_coinFlip = defineTextMotion(ID, (params, t, size) => {
  const layout = coinFlipLayout(params, size);
  const doc = createTextDocument(size, params);
  const u = wrap(t, T43_LOOP_SECONDS);
  const parts = layout.glyphs.map((glyph, index) => {
    const pose = coinPose(layout, index, u);
    const scaleX = Math.cos(pose.angle);
    if (Math.abs(scaleX) < 0.01) return "";
    const moved = pose.lift !== 0 || pose.scaleY !== 1 || scaleX !== 1;
    if (!moved) return path(glyph.pathD, { fill: glyph.color, transform: tf.translate(glyph.x, glyph.y) });
    // Flip about the glyph's centre axis, squash on its floor, hop up.
    return g({ transform: transform(tf.translate(glyph.axisX, glyph.floorY - pose.lift), tf.scale(scaleX, pose.scaleY),
      tf.translate(glyph.x - glyph.axisX, glyph.y - glyph.floorY)) },
    path(glyph.pathD, { fill: scaleX < 0 ? glyph.backColor : glyph.color }));
  });
  return doc.render(parts);
}, { revision: REVISION });
