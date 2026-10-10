import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Font, Glyph, PathCommand } from "opentype.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledFontFaceSpec } from "./bundledFontCatalog";

const parserControl = vi.hoisted(() => ({ calls: 0, override: undefined as ((bytes: ArrayBuffer) => Font) | undefined }));
vi.mock("opentype.js", async importOriginal => {
  const actual = await importOriginal<typeof import("opentype.js")>();
  return { ...actual, parse: (bytes: ArrayBuffer) => {
    parserControl.calls++;
    return parserControl.override ? parserControl.override(bytes) : actual.parse(bytes);
  } };
});
import {
  assertPreparedGlyphRun, prepareGlyphRun, PreparedGlyphRunError,
  PREPARED_GLYPH_MAX_CODE_POINTS, PREPARED_GLYPH_MAX_COMMANDS, PREPARED_GLYPH_MAX_FONT_BYTES,
  PREPARED_GLYPH_PARSER_VERSION, PREPARED_GLYPH_RUN_MAX_COMMANDS,
} from "./preparedGlyphRun";

const faceId = "EditkinFace-bebas-neue-400", hanFaceId = "EditkinFace-noto-sans-tc-700";
const fontRoot = resolve("public/fonts");
let latinBytes: Uint8Array, actualFont: Font;
let actualParse: typeof import("opentype.js").parse;
beforeAll(async () => {
  actualParse = (await vi.importActual<typeof import("opentype.js")>("opentype.js")).parse;
  latinBytes = new Uint8Array(await readFile(join(fontRoot, bundledFontFaceSpec(faceId).fontFile)));
  actualFont = actualParse(Uint8Array.from(latinBytes).buffer);
});
beforeEach(() => { parserControl.calls = 0; parserControl.override = undefined; });
afterEach(() => { parserControl.override = undefined; });

function controlledGlyph(overrides: Partial<Glyph>): Font {
  const original = actualFont.charToGlyph("A"), glyph = Object.assign(Object.create(original) as Glyph, overrides);
  const font = Object.create(actualFont) as Font;
  font.charToGlyph = () => glyph;
  font.charToGlyphIndex = () => original.index;
  font.getKerningValue = () => 0;
  return font;
}

