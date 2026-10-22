import { circlePathD, rectPathD } from "./document";
import type { LineLayout, TextBlockLayout } from "./glyphs";
import { flattenPathD, type FlatPoint } from "./pathOps";

/**
 * Glyph-cell sampler (DESIGN §8): glyph outlines → a grid of square cells with
 * coverage 0..1. Users: T31 LED (dot matrix), T45 Disintegrate, T53 Scramble
 * Decode, T67 Pixel Dissolve.
 *
 * Contours are flattened (chords ≤ min(6, cell / supersample) px) and tested at
 * supersample² points per cell (2×2 or 4×4) with a scanline point-in-polygon
 * test. The default rule is nonzero, the rule librsvg and every font renderer
 * fill glyphs with: the Noto Sans TC / Noto Serif TC render faces draw strokes
 * as overlapping contours, so even-odd (DESIGN §8's wording) punches holes
 * where strokes cross — measured at 120 px, 人 loses 12.5% of its ink at
 * display 900, 發 15%, 累 18%; hand, mono, latin and latin_round match either
 * way. Pass fillRule "evenodd" only for outlines you built yourself.
 *
 * Each cell keeps one sample bitmask per glyph, so the union coverage is exact
 * even where glyphs touch, and every cell is owned by the glyph covering most of
 * its samples (ties: lowest glyphIndex). Results are cached per (outlines,
 * options) and frozen. Pure math: deterministic, browser-safe.
 *
 * Coordinates are those of the outlines (usually block or frame px). The grid is
 * aligned to (originX, originY): cell (column, row) spans
 * [originX + column·size, +size) × [originY + row·size, +size).
 *
 * Usage (T67-style pixel break-up of a fitted word):
 *   const text = layoutFittedText(params.lines, face, box);           // items/shared.ts
 *   const cells = sampleGlyphCells(blockOutlines(text.block), { cellSize: text.fontSize / 9 });
 *   const order = createSeededRng(ID, params.seed, "order");          // seeded vanish order
 *   const visible = cells.filter(cell => cell.coverage >= 0.5 && keep(cell));
 *   path(cellsPathD(visible), { fill: ink, transform: ... })          // one <path> for every cell
 */

export interface GlyphOutline {
  /** Absolute path data (M/L/H/V/Q/C/Z), e.g. PlacedGlyph.pathD. */
  readonly pathD: string;
  /** Offset applied to the outline before sampling. */
  readonly dx?: number;
  readonly dy?: number;
  /** Reported as GlyphCell.glyphIndex (default: the outline's position in the list). */
  readonly glyphIndex?: number;
}

export interface GlyphCellOptions {
  /** Cell edge in px (> 0). */
  readonly cellSize: number;
  /** Samples per cell edge: 2 (4 samples) or 4 (16 samples, default). */
  readonly supersample?: 2 | 4;
  /** Inside test (default "nonzero", matching how glyphs render; see the module doc). */
  readonly fillRule?: "evenodd" | "nonzero";
  /** Keep cells with coverage ≥ this (default: any covered sample). */
  readonly minCoverage?: number;
  /** Also return the empty cells of the outlines' bounding grid (coverage 0, glyphIndex −1): LED off-dots. */
  readonly includeEmpty?: boolean;
  /** Grid alignment (default 0, 0). */
  readonly originX?: number;
  readonly originY?: number;
}

export interface GlyphCell {
  readonly column: number;
  readonly row: number;
  /** Top-left corner and edge in px. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** Covered fraction of the cell's samples, 0..1. */
  readonly coverage: number;
  /** Glyph owning the cell (most samples), or −1 for an empty cell. */
  readonly glyphIndex: number;
}

/** Outlines of a laid-out line, positioned at (x, y) = the line origin on the baseline. glyphIndex = PlacedGlyph.index. */
export function lineOutlines(line: LineLayout, x = 0, y = 0): GlyphOutline[] {
  return line.glyphs.map(glyph => ({ pathD: glyph.pathD, dx: x + glyph.x, dy: y, glyphIndex: glyph.index }));
}

