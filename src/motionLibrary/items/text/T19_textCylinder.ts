import { mixHex } from "../../svg/color";
import { g, path, type Point2 } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { layoutLine, type GlyphBox } from "../../svg/glyphs";
import { project, rotateX, vec3, type Camera3D } from "../../svg/project3d";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { mapPathD } from "./T18_textCorridor";

/**
 * T19 Text Cylinder (円柱), DEPTH: the text wraps around 2–3 horizontal drums
 * (three in tall frames, two otherwise) that turn about a vertical axis; adjacent drums
 * counter-rotate. Every glyph lies on the drum surface: its outline is wrapped around the
 * cylinder point by point (x = R·sin θ, so it narrows as cos θ toward the sides) and
 * projected through a gentle perspective camera that looks a little down, so the far side
 * of each drum shows above its front row: mirrored, moving the other way, and dimmed toward
 * the backdrop (ART_DIRECTION §3, depth). Repeats of the line are separated by a small
 * square icon (□). Drums alternate the readable text colour and the second tone (ink and
 * deep aqua on the paper showcase plate, ART_DIRECTION §0); the icons take the second tone.
 *
 * Sizes: each drum spans 94% of the title-safe width; its glyph size follows from how many
 * whole repeats fit around it, and the drums stack inside the safe height with every
 * glyph at least 9% of the short side. A seamless 4 s loop (catalog loopSeconds): each drum
 * turns a whole number of repeats per loop (one; two at punchy and hype).
 */

const ID = "T19";
const REVISION = 1;
export const T19_LOOP_SECONDS = 4;
/** Drum radius (× half the safe width), glyph em per slot of arc, camera distance (× radius). */
const RADIUS_FILL = 0.94, GLYPH_PER_SLOT = 0.92, CAMERA_DISTANCE = 8;
/** Back row offset: the view tilt puts the far side this many glyph heights above the front row (centre to centre). */
const ROW_OFFSET = 1.1;
/** Least gap between drums (× glyph em), the share of the safe height the drum stack spreads over, and the far side's tone
 * (share of the colour over the backdrop). */
const DRUM_GAP = 0.42, STACK_FILL = 0.8, BACK_TONE = 0.24;
/** The square icon between repeats: side and stroke as a share of the em. */
const ICON = 0.36, ICON_STROKE = 0.085;

export interface CylinderDrum {
  /** Rotation direction (+1 or −1) and the drum axis centre y (frame px). */
  readonly direction: 1 | -1;
  readonly cy: number;
  readonly color: string;
  readonly backColor: string;
}

export interface CylinderLayout {
  readonly drums: readonly CylinderDrum[];
  /** Ring slots (characters and icons) and the repeats of the line around a drum. */
  readonly slots: ReadonlyArray<{ readonly char: string; readonly icon: boolean }>;
  readonly repeats: number;
  readonly radius: number;
  /** Glyph em (px at the drum axis depth). */
  readonly em: number;
  readonly tilt: number;
  readonly cx: number;
  readonly camera: Camera3D;
  /** Glyph outlines at the em size (absolute, pen origin on the baseline) and their ink boxes. */
  readonly glyphs: ReadonlyMap<string, { readonly pathD: string; readonly box: GlyphBox }>;
  readonly iconColor: string;
  readonly iconBackColor: string;
  /** Whole repeats turned per loop. */
  readonly turnsPerLoop: number;
}

