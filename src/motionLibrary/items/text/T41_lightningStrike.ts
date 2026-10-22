import { mixHex } from "../../svg/color";
import { circle, fe, g, path, pathData, rect, transform, tf, type Point2, type SvgDocument } from "../../svg/document";
import { clamp01, expoOut, quadIn, sineOut, smoothstep } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
  type FittedText,
} from "../shared";

/**
 * T41 Lightning Strike (雷擊登場), DRAMA. One strike per clip (ART_DIRECTION §4:
 * ≤ 3 flashes per second; the reference's 2 s cycle gives 0.5 per second):
 * - Flash: a full-frame paper flash, 100% for 2/30 s (2 frames at 30 fps), then
 *   55% for 2/30 s, then off. Flash times are frame-based and not energy-scaled.
 * - Slam: from 0.07 s the word slams from 2.4× to 0.97× in 0.15 s (expoOut) and
 *   settles to 1.0 by 0.27 s.
 * - Bolt: a seeded jagged polyline (7–9 segments, stroke 1.2% of the short side,
 *   paper core, blurred accent glow) with one or two thinner forks, drawn down from
 *   above the frame to the top of the word in 0.04 s at 0.07 s, held to 0.25 s and
 *   faded by 0.45 s.
 * - Shockwave: an accent ring (stroke 1.2% of the short side, thinning) grows
 *   from 0.4× to 1.5× the word width over 0.5 s while it fades.
 * - Glow: a blurred accent copy of the word (σ = 3% of the glyph height) peaks at
 *   85% at 0.3 s and decays to 25% by 1.2 s, while the fill dims from paper to 85%
 *   (mixed 15% toward the backdrop).
 * Hold, then cut 0.15 s before the end (1.85 s in the default 2 s clip). Times
 * other than the flash are standard-energy seconds, scaled by energy and squeezed
 * into short clips.
 */

const ID = "T41";
/** Art revision (part of the clip cache key): 1 = first render; 2 = self-review fix after the first contact sheet (flash frames exact at 2/30 s and 4/30 s); 3 = ART_DIRECTION §0 (hero size, tight tracking, secondaryTone glow). */
const REVISION = 3;
/** Frame-based flash: frames 0–1 at 100%, frames 2–3 at 55% (at 30 fps; the same seconds at any fps). */
const FLASH_FULL = 2 / 30, FLASH_END = 4 / 30, FLASH_HALF_OPACITY = 0.55;
const SLAM_AT = 0.07, SLAM = 0.15, SETTLE = 0.12, SLAM_UNDERSHOOT = 0.97;
const BOLT_GROW = 0.04, BOLT_HOLD_UNTIL = 0.25, BOLT_GONE = 0.45;
const RING_AT = 0.12, RING_SECONDS = 0.5, RING_FROM = 0.4, RING_TO = 1.5;
const GLOW_PEAK_AT = 0.3, GLOW_LOW_AT = 1.2, GLOW_PEAK = 0.85, GLOW_LOW = 0.25, FILL_DIM = 0.15;
const CUT_BEFORE_END = 0.15;
const NATURAL_SECONDS = GLOW_LOW_AT + 0.65;
/** Slam start scale is 1 + SLAM_OVERSIZE · scaleDepth (2.4× at standard energy). */
const SLAM_OVERSIZE = 1.4;
/** Stroke widths as fractions of the short side. */
const BOLT_STROKE = 0.012, RING_STROKE = 0.012;
/** Hero size, with the height kept a little lower than heroTextBox's default so the bolt has sky above the word. */
const HEIGHT_FILL = 0.55;

export interface LightningLayout {
  readonly text: FittedText;
  readonly timeScale: number;
  readonly slamScale: number;
  /** Ink box at the hold, frame px. */
  readonly box: GlyphBox;
  readonly glyphHeight: number;
  readonly cutAt: number;
  /** Bolt polyline (frame px, top to bottom) and its forks. */
  readonly bolt: readonly Point2[];
  readonly forks: ReadonlyArray<readonly Point2[]>;
}

/** Flash opacity at clip time t: 1, then 0.55, then 0 (frame-based, not energy-scaled). */
export function lightningFlash(t: number): number {
  if (t < 0) return 0;
  if (t < FLASH_FULL) return 1;
  if (t < FLASH_END) return FLASH_HALF_OPACITY;
  return 0;
}

/** A jagged polyline from `from` to `to` with `segments` pieces and seeded sideways kinks (smaller near the ends). */
function jagged(from: Point2, to: Point2, segments: number, kink: number, rng: ReturnType<typeof createSeededRng>): Point2[] {
  const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length, ny = dx / length;
  const points: Point2[] = [from];
  for (let index = 1; index < segments; index += 1) {
    const u = (index + rng.range(-0.25, 0.25)) / segments;
    const envelope = Math.sin(Math.PI * u) ** 0.6;
    const offset = rng.range(-1, 1) * kink * envelope;
    points.push([from[0] + dx * u + nx * offset, from[1] + dy * u + ny * offset]);
  }
  points.push(to);
  return points;
}

