import { parse, type Font, type Glyph, type PathCommand } from "opentype.js";
import { bundledFontFaceSpec, type BundledFontFaceSpec } from "./bundledFontCatalog";

export const PREPARED_GLYPH_PARSER_VERSION = "opentype.js@1.3.4" as const;
export const PREPARED_GLYPH_MAX_FONT_BYTES = 16 * 1024 * 1024;
export const PREPARED_GLYPH_MAX_CODE_POINTS = 256;
export const PREPARED_GLYPH_MAX_COMMANDS = 4096;
export const PREPARED_GLYPH_RUN_MAX_COMMANDS = 65536;
export const PREPARED_GLYPH_MAX_COORDINATE_EM = 16;
export const PREPARED_GLYPH_MAX_ADVANCE_EM = 16;
export const PREPARED_GLYPH_MAX_KERNING_EM = 4;

export type PreparedGlyphPathCommand =
  | Readonly<{ type: "M" | "L"; x: number; y: number }>
  | Readonly<{ type: "Q"; x1: number; y1: number; x: number; y: number }>
  | Readonly<{ type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }>
  | Readonly<{ type: "Z" }>;

/** Em coordinates, y-down, relative to the glyph's baseline origin (0, 0). */
export interface PreparedGlyphInk {
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
}

export interface PreparedGlyph {
  readonly kind: "glyph" | "space" | "newline";
  readonly text: string;
  readonly codePoint: number;
  readonly sourceUtf16Offset: number;
  readonly sourceUtf16Length: number;
  readonly glyphId: number | null;
  readonly advanceEm: number;
  readonly kerningAfterEm: number;
  readonly inkEm: PreparedGlyphInk | null;
  /** Font-unit coordinates, y-down. Scale by fontSize / run.unitsPerEm once. */
  readonly pathCommands: readonly PreparedGlyphPathCommand[];
}

export interface PreparedGlyphRun {
  readonly schema: "editkin.prepared-glyph-run/v1";
  readonly parserVersion: typeof PREPARED_GLYPH_PARSER_VERSION;
  readonly faceId: string;
  readonly fontSha256: string;
  readonly manifestSha256: string;
  readonly text: string;
  readonly unitsPerEm: number;
  /** Original font units, y-up font metrics, not the y-down contour coordinates. */
  readonly ascender: number;
  readonly descender: number;
  readonly glyphs: readonly PreparedGlyph[];
}

export type PreparedGlyphBlockReason = "FACE" | "BYTES" | "LIMIT" | "TEXT" | "SHA" | "PARSE"
  | "METRICS" | "MISSING_GLYPH" | "CONTOUR" | "IDENTITY";
export class PreparedGlyphRunError extends Error {
  readonly status = "BLOCK";
  constructor(readonly reason: PreparedGlyphBlockReason, message: string) {
    super(message);
    this.name = "PreparedGlyphRunError";
  }
}
function block(reason: PreparedGlyphBlockReason, message: string): never {
  throw new PreparedGlyphRunError(reason, message);
}

// Receipt membership cannot be copied through JSON, structuredClone or a spread.
// It retains no font, source byte array, mutable parser object or strong cache.
const preparedRuns = new WeakSet<object>();
const markOrFormat = /[\p{M}\p{Cf}\p{Cs}]/u;
const pictographic = /\p{Extended_Pictographic}/u;
const latinOrHan = /[\p{Script=Latin}\p{Script=Han}]/u;
const commonPunctuation = /\p{P}/u;
const space = /\p{Zs}/u;

function textUnits(text: string): Array<{ text: string; codePoint: number; sourceUtf16Offset: number; sourceUtf16Length: number }> {
  if (typeof text !== "string") block("TEXT", "Prepared glyph text must be an exact string");
  if (text.length > PREPARED_GLYPH_MAX_CODE_POINTS * 2) block("LIMIT", "Prepared glyph text exceeds the UTF-16 bound");
  const units = []; let offset = 0;
  for (const character of text) {
    if (units.length >= PREPARED_GLYPH_MAX_CODE_POINTS) block("LIMIT", "Prepared glyph text exceeds 256 code points");
    const codePoint = character.codePointAt(0)!;
    if (character !== "\n" && (markOrFormat.test(character) || pictographic.test(character)
      || !(space.test(character) || (codePoint >= 0x21 && codePoint <= 0x7e)
        || latinOrHan.test(character) || (commonPunctuation.test(character)
          && ((codePoint >= 0xa1 && codePoint <= 0xbf) || (codePoint >= 0x2000 && codePoint <= 0x206f)
            || (codePoint >= 0x3001 && codePoint <= 0x303f)))
        || (codePoint >= 0xff01 && codePoint <= 0xff5e)))) {
      block("TEXT", `Unsupported complex/RTL/combining/emoji/control text at UTF-16 offset ${offset}`);
    }
    units.push({ text: character, codePoint, sourceUtf16Offset: offset, sourceUtf16Length: character.length });
    offset += character.length;
  }
  return units;
}

