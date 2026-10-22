import { describe, expect, it } from "vitest";
import { circlePathD, rectPathD } from "./document";
import { blockOutlines, cellsPathD, lineOutlines, sampleGlyphCells, type GlyphCell } from "./glyphCells";
import { layoutLine, layoutTextBlock, type MotionFontSelector } from "./glyphs";

const coveredArea = (cells: readonly GlyphCell[]) => cells.reduce((sum, cell) => sum + cell.coverage * cell.size * cell.size, 0);
const key = (cell: GlyphCell) => `${cell.column},${cell.row}`;
// Circle as a polygon (the sampler refuses arcs, like the rest of pathOps).
const polygonCircle = (cx: number, cy: number, r: number, sides = 720) =>
  `M${Array.from({ length: sides }, (_, index) => {
    const a = (2 * Math.PI * index) / sides;
    return `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  }).join("L")}Z`;

describe("sampleGlyphCells: geometry", () => {
  it("fills whole cells and orders them by row, then column", () => {
    const cells = sampleGlyphCells(rectPathD(0, 0, 10, 10), { cellSize: 5 });
    expect(cells.map(cell => [cell.column, cell.row, cell.x, cell.y, cell.size, cell.coverage, cell.glyphIndex]))
      .toEqual([[0, 0, 0, 0, 5, 1, 0], [1, 0, 5, 0, 5, 1, 0], [0, 1, 0, 5, 5, 1, 0], [1, 1, 5, 5, 5, 1, 0]]);
    expect(Object.isFrozen(cells) && Object.isFrozen(cells[0])).toBe(true);
  });
  it("measures partial coverage on the supersample grid", () => {
    const four = sampleGlyphCells(rectPathD(2.5, 0, 10, 5), { cellSize: 5 });
    expect(four.map(cell => [cell.column, cell.coverage])).toEqual([[0, 0.5], [1, 1], [2, 0.5]]);
    const two = sampleGlyphCells(rectPathD(2, 0, 3, 5), { cellSize: 5, supersample: 2 });
    expect(two.map(cell => cell.coverage)).toEqual([0.5]); // samples at x = 1.25 (out) and 3.75 (in)
  });
  it("matches the analytic area of a disc to within 0.5%", () => {
    for (const cellSize of [3, 5]) {
      const cells = sampleGlyphCells(polygonCircle(100, 80, 40), { cellSize });
      expect(coveredArea(cells) / (Math.PI * 40 * 40)).toBeCloseTo(1, 2);
    }
  });
  it("uses nonzero by default and even-odd on request", () => {
    // Outer square and an inner square drawn in the SAME direction: a hole only for even-odd.
    const nested = `${rectPathD(0, 0, 30, 30)}${rectPathD(10, 10, 10, 10)}`;
    const evenOdd = sampleGlyphCells(nested, { cellSize: 10, fillRule: "evenodd" });
    const nonzero = sampleGlyphCells(nested, { cellSize: 10 });
    expect(evenOdd.map(key)).not.toContain("1,1");
    expect(nonzero.map(key)).toContain("1,1");
    expect(evenOdd).toHaveLength(8);
    expect(nonzero).toHaveLength(9);
  });
  it("aligns the grid to the origin and filters by coverage", () => {
    const shifted = sampleGlyphCells(rectPathD(2, 2, 6, 6), { cellSize: 6, originX: 2, originY: 2 });
    expect(shifted.map(cell => [cell.x, cell.y, cell.coverage])).toEqual([[2, 2, 1]]);
    const half = sampleGlyphCells(rectPathD(2.5, 0, 10, 5), { cellSize: 5, minCoverage: 0.75 });
    expect(half.map(cell => cell.column)).toEqual([1]);
  });
  it("adds the empty cells of the bounding grid for LED off-dots", () => {
    const ring = sampleGlyphCells(`${rectPathD(0, 0, 30, 30)}${rectPathD(10, 10, 10, 10)}`, { cellSize: 10, includeEmpty: true, fillRule: "evenodd" });
    expect(ring).toHaveLength(9);
    const hole = ring.find(cell => key(cell) === "1,1")!;
    expect([hole.coverage, hole.glyphIndex]).toEqual([0, -1]);
    expect(ring.map(key)).toEqual(["0,0", "1,0", "2,0", "0,1", "1,1", "2,1", "0,2", "1,2", "2,2"]);
  });
  it("unions overlapping outlines and gives each cell to the glyph with the most samples", () => {
    const cells = sampleGlyphCells([
      { pathD: rectPathD(0, 0, 7.5, 10), glyphIndex: 4 },
      { pathD: rectPathD(0, 0, 5, 10), dx: 5, glyphIndex: 2 }, // x 5..10
    ], { cellSize: 10 });
    expect(cells).toHaveLength(1);
    expect(cells[0].coverage).toBe(1);
    expect(cells[0].glyphIndex).toBe(4); // 12 of 16 samples vs 8
    const tie = sampleGlyphCells([{ pathD: rectPathD(5, 0, 5, 10), glyphIndex: 9 }, { pathD: rectPathD(0, 0, 5, 10), glyphIndex: 3 }], { cellSize: 10 });
    expect(tie[0].glyphIndex).toBe(3);
  });
  it("is cached, deterministic and validates its options", () => {
    const options = { cellSize: 4 } as const;
    const first = sampleGlyphCells(polygonCircle(0, 0, 20, 64), options);
    expect(sampleGlyphCells(polygonCircle(0, 0, 20, 64), { cellSize: 4 })).toBe(first);
    expect(sampleGlyphCells([{ pathD: polygonCircle(0, 0, 20, 64) }], options)).toEqual(first);
    expect(sampleGlyphCells("", options)).toEqual([]);
    expect(() => sampleGlyphCells(rectPathD(0, 0, 1, 1), { cellSize: 0 })).toThrow(/cellSize/);
    expect(() => sampleGlyphCells(rectPathD(0, 0, 1, 1), { cellSize: 1, supersample: 3 as never })).toThrow(/supersample/);
    expect(() => sampleGlyphCells(circlePathD(0, 0, 5), { cellSize: 1 })).toThrow(/only absolute/); // arcs are refused
  });
});

describe("sampleGlyphCells: glyph outlines", () => {
  it("leaves counters empty: the centre of 回 is a hole on every CJK face", () => {
    for (const face of [{ font: "display", weight: 700 }, { font: "serif", weight: 900 }, { font: "hand" }] as const) {
      const line = layoutLine("回", { ...face, size: 200 });
      const cells = sampleGlyphCells(lineOutlines(line), { cellSize: 10, minCoverage: 0.5 });
      const box = line.glyphs[0].bbox!;
      const centre = { column: Math.floor((box.x0 + box.x1) / 2 / 10), row: Math.floor((box.y0 + box.y1) / 2 / 10) };
      expect(cells.some(cell => cell.column === centre.column && cell.row === centre.row)).toBe(false);
      expect(cells.length).toBeGreaterThan(40);
    }
  });
  it("fills overlapping stroke contours like the renderer (nonzero); even-odd would punch holes in Noto CJK", () => {
    // 人 has no counters, so any even-odd loss is a stroke overlap that the renderer fills.
    const lost = (face: MotionFontSelector, text: string) => {
      const outlines = lineOutlines(layoutLine(text, { ...face, size: 120 }));
      const filled = coveredArea(sampleGlyphCells(outlines, { cellSize: 2 }));
      expect(coveredArea(sampleGlyphCells(outlines, { cellSize: 2, fillRule: "nonzero" }))).toBe(filled);
      return 1 - coveredArea(sampleGlyphCells(outlines, { cellSize: 2, fillRule: "evenodd" })) / filled;
    };
    expect(lost({ font: "display", weight: 900 }, "人")).toBeGreaterThan(0.08);
    expect(lost({ font: "serif", weight: 700 }, "發")).toBeGreaterThan(0.04);
    expect(lost({ font: "hand" }, "回國爆發")).toBe(0);
    expect(lost({ font: "mono" }, "回國爆發")).toBe(0);
    expect(lost({ font: "latin" }, "BOA8")).toBe(0);
  });
  it("keeps per-glyph ownership across a text block (spaces count in glyphIndex)", () => {
    const block = layoutTextBlock(["墨 跡", "暈開"], { font: "display", weight: 900, size: 100, lineHeight: 1.1 });
    const outlines = blockOutlines(block, 40, 30);
    expect(outlines.map(outline => outline.glyphIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(outlines[1].pathD).toBe(""); // the space
    const cells = sampleGlyphCells(outlines, { cellSize: 8 });
    const owners = new Set(cells.map(cell => cell.glyphIndex));
    expect([...owners].sort()).toEqual([0, 2, 3, 4]);
    // Cells sit where the block was placed (40, 30) and mostly below its first line's top.
    expect(Math.min(...cells.map(cell => cell.x))).toBeGreaterThanOrEqual(40 - 8);
    expect(Math.min(...cells.map(cell => cell.y))).toBeGreaterThanOrEqual(30 - 8);
    const second = cells.filter(cell => cell.glyphIndex >= 3);
    expect(second.every(cell => cell.y >= 30 + block.lines[1].baselineY - 100)).toBe(true);
  });
});

describe("cellsPathD", () => {
  it("draws one square or dot per cell in a single path", () => {
    const cells = sampleGlyphCells(rectPathD(0, 0, 20, 10), { cellSize: 10 });
    expect(cellsPathD(cells)).toBe("M0.7 0.7H9.3V9.3H0.7ZM10.7 0.7H19.3V9.3H10.7Z");
    expect(cellsPathD(cells, { shape: "dot", scale: 0.5 })).toBe(`${circlePathD(5, 5, 2.5, 2)}${circlePathD(15, 5, 2.5, 2)}`);
    expect(() => cellsPathD(cells, { scale: 0 })).toThrow(/scale/);
  });
});
