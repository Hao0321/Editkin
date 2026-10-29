import { fe, g, path, transform, tf } from "../../svg/document";
import { clamp01, cubicIn, cubicOut, smoothstep } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, frameUnit, heroTextBox, itemTiming, layoutFittedText, textBackdrop, textFace, textOnBackground, titleSafeBox,
  type FittedText,
} from "../shared";

/**
 * T04 Punch Zoom (パンチズーム): the word flies in from depth, scale 0.2× → 1.15×
 * in 0.22 s on an accelerating log-scale ramp (the rush toward the camera), then
 * settles to 1.0 by 0.38 s. It approaches slightly off-axis, from below right
 * (an offset of 16% / 6% of the short side that closes with the zoom). Three soft
 * ghosts trail it (CERTIFICATION r3: echoes must read as ghosts, never as a solid
 * extrusion, since thick 3D text is ART_REJECTED): each sits where the word was 1–3
 * steps of 0.05 s earlier along the approach path, is drawn 6% / 12% / 18% larger
 * than the word, behind it, at 35% / 20% / 10% in the word's own colour (same-colour
 * ghosts read as afterimages, accent-coloured ones as a second object), and the three share one
 * small Gaussian blur (σ = 1.5% of the current ink height, filter region tight
 * around their union). They die out right after the peak. On impact a
 * horizontal camera shake of ±18 px at 1080 units (the reference's ±12 px at 720)
 * decays over 0.8 s; it is clamped to 1.8% of the short side for every energy
 * (ART_DIRECTION §4: under 2% of the frame). The word holds while it keeps drifting
 * toward the camera (+3% over the hold, so the hold never goes dead), then pushes on
 * (+25%) while it fades out over 0.35 s, gone 0.12 s before the end.
 * Times are standard-energy seconds, scaled by energy and squeezed into short clips.
 */

const ID = "T04";
/** Art revision (part of the clip cache key): 1 = first render; 2 = a 3% push through the hold;
 * 3 = CERTIFICATION REVISE: the echoes become blurred, larger ghosts at 35/20/10% (no extrusion look);
 * 4 = ART_DIRECTION §0: same-colour ghosts, hero size (heroTextBox) and tight tracking. */
const REVISION = 4;
const FLY = 0.22, SETTLE = 0.16, SHAKE_SECONDS = 0.8, FADE = 0.35, TAIL = 0.12, FADE_IN = 0.05;
const NATURAL_SECONDS = FLY + SETTLE + SHAKE_SECONDS + FADE + TAIL;
const START_SCALE = 0.2, PEAK = 0.15, EXIT_GROWTH = 0.25, HOLD_DRIFT = 0.03;
/** Log-scale ramp exponent: > 1 accelerates toward the camera. */
const FLY_EXPONENT = 1.6;
const ECHO_STEP = 0.05, ECHO_OPACITY = [0.35, 0.2, 0.1], ECHO_GROWTH = 0.06, ECHO_BLUR = 0.015;
/** Echoes fade out over this long after the peak (standard seconds). */
const ECHO_TAIL = 0.08;
const SHAKE_UNITS = 18, SHAKE_HZ = 11, SHAKE_MAX = 0.018;
const LINE_HEIGHT = 1.04;
/** Start offset of the approach (fractions of the short side): below and to the right of the hold position. */
const APPROACH_X = 0.06, APPROACH_Y = 0.16;

export interface PunchZoomLayout {
  readonly text: FittedText;
  readonly timeScale: number;
  readonly peakScale: number;
  /** Clip seconds. */
  readonly landAt: number;
  readonly fadeAt: number;
  readonly goneAt: number;
  /** Peak shake in px (already clamped). */
  readonly shake: number;
  /** Ink box at the hold (1.0×, no shake), frame px. */
  readonly box: GlyphBox;
}

/** Fitted text, timing and shake amplitude (shared by the generator and its tests). */
export function punchZoomLayout(params: TextMotionParams, size: MotionFrameSize): PunchZoomLayout {
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS);
  const safe = titleSafeBox(size);
  const peakScale = 1 + PEAK * energy.scaleDepth;
  // Hero size (ART_DIRECTION §0) with room for the +3% hold drift.
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom: 1 + HOLD_DRIFT }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const { ink, inkCenter } = text;
  const goneAt = params.durationSeconds - TAIL * timeScale;
  return {
    text, timeScale, peakScale,
    landAt: (FLY + SETTLE) * timeScale,
    fadeAt: goneAt - FADE * timeScale, goneAt,
    shake: Math.min(SHAKE_UNITS * frameUnit(size) * energy.amplitude, SHAKE_MAX * Math.min(size.width, size.height)),
    box: { x0: safe.cx + ink.x0 - inkCenter[0], y0: safe.cy + ink.y0 - inkCenter[1], x1: safe.cx + ink.x1 - inkCenter[0], y1: safe.cy + ink.y1 - inkCenter[1] },
  };
}

