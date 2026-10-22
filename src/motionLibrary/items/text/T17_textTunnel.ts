import { mixHex } from "../../svg/color";
import { g, outlinedAttrs, path, transform, tf } from "../../svg/document";
import { energyProfile, loopPhase, smoothstep } from "../../svg/easing";
import { depthFade, project, vec3, type Camera3D } from "../../svg/project3d";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, frameUnit, heroTextBox, layoutFittedText, secondaryTone, textBackdrop, textFace,
} from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T17 Text Tunnel (テキストトンネル), DEPTH: solid copies of the word recede toward a
 * vanishing point at the frame centre. Copy depths are spaced geometrically (each slot RATIO
 * times deeper) and the stack streams toward the camera, so every copy's scale grows
 * exponentially (CATALOG T17) through a real projection (svg/project3d: scale = focal / depth,
 * the front slot at the hero size).
 *
 * Revision 2 (Claude review 2026-10-22: the r1 outline rest frames read as a tangle of thin
 * lines on complex glyphs): every copy is a FILLED word, keyed by a backdrop-coloured rim, in a
 * dark-to-aqua depth ramp. The colour is the second tone (aqua on the dark card, ART_DIRECTION
 * §0) fogged toward the backdrop by depth, steeply (FOG_PER_SLOT a slot), so the reading copy
 * is always the brightest mass and the deeper copies sit back as darker steps; the rim (a
 * stroke painted under the fill, so only its outer half shows) cuts a clean gap wherever a
 * nearer copy crosses a deeper one. Only a few copies are ever visible (the ramp darkens them
 * into the backdrop by the fourth slot and the core fades out), so the word stays legible at
 * phone size in every frame: discrete echo steps, never a solid extrusion (thick 3D text stays
 * ART_REJECTED).
 *
 * The nearest copy is the reading word: at full aqua it dives through the lens, growing tenfold
 * (quadratic) over its last WHOOSH slots, so it floods the frame for a beat; it cuts out in its
 * last two frames and wraps to the back. A seamless 2.5 s loop (catalog loopSeconds): the stack
 * advances two slots per loop (one pass every 1.25 s), so frame 0 equals the frame at 2.5 s;
 * punchy and hype advance four slots. The tunnel bleeds by definition; the reading copy
 * (heroTextBox: 80–90% of the title-safe width, tight displayTracking) stays whole inside the
 * safe box until it dives.
 */

const ID = "T17";
const REVISION = 2;
export const T17_LOOP_SECONDS = 2.5;
/** Copies in the stack: slots 0 (front, hero size) to COPIES − 1 (the core, faded out). */
export const T17_COPIES = 5;
/** Depth ratio between neighbouring slots. */
export const T17_RATIO = 1.25;
/** Slots advanced per loop by energy tier (calm, standard, punchy, hype). */
const SLOTS_PER_LOOP: readonly number[] = [2, 2, 4, 4];
/** The dive through the lens: the copy's last WHOOSH slots grow it to WHOOSH_SCALE × (quadratic), cutting out over the last share. */
export const T17_WHOOSH = 0.4;
const WHOOSH_SCALE = 10, WHOOSH_CUT = 0.15;
/** The depth ramp: the fill fogs toward the backdrop by FOG_PER_SLOT a slot (at most FOG_MAX); the core fades over its last slots. */
export const T17_FOG_PER_SLOT = 0.3, T17_FOG_MAX = 0.85;
const CORE_FADE_SLOTS = 1.5;
/** The key rim: a backdrop stroke under the fill (em of the copy; its outer half shows, wide enough to close the small counters
 * over deeper copies, so they leave only the odd small step, not hairlines) and the thinnest drawn rim (px at 1080 units). A rim
 * painted under the fill also hides the glyphs' internal overlapping contours (a stroke on top would trace them). */
const KEY_EM = 0.11, MIN_KEY = 2;
const LINE_HEIGHT = 1.04;

export interface TunnelLayout {
  /** Word outline in block coordinates (compact relative path data) and its ink centre. */
  readonly pathD: string;
  readonly inkCenter: readonly [number, number];
  readonly fontSize: number;
  /** Ink box of the hero-sized copy, frame px (centred on the vanishing point). */
  readonly ink: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** Vanishing point (frame centre). */
  readonly cx: number;
  readonly cy: number;
  readonly backdrop: string;
  /** The reading tone: the front of the depth ramp. */
  readonly tone: string;
  /** Slots advanced per loop (energy). */
  readonly slotsPerLoop: number;
  readonly minKey: number;
}

