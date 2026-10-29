import { describe, expect, it } from "vitest";
import { bundledFontFaceSpec } from "../../typography/bundledFontCatalog";
import {
  MotionLibraryGlyphError, assertMotionText, circleSampler, clearMotionLibraryLayoutCache, fitFontSize, layoutLine, layoutOnPath,
  layoutTextBlock, layoutVertical, motionFaceMetrics, motionLibraryFontDigests, polylineSampler, registerMotionLibraryFontBytes,
  resolveMotionFace, translatePathD,
} from "./glyphs";

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("font registry", () => {
  it("maps roles to compiled render faces and snaps weights", () => {
    expect(resolveMotionFace({ font: "display" }).faceId).toBe("EditkinFace-noto-sans-tc-900");
    expect(resolveMotionFace({ font: "display", weight: 875 }).faceId).toBe("EditkinFace-noto-sans-tc-900");
    expect(resolveMotionFace({ font: "display", weight: 420 }).faceId).toBe("EditkinFace-noto-sans-tc-400");
    expect(resolveMotionFace({ font: "serif", weight: 100 }).faceId).toBe("EditkinFace-noto-serif-tc-200");
    expect(resolveMotionFace({ font: "hand", weight: 300 }).faceId).toBe("EditkinFace-lxgw-wenkai-tc-700");
    expect(resolveMotionFace({ font: "mono" }).faceId).toBe("EditkinFace-lxgw-wenkai-mono-tc-400");
    expect(resolveMotionFace({ font: "latin" }).faceId).toBe("EditkinFace-bebas-neue-400");
    expect(resolveMotionFace({ font: "latin_round", weight: 700 }).faceId).toBe("EditkinFace-fredoka-700");
    expect(resolveMotionFace({ font: "display" }).sha256).toBe(bundledFontFaceSpec("EditkinFace-noto-sans-tc-900").sha256);
    expect(() => resolveMotionFace({ font: "comic" as never })).toThrow(/Unknown motion font role/);
  });
  it("lists every reachable face digest for cache keys", () => {
    const digests = motionLibraryFontDigests();
    expect(digests).toHaveLength(44);
    expect(digests.every(row => /^[a-f0-9]{64}$/.test(row.sha256))).toBe(true);
    expect([...digests.map(row => row.faceId)].sort()).toEqual(digests.map(row => row.faceId));
  });
  it("refuses font bytes that do not match the compiled catalog", async () => {
    await expect(registerMotionLibraryFontBytes("EditkinFace-bebas-neue-400", new Uint8Array([1, 2, 3]))).rejects.toThrow(/SHA-256/);
  });
});

describe("layoutLine", () => {
  it("advances by the sum of glyph advances plus tracking between glyphs", () => {
    const plain = layoutLine("爆發累計", { font: "display", size: 100, kerning: false });
    expect(plain.glyphs.map(glyph => glyph.char)).toEqual(["爆", "發", "累", "計"]);
    expect(plain.width).toBeCloseTo(sum(plain.glyphs.map(glyph => glyph.advance)), 9);
    for (const glyph of plain.glyphs) expect(glyph.advance).toBeCloseTo(100, 9);
    const tracked = layoutLine("爆發累計", { font: "display", size: 100, tracking: 0.1, kerning: false });
    expect(tracked.width).toBeCloseTo(plain.width + 3 * 0.1 * 100, 9);
    [0, 110, 220, 330].forEach((x, index) => expect(tracked.glyphs[index].x).toBeCloseTo(x, 9));
  });
  it("applies pair kerning for Latin when enabled", () => {
    const kerned = layoutLine("AV", { font: "display", weight: 900, size: 100 });
    const plain = layoutLine("AV", { font: "display", weight: 900, size: 100, kerning: false });
    expect(kerned.width).toBeLessThan(plain.width);
    expect(kerned.width).toBeCloseTo(sum(kerned.glyphs.map(glyph => glyph.advance)) + (kerned.glyphs[1].x - kerned.glyphs[0].advance), 9);
  });
  it("produces outlines, ink boxes and metrics in pixels", () => {
    const line = layoutLine("出發 A1", { font: "display", size: 200 });
    const space = line.glyphs[2];
    expect(space.whitespace).toBe(true);
    expect(space.pathD).toBe("");
    expect(space.bbox).toBeNull();
    for (const glyph of line.glyphs.filter(entry => !entry.whitespace)) {
      expect(glyph.pathD).toMatch(/^M/);
      expect(glyph.bbox!.x1).toBeGreaterThan(glyph.bbox!.x0);
      expect(glyph.bbox!.y0).toBeLessThan(0); // y-down: ink rises above the baseline
    }
    expect(line.inkBox!.x0).toBeGreaterThanOrEqual(0);
    expect(line.inkBox!.x1).toBeLessThanOrEqual(line.width + 1);
    expect(line.emTop).toBeCloseTo(-176, 6); // Noto Sans TC typo ascender 880/1000
    expect(line.emBottom).toBeCloseTo(24, 6);
    expect(motionFaceMetrics({ font: "display" }, 100).emTop).toBeCloseTo(-88, 6);
  });
  it("is deterministic and independent of the layout cache", () => {
    const first = layoutLine("未來光維度", { font: "serif", size: 123.4567 });
    clearMotionLibraryLayoutCache();
    const second = layoutLine("未來光維度", { font: "serif", size: 123.4567 });
    expect(second.pathD).toBe(first.pathD);
    // Sizes are canonicalised to 3 decimals before use: callers that differ below that share one exact layout.
    expect(layoutLine("未來光維度", { font: "serif", size: 123.45670001 }).pathD).toBe(first.pathD);
    expect(first.size).toBe(123.457);
    expect(Object.isFrozen(first.glyphs[0])).toBe(true);
  });
});

