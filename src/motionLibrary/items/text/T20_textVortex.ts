import { mixHex } from "../../svg/color";
import { g, path, polygon, transform, tf, type Point2 } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, frameUnit, heroTextBox, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground,
} from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T20 Text Vortex (渦), DEPTH: a stack of 10 copies of the word wrung like a towel around
 * the frame centre. Copy i (0 = front) is scaled SHRINK^i and turned by i × twist; the twist
 * swings between ±TWIST per copy (it passes CATALOG T20's 6° on the way), lingering at the
 * wound ends and snapping through the straight stack, so the copies fan into a spiral one
 * way, unwind and wind the other way. The front copy is the reading word in the readable
 * text colour (heroTextBox, tight displayTracking); the copies behind it are solid slices
 * alternating the second tone and the text colour (aqua and cream on the dark card,
 * ART_DIRECTION §0), each keyed by a thin backdrop-coloured outline and fogged toward the
 * backdrop with depth, so the fanned edges read as a twisted paper stack (flat colour, no
 * extrusion). The whole stack rocks a few degrees, and three arrowhead glints in the second
 * tone orbit the vortex once per loop on a tilted ellipse, pointing along their travel.
 *
 * A seamless 3 s loop (catalog loopSeconds): twist, rock and orbit are periodic in the loop.
 * Energy scales the twist. The front copy stays inside the 5% title-safe box at every phase
 * and the fanned copies stay inside the frame.
 */

const ID = "T20";
const REVISION = 1;
export const T20_LOOP_SECONDS = 3;
export const T20_COPIES = 10;
/** Scale step between copies, the twist per copy at the wound ends (degrees, standard energy) and the stack's rock. */
const SHRINK = 0.92, TWIST = 12, ROCK = 4;
/** Twist shaping: |sin|^SHAPE keeps the stack wound longer and snaps it through straight. */
const SHAPE = 0.55;
/** Keyline (em of the hero copy) separating the slices, depth fog per copy (toward the backdrop, capped). */
const KEYLINE_EM = 0.016, FOG_PER_COPY = 0.06, FOG_MAX = 0.6, LINE_HEIGHT = 1.04;
/** Glints: count, orbit radius (× the larger half-extent of the word), ellipse squash, size (× short side). */
const GLINTS = 3, GLINT_ORBIT = 1.04, GLINT_SQUASH = 0.62, GLINT_SIZE = 0.046;

export interface VortexLayout {
  readonly pathD: string;
  readonly inkCenter: readonly [number, number];
  readonly fontSize: number;
  /** Hero ink box size (px) before the fit factor. */
  readonly inkWidth: number;
  readonly inkHeight: number;
  /** Uniform fit factor: the most twisted copies stay inside the frame, the rocked front copy inside the safe box. */
  readonly fit: number;
  readonly cx: number;
  readonly cy: number;
  readonly backdrop: string;
  readonly primary: string;
  readonly secondary: string;
  /** Twist per copy at the wound ends (degrees, energy applied). */
  readonly twist: number;
  readonly glintSize: number;
  readonly keyline: number;
}

/** Half-extents of a w × h box rotated by `degrees`. */
function rotatedHalfExtents(w: number, h: number, degrees: number): [number, number] {
  const a = (Math.abs(degrees) * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return [(w * c + h * s) / 2, (w * s + h * c) / 2];
}

export function vortexLayout(params: TextMotionParams, size: MotionFrameSize): VortexLayout {
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom: 1.04 }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const w = text.ink.x1 - text.ink.x0, h = text.ink.y1 - text.ink.y0;
  const twist = TWIST * Math.min(1.4, energyProfile(params.energy).amplitude);
  // Fit: every turn a copy passes through (0° up to its wound angle) keeps its box inside the frame.
  let fit = 1;
  for (let index = 1; index < T20_COPIES; index += 1) {
    const wound = index * twist + ROCK;
    for (let turn = 0; turn <= wound + 1e-9; turn += Math.max(1, wound / 12)) {
      const [hx, hy] = rotatedHalfExtents(w * SHRINK ** index, h * SHRINK ** index, Math.min(turn, wound));
      fit = Math.min(fit, (size.width / 2 - 2) / hx, (size.height / 2 - 2) / hy);
    }
  }
  const [fx, fy] = rotatedHalfExtents(w, h, ROCK);
  fit = Math.min(fit, (size.width * 0.45) / fx, (size.height * 0.45) / fy);
  const backdrop = textBackdrop(params);
  return {
    pathD: compactPathD(text.block.pathD), inkCenter: text.inkCenter, fontSize: text.fontSize, inkWidth: w, inkHeight: h, fit,
    cx: size.width / 2, cy: size.height / 2, backdrop,
    primary: textOnBackground(params.palette, backdrop), secondary: secondaryTone(params.palette, backdrop),
    twist, glintSize: GLINT_SIZE * Math.min(size.width, size.height), keyline: Math.max(KEYLINE_EM * text.fontSize, 1.2 * frameUnit(size)),
  };
}

/** Twist per copy (degrees) and the stack's rock at loop phase (0..1). */
export function vortexPose(layout: VortexLayout, phase: number): { readonly twist: number; readonly rock: number } {
  const s = Math.sin(2 * Math.PI * phase);
  return { twist: layout.twist * Math.sign(s) * Math.abs(s) ** SHAPE, rock: ROCK * Math.sin(2 * Math.PI * phase + Math.PI / 3) };
}

export const T20_textVortex = defineTextMotion(ID, (params, t, size) => {
  const layout = vortexLayout(params, size);
  const doc = createTextDocument(size, params);
  const phase = loopPhase(t, T20_LOOP_SECONDS);
  const { twist, rock } = vortexPose(layout, phase);
  const copies: string[] = [];
  for (let index = T20_COPIES - 1; index >= 0; index -= 1) {
    const scale = layout.fit * SHRINK ** index;
    const base = index % 2 === 1 ? layout.secondary : layout.primary;
    const fill = mixHex(base, layout.backdrop, Math.min(FOG_MAX, FOG_PER_COPY * index));
    copies.push(path(layout.pathD, {
      fill, stroke: layout.backdrop, "stroke-width": layout.keyline / scale, "stroke-linejoin": "round", "paint-order": "stroke",
      transform: transform(tf.translate(layout.cx, layout.cy), tf.rotate(rock + index * twist), tf.scale(scale),
        tf.translate(-layout.inkCenter[0], -layout.inkCenter[1])),
    }));
  }
  // Arrowhead glints orbiting once per loop (clockwise on a tilted ellipse), each pointing along its travel.
  const orbit = (GLINT_ORBIT * layout.fit * Math.max(layout.inkWidth, layout.inkHeight)) / 2;
  const s = layout.glintSize;
  const arrow: Point2[] = [[s * 0.6, 0], [-s * 0.5, -s * 0.46], [-s * 0.2, 0], [-s * 0.5, s * 0.46]];
  const glints = Array.from({ length: GLINTS }, (_, index) => {
    const angle = 2 * Math.PI * (phase + index / GLINTS);
    const x = layout.cx + orbit * Math.cos(angle), y = layout.cy + orbit * GLINT_SQUASH * Math.sin(angle);
    const heading = (Math.atan2(GLINT_SQUASH * Math.cos(angle), -Math.sin(angle)) * 180) / Math.PI;
    return polygon(arrow, { fill: layout.secondary, transform: transform(tf.translate(x, y), tf.rotate(heading)) });
  });
  return doc.render(g(undefined, copies), g(undefined, glints));
}, { revision: REVISION });