/** Word scale and remaining approach (1 = at the start offset, 0 = home) at clip time t (before the exit push). */
function flyPose(t: number, layout: PunchZoomLayout): { readonly scale: number; readonly away: number } {
  const fly = FLY * layout.timeScale, settle = SETTLE * layout.timeScale;
  if (t <= 0) return { scale: START_SCALE, away: 1 };
  if (t < fly) {
    const ramp = (t / fly) ** FLY_EXPONENT;
    return { scale: START_SCALE * (layout.peakScale / START_SCALE) ** ramp, away: 1 - ramp };
  }
  if (t < fly + settle) return { scale: layout.peakScale + (1 - layout.peakScale) * cubicOut((t - fly) / settle), away: 0 };
  return { scale: 1, away: 0 };
}

/** Horizontal camera shake (px) at clip time t: a decaying 11 Hz sway from the impact at the peak. */
export function punchZoomShake(t: number, layout: PunchZoomLayout, phase: number): number {
  const impact = FLY * layout.timeScale, span = SHAKE_SECONDS * layout.timeScale;
  if (t <= impact || t >= impact + span) return 0;
  const p = (t - impact) / span;
  return layout.shake * (1 - p) ** 2 * Math.sin(2 * Math.PI * SHAKE_HZ * (t - impact) + phase);
}

export const T04_punchZoom = defineTextMotion(ID, (params, t, size) => {
  const layout = punchZoomLayout(params, size);
  const doc = createTextDocument(size, params);
  if (t >= layout.goneAt) return doc.render();
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  // Same-colour ghosts: afterimages of the word itself (paper on a dark card, ink on accent or cream).
  const echoColor = textColor;
  const { text } = layout;
  const cx = (layout.box.x0 + layout.box.x1) / 2, cy = (layout.box.y0 + layout.box.y1) / 2;
  // The shake starts on a seeded phase so different seeds sway differently; the sine starts at the impact.
  const phase = createSeededRng(ID, params.seed, "shake").range(-0.4, 0.4);
  const dx = punchZoomShake(t, layout, phase);

  const short = Math.min(size.width, size.height);
  const pose = flyPose(t, layout);
  let scale = pose.scale;
  // A slow push through the hold (linear, so it never stalls), carried on into the exit.
  if (t > layout.landAt) scale *= 1 + HOLD_DRIFT * clamp01((t - layout.landAt) / (layout.fadeAt - layout.landAt));
  let opacity = clamp01(t / (FADE_IN * layout.timeScale));
  if (t > layout.fadeAt) {
    const p = (t - layout.fadeAt) / (layout.goneAt - layout.fadeAt);
    scale *= 1 + EXIT_GROWTH * cubicIn(p);
    opacity *= 1 - p;
  }
  const placed = (s: number, away: number, fill: string, alpha: number) => g({
    opacity: alpha < 1 ? alpha : undefined,
    transform: transform(tf.translate(cx + dx + APPROACH_X * short * away, cy + APPROACH_Y * short * away), tf.scale(s),
      tf.translate(-text.inkCenter[0], -text.inkCenter[1])),
  }, path(text.block.pathD, { fill }));

  // Ghosts: where the word was 1–3 steps earlier along its path, drawn larger than the word, behind it, faintest
  // (oldest) first, under one small blur; they fade out right after the peak.
  const peakAt = FLY * layout.timeScale;
  const echoFade = 1 - smoothstep(peakAt, peakAt + ECHO_TAIL * layout.timeScale, t);
  const ghosts: string[] = [];
  const halfW = (text.ink.x1 - text.ink.x0) / 2, halfH = (text.ink.y1 - text.ink.y0) / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  if (echoFade > 0.002) {
    for (let k = ECHO_OPACITY.length; k >= 1; k -= 1) {
      const past = t - k * ECHO_STEP * layout.timeScale;
      if (past < 0) continue;
      const alpha = ECHO_OPACITY[k - 1] * echoFade * clamp01(past / (FADE_IN * layout.timeScale));
      if (alpha <= 0.002) continue;
      const away = flyPose(past, layout).away, ghostScale = scale * (1 + ECHO_GROWTH * k);
      const gx = cx + dx + APPROACH_X * short * away, gy = cy + APPROACH_Y * short * away;
      x0 = Math.min(x0, gx - halfW * ghostScale); x1 = Math.max(x1, gx + halfW * ghostScale);
      y0 = Math.min(y0, gy - halfH * ghostScale); y1 = Math.max(y1, gy + halfH * ghostScale);
      ghosts.push(placed(ghostScale, away, echoColor, alpha));
    }
  }
  let trail = "";
  if (ghosts.length) {
    const sigma = Math.max(0.5, ECHO_BLUR * 2 * halfH * scale), pad = 3 * sigma;
    const rx0 = Math.max(0, x0 - pad), ry0 = Math.max(0, y0 - pad), rx1 = Math.min(size.width, x1 + pad), ry1 = Math.min(size.height, y1 + pad);
    if (rx1 > rx0 && ry1 > ry0) {
      const blur = doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: sigma }), { x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 });
      trail = g({ filter: blur }, ghosts);
    }
  }
  const word = opacity > 0.002 ? placed(scale, pose.away, textColor, opacity) : "";
  return doc.render(trail, word);
}, { revision: REVISION });
