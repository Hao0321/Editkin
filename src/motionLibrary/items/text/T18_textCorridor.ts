import { mixHex } from "../../svg/color";
import { circlePathD, g, path, polygonPathD, type Point2 } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { layoutLine, type GlyphBox } from "../../svg/glyphs";
import { parseAbsolutePathD } from "../../svg/pathOps";
import { project, projectPolygon, vec3, type Camera3D, type Vec3 } from "../../svg/project3d";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, readableColor, textFace } from "../shared";
import { isMarqueeSeparator } from "./T09_hugeTextScroll";

/**
 * T18 Text Corridor (文字の廊下), DEPTH: a one-point-perspective corridor whose floor,
 * ceiling and both walls are tiled with the repeating text (line 1, joined with 「・」).
 * Every character sits upright on its own tile; character tiles are the accent with ink
 * glyphs (ART_DIRECTION §0: ink on the accent card), separator tiles are the deep shade
 * with a paper dot, and the dark gaps between tiles draw the grid. The tile pitch grows with
 * the frame aspect in wide frames (bold tiles, never a mosaic). The corridor matches the
 * frame's aspect, so its corner lines run into the frame corners, and the
 * camera dollies forward (svg/project3d: real perspective; tiles are projected polygons
 * clipped at the near plane, glyph outlines are mapped point by point through the same
 * projection). Tiles wash toward paper with depth, into a bright cream core at the end of
 * the corridor (the vanishing core), so they emerge from the light and never pop in.
 *
 * Lanes read like signage: walls read along the corridor (left wall into the depth, right
 * wall out of it), floor and ceiling lanes read top to bottom on screen. A seamless 2 s
 * loop (catalog loopSeconds): every lane advances a whole number of text repeats per loop
 * (one at calm and standard, two at punchy and hype). The corridor bleeds by definition:
 * tiles stream out through every frame edge.
 */

const ID = "T18";
const REVISION = 1;
export const T18_LOOP_SECONDS = 2;
/** Corridor half-height (world units; the half-width follows the frame aspect) and the tile pitch in tall frames; wide frames
 * scale the pitch with the aspect, so a landscape corridor keeps bold tiles instead of a mosaic. */
const HALF_HEIGHT = 1, TILE = 2 / 3;
/** Tile body and glyph em as a share of the pitch; the separator dot radius as a share of the tile. */
const TILE_FILL = 0.8, GLYPH_EM = 0.58, DOT = 0.1;
/** The corridor's far end (depth, world units): the bright core sits there. Tiles wash toward paper from WASH_FROM. */
export const T18_CORE_DEPTH = 7.5;
const WASH_FROM = 1.6, WASH_POWER = 1.35;
/** Glyphs are drawn only on tiles at least this tall on screen (px at 1080 units); smaller tiles are plain. */
const MIN_GLYPH_TILE = 26;

/** One planar lane of tiles: depth runs along it; the tile frame gives the glyph's right and down axes. */
interface Lane {
  readonly plane: "left" | "right" | "floor" | "ceiling";
  /** Tile centre across the lane (world): y on walls, x on floor and ceiling. */
  readonly across: number;
  /** +1: the text index grows with depth (reads into the corridor), −1: it grows toward the camera. */
  readonly order: 1 | -1;
  /** Seeded offset along the lane, in tiles. */
  readonly phase: number;
  /** Lane pitch across the plane (world units). */
  readonly pitch: number;
}

export interface CorridorLayout {
  readonly halfWidth: number;
  readonly lanes: readonly Lane[];
  readonly camera: Camera3D;
  /** Tile sequence of one repeat: each character, flagged when it is a separator. */
  readonly cells: ReadonlyArray<{ readonly char: string; readonly separator: boolean }>;
  /** Glyph outlines at 100 px (absolute, pen origin on the baseline) and ink boxes, by character. */
  readonly glyphs: ReadonlyMap<string, { readonly pathD: string; readonly box: GlyphBox }>;
  readonly tilesPerLoop: number;
  readonly unit: number;
  readonly colors: { readonly tile: string; readonly glyph: string; readonly separatorTile: string; readonly dot: string; readonly core: string };
}

