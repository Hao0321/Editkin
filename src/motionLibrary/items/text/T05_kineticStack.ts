import { g, path, transform, tf } from "../../svg/document";
import { clamp01, cubicOut, quadIn, smoothstep } from "../../svg/easing";
import { layoutLine, type GlyphBox, type LineLayout } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, frameUnit, itemTiming, readableColor, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T05 Kinetic Stack (キネティック): up to four lines stack vertically, centred:
 * small, BIG, small (the hero line is the middle one: index ⌊n/2⌋ for 2–4 lines;
 * it is set in secondaryTone, the others in the readable text role at 0.62 of its size;
 * ART_DIRECTION §0: accent on a dark card, accent2 on accent or cream).
 * Each line slams in from 1.4× and 0 opacity with a 30-unit drop (the reference's
 * 20 px at 720), 0.25 s apart (landing 0.2, 0.45, 0.7 s); each landing nudges
 * the lines already down by 4 units, so the stack thumps as it builds. The block
 * holds while the whole stack drifts 3% larger (a slow push that keeps the hold
 * alive), then the lines fly out downward, bottom line first, 0.07 s apart (so a
 * falling line never crosses one still standing): each falls out of the frame under
 * gravity (quadIn) in 0.3 s, solid all the way (a short fade over the last quarter
 * only), gone 0.1 s before the end. Times are standard-energy
 * seconds, scaled by energy and squeezed into short clips.
 */

const ID = "T05";
/** Art revision (part of the clip cache key): 1 = first render; 2 = self-review fix after the first contact sheet (bottom-first fly-out exit and a 3% hold drift); 3 = ART_DIRECTION §0 (secondaryTone hero, tight tracking); 4 = small lines at 0.62 of the hero (hierarchy through colour, not size alone). */
const REVISION = 4;
const FIRST_START = 0.06, STAGGER = 0.25, SLAM = 0.14, MIN_HOLD = 0.9, EXIT = 0.3, EXIT_STAGGER = 0.07, TAIL = 0.1;
const DROP_UNITS = 30, NUDGE_UNITS = 4, NUDGE_SECONDS = 0.12;
/** A falling line ends this far below the frame (fraction of the frame height). */
const EXIT_CLEARANCE = 0.04;
/** Slam-in scale is 1 + SLAM_OVERSIZE · scaleDepth (1.4× at standard energy). */
const SLAM_OVERSIZE = 0.4;
/** Secondary lines are this fraction of the hero line's font size. */
const SMALL_RATIO = 0.62;
/** Gap between ink boxes as a fraction of the hero font size. */
const GAP = 0.12;
const SIZE_CAP = 0.36, SAFE_WIDTH = 0.9, SAFE_HEIGHT = 0.86, HOLD_DRIFT = 0.03;

export interface StackLine {
  readonly layout: LineLayout;
  readonly hero: boolean;
  readonly color: string;
  /** Ink box at the hold, frame px. */
  readonly box: GlyphBox;
  /** Clip seconds. */
  readonly start: number;
  readonly land: number;
  readonly exitAt: number;
}

export interface KineticStackLayout {
  readonly heroSize: number;
  /** Centre of the stack (frame px): the hold drift scales about it. */
  readonly cx: number;
  readonly cy: number;
  readonly timeScale: number;
  readonly slamScale: number;
  readonly unit: number;
  readonly amplitude: number;
  readonly lines: readonly StackLine[];
}

/** Index of the big line: the middle one (a single line is the hero itself). */
export function kineticHeroIndex(count: number): number {
  return count <= 1 ? 0 : Math.floor(count / 2);
}