describe("unsupported text is refused before rendering, naming the character", () => {
  const glyphError = (run: () => unknown): MotionLibraryGlyphError => {
    try { run(); } catch (error) { if (error instanceof MotionLibraryGlyphError) return error; throw error; }
    throw new Error("expected a MotionLibraryGlyphError");
  };
  it("missing glyphs", () => {
    const error = glyphError(() => layoutLine("ABC爆", { font: "latin", size: 50 }));
    expect(error.reason).toBe("missing_glyph");
    expect(error.character).toBe("爆");
    expect(error.codePoint).toBe(0x7206);
    expect(error.textIndex).toBe(3);
    expect(error.faceId).toBe("EditkinFace-bebas-neue-400");
    expect(error.message).toContain("爆");
    expect(error.message).toContain("U+7206");
    const emoji = String.fromCodePoint(0x1F600);
    expect(glyphError(() => assertMotionText(`好${emoji}`, { font: "display" })).character).toBe(emoji);
  });
  it("combining marks, format characters and line breaks", () => {
    const combining = glyphError(() => layoutLine(`e${String.fromCodePoint(0x301)}`, { font: "display", size: 50 }));
    expect(combining.reason).toBe("unsupported_character");
    expect(combining.codePoint).toBe(0x301);
    expect(glyphError(() => layoutLine(`a${String.fromCodePoint(0x200D)}b`, { font: "display", size: 50 })).reason).toBe("unsupported_character");
    expect(glyphError(() => layoutLine(`第一行${String.fromCharCode(10)}第二行`, { font: "display", size: 50 })).reason).toBe("line_break");
    expect(glyphError(() => layoutVertical(`直${String.fromCodePoint(0x2028)}書`, { font: "serif", size: 50 })).reason).toBe("line_break");
  });
});

describe("layoutTextBlock and fitting", () => {
  it("stacks lines on a fixed baseline step and centres them", () => {
    const block = layoutTextBlock(["今晚", "全速衝刺", "就是現在"], { font: "display", size: 80, lineHeight: 1.2 });
    [70.4, 166.4, 262.4].forEach((y, index) => expect(block.lines[index].baselineY).toBeCloseTo(y, 9));
    expect(block.lines[0].x).toBeCloseTo((block.width - block.lines[0].layout.width) / 2, 9);
    expect(block.lines[1].x).toBe(0);
    expect(block.height).toBeCloseTo(70.4 + 2 * 96 + 9.6, 6);
    expect(block.pathD.split("M").length - 1).toBeGreaterThan(10);
  });
  it("fits text inside the requested box", () => {
    const size = fitFontSize(["全力衝刺"], { font: "display" }, { maxWidth: 864, maxHeight: 800, maxSize: 389 });
    const line = layoutLine("全力衝刺", { font: "display", size });
    expect(line.inkBox!.x1 - line.inkBox!.x0).toBeLessThanOrEqual(864.01);
    expect(size).toBeLessThan(389);
    expect(fitFontSize(["爆"], { font: "display" }, { maxWidth: 5000, maxHeight: 5000, maxSize: 389 })).toBe(389);
    expect(fitFontSize(["全力衝刺"], { font: "display" }, { maxWidth: 400, maxSize: 389 })).toBeLessThan(size);
  });
  it("translatePathD shifts absolute path data", () => {
    expect(translatePathD("M1 2L3 4Q5 6 7 8Z", 10, -1)).toBe("M11 1L13 3Q15 5 17 7Z");
  });
});

