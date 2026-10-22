import { g, line, path, polygon, transform, tf, type Point2 } from "../../svg/document";
import { mixHex } from "../../svg/color";
import { cubicIn, cubicOut, expoOut, impulse, quadOut } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { roughenPathD } from "../../svg/roughen";
import { defineTextMotion, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, readableColor, secondaryTone, textBackdrop, textFace, textOnBackground,
} from "../shared";

/**
 * T01 Word Burst (ワードバースト): elastic pop 0.3× → 1.25× (0.25 s) → 1.0 (0.5 s);
 * at about 1.0 s the word punches to 1.08× and bursts: 16–18 seeded torn-paper
 * shards (accent and the text colour; three larger hero shards) blast out
 * radially from behind the word (expoOut), clear its edge, tumble with a paper
 * flutter and sink a little as they fade, gone by 1.6 s, while 6–8 short speed
 * lines (stroke 1.8% of the glyph height) flash outward just outside the ink box
 * for 0.18 s. Then a ±2% breathe. The word edge is roughened once (baked outline,
 * seeded). A short exit closes the clip. Type and colour follow ART_DIRECTION §0:
 * heroTextBox size (80–90% of the title-safe width), displayTracking, paper text
 * with secondaryTone shards (accent on a dark card, accent2 on accent or cream).
 * Times are standard-energy seconds, scaled by energy and squeezed into short clips.
 */

const ID = "T01";
/**
 * Art revision (part of the clip cache key): 1 = Phase 1; 2 = burst revision (16–18 shards, flutter, punch 1.08,
 * 1.8% speed lines); 3 = ART_DIRECTION §0 overhaul (hero size, tight tracking, §0 two-tone, readable speed lines).
 */
const REVISION = 3;
const POP_PEAK = 0.25, POP_SETTLE = 0.5, BURST = 1.0, SHARDS_GONE = 1.6, EXIT = 0.28, MIN_HOLD = 0.2;
const NATURAL_SECONDS = SHARDS_GONE + MIN_HOLD + EXIT;
const BREATHE_PERIOD = 1.6, BREATHE_DEPTH = 0.02, PUNCH = 0.08, FADE_IN = 0.06;
const LINE_HEIGHT = 1.04;
/** Shard sizes (side length) are fractions of the tallest glyph's ink height. */
const SHARD_COUNT: readonly [number, number] = [16, 18], HERO_COUNT = 3;
const SHARD_SIZE: readonly [number, number] = [0.08, 0.18], HERO_SIZE: readonly [number, number] = [0.19, 0.22];
/** Visible travel beyond the word edge, in glyph heights (heroes are heavier and go less far). */
const SHARD_REACH: readonly [number, number] = [0.5, 1.5], HERO_REACH: readonly [number, number] = [0.4, 0.8];
const FLIP_TURNS: readonly [number, number] = [1, 2];
/** Paper settles: a fall of this many glyph heights by the end of the flight (∝ p²). */
const SHARD_FALL = 0.4;
const SPEED_LINE_COUNT: readonly [number, number] = [6, 8], SPEED_LINE_SECONDS = 0.18, SPEED_LINE_OPACITY = 0.7;
const SPEED_LINE_STROKE = 0.018, SPEED_LINE_LENGTH: readonly [number, number] = [0.15, 0.25];
/** max over q of expoOut(q) − cubicIn(q): the longest a speed line gets, as a fraction of its reach. */
const SPEED_LINE_PEAK = 0.8735;

function popScale(t: number, timeScale: number, depth: number): number {
  const start = Math.max(0.12, 1 - 0.7 * depth), overshoot = 0.25 * depth;
  const peak = POP_PEAK * timeScale, settle = POP_SETTLE * timeScale;
  if (t <= 0) return start;
  if (t < peak) return start + (1 + overshoot - start) * cubicOut(t / peak);
  if (t < settle) {
    const u = (t - peak) / (settle - peak);
    // One undershoot, landing with zero velocity at the settle time.
    return 1 + overshoot * Math.cos(1.5 * Math.PI * u) * (1 - u) ** 1.5;
  }
  return 1;
}

/** Distance from the box centre to its edge along the unit direction (cos, sin). */
function rayExit(halfW: number, halfH: number, cos: number, sin: number): number {
  return Math.min(Math.abs(cos) > 1e-9 ? halfW / Math.abs(cos) : Infinity, Math.abs(sin) > 1e-9 ? halfH / Math.abs(sin) : Infinity);
}

interface Shard {
  readonly x: number; readonly y: number;
  readonly dx: number; readonly dy: number;
  readonly travel: number; readonly fall: number; readonly delay: number; readonly flight: number;
  readonly spin: number; readonly baseRotation: number;
  readonly flipPhase: number; readonly flipTurns: number;
  readonly color: string; readonly backColor: string;
  readonly corners: readonly Point2[];
}