/** Word fit, timing and the seeded bolt geometry (shared by the generator and its tests). */
export function lightningLayout(params: TextMotionParams, size: MotionFrameSize): LightningLayout {
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS);
  const safe = titleSafeBox(size);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { heightFill: HEIGHT_FILL }), lineHeight: 1.04, tracking: displayTracking(params.lines),
  });
  const { ink, inkCenter } = text;
  // The word sits a little below centre: the bolt needs the sky above it.
  const cx = safe.cx, cy = safe.cy + 0.06 * (ink.y1 - ink.y0);
  const box = { x0: cx + ink.x0 - inkCenter[0], y0: cy + ink.y0 - inkCenter[1], x1: cx + ink.x1 - inkCenter[0], y1: cy + ink.y1 - inkCenter[1] };
  let glyphHeight = 0;
  for (const line of text.block.lines) for (const glyph of line.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;

  const rng = createSeededRng(ID, params.seed, "bolt");
  const width = box.x1 - box.x0;
  const strikeX = cx + width * rng.range(-0.18, 0.18);
  const end: Point2 = [strikeX, box.y0 + 0.04 * glyphHeight];
  const start: Point2 = [strikeX + Math.min(size.width, size.height) * rng.range(-0.16, 0.16), -0.04 * size.height];
  const bolt = jagged(start, end, rng.int(7, 9), Math.hypot(end[0] - start[0], end[1] - start[1]) * 0.055, rng);
  const forks: Point2[][] = [];
  const forkCount = rng.int(1, 2);
  for (let fork = 0; fork < forkCount; fork += 1) {
    const r = rng.fork(`fork${fork}`);
    const at = bolt[Math.min(bolt.length - 2, 2 + Math.floor(r.range(0, bolt.length - 3)))];
    const main = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const angle = main + r.sign() * r.range(0.45, 0.75);
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]) * r.range(0.14, 0.24);
    forks.push(jagged(at, [at[0] + Math.cos(angle) * length, at[1] + Math.sin(angle) * length], 3, length * 0.12, r));
  }
  return {
    text, timeScale, slamScale: 1 + SLAM_OVERSIZE * energy.scaleDepth, box, glyphHeight,
    cutAt: params.durationSeconds - CUT_BEFORE_END * timeScale, bolt, forks,
  };
}

function wordScale(t: number, layout: LightningLayout): number {
  const ts = layout.timeScale, start = SLAM_AT, slam = SLAM * ts, settle = SETTLE * ts;
  if (t < start) return layout.slamScale;
  if (t < start + slam) return layout.slamScale + (SLAM_UNDERSHOOT - layout.slamScale) * expoOut((t - start) / slam);
  if (t < start + slam + settle) return SLAM_UNDERSHOOT + (1 - SLAM_UNDERSHOOT) * sineOut((t - start - slam) / settle);
  return 1;
}

/** Glow strength 0..1 of GLOW_PEAK: rises to the peak at 0.3 s, decays to GLOW_LOW by 1.2 s, then holds. */
function glowLevel(t: number, ts: number): number {
  if (t < SLAM_AT) return 0;
  const peakAt = GLOW_PEAK_AT * ts, lowAt = GLOW_LOW_AT * ts;
  if (t < peakAt) return GLOW_PEAK * smoothstep(SLAM_AT, peakAt, t);
  if (t < lowAt) return GLOW_PEAK + (GLOW_LOW - GLOW_PEAK) * smoothstep(peakAt, lowAt, t);
  return GLOW_LOW;
}

function polylineD(points: readonly Point2[]): string {
  const builder = pathData(2).M(points[0][0], points[0][1]);
  for (const point of points.slice(1)) builder.L(point[0], point[1]);
  return builder.toString();
}

/** The polyline cut to its first `fraction` of length (the bolt drawing down). */
function partial(points: readonly Point2[], fraction: number): Point2[] {
  if (fraction >= 1) return [...points];
  const lengths = points.slice(1).map((point, index) => Math.hypot(point[0] - points[index][0], point[1] - points[index][1]));
  let remaining = lengths.reduce((sum, value) => sum + value, 0) * Math.max(0, fraction);
  const result: Point2[] = [points[0]];
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining >= lengths[index]) { result.push(points[index + 1]); remaining -= lengths[index]; continue; }
    const k = remaining / (lengths[index] || 1);
    result.push([points[index][0] + (points[index + 1][0] - points[index][0]) * k, points[index][1] + (points[index + 1][1] - points[index][1]) * k]);
    break;
  }
  return result;
}