const REFERENCE_SIZE = 100;

/** One tile per visible character of the line; a separator tile closes the repeat when the line has none. */
function corridorCells(text: string): Array<{ char: string; separator: boolean }> {
  const characters = [...text.trim()].filter(character => character.trim());
  const cells = characters.map(char => ({ char, separator: isMarqueeSeparator(char) }));
  if (!cells.length || !cells[cells.length - 1].separator) cells.push({ char: "・", separator: true });
  return cells;
}

export function corridorLayout(params: TextMotionParams, size: MotionFrameSize): CorridorLayout {
  const face = textFace(params.font, 900);
  const aspect = size.width / size.height;
  const halfWidth = HALF_HEIGHT * aspect;
  const cells = corridorCells(params.lines[0]);
  const glyphs = new Map<string, { pathD: string; box: GlyphBox }>();
  for (const cell of cells) {
    if (cell.separator || glyphs.has(cell.char)) continue;
    const line = layoutLine(cell.char, { ...face, size: REFERENCE_SIZE });
    const glyph = line.glyphs[0];
    if (glyph && glyph.bbox && glyph.pathD) glyphs.set(cell.char, { pathD: glyph.pathD, box: glyph.bbox });
  }
  // Lanes: as many tiles across each plane as fit the pitch (at least one).
  const rng = createSeededRng(ID, params.seed, "lanes");
  const lanes: Lane[] = [];
  const unit = TILE * Math.max(1, aspect);
  const across = (half: number) => {
    const count = Math.max(1, Math.round((2 * half) / unit));
    const pitch = (2 * half) / count;
    return Array.from({ length: count }, (_, index) => ({ centre: -half + pitch * (index + 0.5), pitch }));
  };
  for (const { centre, pitch } of across(HALF_HEIGHT)) {
    lanes.push({ plane: "left", across: centre, order: 1, phase: rng.next() * cells.length, pitch });
    lanes.push({ plane: "right", across: centre, order: -1, phase: rng.next() * cells.length, pitch });
  }
  for (const { centre, pitch } of across(halfWidth)) {
    lanes.push({ plane: "floor", across: centre, order: -1, phase: rng.next() * cells.length, pitch });
    lanes.push({ plane: "ceiling", across: centre, order: 1, phase: rng.next() * cells.length, pitch });
  }
  const palette = params.palette;
  const tier = energyProfile(params.energy).tier;
  return {
    halfWidth, lanes, cells, glyphs,
    camera: { focal: size.height / 2, cx: size.width / 2, cy: size.height / 2, near: 0.02 },
    tilesPerLoop: cells.length * (tier >= 2 ? 2 : 1), unit,
    colors: {
      tile: palette.accent, glyph: readableColor(palette.accent, [palette.ink, palette.paper]),
      separatorTile: palette.accent2, dot: readableColor(palette.accent2, [palette.paper, palette.ink]), core: palette.paper,
    },
  };
}

/** World point of the tile frame: (s, a) = (along the lane in world units of depth, across the tile, world). */
function lanePoint(lane: Lane, halfWidth: number, depth: number, across: number): Vec3 {
  switch (lane.plane) {
    case "left": return vec3(-halfWidth, across, -depth);
    case "right": return vec3(halfWidth, across, -depth);
    case "floor": return vec3(across, HALF_HEIGHT, -depth);
    case "ceiling": return vec3(across, -HALF_HEIGHT, -depth);
  }
}

/**
 * Glyph frame on a tile: local (gx, gy) at 100 px → world. Walls: right = along the lane toward
 * reading order, down = +y. Floor: right = +x, down = toward the camera. Ceiling: right = +x, down = away.
 */
