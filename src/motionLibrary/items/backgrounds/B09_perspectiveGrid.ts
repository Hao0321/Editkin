import { mostContrasting } from "../../svg/color";
import { createSvgDocument, g, path, pathData, rect, tf } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B09 Perspective Grid (ART_DIRECTION §10, base D): synthwave floor and ceiling
 * grids on the dark card, mirrored about a horizon at the frame centre and
 * scrolling toward the camera, drawn crisp as in the reference: cream cross lines
 * and accent long lines, all at full strength. Lines are in true perspective: the
 * cross lines thin out and crowd toward the horizon (stopping before they come
 * closer than a few pixels), and the long lines taper and converge on the vanishing
 * point, where they meet in a star on a thin cream horizon line.
 *
 * Loop: the cross lines move by exactly one cell per cycle, so frame N equals
 * frame 0. Two cells per loop at speed 1; other speeds scale the scroll and stretch
 * the loop by 1, 2 or 4 so it still moves whole cells (backgroundLoop). density
 * sets the cell size (the camera stays put). Energy scales the line
 * weight; the seed sets the depth phase.
 */

const ID = "B09";
/** Art revision: 1 = accent lines fading into a glowing horizon; 2 = §10 reference recreation (crisp cream cross lines, accent long lines). */
const REVISION = 2;
export const B09_LOOP_SECONDS = 2;
/** Cells scrolled per loop at speed 1. */
export const B09_LOOP_CYCLES = 2;
/** Focal length as a fraction of the frame's long side; the cell width at the bottom edge (authored px). */
const FOCAL = 0.75, BASE_CELL = 150;
/** Line width at the bottom edge (authored px). */
const LINE = 3.2;
/** Cross lines stop where neighbouring lines come closer than this (authored px). */
const CROWD = 4;
/** Long lines: the columns drawn reach this multiple of the bottom edge's half width. */
const COLUMN_REACH = 3;
const HORIZON_LINE = 2.5;

export const B09_perspectiveGrid = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const weight = clamp(energyProfile(params.energy).amplitude, 0.75, 1.3);
  const { loopSeconds, cycles } = backgroundLoop(B09_LOOP_SECONDS, B09_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const depthPhase = createSeededRng(ID, params.seed).next();
  const cx = size.width / 2, cy = size.height / 2, half = size.height / 2;
  // Camera height 1 (world units): a floor point at depth z shows at y = cy + focal / z.
  const focal = FOCAL * Math.max(size.width, size.height);
  const lineWidth = LINE * unit * weight;
  const nearest = focal / (half + lineWidth * 2);
  // World cell: BASE_CELL / density px wide at the bottom edge.
  const cell = (BASE_CELL * unit) / params.density / (focal / nearest);
  // Neighbouring cross lines at depth z are focal · cell / z² px apart: stop where they crowd.
  const farthest = Math.sqrt((focal * cell) / (CROWD * unit));
  const cross = pathData(2), long = pathData(2);

  // Cross lines at depth z = (k + phase) · cell, moving one cell per cycle toward the camera.
  const phase = (((depthPhase - cycles * u) % 1) + 1) % 1;
  for (let k = Math.floor(nearest / cell) - 1; (k + phase) * cell <= farthest; k += 1) {
    const z = (k + phase) * cell;
    if (z < nearest) continue;
    const y = cy + focal / z, width = Math.max(0.8, (lineWidth * nearest) / z);
    cross.M(0, y - width / 2).H(size.width).V(y + width / 2).H(0).Z();
  }

  // Long lines between cell columns, from the bottom edge to the vanishing point (a linear taper is the
  // perspective-correct width), out to COLUMN_REACH half-widths of the bottom edge.
  const columns = Math.ceil((COLUMN_REACH * cx * nearest) / focal / cell);
  const bottomY = cy + focal / nearest;
  for (let column = -columns; column < columns; column += 1) {
    const xb = cx + (focal * (column + 0.5) * cell) / nearest;
    long.M(xb - lineWidth / 2, bottomY).L(xb + lineWidth / 2, bottomY).L(cx, cy).Z();
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  const cream = mostContrasting(params.palette.bg, [params.palette.paper, params.palette.ink]);
  const floor = [path(long.toString(), { fill: params.palette.accent }), path(cross.toString(), { fill: cream })];
  const horizon = HORIZON_LINE * unit;
  return doc.render(
    floor,
    // The ceiling mirrors the floor about the horizon.
    g({ transform: tf.matrix(1, 0, 0, -1, 0, size.height) }, floor),
    rect(0, cy - horizon / 2, size.width, horizon, { fill: cream }),
  );
}, { revision: REVISION, loopSeconds: B09_LOOP_SECONDS, loopCycles: B09_LOOP_CYCLES });