function drawBolt(doc: SvgDocument, layout: LightningLayout, t: number, core: string, glow: string, short: number): string {
  const ts = layout.timeScale;
  if (t < SLAM_AT || t >= BOLT_GONE * ts) return "";
  const grow = clamp01((t - SLAM_AT) / (BOLT_GROW * ts));
  const fade = t < BOLT_HOLD_UNTIL * ts ? 1 : 1 - smoothstep(BOLT_HOLD_UNTIL * ts, BOLT_GONE * ts, t);
  if (fade <= 0.002) return "";
  const stroke = BOLT_STROKE * short;
  const main = partial(layout.bolt, grow);
  if (main.length < 2) return "";
  const forkD = grow >= 1 ? layout.forks.map(polylineD).join("") : "";
  const mainD = polylineD(main);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of [...layout.bolt, ...layout.forks.flat()]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const sigma = stroke * 1.1, pad = 3 * sigma + stroke * 2;
  const blur = doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: sigma }),
    { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), width: Math.min(doc.width, x1 + pad) - Math.max(0, x0 - pad), height: Math.min(doc.height, y1 + pad) - Math.max(0, y0 - pad) });
  const line = { fill: "none", "stroke-linejoin": "miter", "stroke-linecap": "round", "stroke-miterlimit": 6 } as const;
  return g({ opacity: fade < 1 ? fade : undefined },
    g({ filter: blur, opacity: 0.95 },
      path(mainD, { ...line, stroke: glow, "stroke-width": stroke * 3.2 }),
      forkD && path(forkD, { ...line, stroke: glow, "stroke-width": stroke * 2 })),
    path(mainD, { ...line, stroke: core, "stroke-width": stroke }),
    forkD && path(forkD, { ...line, stroke: core, "stroke-width": stroke * 0.6 }));
}

export const T41_lightningStrike = defineTextMotion(ID, (params, t, size) => {
  const layout = lightningLayout(params, size);
  const doc = createTextDocument(size, params);
  const flash = lightningFlash(t);
  const flashRect = flash > 0 ? rect(0, 0, size.width, size.height, { fill: params.palette.paper, opacity: flash < 1 ? flash : undefined }) : "";
  if (t >= layout.cutAt) return doc.render();
  const short = Math.min(size.width, size.height), ts = layout.timeScale;
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  const accent = secondaryTone(params.palette, backdrop);
  const { text, box } = layout;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const parts: string[] = [];

  // Shockwave ring behind everything.
  const ringAge = (t - RING_AT * ts) / (RING_SECONDS * ts);
  if (ringAge >= 0 && ringAge < 1) {
    const diameter = (box.x1 - box.x0) * (RING_FROM + (RING_TO - RING_FROM) * expoOut(ringAge));
    parts.push(circle(cx, cy, diameter / 2, { fill: "none", stroke: accent, "stroke-width": RING_STROKE * short * (1 - 0.6 * ringAge),
      opacity: 1 - quadIn(ringAge) }));
  }
  parts.push(drawBolt(doc, layout, t, params.palette.paper, accent, short));

  if (t >= SLAM_AT) {
    const scale = wordScale(t, layout);
    const placement = transform(tf.translate(cx, cy), scale !== 1 && tf.scale(scale), tf.translate(-text.inkCenter[0], -text.inkCenter[1]));
    const glow = glowLevel(t, ts);
    if (glow > 0.002) {
      // Glow: the word in the accent, fattened by a stroke and blurred; the region follows the scaled ink box.
      const sigma = 0.03 * layout.glyphHeight * scale, pad = 3 * sigma + 0.04 * layout.glyphHeight * scale;
      const halfW = ((box.x1 - box.x0) / 2) * scale + pad, halfH = ((box.y1 - box.y0) / 2) * scale + pad;
      const x0 = Math.max(0, cx - halfW), y0 = Math.max(0, cy - halfH), x1 = Math.min(size.width, cx + halfW), y1 = Math.min(size.height, cy + halfH);
      const blur = doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: sigma }), { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      parts.push(g({ filter: blur, opacity: glow },
        g({ transform: placement }, path(text.block.pathD, { fill: accent, stroke: accent, "stroke-width": 0.04 * layout.glyphHeight, "stroke-linejoin": "round" }))));
    }
    const dim = FILL_DIM * smoothstep(GLOW_PEAK_AT * ts, GLOW_LOW_AT * ts, t);
    parts.push(g({ transform: placement }, path(text.block.pathD, { fill: dim > 0 ? mixHex(textColor, backdrop, dim) : textColor })));
  }
  return doc.render(parts, flashRect);
}, { revision: REVISION });