describe("physical prepared glyph runs", () => {
  it("binds actual catalog bytes and true unshaped glyph metrics/contours to the exact string", async () => {
    const text = "AV fi 9,\nEditkin!", run = await prepareGlyphRun(faceId, text, latinBytes), spec = bundledFontFaceSpec(faceId);
    assertPreparedGlyphRun(run);
    expect(run.schema).toBe("editkin.prepared-glyph-run/v1");
    expect(run.parserVersion).toBe(PREPARED_GLYPH_PARSER_VERSION);
    expect(run.faceId).toBe(faceId); expect(run.fontSha256).toBe(spec.sha256); expect(run.manifestSha256).toBe(spec.manifestSha256);
    expect(run.text).toBe(text); expect(run.unitsPerEm).toBe(actualFont.unitsPerEm);
    expect(run.ascender).toBe(actualFont.ascender); expect(run.descender).toBe(actualFont.descender);
    expect(run.glyphs.map(glyph => glyph.text).join("")).toBe(text);
    expect(run.glyphs.map(glyph => glyph.sourceUtf16Offset)).toEqual(Array.from({ length: text.length }, (_, index) => index));
    const a = actualFont.charToGlyph("A"), v = actualFont.charToGlyph("V"), ink = a.getBoundingBox();
    expect(run.glyphs[0].glyphId).toBe(a.index);
    expect(run.glyphs[0].advanceEm).toBe(a.advanceWidth! / actualFont.unitsPerEm);
    expect(run.glyphs[0].kerningAfterEm).toBe(actualFont.getKerningValue(a, v) / actualFont.unitsPerEm);
    expect(run.glyphs[0].inkEm).toEqual({ xMin: ink.x1 / actualFont.unitsPerEm, yMin: -ink.y2 / actualFont.unitsPerEm,
      xMax: ink.x2 / actualFont.unitsPerEm, yMax: -ink.y1 / actualFont.unitsPerEm });
    expect(JSON.stringify(run.glyphs[0].pathCommands)).toBe(JSON.stringify(a.getPath(0, 0, actualFont.unitsPerEm).commands));
    const newlineIndex = text.indexOf("\n"), newline = run.glyphs[newlineIndex];
    expect(newline.kind).toBe("newline"); expect(newline.glyphId).toBeNull(); expect(newline.advanceEm).toBe(0);
    expect(newline.inkEm).toBeNull(); expect(newline.pathCommands).toHaveLength(0);
    expect(run.glyphs[newlineIndex - 1].kerningAfterEm).toBe(0); expect(newline.kerningAfterEm).toBe(0);
    expect(run.glyphs[2].kind).toBe("space"); expect(run.glyphs[2].inkEm).toBeNull();
    expect(run.glyphs.filter(glyph => glyph.text === "f" || glyph.text === "i")).toHaveLength(4); // No implicit fi ligature.
  });

  it("prepares real Han, numerals and punctuation from the physical TC face", async () => {
    const bytes = new Uint8Array(await readFile(join(fontRoot, bundledFontFaceSpec(hanFaceId).fontFile)));
    const text = "改變方向，動作接續。\n2026", run = await prepareGlyphRun(hanFaceId, text, bytes);
    assertPreparedGlyphRun(run);
    expect(run.fontSha256).toBe(bundledFontFaceSpec(hanFaceId).sha256);
    expect(run.glyphs.map(glyph => glyph.text).join("")).toBe(text);
    expect(run.glyphs[0].inkEm!.yMin).toBeLessThan(run.glyphs[0].inkEm!.yMax);
    expect(run.glyphs[0].pathCommands.length).toBeGreaterThan(0);
    expect(run.glyphs.filter(glyph => glyph.kind === "glyph").every(glyph => glyph.glyphId! > 0)).toBe(true);
  });

  it("copies the requested byte view before async work and retains no caller buffer reference", async () => {
    const backing = new Uint8Array(latinBytes.length + 12); backing.set(latinBytes, 5);
    const view = backing.subarray(5, 5 + latinBytes.length), pending = prepareGlyphRun(faceId, "A", view);
    backing.fill(0);
    const run = await pending;
    assertPreparedGlyphRun(run); expect(run.fontSha256).toBe(bundledFontFaceSpec(faceId).sha256);
    expect(run.glyphs[0].pathCommands.length).toBeGreaterThan(0);
  });

  it("deep freezes every receipt level and refuses cloned or forged physical authority", async () => {
    const run = await prepareGlyphRun(faceId, "AV ", latinBytes);
    expect(Object.isFrozen(run)).toBe(true); expect(Object.isFrozen(run.glyphs)).toBe(true);
    expect(run.glyphs.every(glyph => Object.isFrozen(glyph) && Object.isFrozen(glyph.pathCommands)
      && glyph.pathCommands.every(Object.isFrozen) && (glyph.inkEm === null || Object.isFrozen(glyph.inkEm)))).toBe(true);
    expect(() => { (run.glyphs[0] as { advanceEm: number }).advanceEm = 99; }).toThrow();
    expect(() => assertPreparedGlyphRun({ ...run })).toThrow(/factory/);
    expect(() => assertPreparedGlyphRun(JSON.parse(JSON.stringify(run)))).toThrow(/factory/);
    expect(() => assertPreparedGlyphRun(structuredClone(run))).toThrow(/factory/);
    expect(() => assertPreparedGlyphRun(null)).toThrow(/factory/);
    assertPreparedGlyphRun(run);
  });

  it("rejects unknown IDs, empty/non-byte/oversized data and wrong actual SHA before parsing", async () => {
    await expect(prepareGlyphRun("../outside.ttf", "A", latinBytes)).rejects.toMatchObject({ status: "BLOCK", reason: "FACE" });
    await expect(prepareGlyphRun(faceId, "A", new Uint8Array())).rejects.toMatchObject({ reason: "BYTES" });
    await expect(prepareGlyphRun(faceId, "A", [] as unknown as Uint8Array)).rejects.toMatchObject({ reason: "BYTES" });
    await expect(prepareGlyphRun(faceId, "A", new Uint8Array(PREPARED_GLYPH_MAX_FONT_BYTES + 1))).rejects.toMatchObject({ reason: "LIMIT" });
    const corrupt = Uint8Array.from(latinBytes); corrupt[corrupt.length - 1] ^= 1;
    await expect(prepareGlyphRun(faceId, "A", corrupt)).rejects.toMatchObject({ reason: "SHA" });
    await expect(prepareGlyphRun(faceId, "A", latinBytes.subarray(0, latinBytes.length - 1))).rejects.toMatchObject({ reason: "SHA" });
    expect(parserControl.calls).toBe(0);
  });

  it.each(["A\tB", "A\rB", "A\u0000B", "e\u0301", "A\u200dB", "A\ufe0f", "שלום", "مرحبا", "נ", "\u05be", "\u061b", "नमस्ते", "😀", "🇹🇼", "\ud800"])(
    "blocks unsupported complex/control text without pretending to shape %j", async text => {
      await expect(prepareGlyphRun(faceId, text, latinBytes)).rejects.toMatchObject({ status: "BLOCK", reason: "TEXT" });
      expect(parserControl.calls).toBe(0);
    });

  it("rejects a genuine missing code-point glyph instead of .notdef fallback", async () => {
    expect(actualFont.charToGlyphIndex("中")).toBe(0);
    await expect(prepareGlyphRun(faceId, "A中", latinBytes)).rejects.toMatchObject({ reason: "MISSING_GLYPH" });
  });

  it("retains LF/empty runs and admits the exact code-point bound without unlimited text", async () => {
    const blank = await prepareGlyphRun(faceId, "\n", latinBytes), empty = await prepareGlyphRun(faceId, "", latinBytes);
    assertPreparedGlyphRun(blank); assertPreparedGlyphRun(empty); expect(empty.glyphs).toHaveLength(0);
    const bounded = await prepareGlyphRun(faceId, ".".repeat(PREPARED_GLYPH_MAX_CODE_POINTS), latinBytes);
    expect(bounded.glyphs).toHaveLength(PREPARED_GLYPH_MAX_CODE_POINTS);
    parserControl.calls = 0;
    await expect(prepareGlyphRun(faceId, ".".repeat(PREPARED_GLYPH_MAX_CODE_POINTS + 1), latinBytes)).rejects.toMatchObject({ reason: "LIMIT" });
    await expect(prepareGlyphRun(faceId, "A".repeat(513), latinBytes)).rejects.toMatchObject({ reason: "LIMIT" });
    expect(parserControl.calls).toBe(0);
  });

  // Controlled parser outputs calibrate the bounded receipt checks separately
  // from the genuine font cases above; they are not physical-font evidence.
  it("preserves UTF-16 offsets for a supported supplementary Han parser control", async () => {
    parserControl.override = () => controlledGlyph({});
    const run = await prepareGlyphRun(faceId, "A𠀀B", latinBytes);
    expect(run.glyphs.map(glyph => [glyph.codePoint, glyph.sourceUtf16Offset, glyph.sourceUtf16Length])).toEqual([
      [0x41, 0, 1], [0x20000, 1, 2], [0x42, 3, 1],
    ]);
  });

  it("blocks parser errors, nonfinite metrics and a false glyph identity", async () => {
    parserControl.override = () => { throw new Error("parser control"); };
    await expect(prepareGlyphRun(faceId, "A", latinBytes)).rejects.toBeInstanceOf(PreparedGlyphRunError);
    parserControl.override = () => controlledGlyph({ advanceWidth: NaN });
    await expect(prepareGlyphRun(faceId, "A", latinBytes)).rejects.toMatchObject({ reason: "METRICS" });
    parserControl.override = () => controlledGlyph({ index: 0 });
    await expect(prepareGlyphRun(faceId, "A", latinBytes)).rejects.toMatchObject({ reason: "MISSING_GLYPH" });
  });

  it("blocks open, nonfinite and over-budget contours with verified font input", async () => {
    parserControl.override = () => controlledGlyph({ getPath: () => ({ commands: [{ type: "M", x: 0, y: 0 }] }) as ReturnType<Glyph["getPath"]> });
    await expect(prepareGlyphRun(faceId, "A", latinBytes)).rejects.toMatchObject({ reason: "CONTOUR" });
    parserControl.override = () => controlledGlyph({ getPath: () => ({ commands: [{ type: "M", x: NaN, y: 0 }, { type: "Z" }] }) as ReturnType<Glyph["getPath"]> });
    await expect(prepareGlyphRun(faceId, "A", latinBytes)).rejects.toMatchObject({ reason: "METRICS" });
    const commands: PathCommand[] = [{ type: "M", x: 0, y: 0 },
      ...Array.from({ length: PREPARED_GLYPH_MAX_COMMANDS - 1 }, (): PathCommand => ({ type: "L", x: 1, y: 1 })), { type: "Z" }];
    parserControl.override = () => controlledGlyph({ getPath: () => ({ commands }) as ReturnType<Glyph["getPath"]> });
    await expect(prepareGlyphRun(faceId, "A", latinBytes)).rejects.toMatchObject({ reason: "LIMIT" });
    commands.splice(1, 1); // Exactly the per-glyph cap; a 17-glyph run exceeds the total cap.
    expect(commands.length * 17).toBeGreaterThan(PREPARED_GLYPH_RUN_MAX_COMMANDS);
    parserControl.override = () => controlledGlyph({ getPath: () => ({ commands }) as ReturnType<Glyph["getPath"]> });
    await expect(prepareGlyphRun(faceId, "A".repeat(17), latinBytes)).rejects.toMatchObject({ reason: "LIMIT" });
  });
});