function finite(value: number | undefined, maximum: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maximum) block("METRICS", `Invalid bounded glyph ${name}`);
  return value === 0 ? 0 : value; // Stable zero, without rounding genuine curve extrema.
}

function contour(commands: readonly PathCommand[], unitsPerEm: number): readonly PreparedGlyphPathCommand[] {
  if (commands.length > PREPARED_GLYPH_MAX_COMMANDS) block("LIMIT", "Glyph exceeds 4096 path commands");
  const maximum = unitsPerEm * PREPARED_GLYPH_MAX_COORDINATE_EM;
  const result: PreparedGlyphPathCommand[] = []; let openContour = false;
  for (const command of commands) {
    const coordinate = (value: number, name: string) => finite(value, maximum, name);
    if (command.type === "M") {
      if (openContour) block("CONTOUR", "Glyph contour must close before the next move");
      openContour = true;
      result.push(Object.freeze({ type: "M", x: coordinate(command.x, "x"), y: coordinate(command.y, "y") }));
    } else if (command.type === "Z") {
      if (!openContour) block("CONTOUR", "Glyph close requires an open contour");
      openContour = false; result.push(Object.freeze({ type: "Z" }));
    } else {
      if (!openContour) block("CONTOUR", "Glyph drawing requires an open contour");
      if (command.type === "L") result.push(Object.freeze({ type: "L", x: coordinate(command.x, "x"), y: coordinate(command.y, "y") }));
      else if (command.type === "Q") result.push(Object.freeze({ type: "Q", x1: coordinate(command.x1, "x1"), y1: coordinate(command.y1, "y1"), x: coordinate(command.x, "x"), y: coordinate(command.y, "y") }));
      else if (command.type === "C") result.push(Object.freeze({ type: "C", x1: coordinate(command.x1, "x1"), y1: coordinate(command.y1, "y1"), x2: coordinate(command.x2, "x2"), y2: coordinate(command.y2, "y2"), x: coordinate(command.x, "x"), y: coordinate(command.y, "y") }));
      else block("CONTOUR", "Unsupported glyph path command");
    }
  }
  if (openContour) block("CONTOUR", "Glyph path ends with an unclosed contour");
  return Object.freeze(result);
}

function physicalInk(glyph: Glyph, unitsPerEm: number): PreparedGlyphInk {
  // getBoundingBox evaluates curve extrema. getMetrics includes control points.
  const box = glyph.getBoundingBox(), maximum = unitsPerEm * PREPARED_GLYPH_MAX_COORDINATE_EM;
  const xMin = finite(box.x1, maximum, "ink xMin"), xMax = finite(box.x2, maximum, "ink xMax");
  finite(box.y2, maximum, "ink yMin"); finite(box.y1, maximum, "ink yMax");
  const yMin = -box.y2, yMax = -box.y1;
  if (xMax <= xMin || yMax <= yMin) block("CONTOUR", "Visible glyph requires nonempty true ink bounds");
  return Object.freeze({ xMin: xMin / unitsPerEm, yMin: yMin / unitsPerEm, xMax: xMax / unitsPerEm, yMax: yMax / unitsPerEm });
}

/** Simple, unshaped LTR code-point glyphs only. No ligature substitution,
 * contextual shaping, bidi, fallback, hinting, synthetic face or color emoji. */
