import { g, path, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  backdropTone, createTextDocument, heroTextBox, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T50 Stop Motion (定格動畫), PLAY, shown on the accent plate: every 1/8 s each
 * character snaps to a new seeded pose (offset ±3% of the glyph size, rotation
 * ±6°, scale 0.96–1.04, about its own ink centre) with no in-betweens, so the word
 * judders like a stop-motion shoot at 8 poses per second whatever the project fps:
 * the pose index is floor(t · 8), a function of time alone. The 2 s loop (catalog
 * loopSeconds) holds 16 poses and the 17th is the first again, so frame 0 equals
 * the frame at 2 s.
 *
 * Colours: ink glyphs with every other character cream on the coral card, as in
 * the reference; elsewhere the readable text role and the second tone (cream and
 * coral on the dark card, ART_DIRECTION §0). The word is hero-sized (heroTextBox)
 * with headroom for the largest pose, so every glyph stays inside the 5% title-safe
 * box in every pose; it is letter-spaced +0.06 em (not the tight display tracking)
 * so neighbours posing toward each other never pile up. Energy scales the pose
 * amplitudes.
 */

const ID = "T50";
const REVISION = 1;
export const T50_LOOP_SECONDS = 2;
export const T50_POSES_PER_SECOND = 8;
/** Pose ranges: offset (× glyph size), rotation (degrees), scale. */
export const T50_OFFSET = 0.03, T50_ROTATION = 6, T50_SCALE: readonly [number, number] = [0.96, 1.04];
const LINE_HEIGHT = 1.1;
/** Letter-spaced, not tight: at −0.04 em two neighbours posing toward each other would overlap (up to 0.2 em of jitter between them). */
export const T50_TRACKING = 0.06;

export interface StopMotionGlyph {
  readonly index: number;
  readonly pathD: string;
  /** Pen origin (frame px) and ink centre (frame px). */
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly box: GlyphBox;
  readonly color: string;
}

export interface StopMotionPlan {
  readonly glyphs: readonly StopMotionGlyph[];
  /** Glyph size (px): the tallest ink height. */
  readonly glyphSize: number;
  /** Pose amplitude multiplier (energy). */
  readonly amplitude: number;
}

export function stopMotionPlan(params: TextMotionParams, size: MotionFrameSize): StopMotionPlan {
  const amplitude = Math.min(1.5, energyProfile(params.energy).amplitude);
  // Headroom for the largest pose: scale up 4%, a 6° turn and a 3% shift of each glyph.
  const headroom = (1 + (T50_SCALE[1] - 1) * amplitude) * (1 + 0.1 * amplitude) + 2 * T50_OFFSET * amplitude;
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom }), lineHeight: LINE_HEIGHT, tracking: T50_TRACKING,
  });
  const safe = titleSafeBox(size);
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const backdrop = textBackdrop(params);
  const accentCard = backdropTone(params.palette, backdrop) === "accent";
  // The reference alternates ink and cream on the coral card; elsewhere the §0 two-tone pair.
  const first = textOnBackground(params.palette, backdrop);
  const second = accentCard ? (first === params.palette.ink ? params.palette.paper : params.palette.ink) : secondaryTone(params.palette, backdrop);
  const glyphs: StopMotionGlyph[] = [];
  let glyphSize = 0;
  for (const placed of text.block.lines) {
    for (const glyph of placed.layout.glyphs) {
      if (glyph.whitespace || !glyph.bbox) continue;
      const x = dx + placed.x + glyph.x, y = dy + placed.baselineY;
      glyphSize = Math.max(glyphSize, glyph.bbox.y1 - glyph.bbox.y0);
      glyphs.push({
        index: glyphs.length, pathD: compactPathD(glyph.pathD), x, y,
        cx: x + (glyph.bbox.x0 + glyph.bbox.x1) / 2, cy: y + (glyph.bbox.y0 + glyph.bbox.y1) / 2,
        box: { x0: x + glyph.bbox.x0, y0: y + glyph.bbox.y0, x1: x + glyph.bbox.x1, y1: y + glyph.bbox.y1 },
        color: glyphs.length % 2 === 0 ? first : second,
      });
    }
  }
  if (!(glyphSize > 0)) glyphSize = text.fontSize * 0.88;
  return { glyphs, glyphSize, amplitude };
}

/** Pose index at time t: floor(t · 8) within the loop's 16 poses (fps independent). */
export function stopMotionPoseIndex(t: number): number {
  const poses = T50_LOOP_SECONDS * T50_POSES_PER_SECOND;
  return Math.floor(loopPhase(t, T50_LOOP_SECONDS) * poses + 1e-6) % poses;
}

export interface StopMotionPose { readonly dx: number; readonly dy: number; readonly rotation: number; readonly scale: number }

/** The seeded pose of glyph `index` for pose `pose` (the same seed, glyph and pose always give the same pose). */
export function stopMotionPose(plan: StopMotionPlan, seed: number, index: number, pose: number): StopMotionPose {
  const rng = createSeededRng(ID, seed, `pose:${index}:${pose}`);
  const a = plan.amplitude, offset = T50_OFFSET * plan.glyphSize * a;
  return {
    dx: rng.range(-offset, offset), dy: rng.range(-offset, offset), rotation: rng.range(-T50_ROTATION, T50_ROTATION) * a,
    scale: 1 + (rng.range(T50_SCALE[0], T50_SCALE[1]) - 1) * a,
  };
}

export const T50_stopMotion = defineTextMotion(ID, (params, t, size) => {
  const plan = stopMotionPlan(params, size);
  const doc = createTextDocument(size, params);
  const pose = stopMotionPoseIndex(t);
  const parts = plan.glyphs.map(glyph => {
    const p = stopMotionPose(plan, params.seed, glyph.index, pose);
    return path(glyph.pathD, {
      fill: glyph.color,
      transform: transform(tf.translate(glyph.cx + p.dx, glyph.cy + p.dy), tf.rotate(p.rotation), tf.scale(p.scale), tf.translate(glyph.x - glyph.cx, glyph.y - glyph.cy)),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
