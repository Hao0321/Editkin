import { fe, g, path, tf, transform, type SvgDocument } from "../../svg/document";
import { expoIn, expoOut, impulse } from "../../svg/easing";
import { translatePathD, type GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, frameUnit, heroTextBox, itemTiming, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground,
} from "../shared";
import { scatterOffsets, scatterPose, type ScatterOffset } from "./scatter";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T44 Explode Out (爆裂四散), DRAMA: the word assembles from an explosion, holds,
 * then blows apart.
 * - In (0–0.3 s, expoOut): every character flies home from its exploded position
 *   (the scatter helper's radial mode: out from the word centre through the
 *   character, ±25°), scale 1.6 → 1, opacity 0 → 1, spin → 0, each trailed by two
 *   ghosts at 40% and 20% (the same character a few frames earlier on its path).
 * - Hold (0.3–1.1 s), with a 1.03 punch of the whole word as it lands.
 * - Out (1.1–1.45 s, expoIn): every character flies away along the line from the
 *   word centre through its own centre (±25° seeded spread), 0.6–0.9 frame widths,
 *   spinning 90–200°, scaling to 1.8 and fading out, with a Gaussian blur that grows
 *   to 6 px at 1080 (scaled with the frame) on each character's own group, only
 *   during the out phase (one tight filter per character).
 * The frame is empty after 1.45 s (to 2.0 s at the default length). Characters
 * alternate the text colour and the second tone (cream and lime on the dark card,
 * ART_DIRECTION §0). Hero type: display 900 at heroTextBox size with tight tracking,
 * inside the 5% title-safe box at the hold, ≥ 9% of the short side tall.
 *
 * Timing: standard-energy seconds, scaled by energy (itemTiming) and squeezed into
 * short clips; a longer clip lengthens the hold, the out phase stays 0.9 s before the
 * end (0.35 s of flight and the 0.55 s blank).
 */

const ID = "T44";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T44_IN = 0.3, T44_OUT_START = 1.1, T44_OUT = 0.35, T44_TAIL = 0.55;
const NATURAL_SECONDS = T44_OUT_START + T44_OUT + T44_TAIL;
/** In: start scale; ghosts (time behind the character, opacity). Out: end scale, travel (× frame width), spin, blur (px at 1080). */
export const T44_IN_SCALE = 1.6, T44_OUT_SCALE = 1.8, T44_BLUR = 6, T44_PUNCH = 0.03;
const GHOSTS: ReadonlyArray<readonly [number, number]> = [[0.035, 0.4], [0.07, 0.2]];
const IN_DISTANCE: readonly [number, number] = [0.35, 0.6], OUT_DISTANCE: readonly [number, number] = [0.6, 0.9];
const IN_SPIN: readonly [number, number] = [60, 140], OUT_SPIN: readonly [number, number] = [90, 200];
const LINE_HEIGHT = 1.04;

export interface ExplodeGlyph {
  readonly index: number;
  /** Outline in block coordinates. */
  readonly pathD: string;
  /** Ink centre in frame px (home) and ink box half extents. */
  readonly cx: number;
  readonly cy: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly color: string;
  readonly in: ScatterOffset;
  readonly out: ScatterOffset;
}

export interface ExplodePlan {
  readonly glyphs: readonly ExplodeGlyph[];
  /** Block → frame offset (translate block coordinates by this to place the word at home). */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Word ink box at home (frame px) and its centre. */
  readonly box: GlyphBox;
  readonly centerX: number;
  readonly centerY: number;
  readonly glyphHeight: number;
  readonly fontSize: number;
}

export interface ExplodeTimes {
  readonly inEnd: number;
  readonly outStart: number;
  readonly outEnd: number;
  readonly timeScale: number;
}

export function explodeTimes(params: TextMotionParams): ExplodeTimes {
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS);
  const outStart = Math.max(T44_IN * timeScale, params.durationSeconds - (T44_OUT + T44_TAIL) * timeScale);
  return { inEnd: T44_IN * timeScale, outStart, outEnd: outStart + T44_OUT * timeScale, timeScale };
}