/** Outlines of a text block at (x, y) = the block's top-left. glyphIndex runs across lines (line 2 continues after line 1's glyphs, spaces included). */
export function blockOutlines(block: TextBlockLayout, x = 0, y = 0): GlyphOutline[] {
  const outlines: GlyphOutline[] = [];
  let running = 0;
  for (const line of block.lines) {
    for (const glyph of line.layout.glyphs) {
      outlines.push({ pathD: glyph.pathD, dx: x + line.x + glyph.x, dy: y + line.baselineY, glyphIndex: running + glyph.index });
    }
    running += line.layout.glyphs.length;
  }
  return outlines;
}

interface Edge { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }

const CACHE_LIMIT = 48;
const cache = new Map<string, readonly GlyphCell[]>();

function popcount(mask: number): number {
  let value = mask, count = 0;
  while (value) { value &= value - 1; count += 1; }
  return count;
}

/** Sample outlines into cells (see module doc). A plain string is one outline with glyphIndex 0. */
export function sampleGlyphCells(outlines: string | readonly GlyphOutline[], options: GlyphCellOptions): readonly GlyphCell[] {
  const size = options.cellSize, ss = options.supersample ?? 4, rule = options.fillRule ?? "nonzero";
  if (!(size > 0) || size > 4096 || !Number.isFinite(size)) throw new Error("sampleGlyphCells needs 0 < cellSize ≤ 4096");
  if (ss !== 2 && ss !== 4) throw new Error("sampleGlyphCells supersample must be 2 or 4");
  const originX = options.originX ?? 0, originY = options.originY ?? 0;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) throw new Error("sampleGlyphCells origin must be finite");
  const list: readonly GlyphOutline[] = typeof outlines === "string" ? [{ pathD: outlines, glyphIndex: 0 }] : outlines;
  const samples = ss * ss;
  const minCoverage = options.minCoverage ?? 1 / (samples * 2);
  const key = JSON.stringify([size, ss, rule, originX, originY, minCoverage, Boolean(options.includeEmpty),
    list.map((outline, index) => [outline.pathD, outline.dx ?? 0, outline.dy ?? 0, outline.glyphIndex ?? index])]);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }

  const step = size / ss;
  const segmentLength = Math.max(0.25, Math.min(6, step));
  const masks = new Map<string, { column: number; row: number; byGlyph: Map<number, number> }>();
  let minColumn = Infinity, maxColumn = -Infinity, minRow = Infinity, maxRow = -Infinity;
  list.forEach((outline, position) => {
    if (!outline.pathD) return;
    const glyphIndex = outline.glyphIndex ?? position, dx = outline.dx ?? 0, dy = outline.dy ?? 0;
    const contours: FlatPoint[][] = flattenPathD(outline.pathD, { segmentLength, label: "sampleGlyphCells" });
    const edges: Edge[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const contour of contours) {
      for (let index = 0; index < contour.length; index += 1) {
        const [ax, ay] = contour[index], [bx, by] = contour[(index + 1) % contour.length];
        edges.push({ x1: ax + dx, y1: ay + dy, x2: bx + dx, y2: by + dy });
        x0 = Math.min(x0, ax + dx); x1 = Math.max(x1, ax + dx); y0 = Math.min(y0, ay + dy); y1 = Math.max(y1, ay + dy);
      }
    }
    if (!edges.length) return;
    // Cells touched by [x0, x1) × [y0, y1): an edge that lands exactly on a grid line does not start a new cell.
    const columnStart = Math.floor((x0 - originX) / size), columnEnd = Math.max(columnStart, Math.ceil((x1 - originX) / size) - 1);
    const rowStart = Math.floor((y0 - originY) / size), rowEnd = Math.max(rowStart, Math.ceil((y1 - originY) / size) - 1);
    minColumn = Math.min(minColumn, columnStart); maxColumn = Math.max(maxColumn, columnEnd);
    minRow = Math.min(minRow, rowStart); maxRow = Math.max(maxRow, rowEnd);
    const crossings: Array<{ x: number; winding: number }> = [];
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let sub = 0; sub < ss; sub += 1) {
        const y = originY + row * size + (sub + 0.5) * step;
        crossings.length = 0;
        for (const edge of edges) {
          if ((edge.y1 <= y && y < edge.y2) || (edge.y2 <= y && y < edge.y1)) {
            crossings.push({ x: edge.x1 + ((y - edge.y1) * (edge.x2 - edge.x1)) / (edge.y2 - edge.y1), winding: edge.y2 > edge.y1 ? 1 : -1 });
          }
        }
        if (!crossings.length) continue;
        crossings.sort((a, b) => a.x - b.x || a.winding - b.winding);
        let pointer = 0, parity = 0, winding = 0;
        for (let column = columnStart; column <= columnEnd; column += 1) {
          for (let sx = 0; sx < ss; sx += 1) {
            const x = originX + column * size + (sx + 0.5) * step;
            while (pointer < crossings.length && crossings[pointer].x < x) { parity ^= 1; winding += crossings[pointer].winding; pointer += 1; }
            if (rule === "evenodd" ? parity === 1 : winding !== 0) {
              const cellKey = `${column},${row}`;
              let cell = masks.get(cellKey);
              if (!cell) { cell = { column, row, byGlyph: new Map() }; masks.set(cellKey, cell); }
              cell.byGlyph.set(glyphIndex, (cell.byGlyph.get(glyphIndex) ?? 0) | (1 << (sub * ss + sx)));
            }
          }
        }
      }
    }
  });

  const cells: GlyphCell[] = [];
  for (const cell of masks.values()) {
    let union = 0, owner = -1, best = -1;
    for (const [glyphIndex, mask] of [...cell.byGlyph.entries()].sort((a, b) => a[0] - b[0])) {
      union |= mask;
      const count = popcount(mask);
      if (count > best) { best = count; owner = glyphIndex; }
    }
    const coverage = popcount(union) / samples;
    if (coverage >= minCoverage) {
      cells.push({ column: cell.column, row: cell.row, x: originX + cell.column * size, y: originY + cell.row * size, size, coverage, glyphIndex: owner });
    }
  }
  if (options.includeEmpty && Number.isFinite(minColumn)) {
    const present = new Set(cells.map(cell => `${cell.column},${cell.row}`));
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        if (!present.has(`${column},${row}`)) {
          cells.push({ column, row, x: originX + column * size, y: originY + row * size, size, coverage: 0, glyphIndex: -1 });
        }
      }
    }
  }
  cells.sort((a, b) => a.row - b.row || a.column - b.column);
  const result = Object.freeze(cells.map(cell => Object.freeze(cell)));
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}

/**
 * All cells as one path: "square" (centred squares of edge size·scale) or "dot"
 * (centred circles of diameter size·scale). Default scale 0.86 (a visible gap).
 */
export function cellsPathD(cells: readonly GlyphCell[], options: { readonly shape?: "square" | "dot"; readonly scale?: number;
  readonly decimals?: 0 | 1 | 2 | 3 } = {}): string {
  const shape = options.shape ?? "square", scale = options.scale ?? 0.86, decimals = options.decimals ?? 2;
  if (!(scale > 0) || scale > 2) throw new Error("cellsPathD scale must be within 0..2");
  let d = "";
  for (const cell of cells) {
    const edge = cell.size * scale, cx = cell.x + cell.size / 2, cy = cell.y + cell.size / 2;
    d += shape === "dot" ? circlePathD(cx, cy, edge / 2, decimals) : rectPathD(cx - edge / 2, cy - edge / 2, edge, edge, decimals);
  }
  return d;
}