export async function prepareGlyphRun(faceId: string, text: string, bytes: Uint8Array): Promise<PreparedGlyphRun> {
  let spec: BundledFontFaceSpec;
  try { spec = bundledFontFaceSpec(faceId); } catch { block("FACE", "Unknown compiled physical font face ID"); }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) block("BYTES", "Prepared glyph font requires nonempty Uint8Array bytes");
  if (bytes.byteLength > PREPARED_GLYPH_MAX_FONT_BYTES) block("LIMIT", "Prepared glyph font exceeds 16MiB");
  const units = textUnits(text);
  // Own only the requested view. Caller mutation during/after the async digest
  // cannot mutate the font subsequently parsed or any returned contour.
  const ownedBytes = new Uint8Array(bytes.byteLength); ownedBytes.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", ownedBytes.buffer);
  const actualSha = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  if (actualSha !== spec.sha256) block("SHA", "Actual physical font SHA differs from compiled catalog");
  let font: Font;
  try { font = parse(ownedBytes.buffer); } catch { block("PARSE", "Verified physical font could not be parsed"); }
  const unitsPerEm = font.unitsPerEm;
  if (!Number.isSafeInteger(unitsPerEm) || unitsPerEm < 16 || unitsPerEm > 16384
    || !Number.isSafeInteger(font.numGlyphs) || font.numGlyphs < 1 || font.numGlyphs > 65535) block("METRICS", "Invalid physical font units or glyph count");
  const ascender = finite(font.ascender, unitsPerEm * 16, "ascender"), descender = finite(font.descender, unitsPerEm * 16, "descender");
  if (ascender <= descender) block("METRICS", "Invalid physical font vertical metrics");
  const glyphs: PreparedGlyph[] = []; const physical: Array<Glyph | null> = []; let commandCount = 0;
  for (const unit of units) {
    if (unit.text === "\n") {
      glyphs.push({ ...unit, kind: "newline", glyphId: null, advanceEm: 0, kerningAfterEm: 0, inkEm: null, pathCommands: Object.freeze([]) });
      physical.push(null); continue;
    }
    const glyph = font.charToGlyph(unit.text), index = font.charToGlyphIndex(unit.text);
    if (!Number.isSafeInteger(index) || index < 1 || index >= font.numGlyphs || glyph.index !== index) block("MISSING_GLYPH", `Physical font has no exact glyph at UTF-16 offset ${unit.sourceUtf16Offset}`);
    const advance = finite(glyph.advanceWidth, unitsPerEm * PREPARED_GLYPH_MAX_ADVANCE_EM, "advance");
    if (advance < 0) block("METRICS", "Negative glyph advance is outside simple LTR support");
    const commands = contour(glyph.getPath(0, 0, unitsPerEm).commands, unitsPerEm);
    commandCount += commands.length;
    if (commandCount > PREPARED_GLYPH_RUN_MAX_COMMANDS) block("LIMIT", "Prepared run exceeds 65536 path commands");
    const whitespace = space.test(unit.text);
    if (!whitespace && commands.length === 0) block("MISSING_GLYPH", "Visible text cannot use an empty fallback glyph");
    if (whitespace && commands.length !== 0) block("CONTOUR", "Space must not contain visible glyph ink");
    glyphs.push({ ...unit, kind: whitespace ? "space" : "glyph", glyphId: index, advanceEm: advance / unitsPerEm,
      kerningAfterEm: 0, inkEm: whitespace ? null : physicalInk(glyph, unitsPerEm), pathCommands: commands });
    physical.push(glyph);
  }
  for (let index = 0; index < glyphs.length; index++) {
    const left = physical[index], right = physical[index + 1];
    const kerning = left && right ? finite(font.getKerningValue(left, right), unitsPerEm * PREPARED_GLYPH_MAX_KERNING_EM, "kerning") / unitsPerEm : 0;
    glyphs[index] = Object.freeze({ ...glyphs[index], kerningAfterEm: kerning });
  }
  const run: PreparedGlyphRun = Object.freeze({ schema: "editkin.prepared-glyph-run/v1", parserVersion: PREPARED_GLYPH_PARSER_VERSION,
    faceId: spec.faceId, fontSha256: actualSha, manifestSha256: spec.manifestSha256, text, unitsPerEm, ascender, descender,
    glyphs: Object.freeze(glyphs) });
  preparedRuns.add(run);
  return run;
}

/** A copied or caller-authored receipt cannot authorize physical layout. */
export function assertPreparedGlyphRun(run: unknown): asserts run is PreparedGlyphRun {
  if (!run || typeof run !== "object" || !preparedRuns.has(run)) block("IDENTITY", "Prepared glyph run was not made by this factory");
  const prepared = run as PreparedGlyphRun, spec = bundledFontFaceSpec(prepared.faceId);
  if (prepared.schema !== "editkin.prepared-glyph-run/v1" || prepared.parserVersion !== PREPARED_GLYPH_PARSER_VERSION
    || prepared.fontSha256 !== spec.sha256 || prepared.manifestSha256 !== spec.manifestSha256
    || !Object.isFrozen(prepared) || !Object.isFrozen(prepared.glyphs)
    || prepared.glyphs.some(glyph => !Object.isFrozen(glyph) || !Object.isFrozen(glyph.pathCommands)
      || (glyph.inkEm !== null && !Object.isFrozen(glyph.inkEm)) || glyph.pathCommands.some(command => !Object.isFrozen(command)))) {
    block("IDENTITY", "Prepared glyph receipt identity or deep immutability differs from the current catalog");
  }
}
