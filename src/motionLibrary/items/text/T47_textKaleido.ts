import { g, path, transform, tf } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { layoutTextBlock, type GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, secondaryTone, textBackdrop, textFace, textOnBackground } from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T47 Text Kaleido (文字萬花筒), DRAMA, designed on the paper plate: 8 copies of the word
 * radiate from the frame centre like petals. Copy 0 reads outward along the +x axis with its
 * inner edge at r0 = 12% of the short side; copy k is that copy turned k × 45° about the frame
 * centre, so the centre stays clear and neighbouring petals overlap only near their bases.
 * Copies alternate the readable text colour and the second tone (ink and olive on the cream
 * card: the lime accent cannot be read on cream, ART_DIRECTION §0 / T43's precedent); the
 * even copies lie under the odd ones (two whorls, eightfold symmetric), and every copy is
 * keyed by a backdrop-coloured outline so the overlapping bases separate cleanly. The rosette
 * turns 90°/s, and each copy's radius breathes ±8% (two breaths per loop) with phase k × 45°,
 * a wave running around the flower.
 *
 * Size: the word is as large as the rosette allows: its outer tip (at the widest breath)
 * stays on a circle of 45% of the short side, so every glyph stays inside the frame while it
 * turns. A seamless 4 s loop (catalog loopSeconds: one full turn). Energy scales the
 * breathing depth, never the period.
 */

const ID = "T47";
const REVISION = 1;
export const T47_LOOP_SECONDS = 4;
export const T47_COPIES = 8;
/** Inner edge radius (× short side), breathing depth (× the copy's centre radius), breaths per loop, rosette radius (× short side). */
export const T47_INNER = 0.12;
const BREATH = 0.08, BREATHS = 2, ROSETTE = 0.45, LINE_HEIGHT = 1.04, KEYLINE = 0.07;

export interface KaleidoLayout {
  /** Word outline in block coordinates and its ink box. */
  readonly pathD: string;
  readonly ink: GlyphBox;
  readonly fontSize: number;
  readonly cx: number;
  readonly cy: number;
  /** Distance from the frame centre to the copy's ink centre at rest (px), and the breathing amplitude (px). */
  readonly radius: number;
  readonly breath: number;
  /** Keyline around every copy (backdrop colour, px) so overlapping petals separate. */
  readonly keyline: number;
  readonly backdrop: string;
  readonly colors: readonly [string, string];
}

/** Outer reach of a radial copy: its far corners from the centre, for a word w × h whose inner edge sits at r. */
function reach(w: number, h: number, r: number): number {
  return Math.hypot(r + w, h / 2);
}

export function kaleidoLayout(params: TextMotionParams, size: MotionFrameSize): KaleidoLayout {
  const short = Math.min(size.width, size.height);
  const face = { ...textFace(params.font, 900), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines) };
  const reference = layoutTextBlock(params.lines, { ...face, size: 100 });
  const refInk = reference.inkBox ?? { x0: 0, y0: 0, x1: reference.width, y1: reference.height };
  const w100 = refInk.x1 - refInk.x0, h100 = refInk.y1 - refInk.y0;
  const inner = T47_INNER * short, limit = ROSETTE * short;
  const depth = BREATH * Math.min(1.6, energyProfile(params.energy).amplitude);
  // The largest size whose breathing-out pose still reaches no further than the rosette circle (bisection; reach grows with size).
  let low = 1, high = 4000;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const size100 = (low + high) / 2, k = size100 / 100;
    const w = w100 * k, h = h100 * k;
    const centre = inner + w / 2;
    if (reach(w, h, centre * (1 + depth) - w / 2) <= limit) low = size100; else high = size100;
  }
  const fontSize = Math.floor(low * 1000) / 1000;
  const block = layoutTextBlock(params.lines, { ...face, size: fontSize });
  const ink = block.inkBox ?? { x0: 0, y0: 0, x1: block.width, y1: block.height };
  const w = ink.x1 - ink.x0;
  const backdrop = textBackdrop(params);
  return {
    pathD: compactPathD(block.pathD), ink, fontSize, cx: size.width / 2, cy: size.height / 2, backdrop,
    radius: inner + w / 2, breath: depth * (inner + w / 2), keyline: KEYLINE * fontSize,
    colors: [textOnBackground(params.palette, backdrop), secondaryTone(params.palette, backdrop)],
  };
}

/** Rosette turn (degrees) and copy k's radius (px) at loop phase (0..1). */
export function kaleidoPose(layout: KaleidoLayout, phase: number, k: number): { readonly turn: number; readonly radius: number } {
  return {
    turn: 360 * phase,
    radius: layout.radius + layout.breath * Math.sin(2 * Math.PI * BREATHS * phase + (k * Math.PI) / 4),
  };
}

export const T47_textKaleido = defineTextMotion(ID, (params, t, size) => {
  const layout = kaleidoLayout(params, size);
  const doc = createTextDocument(size, params);
  const phase = loopPhase(t, T47_LOOP_SECONDS);
  const icx = (layout.ink.x0 + layout.ink.x1) / 2, icy = (layout.ink.y0 + layout.ink.y1) / 2;
  const copy = (k: number) => {
    const { turn, radius } = kaleidoPose(layout, phase, k);
    // Copy 0 reads outward along +x (its ink centre at +radius), turned k × 45° plus the rosette turn about the centre.
    return path(layout.pathD, {
      fill: layout.colors[k % 2], stroke: layout.backdrop, "stroke-width": layout.keyline, "stroke-linejoin": "round", "paint-order": "stroke",
      transform: transform(tf.translate(layout.cx, layout.cy), tf.rotate(turn + k * 45), tf.translate(radius - icx, -icy)),
    });
  };
  const under = [0, 2, 4, 6].map(copy), over = [1, 3, 5, 7].map(copy);
  return doc.render(g(undefined, under), g(undefined, over));
}, { revision: REVISION });
