import { g, path, rect, transform, tf } from "../../svg/document";
import { cubicInOut, cubicOut, smootherstep, smoothstep } from "../../svg/easing";
import { lineOutlines, sampleGlyphCells } from "../../svg/glyphCells";
import { layoutLine, type GlyphBox, type LineLayout } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T07 Zoom Through (ズームスルー): a chain of words (one per line; 未來 → 光 → 維度
 * by default). The first word comes in from far (0.15× → 1.0, a perspective
 * approach that eases out). Each word holds ~0.3 s, then the camera flies
 * through it: the word's scale ramps exponentially with an accelerating rate
 * (scale = S_cut^(τ^1.7)) about a target point inside its widest counter or gap,
 * so its strokes rush past the frame edges, until the clear area around the target
 * covers the whole frame and the word is gone. The next word waits behind it on a
 * farther plane: it fades up out of the depth fog at 0.2× inside the opening,
 * grows more slowly than the strokes in front of it (parallax) and settles at 1.0
 * as the camera arrives. The camera drifts sideways onto the target early in the
 * fly, while the word is still small. The last word flies through into empty
 * space, 0.06 s before the end. Words alternate the readable text role and secondaryTone
 * (ART_DIRECTION §0: paper → accent → paper on a dark card, ink → accent2 → ink on cream when the accent reads below 3:1).
 * Words are sized with heroTextBox (the widest fills 86% of the title-safe width). Everything is clipped to the frame (the strokes reach
 * hundreds of times their size). Times are standard-energy seconds, scaled by
 * energy and squeezed into short clips; extra clip time lengthens the holds.
 *
 * The target is found once per word (cached): the glyphs are sampled into a
 * coverage grid (svg/glyphCells.ts) and the empty cell inside the ink box with the
 * best clearance to the strokes, slightly preferring the middle, wins.
 */

const ID = "T07";
/** Art revision (part of the clip cache key): 1 = first render; 2 = ART_DIRECTION §0 (hero size, tight tracking, secondaryTone). */
const REVISION = 2;
const ENTER = 0.38, HOLD = 0.3, HOLD_LAST = 0.4, FLY = 0.46;
/** Blank after the last fly-through, so the clip ends on a clean frame. */
const TAIL = 0.06;
/** Share of a fly spent going through the outgoing word; the rest is the incoming word's settle. */
const THROUGH = 0.55;
const THROUGH_EXPONENT = 1.7;
/** The first word starts this far away; an incoming word waits at NEXT_FAR behind the one being flown through. */
const FIRST_FAR = 0.15, NEXT_FAR = 0.2;
/** Coverage grid cell, as a fraction of the font size. */
const TARGET_CELL = 1 / 36;

export interface ZoomTarget {
  /** Target point in line coordinates (origin on the baseline at the pen start). */
  readonly x: number;
  readonly y: number;
  /** Clear radius around it (px at the rest size). */
  readonly clearance: number;
}

export interface ZoomWord {
  readonly layout: LineLayout;
  readonly color: string;
  /** Ink centre in line coordinates. */
  readonly cx: number;
  readonly cy: number;
  readonly target: ZoomTarget;
  /** Ink box at the hold, frame px. */
  readonly box: GlyphBox;
}

export type ZoomSegment =
  | { readonly kind: "enter"; readonly word: number; readonly start: number; readonly end: number }
  | { readonly kind: "hold"; readonly word: number; readonly start: number; readonly end: number }
  | { readonly kind: "fly"; readonly word: number; readonly start: number; readonly end: number }
  | { readonly kind: "exit"; readonly word: number; readonly start: number; readonly end: number };

export interface ZoomThroughPlan {
  readonly fontSize: number;
  readonly timeScale: number;
  readonly words: readonly ZoomWord[];
  readonly segments: readonly ZoomSegment[];
  /** Half the frame diagonal: the clear radius (on screen) at which a word has left the frame. */
  readonly reach: number;
}

const TARGET_CACHE_LIMIT = 64;
const targetCache = new Map<string, ZoomTarget>();