/**
 * Shards start behind the settled word, inside its ink-box edge, and travel past
 * the edge by 0.5–1.5 glyph heights (heroes 0.4–0.8), so every shard visibly
 * leaves the word. Sizes follow the glyph height, not the frame.
 */
function shards(params: TextMotionParams, word: GlyphBox, glyphHeight: number, timeScale: number, amplitude: number, textColor: string,
  accentColor: string): Shard[] {
  const rng = createSeededRng(ID, params.seed, "shards");
  const count = rng.int(SHARD_COUNT[0], SHARD_COUNT[1]);
  const offset = rng.range(0, 360), colorFlip = rng.int(0, 1), heroStart = rng.int(0, count - 1);
  const heroes = new Set(Array.from({ length: HERO_COUNT }, (_, k) => (heroStart + Math.round((k * count) / HERO_COUNT)) % count));
  const cx = (word.x0 + word.x1) / 2, cy = (word.y0 + word.y1) / 2;
  const halfW = (word.x1 - word.x0) / 2, halfH = (word.y1 - word.y0) / 2;
  const result: Shard[] = [];
  for (let index = 0; index < count; index += 1) {
    const r = rng.fork(index), hero = heroes.has(index);
    const angle = ((offset + (index + r.range(-0.45, 0.45)) * (360 / count)) * Math.PI) / 180;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const exit = rayExit(halfW, halfH, dx, dy), start = exit * r.range(0.55, 0.9);
    const size = r.range(...(hero ? HERO_SIZE : SHARD_SIZE)) * glyphHeight;
    // A torn square: corners near ±45°, so the side length is about `size`.
    const corners: Point2[] = [0, 1, 2, 3].map(corner => {
      const a = ((45 + corner * 90 + r.range(-25, 25)) * Math.PI) / 180, radius = (size / Math.SQRT2) * r.range(0.8, 1.2);
      return [Math.cos(a) * radius, Math.sin(a) * radius] as const;
    });
    const color = (index + colorFlip) % 2 === 0 ? accentColor : textColor;
    result.push({
      x: cx + dx * start, y: cy + dy * start, dx, dy,
      travel: exit - start + r.range(...(hero ? HERO_REACH : SHARD_REACH)) * glyphHeight * amplitude,
      fall: SHARD_FALL * glyphHeight * amplitude * r.range(0.7, 1.3),
      delay: r.range(0, 0.04) * timeScale,
      flight: r.range(0.5, 0.56) * timeScale,
      spin: r.sign() * r.range(180, 360) * (hero ? 0.6 : 1),
      baseRotation: r.range(0, 360),
      flipPhase: r.range(0, 2 * Math.PI), flipTurns: r.range(FLIP_TURNS[0], FLIP_TURNS[1]),
      // The back of the paper is a touch darker, so the flutter reads as a flip and not a squash.
      color, backColor: mixHex(color, params.palette.ink, 0.22),
      corners,
    });
  }
  return result;
}

function drawShard(shard: Shard, t: number, burstAt: number): string {
  const local = t - burstAt - shard.delay;
  if (local < 0 || local >= shard.flight) return "";
  const p = local / shard.flight;
  // Blast: most of the travel happens in the first few frames, then the paper hangs and flutters.
  const distance = shard.travel * expoOut(p);
  const opacity = p < 0.55 ? 1 : 1 - quadOut((p - 0.55) / 0.45);
  if (opacity <= 0.002) return "";
  // Paper flutter: the shard flips about its own axis 1–2 turns over the flight.
  const flip = Math.cos(shard.flipPhase + 2 * Math.PI * shard.flipTurns * quadOut(p)), shrink = 1 - 0.15 * p;
  return polygon(shard.corners, {
    fill: flip >= 0 ? shard.color : shard.backColor,
    opacity: opacity < 1 ? opacity : undefined,
    transform: transform(tf.translate(shard.x + shard.dx * distance, shard.y + shard.dy * distance + shard.fall * p * p),
      tf.rotate(shard.baseRotation + shard.spin * quadOut(p)), tf.scale(flip * shrink, shrink)),
  });
}

interface SpeedLine {
  readonly dx: number; readonly dy: number;
  readonly start: number; readonly reach: number; readonly delay: number;
}

/** 6–8 radial streaks starting just outside the punched word (1.1 × the ink-box edge + a small gap). */
function speedLines(params: TextMotionParams, word: GlyphBox, glyphHeight: number, timeScale: number, amplitude: number): SpeedLine[] {
  const rng = createSeededRng(ID, params.seed, "speed-lines");
  const count = rng.int(SPEED_LINE_COUNT[0], SPEED_LINE_COUNT[1]), offset = rng.range(0, 360);
  const halfW = (word.x1 - word.x0) / 2, halfH = (word.y1 - word.y0) / 2, wordWidth = word.x1 - word.x0;
  return Array.from({ length: count }, (_, index) => {
    const r = rng.fork(index);
    const angle = ((offset + (index + r.range(-0.3, 0.3)) * (360 / count)) * Math.PI) / 180;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    return {
      dx, dy,
      start: rayExit(halfW, halfH, dx, dy) * 1.1 + 0.06 * glyphHeight,
      reach: (r.range(SPEED_LINE_LENGTH[0], SPEED_LINE_LENGTH[1]) * wordWidth * amplitude) / SPEED_LINE_PEAK,
      delay: r.range(0, 0.03) * timeScale,
    };
  });
}