describe("layoutVertical (tategaki)", () => {
  it("stacks cells top to bottom in text order with CJK upright and Latin sideways", () => {
    const column = layoutVertical("出發「時刻」A1", { font: "display", size: 100 });
    expect(column.glyphs.map(glyph => glyph.char)).toEqual(["出", "發", "「", "時", "刻", "」", "A", "1"]);
    for (let index = 1; index < column.glyphs.length; index += 1) {
      const previous = column.glyphs[index - 1], current = column.glyphs[index];
      expect(current.y).toBeCloseTo(previous.y + previous.advance, 9);
    }
    expect(column.height).toBeCloseTo(sum(column.glyphs.map(glyph => glyph.advance)), 9);
    const [chu, , bracket] = column.glyphs;
    expect(chu.rotated).toBe(false);
    expect(chu.advance).toBeCloseTo(100, 9);
    // Upright ideographs are centred on the column axis.
    expect(Math.abs((chu.bbox!.x0 + chu.bbox!.x1) / 2)).toBeLessThan(6);
    // Brackets switch to the face's vertical form (a different glyph than horizontal setting).
    const horizontalBracket = layoutLine("「", { font: "display", size: 100 }).glyphs[0];
    expect(bracket.glyphId).not.toBe(horizontalBracket.glyphId);
    expect(bracket.rotated).toBe(false);
    const latin = column.glyphs[6];
    expect(latin.rotated).toBe(true);
    expect(latin.advance).toBeCloseTo(layoutLine("A", { font: "display", size: 100 }).glyphs[0].advance, 9);
    // Sideways glyphs are rotated 90° clockwise: an upright-narrow "1" becomes wider than tall.
    const one = column.glyphs[7];
    expect(one.bbox!.x1 - one.bbox!.x0).toBeGreaterThan(one.bbox!.y1 - one.bbox!.y0);
    const upright = layoutVertical("A1", { font: "display", size: 100, uprightLatin: true });
    expect(upright.glyphs.every(glyph => !glyph.rotated && Math.abs(glyph.advance - 100) < 1e-9)).toBe(true);
  });
  it("applies tracking between cells", () => {
    const plain = layoutVertical("山海", { font: "serif", size: 80 });
    const tracked = layoutVertical("山海", { font: "serif", size: 80, tracking: 0.25 });
    expect(tracked.height).toBeCloseTo(plain.height + 20, 9);
    expect(tracked.glyphs[1].y).toBeCloseTo(plain.glyphs[1].y + 20, 9);
  });
});

describe("layoutOnPath", () => {
  it("places glyph centres on the path with tangent angles", () => {
    const radius = 300;
    const result = layoutOnPath("無限循環", { font: "display", size: 80, align: "center" }, circleSampler(500, 500, radius));
    expect(result.glyphs).toHaveLength(4);
    for (const glyph of result.glyphs) {
      expect(Math.hypot(glyph.x - 500, glyph.y - 500)).toBeCloseTo(radius, 6);
      expect(glyph.transform).toMatch(/^translate\(.+\) rotate\(.+\)$/);
      expect(glyph.pathD).toMatch(/^M/);
    }
    expect(result.glyphs[1].distance - result.glyphs[0].distance).toBeCloseTo(80, 6);
    const top = circleSampler(0, 0, 100)(0);
    expect(top.x).toBeCloseTo(0, 9);
    expect(top.y).toBeCloseTo(-100, 9);
    expect(top.angle).toBeCloseTo(0, 9);
  });
  it("polyline sampler is arc-length parameterised", () => {
    const sampler = polylineSampler([[0, 0], [100, 0], [100, 50]]);
    expect(sampler.totalLength).toBe(150);
    const middle = sampler(50), corner = sampler(125);
    expect([middle.x, middle.y, middle.angle]).toEqual([50, 0, 0]);
    expect(corner.x).toBeCloseTo(100, 9);
    expect(corner.y).toBeCloseTo(25, 9);
    expect(corner.angle).toBeCloseTo(90, 9);
  });
});