/**
 * The fly-through target of a laid-out word: the empty coverage cell inside the
 * ink box whose distance to the nearest stroke cell, minus 0.25 × its distance to
 * the ink centre, is largest. Clearance is that stroke distance less half a cell.
 */
export function zoomThroughTarget(layout: LineLayout): ZoomTarget {
  const key = `${layout.faceId}|${layout.size}|${layout.tracking}|${layout.text}`;
  const hit = targetCache.get(key);
  if (hit) return hit;
  const ink = layout.inkBox ?? { x0: 0, y0: -layout.size, x1: layout.width, y1: 0 };
  const cell = Math.max(1, layout.size * TARGET_CELL);
  const cells = sampleGlyphCells(lineOutlines(layout), { cellSize: cell, supersample: 2, includeEmpty: true });
  const covered = cells.filter(entry => entry.coverage > 0);
  const centerX = (ink.x0 + ink.x1) / 2, centerY = (ink.y0 + ink.y1) / 2;
  let best: ZoomTarget = { x: centerX, y: centerY, clearance: cell / 2 }, bestScore = -Infinity;
  for (const entry of cells) {
    if (entry.coverage > 0) continue;
    const x = entry.x + entry.size / 2, y = entry.y + entry.size / 2;
    if (x < ink.x0 || x > ink.x1 || y < ink.y0 || y > ink.y1) continue;
    let nearest = Infinity;
    for (const stroke of covered) {
      const dx = stroke.x + stroke.size / 2 - x, dy = stroke.y + stroke.size / 2 - y;
      const distance = dx * dx + dy * dy;
      if (distance < nearest) nearest = distance;
    }
    const clearance = Math.sqrt(nearest) - cell / 2;
    const score = clearance - 0.25 * Math.hypot(x - centerX, y - centerY);
    if (score > bestScore) { bestScore = score; best = { x, y, clearance: Math.max(cell / 2, clearance) }; }
  }
  const result = Object.freeze(best);
  targetCache.set(key, result);
  if (targetCache.size > TARGET_CACHE_LIMIT) targetCache.delete(targetCache.keys().next().value!);
  return result;
}

/** Words, targets and the enter / hold / fly / exit timeline (shared by the generator and its tests). */
export function zoomThroughPlan(params: TextMotionParams, size: MotionFrameSize): ZoomThroughPlan {
  const count = params.lines.length;
  const natural = ENTER + (count - 1) * (HOLD + FLY) + HOLD_LAST + FLY * THROUGH + TAIL;
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, natural);
  const face = textFace(params.font, 900);
  const safe = titleSafeBox(size);
  // One size for the whole chain: the widest / tallest word fills the hero box (ART_DIRECTION §0).
  let widest = 1e-6, tallest = 1e-6;
  for (const text of params.lines) {
    const ink = layoutLine(text, { ...face, size: 100, tracking: displayTracking([text]) }).inkBox;
    if (ink) { widest = Math.max(widest, ink.x1 - ink.x0); tallest = Math.max(tallest, ink.y1 - ink.y0); }
  }
  const hero = heroTextBox(size);
  const fontSize = Number(Math.max(8, Math.min(hero.maxSize, (100 * hero.maxWidth) / widest, (100 * hero.maxHeight) / tallest)).toFixed(3));
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const accent = secondaryTone(params.palette, backdrop);
  const words = params.lines.map((text, index): ZoomWord => {
    const layout = layoutLine(text, { ...face, size: fontSize, tracking: displayTracking([text]) });
    const ink = layout.inkBox ?? { x0: 0, y0: -fontSize, x1: layout.width, y1: 0 };
    const cx = (ink.x0 + ink.x1) / 2, cy = (ink.y0 + ink.y1) / 2;
    return {
      layout, color: index % 2 === 0 ? primary : accent, cx, cy, target: zoomThroughTarget(layout),
      box: { x0: safe.cx + ink.x0 - cx, y0: safe.cy + ink.y0 - cy, x1: safe.cx + ink.x1 - cx, y1: safe.cy + ink.y1 - cy },
    };
  });
  // Spare time (beyond the squeezed natural program) lengthens every hold equally.
  const spare = Math.max(0, params.durationSeconds - natural * timeScale) / count;
  const segments: ZoomSegment[] = [];
  let clock = 0;
  const push = (kind: ZoomSegment["kind"], word: number, seconds: number) => {
    segments.push({ kind, word, start: clock, end: clock + seconds });
    clock += seconds;
  };
  push("enter", 0, ENTER * timeScale);
  for (let word = 0; word < count; word += 1) {
    const last = word === count - 1;
    push("hold", word, (last ? HOLD_LAST : HOLD) * timeScale + spare);
    push(last ? "exit" : "fly", word, (last ? FLY * THROUGH : FLY) * timeScale);
  }
  return { fontSize, timeScale, words, segments, reach: Math.hypot(size.width, size.height) / 2 };
}