export function cylinderLayout(params: TextMotionParams, size: MotionFrameSize): CylinderLayout {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const face = textFace(params.font, 900);
  const characters = [...params.lines.join(" ")].filter(character => character.trim());
  const slots = [...characters.map(char => ({ char, icon: false })), { char: "□", icon: true }];
  const radius = (safe.width / 2) * RADIUS_FILL;
  const drumCount = size.height > size.width * 1.2 ? 3 : 2;
  // Repeats around the drum: the largest whole number whose glyphs still let the drums stack in the safe height.
  const blockHeight = (em: number) => drumCount * em * (1 + ROW_OFFSET) + (drumCount - 1) * DRUM_GAP * em;
  let repeats = 1, em = 0;
  for (; repeats < 24; repeats += 1) {
    em = (GLYPH_PER_SLOT * 2 * Math.PI * radius) / (repeats * slots.length);
    if (blockHeight(em * 1.12) <= safe.height * 0.96) break;
  }
  em = Math.max(em, 0.09 * short / 0.86);
  const tilt = Math.asin(Math.min(0.5, (ROW_OFFSET * em) / (2 * radius)));
  const face100 = { ...face, size: 100 };
  const glyphs = new Map<string, { pathD: string; box: GlyphBox }>();
  for (const slot of slots) {
    if (slot.icon || glyphs.has(slot.char)) continue;
    const line = layoutLine(slot.char, { ...face100, size: em });
    const glyph = line.glyphs[0];
    if (glyph && glyph.bbox && glyph.pathD) glyphs.set(slot.char, { pathD: glyph.pathD, box: glyph.bbox });
  }
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop), secondary = secondaryTone(params.palette, backdrop);
  // Spread the drums so the stack (far row of the first to front row of the last) fills STACK_FILL of the safe height.
  const spacing = drumCount > 1
    ? Math.max(em * (1 + ROW_OFFSET) + DRUM_GAP * em, (STACK_FILL * safe.height - em * (1 + ROW_OFFSET)) / (drumCount - 1))
    : 0;
  const drums: CylinderDrum[] = Array.from({ length: drumCount }, (_, index) => {
    const color = index % 2 === 0 ? primary : secondary;
    // The drum's axis centre: rows centred in the frame (the far row sits ROW_OFFSET em above the front row).
    return { direction: index % 2 === 0 ? 1 : -1, cy: size.height / 2 + (index - (drumCount - 1) / 2) * spacing, color,
      backColor: mixHex(backdrop, color, BACK_TONE) };
  });
  const tier = energyProfile(params.energy).tier;
  return {
    drums, slots, repeats, radius, em, tilt, cx: size.width / 2, glyphs,
    camera: { focal: CAMERA_DISTANCE * radius, cx: size.width / 2, cy: 0, near: 1 },
    iconColor: secondary, iconBackColor: mixHex(backdrop, secondary, BACK_TONE),
    turnsPerLoop: tier >= 2 ? 2 : 1,
  };
}

/** The □ icon as absolute path data centred on the origin: a square ring ICON em wide with an ICON_STROKE em wall. */
function iconPathD(em: number): string {
  const half = (ICON * em) / 2, inner = half - ICON_STROKE * em;
  const square = (h: number, clockwise: boolean) => (clockwise
    ? `M${-h} ${-h}L${h} ${-h}L${h} ${h}L${-h} ${h}Z` : `M${-h} ${-h}L${-h} ${h}L${h} ${h}L${h} ${-h}Z`);
  return square(Number(half.toFixed(2)), true) + square(Number(inner.toFixed(2)), false);
}

/** A point on drum `drum` at angle θ (0 = facing the camera) and height v (px, down from the axis centre) → frame px. */
function drumPoint(layout: CylinderLayout, drum: CylinderDrum, theta: number, v: number): Point2 {
  const r = layout.radius;
  // Tilt the drum's far side up (the camera looks a little down), then place its axis CAMERA_DISTANCE radii away.
  const local = rotateX(vec3(r * Math.sin(theta), v, r * Math.cos(theta)), -(layout.tilt * 180) / Math.PI);
  const p = project(vec3(local.x, local.y, local.z - CAMERA_DISTANCE * r), layout.camera);
  return [p.x, drum.cy + (p.y - layout.camera.cy) ];
}

export const T19_textCylinder = defineTextMotion(ID, (params, t, size) => {
  const layout = cylinderLayout(params, size);
  const doc = createTextDocument(size, params);
  const n = layout.slots.length * layout.repeats, step = (2 * Math.PI) / n;
  const turn = (layout.turnsPerLoop * 2 * Math.PI * loopPhase(t, T19_LOOP_SECONDS)) / layout.repeats;
  const back: string[] = [], front: string[] = [];
  for (const drum of layout.drums) {
    for (let k = 0; k < n; k += 1) {
      const slot = layout.slots[k % layout.slots.length];
      // Slot centre angle; the text runs left to right across the front (θ grows toward +x).
      const theta = k * step - drum.direction * turn;
      const facing = Math.cos(theta);
      const target = facing >= 0 ? front : back;
      if (slot.icon) {
        // A hollow square (outer contour clockwise, hole counter-clockwise) wrapped onto the drum like the glyphs.
        const d = mapPathD(iconPathD(layout.em), (u, v) => drumPoint(layout, drum, theta + u / layout.radius, v));
        target.push(path(d, { fill: facing >= 0 ? layout.iconColor : layout.iconBackColor }));
        continue;
      }
      const glyph = layout.glyphs.get(slot.char);
      if (!glyph) continue;
      const gx = (glyph.box.x0 + glyph.box.x1) / 2, gy = (glyph.box.y0 + glyph.box.y1) / 2;
      const d = mapPathD(glyph.pathD, (x, y) => drumPoint(layout, drum, theta + (x - gx) / layout.radius, y - gy));
      target.push(path(d, { fill: facing >= 0 ? drum.color : drum.backColor }));
    }
  }
  return doc.render(g(undefined, back), g(undefined, front));
}, { revision: REVISION });