function drawSpeedLine(streak: SpeedLine, centre: Point2, t: number, burstAt: number, duration: number, color: string, stroke: number): string {
  const local = t - burstAt - streak.delay, span = duration - streak.delay;
  if (local < 0 || local >= span) return "";
  const q = local / span;
  // The head shoots out (expoOut) and the tail catches up (cubicIn): a streak that flashes out and vanishes.
  const head = streak.start + streak.reach * expoOut(q), tail = streak.start + streak.reach * cubicIn(q);
  if (head - tail < stroke) return "";
  return line(centre[0] + streak.dx * tail, centre[1] + streak.dy * tail, centre[0] + streak.dx * head, centre[1] + streak.dy * head,
    { stroke: color, "stroke-width": stroke, "stroke-linecap": "round", opacity: SPEED_LINE_OPACITY });
}

/** Compatibility re-export: the display tracking rule now lives in items/shared.ts (displayTracking). */
export const wordBurstTracking = displayTracking;

export const T01_wordBurst = defineTextMotion(ID, (params, t, size) => {
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS);
  const depth = energy.scaleDepth;
  const holdMax = 1 + BREATHE_DEPTH * depth + PUNCH * depth;
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom: holdMax }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const { ink, inkCenter, fontSize } = text;
  const center: Point2 = [size.width / 2, size.height / 2];
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  const accentColor = secondaryTone(params.palette, backdrop);

  const settleAt = POP_SETTLE * timeScale, burstAt = BURST * timeScale;
  const exitDuration = EXIT * timeScale, exitAt = params.durationSeconds - exitDuration;
  let scale = popScale(t, timeScale, depth);
  if (t >= settleAt) scale *= 1 + BREATHE_DEPTH * depth * Math.sin((2 * Math.PI * (t - settleAt)) / (BREATHE_PERIOD * timeScale));
  scale *= 1 + PUNCH * depth * impulse(t, burstAt, 0.05 * timeScale, 0.3 * timeScale);
  let opacity = Math.min(1, Math.max(0, t / (FADE_IN * timeScale)));
  if (t > exitAt) {
    const p = Math.min(1, (t - exitAt) / exitDuration);
    scale *= 1 - 0.12 * cubicIn(p);
    opacity *= 1 - cubicIn(p);
  }

  // Static distressed edge baked into the outline (an SVG turbulence filter costs ~1.7 s/frame in librsvg).
  const roughOutline = roughenPathD(text.block.pathD, {
    amplitude: fontSize * 0.0038, wavelength: fontSize * 0.06, step: Math.max(1, fontSize * 0.008), grain: 0.22, seed: params.seed,
  });

  let burst: string[] = [];
  if (t >= burstAt && t < burstAt + (SHARDS_GONE - BURST + 0.05) * timeScale) {
    // Burst geometry is laid out on the settled (1.0×) word, so it does not depend on the breathe.
    const settledWord: GlyphBox = {
      x0: center[0] - (inkCenter[0] - ink.x0), y0: center[1] - (inkCenter[1] - ink.y0),
      x1: center[0] + (ink.x1 - inkCenter[0]), y1: center[1] + (ink.y1 - inkCenter[1]),
    };
    let glyphHeight = 0;
    for (const placed of text.block.lines) for (const glyph of placed.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
    if (!(glyphHeight > 0)) glyphHeight = fontSize * 0.88;
    // Paper streaks on a dark card; where paper would not read at 3:1 (accent or cream), the text colour.
    const lineColor = readableColor(backdrop, [params.palette.paper, textColor]);
    burst = [
      ...shards(params, settledWord, glyphHeight, timeScale, energy.amplitude, textColor, accentColor).map(shard => drawShard(shard, t, burstAt)),
      ...speedLines(params, settledWord, glyphHeight, timeScale, energy.amplitude)
        .map(streak => drawSpeedLine(streak, center, t, burstAt, SPEED_LINE_SECONDS * timeScale, lineColor, SPEED_LINE_STROKE * glyphHeight)),
    ];
  }

  const word = opacity <= 0.002 ? "" : g({
    opacity: opacity < 1 ? opacity : undefined,
    transform: transform(tf.translate(center[0], center[1]), tf.scale(scale), tf.translate(-inkCenter[0], -inkCenter[1])),
  }, path(roughOutline, { fill: textColor }));

  return createTextDocument(size, params).render(g(undefined, burst), word);
}, { revision: REVISION });