function glyphToWorld(lane: Lane, halfWidth: number, centreDepth: number, scale: number, gx: number, gy: number): Vec3 {
  const a = lane.across;
  switch (lane.plane) {
    case "left": return vec3(-halfWidth, a + gy * scale, -(centreDepth + gx * scale));
    case "right": return vec3(halfWidth, a + gy * scale, -(centreDepth - gx * scale));
    case "floor": return vec3(a + gx * scale, HALF_HEIGHT, -(centreDepth - gy * scale));
    case "ceiling": return vec3(a + gx * scale, -HALF_HEIGHT, -(centreDepth + gy * scale));
  }
}

const parsedCache = new Map<string, ReturnType<typeof parseAbsolutePathD>>();
function parsedPath(d: string): ReturnType<typeof parseAbsolutePathD> {
  let hit = parsedCache.get(d);
  if (!hit) {
    hit = parseAbsolutePathD(d, "mapPathD");
    parsedCache.set(d, hit);
    if (parsedCache.size > 64) parsedCache.delete(parsedCache.keys().next().value!);
  }
  return hit;
}

/** An integer count of tenths as a compact path number: "12.3", ".5", "-4", "0" (no leading zero, no signed zero). */
function tenthsText(tenths: number): string {
  if (tenths === 0) return "0";
  const negative = tenths < 0, magnitude = negative ? -tenths : tenths;
  const whole = Math.floor(magnitude / 10), fraction = magnitude - whole * 10;
  const body = fraction === 0 ? String(whole) : whole === 0 ? `.${fraction}` : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/**
 * Map absolute M/L/Q/C/Z path data point by point (control points too: under a projective map
 * straight edges stay exact and the short glyph curves stay within a fraction of a pixel) and
 * emit compact relative path data in tenths of a pixel. Positions are snapped to whole tenths
 * first and the steps are exact integer differences, so rounding never accumulates; numbers are
 * written from integers (no toFixed in the hot loop). Throws on a non-finite point.
 */
export function mapPathD(d: string, map: (x: number, y: number) => Point2): string {
  let out = "", x = 0, y = 0, startX = 0, startY = 0;
  const snap = (value: number) => {
    if (!Number.isFinite(value) || Math.abs(value) >= 1e8) throw new RangeError(`mapPathD point out of range (${value})`);
    return Math.round(value * 10);
  };
  /** One command's tokens relative to the segment start; a separator only where a minus sign does not already split them. */
  const emit = (command: string, points: ReadonlyArray<readonly [number, number]>) => {
    let text = command;
    for (const [px, py] of points) {
      for (const token of [tenthsText(snap(px) - x), tenthsText(snap(py) - y)]) text += text.length > 1 && token.charCodeAt(0) !== 45 ? ` ${token}` : token;
    }
    out += text;
  };
  for (const segment of parsedPath(d)) {
    switch (segment.type) {
      case "M": { const end = map(segment.x, segment.y); emit("m", [end]); x = startX = snap(end[0]); y = startY = snap(end[1]); break; }
      case "L": { const end = map(segment.x, segment.y); emit("l", [end]); x = snap(end[0]); y = snap(end[1]); break; }
      case "Q": { const c1 = map(segment.x1, segment.y1), end = map(segment.x, segment.y); emit("q", [c1, end]); x = snap(end[0]); y = snap(end[1]); break; }
      case "C": {
        const c1 = map(segment.x1, segment.y1), c2 = map(segment.x2, segment.y2), end = map(segment.x, segment.y);
        emit("c", [c1, c2, end]); x = snap(end[0]); y = snap(end[1]); break;
      }
      case "Z": out += "z"; x = startX; y = startY; break;
    }
  }
  return out;
}

/** Wash toward the core colour with depth (0 near, 1 at the core). */
export function corridorWash(depth: number): number {
  const p = Math.max(0, Math.min(1, (depth - WASH_FROM) / (T18_CORE_DEPTH - WASH_FROM)));
  return p ** WASH_POWER;
}

export const T18_textCorridor = defineTextMotion(ID, (params, t, size) => {
  const layout = corridorLayout(params, size);
  const doc = createTextDocument(size, params);
  const { camera, halfWidth, colors } = layout;
  const shift = layout.tilesPerLoop * loopPhase(t, T18_LOOP_SECONDS);
  const minGlyphTile = MIN_GLYPH_TILE * Math.min(size.width, size.height) / 1080;
  const tile = layout.unit, half = (tile * TILE_FILL) / 2;
  type Draw = { depth: number; markup: string };
  const draws: Draw[] = [];
  for (const lane of layout.lanes) {
    // Tile k (any integer) sits at lane depth (k + phase − shift) · TILE along the lane (toward the core).
    const offset = lane.phase - shift;
    const first = Math.ceil(0.4 / tile - offset - 1), last = Math.floor(T18_CORE_DEPTH / tile - offset);
    const halfAcross = (lane.pitch * TILE_FILL) / 2;
    for (let k = first; k <= last; k += 1) {
      const centreDepth = (k + offset + 0.5) * tile;
      // Wall, floor and ceiling points nearer than depth 1 project outside the frame: such tiles are invisible.
      if (centreDepth + half <= 1 || centreDepth - half >= T18_CORE_DEPTH) continue;
      const cell = layout.cells[((lane.order * k) % layout.cells.length + layout.cells.length) % layout.cells.length];
      const corners = [[-half, -halfAcross], [half, -halfAcross], [half, halfAcross], [-half, halfAcross]].map(([s, a]) =>
        lanePoint(lane, halfWidth, centreDepth + s, lane.across + a));
      const projected = projectPolygon(corners, camera);
      if (!projected.visible) continue;
      const wash = corridorWash(centreDepth);
      const tileColor = mixHex(cell.separator ? colors.separatorTile : colors.tile, colors.core, wash);
      let markup = path(polygonPathD(projected.points as Point2[], 1), { fill: tileColor });
      const tileHeight = (Math.min(tile, lane.pitch) * TILE_FILL * camera.focal) / Math.max(1e-6, centreDepth);
      if (cell.separator) {
        const centre = project(lanePoint(lane, halfWidth, centreDepth, lane.across), camera);
        if (centre.visible) markup += path(circlePathD(centre.x, centre.y, DOT * Math.min(tile, lane.pitch) * TILE_FILL * centre.scale, 1), { fill: mixHex(colors.dot, colors.core, wash) });
      } else if (tileHeight >= minGlyphTile && centreDepth - half > 0.3) {
        const glyph = layout.glyphs.get(cell.char);
        if (glyph) {
          // Centre the glyph's ink box on the tile; GLYPH_EM of the pitch per 100 px em.
          const scale = (Math.min(tile, lane.pitch) * GLYPH_EM) / REFERENCE_SIZE;
          const gx0 = (glyph.box.x0 + glyph.box.x1) / 2, gy0 = (glyph.box.y0 + glyph.box.y1) / 2;
          const d = mapPathD(glyph.pathD, (x, y) => {
            const p = project(glyphToWorld(lane, halfWidth, centreDepth, scale, x - gx0, y - gy0), camera);
            return [p.x, p.y];
          });
          markup += path(d, { fill: mixHex(colors.glyph, colors.core, wash) });
        }
      }
      draws.push({ depth: projected.depth, markup });
    }
  }
  draws.sort((a, b) => b.depth - a.depth);
  // The bright core: the corridor's far opening (its cross-section at the core depth) in paper.
  const coreScale = camera.focal / T18_CORE_DEPTH;
  const core = polygonPathD([[-halfWidth, -HALF_HEIGHT], [halfWidth, -HALF_HEIGHT], [halfWidth, HALF_HEIGHT], [-halfWidth, HALF_HEIGHT]]
    .map(([x, y]) => [camera.cx + x * coreScale, camera.cy + y * coreScale] as Point2), 1);
  return doc.render(path(core, { fill: colors.core }), g(undefined, draws.map(draw => draw.markup)));
}, { revision: REVISION });