export function explodePlan(params: TextMotionParams, size: MotionFrameSize): ExplodePlan {
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom: 1 + T44_PUNCH }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const offsetX = size.width / 2 - text.inkCenter[0], offsetY = size.height / 2 - text.inkCenter[1];
  const backdrop = textBackdrop(params);
  const colors = [textOnBackground(params.palette, backdrop), secondaryTone(params.palette, backdrop)];
  const placed: Array<Omit<ExplodeGlyph, "in" | "out">> = [];
  let glyphHeight = 0;
  for (const line of text.block.lines) {
    for (const glyph of line.layout.glyphs) {
      if (glyph.whitespace || !glyph.bbox) continue;
      const x = line.x + glyph.x, y = line.baselineY;
      glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
      placed.push({
        index: placed.length, pathD: compactPathD(translatePathD(glyph.pathD, x, y)),
        cx: offsetX + x + (glyph.bbox.x0 + glyph.bbox.x1) / 2, cy: offsetY + y + (glyph.bbox.y0 + glyph.bbox.y1) / 2,
        halfWidth: (glyph.bbox.x1 - glyph.bbox.x0) / 2, halfHeight: (glyph.bbox.y1 - glyph.bbox.y0) / 2,
        color: colors[placed.length % 2],
      });
    }
  }
  const targets = placed.map(glyph => ({ x: glyph.cx, y: glyph.cy, halfWidth: glyph.halfWidth, halfHeight: glyph.halfHeight }));
  const centre = { x: size.width / 2, y: size.height / 2 };
  const inOffsets = scatterOffsets(targets, { mode: "radial", itemId: ID, seed: params.seed, stream: "in", frame: size, center: centre,
    distance: [IN_DISTANCE[0] * size.width, IN_DISTANCE[1] * size.width], rotation: IN_SPIN, scale: [T44_IN_SCALE, T44_IN_SCALE] });
  const outOffsets = scatterOffsets(targets, { mode: "radial", itemId: ID, seed: params.seed, stream: "out", frame: size, center: centre,
    distance: [OUT_DISTANCE[0] * size.width, OUT_DISTANCE[1] * size.width], rotation: OUT_SPIN, scale: [T44_OUT_SCALE, T44_OUT_SCALE] });
  return {
    glyphs: placed.map((glyph, index) => ({ ...glyph, in: inOffsets[index], out: outOffsets[index] })),
    offsetX, offsetY, centerX: centre.x, centerY: centre.y, glyphHeight: glyphHeight || text.fontSize * 0.88, fontSize: text.fontSize,
    box: { x0: text.ink.x0 + offsetX, y0: text.ink.y0 + offsetY, x1: text.ink.x1 + offsetX, y1: text.ink.y1 + offsetY },
  };
}

export interface ExplodePose {
  readonly dx: number;
  readonly dy: number;
  readonly rotation: number;
  readonly scale: number;
  readonly opacity: number;
  /** Blur in px (out phase only). */
  readonly blur: number;
}

/** A character's pose at time t (null when it is not drawn). */
export function explodePose(glyph: ExplodeGlyph, times: ExplodeTimes, t: number, unit: number): ExplodePose | null {
  if (t < 0) return null;
  if (t < times.inEnd) {
    const p = expoOut(t / times.inEnd);
    const pose = scatterPose(glyph.in, p);
    return { ...pose, opacity: Math.min(1, p * 1.25), blur: 0 };
  }
  if (t < times.outStart) return { dx: 0, dy: 0, rotation: 0, scale: 1, opacity: 1, blur: 0 };
  if (t >= times.outEnd) return null;
  const q = (t - times.outStart) / (times.outEnd - times.outStart), e = expoIn(q);
  const pose = scatterPose(glyph.out, 1 - e);
  const opacity = 1 - q * q;
  return opacity <= 0.002 ? null : { ...pose, opacity, blur: T44_BLUR * unit * Math.min(1, q * 1.4) };
}

function drawGlyph(doc: SvgDocument, plan: ExplodePlan, glyph: ExplodeGlyph, pose: ExplodePose, opacityScale: number, punch: number): string {
  const opacity = pose.opacity * opacityScale;
  if (opacity <= 0.002) return "";
  // Punch scales the whole word about its centre; the character's own pose turns and scales it about its ink centre.
  const homeX = plan.centerX + (glyph.cx - plan.centerX) * punch, homeY = plan.centerY + (glyph.cy - plan.centerY) * punch;
  const shape = path(glyph.pathD, {
    fill: glyph.color,
    transform: transform(tf.translate(homeX + pose.dx, homeY + pose.dy), pose.rotation ? tf.rotate(pose.rotation) : false,
      tf.scale(pose.scale * punch), tf.translate(-(glyph.cx - plan.offsetX), -(glyph.cy - plan.offsetY))),
  });
  // The blur sits on the character's own group (default region: its bounding box ± 10%, which holds 3σ at these sizes).
  const filter = pose.blur >= 0.05 ? doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: Number(pose.blur.toFixed(2)) })) : undefined;
  return g({ opacity: opacity < 0.999 ? opacity : undefined, filter }, shape);
}

export const T44_explodeOut = defineTextMotion(ID, (params, t, size) => {
  const plan = explodePlan(params, size), times = explodeTimes(params);
  const doc = createTextDocument(size, params);
  const unit = frameUnit(size);
  const punch = 1 + T44_PUNCH * impulse(t, times.inEnd, 0.04 * times.timeScale, 0.22 * times.timeScale);
  const parts: string[] = [];
  // Ghosts first (in phase only), then the characters.
  if (t > 0 && t < times.inEnd) {
    for (const [lag, alpha] of [...GHOSTS].reverse()) {
      for (const glyph of plan.glyphs) {
        const pose = explodePose(glyph, times, t - lag * times.timeScale, unit);
        if (pose) parts.push(drawGlyph(doc, plan, glyph, pose, alpha, 1));
      }
    }
  }
  for (const glyph of plan.glyphs) {
    const pose = explodePose(glyph, times, t, unit);
    if (pose) parts.push(drawGlyph(doc, plan, glyph, pose, 1, punch));
  }
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