export function tunnelLayout(params: TextMotionParams, size: MotionFrameSize): TunnelLayout {
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const backdrop = textBackdrop(params);
  const cx = size.width / 2, cy = size.height / 2;
  const [ix, iy] = text.inkCenter;
  return {
    pathD: compactPathD(text.block.pathD), inkCenter: text.inkCenter, fontSize: text.fontSize,
    ink: { x0: cx + text.ink.x0 - ix, y0: cy + text.ink.y0 - iy, x1: cx + text.ink.x1 - ix, y1: cy + text.ink.y1 - iy },
    cx, cy, backdrop, tone: secondaryTone(params.palette, backdrop),
    slotsPerLoop: SLOTS_PER_LOOP[energyProfile(params.energy).tier], minKey: MIN_KEY * frameUnit(size),
  };
}

export interface TunnelCopy {
  /** Copy identity (the stream position it entered at). */
  readonly index: number;
  /** Slot position: 0 = the front slot (hero size), COPIES − 1 = the core; negative while the copy dives through the lens. */
  readonly slot: number;
  /** Projected scale (× the hero size). */
  readonly scale: number;
  readonly opacity: number;
  /** Fill: the reading tone fogged toward the backdrop by depth (the dark-to-aqua ramp). */
  readonly fill: string;
}

/** The camera: focal length 1, so a copy at depth d draws at 1 / d × the hero size. */
const CAMERA: Camera3D = { focal: 1, cx: 0, cy: 0, near: 1e-4 };

/** Depth of a slot: geometric spacing, the front slot (0) at depth 1 (the hero size). */
export function tunnelDepth(slot: number): number {
  return T17_RATIO ** slot;
}

/** Depth-ramp fog of a slot (0 at the front, FOG_PER_SLOT a slot, at most FOG_MAX). */
export function tunnelFog(slot: number): number {
  return Math.min(T17_FOG_MAX, T17_FOG_PER_SLOT * Math.max(0, slot));
}

/** Copies on screen at loop phase (0..1), far to near. */
export function tunnelCopies(layout: TunnelLayout, phase: number): TunnelCopy[] {
  const advance = layout.slotsPerLoop * phase;
  const copies: TunnelCopy[] = [];
  for (let index = Math.floor(advance + T17_COPIES - 1); index > advance - T17_WHOOSH; index -= 1) {
    const slot = index - advance;
    let scale = project(vec3(0, 0, -tunnelDepth(slot)), CAMERA).scale;
    let opacity = depthFade(slot, T17_COPIES - 1 - CORE_FADE_SLOTS, T17_COPIES - 1);
    if (slot < 0) {
      // The dive: an accelerating pass through the lens (the flood), cut over its last frames.
      const p = -slot / T17_WHOOSH;
      scale *= 1 + (WHOOSH_SCALE - 1) * p * p;
      opacity *= 1 - smoothstep(1 - WHOOSH_CUT, 1, p);
    }
    if (!(opacity > 0.002)) continue;
    copies.push({ index, slot, scale, opacity, fill: mixHex(layout.tone, layout.backdrop, tunnelFog(slot)) });
  }
  return copies;
}

export const T17_textTunnel = defineTextMotion(ID, (params, t, size) => {
  const layout = tunnelLayout(params, size);
  const doc = createTextDocument(size, params);
  const parts = tunnelCopies(layout, loopPhase(t, T17_LOOP_SECONDS)).map(copy => {
    // The rim lives in the copy, so it thins with depth (never under minKey on screen); a diving copy keeps the hero rim on
    // screen instead of growing it tenfold. Painted under the fill, so only its outer half shows.
    const key = Math.max(KEY_EM * layout.fontSize / Math.max(1, copy.scale), layout.minKey / copy.scale);
    return g({
      opacity: copy.opacity < 0.998 ? copy.opacity : undefined,
      transform: transform(tf.translate(layout.cx, layout.cy), tf.scale(copy.scale), tf.translate(-layout.inkCenter[0], -layout.inkCenter[1])),
    }, path(layout.pathD, outlinedAttrs(copy.fill, layout.backdrop, key)));
  });
  return doc.render(parts);
}, { revision: REVISION });