/** Line sizes, colours, hold boxes and timing (shared by the generator and its tests). */
export function kineticStackLayout(params: TextMotionParams, size: MotionFrameSize): KineticStackLayout {
  const count = params.lines.length, heroIndex = kineticHeroIndex(count);
  const natural = FIRST_START + SLAM + STAGGER * (count - 1) + MIN_HOLD + EXIT + EXIT_STAGGER * (count - 1) + TAIL;
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, natural);
  const face = textFace(params.font, 900);
  const safe = titleSafeBox(size);
  const ratio = (index: number) => (index === heroIndex ? 1 : SMALL_RATIO);
  // Measure at 100 px (hero) and scale linearly: every line must fit the width, the stack the height.
  const reference = params.lines.map((text, index) => layoutLine(text, { ...face, size: 100 * ratio(index), tracking: displayTracking([text]) }));
  const inkWidth = (line: LineLayout) => (line.inkBox ? line.inkBox.x1 - line.inkBox.x0 : 1e-6);
  const inkHeight = (line: LineLayout) => (line.inkBox ? line.inkBox.y1 - line.inkBox.y0 : 1e-6);
  const widest = Math.max(...reference.map(inkWidth));
  const tall = reference.reduce((sum, line) => sum + inkHeight(line), 0) + GAP * 100 * (count - 1);
  const heroSize = Number(Math.max(8, Math.min(SIZE_CAP * Math.min(size.width, size.height),
    (100 * safe.width * SAFE_WIDTH) / widest, (100 * safe.height * SAFE_HEIGHT) / tall)).toFixed(3));

  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const hero = secondaryTone(params.palette, backdrop);
  // When the accent cannot be read here the hero falls back to the text role; the small lines then take a second colour.
  const small = hero !== primary ? primary
    : readableColor(backdrop, [primary === params.palette.paper ? params.palette.ink : params.palette.paper, primary], 2);
  const layouts = params.lines.map((text, index) => layoutLine(text, { ...face, size: Number((heroSize * ratio(index)).toFixed(3)), tracking: displayTracking([text]) }));
  const total = layouts.reduce((sum, line) => sum + inkHeight(line), 0) + GAP * heroSize * (count - 1);
  const goneAt = params.durationSeconds - TAIL * timeScale;
  const lastExit = goneAt - EXIT * timeScale;
  let top = safe.cy - total / 2;
  const lines = layouts.map((layout, index): StackLine => {
    const ink = layout.inkBox ?? { x0: 0, y0: -layout.size, x1: layout.width, y1: 0 };
    const width = ink.x1 - ink.x0, height = ink.y1 - ink.y0;
    const box = { x0: safe.cx - width / 2, y0: top, x1: safe.cx + width / 2, y1: top + height };
    top += height + GAP * heroSize;
    const start = (FIRST_START + STAGGER * index) * timeScale;
    return {
      layout, hero: index === heroIndex, color: index === heroIndex ? hero : small, box,
      start, land: start + SLAM * timeScale, exitAt: lastExit - EXIT_STAGGER * index * timeScale,
    };
  });
  return { heroSize, cx: safe.cx, cy: safe.cy, timeScale, slamScale: 1 + SLAM_OVERSIZE * energy.scaleDepth, unit: frameUnit(size), amplitude: energy.amplitude, lines };
}

export const T05_kineticStack = defineTextMotion(ID, (params, t, size) => {
  const layout = kineticStackLayout(params, size);
  const doc = createTextDocument(size, params);
  const nudgeSeconds = NUDGE_SECONDS * layout.timeScale;
  const parts = layout.lines.map((line, index) => {
    if (t < line.start) return "";
    const ink = line.layout.inkBox ?? { x0: 0, y0: -line.layout.size, x1: line.layout.width, y1: 0 };
    let scale = 1, dy = 0, opacity = 1;
    if (t < line.land) {
      const p = (t - line.start) / (line.land - line.start);
      scale = layout.slamScale + (1 - layout.slamScale) * cubicOut(p);
      dy = -DROP_UNITS * layout.unit * layout.amplitude * (1 - cubicOut(p));
      opacity = clamp01(p / 0.45);
    }
    // Every later landing thumps the lines that are already down.
    for (const later of layout.lines.slice(index + 1)) {
      const since = t - later.land;
      if (since >= 0 && since < nudgeSeconds) dy += NUDGE_UNITS * layout.unit * layout.amplitude * Math.sin(Math.PI * (since / nudgeSeconds)) * (1 - since / nudgeSeconds);
    }
    if (t >= line.exitAt) {
      const q = clamp01((t - line.exitAt) / (EXIT * layout.timeScale));
      if (q >= 1) return "";
      // Fall from the line's place to just below the frame (the hold drift scales about the centre, so allow for it).
      const fall = (size.height * (1 + EXIT_CLEARANCE) - line.box.y0) * (1 + HOLD_DRIFT);
      dy += fall * quadIn(q);
      opacity *= 1 - smoothstep(0.75, 1, q);
    }
    if (opacity <= 0.002) return "";
    const cx = (line.box.x0 + line.box.x1) / 2, cy = (line.box.y0 + line.box.y1) / 2;
    return g({
      opacity: opacity < 1 ? opacity : undefined,
      transform: transform(tf.translate(cx, cy + dy), scale !== 1 && tf.scale(scale), tf.translate(-(ink.x0 + ink.x1) / 2, -(ink.y0 + ink.y1) / 2)),
    }, path(line.layout.pathD, { fill: line.color }));
  });
  // The stack drifts 3% larger from the last landing to the first exit, about its centre.
  const settled = layout.lines[layout.lines.length - 1].land, leaving = Math.min(...layout.lines.map(line => line.exitAt));
  const drift = 1 + HOLD_DRIFT * clamp01((t - settled) / Math.max(1e-6, leaving - settled));
  return doc.render(g({ transform: drift !== 1 ? transform(tf.translate(layout.cx, layout.cy), tf.scale(drift), tf.translate(-layout.cx, -layout.cy)) : undefined }, parts));
}, { revision: REVISION });