/** Scale at which a word's clear area around its target covers the whole frame. */
function cutScale(word: ZoomWord, plan: ZoomThroughPlan): number {
  return (1.02 * plan.reach) / word.target.clearance;
}

/** Placement of a word: screen = centre + scale · (x − camera), camera in the word's line coordinates. */
function wordAt(word: ZoomWord, scale: number, cameraX: number, cameraY: number, centre: readonly [number, number], opacity: number): string {
  if (opacity <= 0.002 || !(scale > 0)) return "";
  return g({
    opacity: opacity < 1 ? opacity : undefined,
    transform: transform(tf.translate(centre[0] - scale * cameraX, centre[1] - scale * cameraY), tf.scale(scale)),
  }, path(word.layout.pathD, { fill: word.color }));
}

export const T07_zoomThrough = defineTextMotion(ID, (params, t, size) => {
  const plan = zoomThroughPlan(params, size);
  const doc = createTextDocument(size, params);
  const segment = plan.segments.find(entry => t >= entry.start && t < entry.end);
  if (!segment) return doc.render();
  const centre = [size.width / 2, size.height / 2] as const;
  const word = plan.words[segment.word];
  const progress = (t - segment.start) / (segment.end - segment.start);
  const parts: string[] = [];
  switch (segment.kind) {
    case "enter": {
      // A perspective approach from FIRST_FAR: log-scale eases out to 1.
      const scale = FIRST_FAR ** (1 - cubicOut(progress));
      parts.push(wordAt(word, scale, word.cx, word.cy, centre, smoothstep(0, 0.3, progress)));
      break;
    }
    case "hold":
      parts.push(wordAt(word, 1, word.cx, word.cy, centre, 1));
      break;
    case "fly":
    case "exit": {
      const u = segment.kind === "fly" ? progress : progress * THROUGH;
      // Camera drifts from the word centre onto the target while the word is still small.
      const drift = smootherstep(0, 0.6 * THROUGH, u);
      const cameraX = word.cx + (word.target.x - word.cx) * drift, cameraY = word.cy + (word.target.y - word.cy) * drift;
      if (segment.kind === "fly") {
        const next = plan.words[segment.word + 1];
        // The next word sits on a farther plane centred on the target: it grows from NEXT_FAR to 1 (slow, then
        // fast once the opening clears, then settling) and fades up out of the depth fog.
        const nextScale = NEXT_FAR ** (1 - cubicInOut(u));
        parts.push(wordAt(next, nextScale, next.cx + cameraX - word.target.x, next.cy + cameraY - word.target.y, centre, smoothstep(0.06, 0.4, u)));
      }
      if (u < THROUGH) {
        const tau = u / THROUGH;
        parts.push(wordAt(word, cutScale(word, plan) ** (tau ** THROUGH_EXPONENT), cameraX, cameraY, centre, 1));
      }
      break;
    }
  }
  const clip = doc.clipPath(rect(0, 0, size.width, size.height));
  return doc.render(g({ "clip-path": clip }, parts));
}, { revision: REVISION });
