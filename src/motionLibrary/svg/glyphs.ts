import { parse, type Font, type Glyph, type PathCommand } from "opentype.js";
import { bundledFontFaceSpec } from "../../typography/bundledFontCatalog";
import { fmt } from "./document";

/**
 * Glyph outlines for motion library frames: text is never <text>, every glyph
 * is its own path built from the static render fonts.
 *
 * Fonts: only Editkin's compiled render faces (public/fonts/render). A face is
 * loaded once per runtime, its bytes verified against the compiled catalog
 * SHA-256, parsed with opentype.js and cached. In Node the bytes are read
 * lazily on first use (EDITKIN_FONT_ROOT, setMotionLibraryFontRoot or the app's
 * public/fonts); a browser runtime registers verified bytes first with
 * registerMotionLibraryFontBytes. This module has no static node: import.
 *
 * Units: layout results are pixels, y-down, origin on the baseline. Path data
 * keeps 2 decimals. Layout is linear in `size`, so lay out once at the target
 * size and animate with transforms (results are cached by text/face/size).
 *
 * Unsupported text is refused before any render: a character the face has no
 * glyph for, combining marks / variation selectors / format and control
 * characters (no shaping engine) and line breaks inside a line throw
 * MotionLibraryGlyphError naming the character.
 */

export const MOTION_FONT_ROLES = ["display", "serif", "hand", "mono", "latin", "latin_round"] as const;
export type MotionFontRole = typeof MOTION_FONT_ROLES[number];

interface FontRoleSpec {
  readonly fontId: string;
  readonly weights: readonly number[];
  readonly defaultWeight: number;
}

const weightRange = (from: number, to: number, step: number) => Object.freeze(Array.from({ length: (to - from) / step + 1 }, (_, index) => from + index * step));

/** display = Noto Sans TC 100–900, serif = Noto Serif TC 200–900, hand = LXGW WenKai TC 700,
 * mono = LXGW WenKai Mono TC 400, latin = Bebas Neue 400, latin_round = Fredoka 300–700. */
export const MOTION_FONT_REGISTRY: Readonly<Record<MotionFontRole, FontRoleSpec>> = Object.freeze({
  display: Object.freeze({ fontId: "noto-sans-tc", weights: weightRange(100, 900, 50), defaultWeight: 900 }),
  serif: Object.freeze({ fontId: "noto-serif-tc", weights: weightRange(200, 900, 50), defaultWeight: 700 }),
  hand: Object.freeze({ fontId: "lxgw-wenkai-tc", weights: Object.freeze([700]), defaultWeight: 700 }),
  mono: Object.freeze({ fontId: "lxgw-wenkai-mono-tc", weights: Object.freeze([400]), defaultWeight: 400 }),
  latin: Object.freeze({ fontId: "bebas-neue", weights: Object.freeze([400]), defaultWeight: 400 }),
  latin_round: Object.freeze({ fontId: "fredoka", weights: weightRange(300, 700, 50), defaultWeight: 600 }),
});

export interface MotionFontSelector {
  readonly font: MotionFontRole;
  /** Snapped to the nearest available weight of the role (ties go heavier). */
  readonly weight?: number;
}

export interface ResolvedMotionFace {
  readonly faceId: string;
  readonly role: MotionFontRole;
  readonly weight: number;
  readonly sha256: string;
}

export function resolveMotionFace(selector: MotionFontSelector): ResolvedMotionFace {
  const spec = MOTION_FONT_REGISTRY[selector?.font];
  if (!spec) throw new Error(`Unknown motion font role: ${String(selector?.font)}`);
  const requested = selector.weight ?? spec.defaultWeight;
  if (!Number.isFinite(requested)) throw new Error("Motion font weight must be a finite number");
  let weight = spec.weights[0];
  for (const candidate of spec.weights) {
    const better = Math.abs(candidate - requested) < Math.abs(weight - requested)
      || (Math.abs(candidate - requested) === Math.abs(weight - requested) && candidate > weight);
    if (better) weight = candidate;
  }
  const faceId = `EditkinFace-${spec.fontId}-${weight}`;
  return Object.freeze({ faceId, role: selector.font, weight, sha256: bundledFontFaceSpec(faceId).sha256 });
}

/** The static weights a role really has (ascending). The library never synthesizes a missing weight. */
export function motionAvailableWeights(role: MotionFontRole): readonly number[] {
  const spec = MOTION_FONT_REGISTRY[role];
  if (!spec) throw new Error(`Unknown motion font role: ${String(role)}`);
  return spec.weights;
}

export interface WeightLadderOptions {
  /** Rung spacing in weight units: from, from ± step, …, to, each snapped to a real weight. Default: every real weight from → to. */
  readonly step?: number;
  /** Width of each step's crossfade, in p units (0 = hard cut, default). T63's 2 frames: 2 / (fps · rampSeconds). */
  readonly crossfade?: number;
  /**
   * Optional easing of the ramp. With it, p is linear time progress, the weight follows ease(p), and every
   * crossfade window is centred on the time the eased ramp crosses that step, so each lasts exactly `crossfade`.
   */
  readonly ease?: (u: number) => number;
}

export interface WeightLadderSample {
  /** The rung being left (or the only one) and the rung being entered (= weightA outside a crossfade). */
  readonly weightA: number;
  readonly weightB: number;
  /** 0 = only A … 1 = only B; 0 outside a crossfade (then weightA === weightB). */
  readonly mix: number;
  /** The same pair ordered by weight, for drawing: lighter at full opacity, heavier over it at heavierOpacity. */
  readonly lighter: number;
  readonly heavier: number;
  /** 1 when lighter === heavier (draw once). */
  readonly heavierOpacity: number;
  /** Every rung of this ladder in ramp order (from → to). */
  readonly rungs: readonly number[];
}

const ladderCache = new Map<string, readonly number[]>();

function ladderRungs(role: MotionFontRole, fromWeight: number, toWeight: number, step: number | undefined): readonly number[] {
  const key = `${role}\u0000${fromWeight}\u0000${toWeight}\u0000${step ?? ""}`;
  const hit = ladderCache.get(key);
  if (hit) return hit;
  const snap = (weight: number) => resolveMotionFace({ font: role, weight }).weight;
  const from = snap(fromWeight), to = snap(toWeight), direction = to >= from ? 1 : -1;
  let wanted: number[];
  if (step === undefined) {
    wanted = motionAvailableWeights(role).filter(weight => weight >= Math.min(from, to) && weight <= Math.max(from, to));
    if (direction < 0) wanted.reverse();
  } else {
    if (Math.abs(toWeight - fromWeight) / step > 1000) throw new Error("weightLadderAt step is too small for this range");
    wanted = [];
    for (let weight = fromWeight; direction > 0 ? weight < toWeight : weight > toWeight; weight += direction * step) wanted.push(weight);
    wanted.push(toWeight);
  }
  const rungs: number[] = [];
  for (const weight of wanted.map(snap)) if (rungs[rungs.length - 1] !== weight) rungs.push(weight);
  const frozen = Object.freeze(rungs);
  ladderCache.set(key, frozen);
  if (ladderCache.size > 64) ladderCache.delete(ladderCache.keys().next().value!);
  return frozen;
}

/** Time u in [0, 1] at which ease(u) first reaches q (bisection; ease must be non-decreasing with ease(0) = 0, ease(1) = 1). */
function easeInverse(ease: (u: number) => number, q: number): number {
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const mid = (low + high) / 2;
    if (ease(mid) < q) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Weight ladder (DESIGN §8, T63 Weight Grow): the weight of a from → to ramp at
 * progress p, as real static weights only. The ramp moves linearly in weight
 * (through ease(p) when given); each step switches rung where the ramp passes the
 * midpoint between two rungs, crossfading over `crossfade` (in p) when set.
 * Missing weights are never faked: a ramp beyond the family's range stops at its
 * lightest / heaviest weight, and a single-weight role (hand, mono, latin) returns
 * that weight throughout. Deterministic and browser-safe.
 *
 * Usage (T63 up-ramp, serif 200 → 900 in 0.75 s at the frame rate):
 *   const rung = weightLadderAt("serif", 200, 900, clamp01(t / 0.75), { step: 100, crossfade: 2 / (fps * 0.75), ease: cubicInOut });
 *   const draw = (weight: number, opacity?: number) => path(<word laid out at `weight`>, { fill: ink, opacity });
 *   [draw(rung.lighter), rung.heavier !== rung.lighter ? draw(rung.heavier, rung.heavierOpacity) : ""]
 * Drawing the lighter weight solid under the heavier one avoids the see-through dip of two half-opacity copies.
 */
export function weightLadderAt(role: MotionFontRole, fromWeight: number, toWeight: number, p: number,
  options: WeightLadderOptions = {}): WeightLadderSample {
  if (![fromWeight, toWeight, p].every(Number.isFinite)) throw new Error("weightLadderAt needs finite weights and progress");
  const step = options.step, crossfade = options.crossfade ?? 0;
  if (step !== undefined && !(step > 0 && Number.isFinite(step))) throw new Error("weightLadderAt step must be a positive number");
  if (!(crossfade >= 0 && crossfade <= 1)) throw new Error("weightLadderAt crossfade must be within 0..1");
  const rungs = ladderRungs(role, fromWeight, toWeight, step);
  const pure = (weight: number): WeightLadderSample =>
    Object.freeze({ weightA: weight, weightB: weight, mix: 0, lighter: weight, heavier: weight, heavierOpacity: 1, rungs });
  if (rungs.length === 1) return pure(rungs[0]);
  const u = Math.min(1, Math.max(0, p));
  const first = rungs[0], span = rungs[rungs.length - 1] - first;
  // Time of each step: the ramp passes the midpoint between rungs k and k + 1.
  const boundaries = rungs.slice(0, -1).map((weight, index) => {
    const q = ((weight + rungs[index + 1]) / 2 - first) / span;
    return options.ease ? easeInverse(options.ease, q) : q;
  });
  let rung = 0;
  for (let index = 0; index < boundaries.length; index += 1) {
    const centre = boundaries[index];
    const start = Math.max(centre - crossfade / 2, index > 0 ? (boundaries[index - 1] + centre) / 2 : -Infinity);
    const end = Math.min(centre + crossfade / 2, index + 1 < boundaries.length ? (centre + boundaries[index + 1]) / 2 : Infinity);
    if (end > start && u > start && u < end) {
      const mix = (u - start) / (end - start), weightA = rungs[index], weightB = rungs[index + 1];
      const ascending = weightB > weightA;
      return Object.freeze({ weightA, weightB, mix, lighter: ascending ? weightA : weightB, heavier: ascending ? weightB : weightA,
        heavierOpacity: ascending ? mix : 1 - mix, rungs });
    }
    if (u >= centre) rung = index + 1;
  }
  return pure(rungs[rung]);
}

/** Every face reachable through the registry with its compiled SHA-256 (sorted): cache-key material. */
export function motionLibraryFontDigests(): ReadonlyArray<{ readonly faceId: string; readonly sha256: string }> {
  const rows: Array<{ faceId: string; sha256: string }> = [];
  for (const role of MOTION_FONT_ROLES) {
    for (const weight of MOTION_FONT_REGISTRY[role].weights) {
      const faceId = `EditkinFace-${MOTION_FONT_REGISTRY[role].fontId}-${weight}`;
      rows.push({ faceId, sha256: bundledFontFaceSpec(faceId).sha256 });
    }
  }
  return Object.freeze(rows.sort((a, b) => (a.faceId < b.faceId ? -1 : a.faceId > b.faceId ? 1 : 0)).map(row => Object.freeze(row)));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type MotionLibraryGlyphErrorReason = "missing_glyph" | "unsupported_character" | "line_break";

export class MotionLibraryGlyphError extends Error {
  readonly character: string;
  readonly codePoint: number;
  readonly faceId: string;
  readonly reason: MotionLibraryGlyphErrorReason;
  /** Code-point index of the character in the laid-out text. */
  readonly textIndex: number;
  constructor(character: string, faceId: string, reason: MotionLibraryGlyphErrorReason, textIndex: number) {
    const codePoint = character.codePointAt(0) ?? 0;
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    const shown = reason === "line_break" ? "line break" : `"${character}"`;
    const why = reason === "missing_glyph" ? `has no glyph for ${shown} (${label})`
      : reason === "line_break" ? `cannot lay out a ${shown} (${label}) inside one line; pass separate lines`
        : `cannot draw ${shown} (${label}): combining, format, control and variation characters need shaping`;
    super(`Motion library font ${faceId} ${why} at character ${textIndex + 1}`);
    this.name = "MotionLibraryGlyphError";
    this.character = character;
    this.codePoint = codePoint;
    this.faceId = faceId;
    this.reason = reason;
    this.textIndex = textIndex;
  }
}

// ---------------------------------------------------------------------------
// Face loading
// ---------------------------------------------------------------------------

interface GlyphRecord {
  readonly index: number;
  /** Advance in font units. */
  readonly advance: number;
  /** Outline in font units, y-down, origin at the pen position on the baseline. */
  readonly commands: readonly PathCommand[];
  /** Ink box in font units, y-down; null for blank glyphs. */
  readonly ink: GlyphBox | null;
}

interface LoadedFace {
  readonly faceId: string;
  readonly font: Font;
  readonly unitsPerEm: number;
  /** hhea ascender (positive) and descender (negative), font units. */
  readonly ascender: number;
  readonly descender: number;
  /** OS/2 typo metrics: the ideographic em box for CJK faces. */
  readonly typoAscender: number;
  readonly typoDescender: number;
  readonly capHeight: number;
  readonly xHeight: number;
  readonly byChar: Map<string, number>;
  readonly byIndex: Map<number, GlyphRecord>;
  readonly kerning: Map<number, number>;
  vertical?: ReadonlyMap<number, number>;
}

const faces = new Map<string, LoadedFace>();
let configuredFontRoot: string | undefined;

type NodeProcessLike = { env?: Record<string, string | undefined>; getBuiltinModule?: (id: string) => unknown };
function nodeProcess(): NodeProcessLike | undefined {
  return (globalThis as { process?: NodeProcessLike }).process;
}
function nodeBuiltin<T>(id: string): T | undefined {
  const getter = nodeProcess()?.getBuiltinModule;
  return typeof getter === "function" ? getter.call(nodeProcess(), id) as T | undefined : undefined;
}

/** Override the font root (the directory holding editkin-open-fonts.json and render/). undefined restores the default. */
export function setMotionLibraryFontRoot(root: string | undefined): void {
  configuredFontRoot = root;
}

export function motionLibraryFontRoot(): string {
  if (configuredFontRoot) return configuredFontRoot;
  const fromEnvironment = nodeProcess()?.env?.EDITKIN_FONT_ROOT;
  if (fromEnvironment) return fromEnvironment;
  const path = nodeBuiltin<typeof import("node:path")>("node:path");
  const here = (import.meta as { dirname?: string }).dirname;
  if (!path || !here) throw new Error("Motion library font root is unknown in this runtime; register font bytes instead");
  return path.resolve(here, "../../../public/fonts");
}

function installFace(faceId: string, bytes: Uint8Array): LoadedFace {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  let font: Font;
  try { font = parse(owned.buffer); } catch (error) { throw new Error(`Motion library font ${faceId} could not be parsed: ${(error as Error).message}`); }
  const unitsPerEm = font.unitsPerEm;
  if (!Number.isSafeInteger(unitsPerEm) || unitsPerEm < 16 || unitsPerEm > 16384) throw new Error(`Motion library font ${faceId} has invalid unitsPerEm`);
  const os2 = (font.tables as Record<string, { sTypoAscender?: number; sTypoDescender?: number; sCapHeight?: number; sxHeight?: number } | undefined>).os2;
  const typoAscender = Number.isFinite(os2?.sTypoAscender) && os2!.sTypoAscender! > 0 ? os2!.sTypoAscender! : Math.round(unitsPerEm * 0.88);
  const typoDescender = Number.isFinite(os2?.sTypoDescender) && os2!.sTypoDescender! < 0 ? os2!.sTypoDescender! : -Math.round(unitsPerEm * 0.12);
  const face: LoadedFace = {
    faceId, font, unitsPerEm, ascender: font.ascender, descender: font.descender, typoAscender, typoDescender,
    capHeight: Number.isFinite(os2?.sCapHeight) && os2!.sCapHeight! > 0 ? os2!.sCapHeight! : Math.round(unitsPerEm * 0.7),
    xHeight: Number.isFinite(os2?.sxHeight) && os2!.sxHeight! > 0 ? os2!.sxHeight! : Math.round(unitsPerEm * 0.5),
    byChar: new Map(), byIndex: new Map(), kerning: new Map(),
  };
  faces.set(faceId, face);
  return face;
}

function loadFaceSync(faceId: string): LoadedFace {
  const spec = bundledFontFaceSpec(faceId);
  const fs = nodeBuiltin<typeof import("node:fs")>("node:fs");
  const path = nodeBuiltin<typeof import("node:path")>("node:path");
  const crypto = nodeBuiltin<typeof import("node:crypto")>("node:crypto");
  if (!fs || !path || !crypto) throw new Error(`Motion library font ${faceId} is not registered in this runtime (call registerMotionLibraryFontBytes first)`);
  const bytes = fs.readFileSync(path.join(motionLibraryFontRoot(), spec.fontFile));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== spec.sha256) throw new Error(`Motion library font ${spec.fontFile} does not match its compiled catalog SHA-256`);
  return installFace(faceId, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

/** Register verified font bytes (browser runtimes, or tests). Rejects bytes whose SHA-256 differs from the compiled catalog. */
export async function registerMotionLibraryFontBytes(faceId: string, bytes: Uint8Array): Promise<void> {
  const spec = bundledFontFaceSpec(faceId);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) throw new Error("Font bytes must be a non-empty Uint8Array");
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", owned.buffer)), value => value.toString(16).padStart(2, "0")).join("");
  if (digest !== spec.sha256) throw new Error(`Font bytes for ${faceId} do not match the compiled catalog SHA-256`);
  if (!faces.has(faceId)) installFace(faceId, owned);
}

export function isMotionLibraryFaceLoaded(faceId: string): boolean {
  return faces.has(faceId);
}

function faceFor(faceId: string): LoadedFace {
  return faces.get(faceId) ?? loadFaceSync(faceId);
}

const UNSUPPORTED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{M}]/u;
const LINE_BREAK_CODES: ReadonlySet<number> = new Set([0x0A, 0x0D, 0x85, 0x2028, 0x2029]);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
const WHITESPACE = /^[\p{Zs}\t]$/u;

function glyphRecordByIndex(face: LoadedFace, index: number): GlyphRecord {
  let record = face.byIndex.get(index);
  if (record) return record;
  const glyph: Glyph = face.font.glyphs.get(index);
  const advance = Number.isFinite(glyph.advanceWidth) ? glyph.advanceWidth! : 0;
  const commands = glyph.getPath(0, 0, face.unitsPerEm).commands.map(command => Object.freeze({ ...command })) as PathCommand[];
  let ink: GlyphBox | null = null;
  if (commands.length) {
    const box = glyph.getBoundingBox();
    if ([box.x1, box.x2, box.y1, box.y2].every(Number.isFinite) && box.x2 > box.x1 && box.y2 > box.y1) {
      ink = Object.freeze({ x0: box.x1, y0: -box.y2, x1: box.x2, y1: -box.y1 });
    }
  }
  record = Object.freeze({ index, advance, commands: Object.freeze(commands), ink });
  face.byIndex.set(index, record);
  return record;
}

function glyphIndexForChar(face: LoadedFace, character: string, textIndex: number): number {
  const cached = face.byChar.get(character);
  if (cached !== undefined) return cached;
  if (LINE_BREAK_CODES.has(character.codePointAt(0) ?? 0)) throw new MotionLibraryGlyphError(character, face.faceId, "line_break", textIndex);
  if (UNSUPPORTED.test(character)) throw new MotionLibraryGlyphError(character, face.faceId, "unsupported_character", textIndex);
  const index = face.font.charToGlyphIndex(character);
  const whitespace = WHITESPACE.test(character);
  if (!Number.isSafeInteger(index) || index < 1 || index >= face.font.numGlyphs) {
    if (!whitespace) throw new MotionLibraryGlyphError(character, face.faceId, "missing_glyph", textIndex);
    // Whitespace the face lacks falls back to its plain space (U+3000 to a full em below).
    const space = face.font.charToGlyphIndex(" ");
    face.byChar.set(character, space > 0 ? -1 - space : -1);
    return face.byChar.get(character)!;
  }
  if (!whitespace && glyphRecordByIndex(face, index).commands.length === 0) {
    throw new MotionLibraryGlyphError(character, face.faceId, "missing_glyph", textIndex);
  }
  face.byChar.set(character, index);
  return index;
}

/** Glyph for a character: negative indices encode a whitespace fallback. */
function recordForChar(face: LoadedFace, character: string, textIndex: number): { record: GlyphRecord; whitespace: boolean } {
  const index = glyphIndexForChar(face, character, textIndex);
  if (index >= 0) {
    const record = glyphRecordByIndex(face, index);
    return { record, whitespace: WHITESPACE.test(character) || record.commands.length === 0 };
  }
  const fallbackAdvance = character === IDEOGRAPHIC_SPACE ? face.unitsPerEm : index === -1 ? face.unitsPerEm / 4 : glyphRecordByIndex(face, -1 - index).advance;
  return { record: Object.freeze({ index: 0, advance: fallbackAdvance, commands: Object.freeze([]), ink: null }), whitespace: true };
}

function kerningValue(face: LoadedFace, left: number, right: number): number {
  if (left <= 0 || right <= 0) return 0;
  const key = left * 65536 + right;
  let value = face.kerning.get(key);
  if (value === undefined) {
    try { value = face.font.getKerningValue(left, right); } catch { value = 0; }
    if (!Number.isFinite(value)) value = 0;
    face.kerning.set(key, value);
  }
  return value;
}

function verticalAlternates(face: LoadedFace): ReadonlyMap<number, number> {
  if (face.vertical) return face.vertical;
  const map = new Map<number, number>();
  const substitution = face.font.substitution as unknown as { getSingle?: (feature: string, script: string, language: string) => Array<{ sub: number; by: number }> };
  for (const script of ["hani", "DFLT", "kana", "latn"]) {
    try {
      const singles = substitution.getSingle?.("vert", script, "DFLT") ?? [];
      for (const single of singles) if (Number.isInteger(single.sub) && Number.isInteger(single.by) && !map.has(single.sub)) map.set(single.sub, single.by);
    } catch { /* A face without this script simply has no alternates there. */ }
    if (map.size) break;
  }
  face.vertical = map;
  return map;
}

// ---------------------------------------------------------------------------
// Path conversion
// ---------------------------------------------------------------------------

const PATH_DECIMALS = 2;

/** Font-unit commands → pixel path data: (x, y) ↦ (x·scale + dx, y·scale + dy), or the rotated variant. */
function commandsToPath(commands: readonly PathCommand[], map: (x: number, y: number) => readonly [number, number]): string {
  let text = "";
  const n = (value: number) => fmt(value, PATH_DECIMALS);
  for (const command of commands) {
    switch (command.type) {
      case "M": { const [x, y] = map(command.x, command.y); text += `M${n(x)} ${n(y)}`; break; }
      case "L": { const [x, y] = map(command.x, command.y); text += `L${n(x)} ${n(y)}`; break; }
      case "Q": {
        const [x1, y1] = map(command.x1, command.y1), [x, y] = map(command.x, command.y);
        text += `Q${n(x1)} ${n(y1)} ${n(x)} ${n(y)}`; break;
      }
      case "C": {
        const [x1, y1] = map(command.x1, command.y1), [x2, y2] = map(command.x2, command.y2), [x, y] = map(command.x, command.y);
        text += `C${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x)} ${n(y)}`; break;
      }
      case "Z": text += "Z"; break;
    }
  }
  return text;
}

function scaledPath(commands: readonly PathCommand[], scale: number, dx: number, dy: number): string {
  return commandsToPath(commands, (x, y) => [x * scale + dx, y * scale + dy]);
}

// ---------------------------------------------------------------------------
// Layout types
// ---------------------------------------------------------------------------

/** Axis-aligned box, y-down. */
export interface GlyphBox { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

export interface LayoutOptions extends MotionFontSelector {
  /** Font size in pixels (em). */
  readonly size: number;
  /** Extra space between glyphs, in em (0.05 = 5% of size). Default 0. */
  readonly tracking?: number;
  /** Apply the face's pair kerning (GPOS/kern). Default true. */
  readonly kerning?: boolean;
}

export interface PlacedGlyph {
  readonly char: string;
  readonly codePoint: number;
  /** Code-point index in the text. */
  readonly index: number;
  readonly glyphId: number;
  /** Outline in px with the origin at this glyph's pen position on the baseline (y-down); "" for blanks. */
  readonly pathD: string;
  /** Pen x of the glyph within the line. */
  readonly x: number;
  /** Advance width in px (tracking and kerning excluded). */
  readonly advance: number;
  /** Ink box relative to the glyph origin; null for blanks. */
  readonly bbox: GlyphBox | null;
  readonly whitespace: boolean;
}

export interface FaceMetrics {
  readonly faceId: string;
  readonly unitsPerEm: number;
  /** All in px at the layout size, y-down relative to the baseline: ascent/descent are positive distances. */
  readonly ascent: number;
  readonly descent: number;
  /** Ideographic em box (OS/2 typo metrics): emTop is negative (above the baseline), emBottom positive. */
  readonly emTop: number;
  readonly emBottom: number;
  readonly capHeight: number;
  readonly xHeight: number;
}

export interface LineLayout extends FaceMetrics {
  readonly text: string;
  readonly size: number;
  readonly tracking: number;
  readonly glyphs: readonly PlacedGlyph[];
  /** Pen advance of the whole line (tracking between glyphs, kerning applied). */
  readonly width: number;
  /** Union of ink boxes in line coordinates (origin at the line start on the baseline). */
  readonly inkBox: GlyphBox | null;
  /** Every outline combined, in line coordinates. */
  readonly pathD: string;
}

function assertSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0 || size > 8192) throw new Error("Motion library font size must be within 0..8192 px");
}

/** Layout inputs are rounded to 3 decimals before use, so a cached layout never depends on which caller built it. */
function canonical(value: number): number {
  return Number(fmt(value));
}

function metricsFor(face: LoadedFace, size: number): FaceMetrics {
  const scale = size / face.unitsPerEm;
  return {
    faceId: face.faceId, unitsPerEm: face.unitsPerEm,
    ascent: face.ascender * scale, descent: -face.descender * scale,
    emTop: -face.typoAscender * scale, emBottom: -face.typoDescender * scale,
    capHeight: face.capHeight * scale, xHeight: face.xHeight * scale,
  };
}

/** Pixel metrics of a face at a size (loads the face on first use). */
export function motionFaceMetrics(selector: MotionFontSelector, size: number): FaceMetrics {
  assertSize(size);
  return Object.freeze(metricsFor(faceFor(resolveMotionFace(selector).faceId), size));
}

function unionBox(box: GlyphBox | null, other: GlyphBox | null): GlyphBox | null {
  if (!other) return box;
  if (!box) return other;
  return { x0: Math.min(box.x0, other.x0), y0: Math.min(box.y0, other.y0), x1: Math.max(box.x1, other.x1), y1: Math.max(box.y1, other.y1) };
}
const offsetBox = (box: GlyphBox | null, dx: number, dy: number): GlyphBox | null =>
  box ? { x0: box.x0 + dx, y0: box.y0 + dy, x1: box.x1 + dx, y1: box.y1 + dy } : null;
const scaleBox = (box: GlyphBox | null, scale: number): GlyphBox | null =>
  box ? { x0: box.x0 * scale, y0: box.y0 * scale, x1: box.x1 * scale, y1: box.y1 * scale } : null;

// Small LRU of finished layouts: frames re-use the same text at the same size.
const LAYOUT_CACHE_LIMIT = 512;
const layoutCache = new Map<string, unknown>();
function cached<T>(key: string, build: () => T): T {
  const hit = layoutCache.get(key);
  if (hit !== undefined) {
    layoutCache.delete(key);
    layoutCache.set(key, hit);
    return hit as T;
  }
  const value = build();
  layoutCache.set(key, value);
  if (layoutCache.size > LAYOUT_CACHE_LIMIT) layoutCache.delete(layoutCache.keys().next().value!);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Check every character of `text` against the face without laying it out (throws MotionLibraryGlyphError). */
export function assertMotionText(text: string, selector: MotionFontSelector): void {
  const face = faceFor(resolveMotionFace(selector).faceId);
  let index = 0;
  for (const character of text) recordForChar(face, character, index++);
}

/** Lay out one line left to right (no line breaking, no shaping). */
export function layoutLine(text: string, options: LayoutOptions): LineLayout {
  if (typeof text !== "string") throw new Error("layoutLine needs a string");
  assertSize(options.size);
  const size = canonical(options.size);
  assertSize(size);
  const tracking = options.tracking ?? 0, kerning = options.kerning ?? true;
  if (!Number.isFinite(tracking) || Math.abs(tracking) > 4) throw new Error("tracking is in em and must be within -4..4");
  const trackingEm = canonical(tracking);
  const { faceId } = resolveMotionFace(options);
  const key = `L\u0000${faceId}\u0000${size}\u0000${trackingEm}\u0000${kerning ? 1 : 0}\u0000${text}`;
  return cached(key, () => {
    const face = faceFor(faceId), scale = size / face.unitsPerEm;
    const glyphs: PlacedGlyph[] = [];
    let pen = 0, previous = 0, inkBox: GlyphBox | null = null, pathD = "", textIndex = 0;
    for (const character of text) {
      const { record, whitespace } = recordForChar(face, character, textIndex);
      if (textIndex > 0) pen += trackingEm * size + (kerning ? kerningValue(face, previous, record.index) * scale : 0);
      const advance = record.advance * scale;
      const bbox = whitespace ? null : scaleBox(record.ink, scale);
      glyphs.push({ char: character, codePoint: character.codePointAt(0)!, index: textIndex, glyphId: record.index,
        pathD: whitespace ? "" : scaledPath(record.commands, scale, 0, 0), x: pen, advance, bbox, whitespace });
      if (!whitespace) {
        pathD += scaledPath(record.commands, scale, pen, 0);
        inkBox = unionBox(inkBox, offsetBox(bbox, pen, 0));
      }
      pen += advance;
      previous = record.index;
      textIndex += 1;
    }
    return deepFreeze({ text, size, tracking: trackingEm, glyphs, width: pen, inkBox, pathD, ...metricsFor(face, size) });
  });
}

/** Width and ink box of a line (same cache as layoutLine). */
export function measureLine(text: string, options: LayoutOptions): { readonly width: number; readonly inkBox: GlyphBox | null; readonly metrics: FaceMetrics } {
  const line = layoutLine(text, options);
  return { width: line.width, inkBox: line.inkBox, metrics: line };
}

// ---------------------------------------------------------------------------
// Blocks and fitting
// ---------------------------------------------------------------------------

export interface TextBlockOptions extends LayoutOptions {
  /** Baseline-to-baseline distance in em (default 1.15). */
  readonly lineHeight?: number;
  readonly align?: "start" | "center" | "end";
}

export interface TextBlockLine {
  readonly layout: LineLayout;
  /** Line origin (start of the pen, on the baseline) in block coordinates. */
  readonly x: number;
  readonly baselineY: number;
}

export interface TextBlockLayout {
  readonly size: number;
  readonly lines: readonly TextBlockLine[];
  /** Block box: x 0..width, y 0..height (from the first line's em top to the last line's em bottom). */
  readonly width: number;
  readonly height: number;
  /** Union ink box in block coordinates. */
  readonly inkBox: GlyphBox | null;
  /** All outlines in block coordinates. */
  readonly pathD: string;
}

export function layoutTextBlock(lines: readonly string[], options: TextBlockOptions): TextBlockLayout {
  if (!Array.isArray(lines) || !lines.length) throw new Error("layoutTextBlock needs at least one line");
  const lineHeightInput = options.lineHeight ?? 1.15, align = options.align ?? "center";
  if (!Number.isFinite(lineHeightInput) || lineHeightInput <= 0 || lineHeightInput > 8) throw new Error("lineHeight is in em and must be within 0..8");
  assertSize(options.size);
  const size = canonical(options.size), lineHeight = canonical(lineHeightInput);
  assertSize(size);
  const { faceId } = resolveMotionFace(options);
  const key = `B\u0000${faceId}\u0000${size}\u0000${canonical(options.tracking ?? 0)}\u0000${options.kerning === false ? 0 : 1}`
    + `\u0000${lineHeight}\u0000${align}\u0000${lines.join("\u0001")}`;
  return cached(key, () => {
    const layouts = lines.map(text => layoutLine(text, { ...options, size }));
    const face = faceFor(faceId), scale = size / face.unitsPerEm;
    const width = Math.max(...layouts.map(layout => layout.width));
    const first = layouts[0], step = lineHeight * size;
    const placed: TextBlockLine[] = layouts.map((layout, index) => ({
      layout,
      x: align === "center" ? (width - layout.width) / 2 : align === "end" ? width - layout.width : 0,
      baselineY: -first.emTop + index * step,
    }));
    let inkBox: GlyphBox | null = null, pathD = "";
    for (const line of placed) {
      inkBox = unionBox(inkBox, offsetBox(line.layout.inkBox, line.x, line.baselineY));
      for (const glyph of line.layout.glyphs) {
        if (glyph.whitespace) continue;
        pathD += scaledPath(glyphRecordByIndex(face, glyph.glyphId).commands, scale, line.x + glyph.x, line.baselineY);
      }
    }
    const last = layouts[layouts.length - 1];
    const height = -first.emTop + (layouts.length - 1) * step + last.emBottom;
    return deepFreeze({ size, lines: placed, width, height, inkBox, pathD });
  });
}

/**
 * Largest size (≤ maxSize) at which every line fits maxWidth and the block fits
 * maxHeight. Measures at 100 px and scales linearly. measure "ink" uses ink
 * extents (visual), "advance" uses pen width and the em box.
 */
export function fitFontSize(lines: readonly string[], options: MotionFontSelector & { tracking?: number; kerning?: boolean; lineHeight?: number },
  box: { maxWidth: number; maxHeight?: number; maxSize: number; minSize?: number; measure?: "ink" | "advance" }): number {
  if (!lines.length) throw new Error("fitFontSize needs at least one line");
  const reference = 100, measure = box.measure ?? "ink";
  const block = layoutTextBlock(lines, { ...options, size: reference });
  const widthAt = measure === "ink"
    ? Math.max(...block.lines.map(line => line.layout.inkBox ? line.layout.inkBox.x1 - line.layout.inkBox.x0 : 0), 1e-6)
    : Math.max(block.width, 1e-6);
  const heightAt = measure === "ink" && block.inkBox ? block.inkBox.y1 - block.inkBox.y0 : block.height;
  let size = Math.min(box.maxSize, (box.maxWidth / widthAt) * reference);
  if (box.maxHeight !== undefined) size = Math.min(size, (box.maxHeight / Math.max(heightAt, 1e-6)) * reference);
  return Math.max(box.minSize ?? 1, size);
}

/** Shift absolute path data (as produced by this module: M/L/Q/C/Z with absolute coordinates) by (dx, dy). */
export function translatePathD(d: string, dx: number, dy: number): string {
  if (!d || (dx === 0 && dy === 0)) return d;
  return d.replace(/([MLQCZ])([^MLQCZ]*)/g, (_, command: string, args: string) => {
    if (command === "Z") return "Z";
    const values = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    return command + values.map((value, index) => fmt(value + (index % 2 === 0 ? dx : dy), PATH_DECIMALS)).join(" ");
  });
}

// ---------------------------------------------------------------------------
// Vertical (tategaki)
// ---------------------------------------------------------------------------

const UPRIGHT_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
/** Blocks set upright besides those scripts: CJK radicals, CJK symbols and punctuation, kana, strokes, enclosed and
 * compatibility CJK, vertical forms, full-width forms. */
const UPRIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [[0x2E80, 0x2FDF], [0x3000, 0x303F], [0x3040, 0x30FF],
  [0x31C0, 0x31FF], [0x3200, 0x33FF], [0xFE30, 0xFE4F], [0xFF01, 0xFF60], [0xFFE0, 0xFFE6]];
function isUprightInVertical(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return UPRIGHT_SCRIPTS.test(character) || UPRIGHT_RANGES.some(([from, to]) => code >= from && code <= to);
}

export interface VerticalGlyph {
  readonly char: string;
  readonly codePoint: number;
  readonly index: number;
  /** Glyph actually drawn (the face's 'vert' alternate when it has one). */
  readonly glyphId: number;
  /** Outline in px; origin = the column axis (x = 0) at this cell's top. */
  readonly pathD: string;
  /** Cell top within the column. */
  readonly y: number;
  /** Cell height in px (tracking excluded). */
  readonly advance: number;
  /** Set sideways (rotated 90° clockwise): Latin, digits and symbols without a vertical form. */
  readonly rotated: boolean;
  readonly bbox: GlyphBox | null;
  readonly whitespace: boolean;
}

export interface VerticalLayout {
  readonly text: string;
  readonly size: number;
  readonly tracking: number;
  readonly glyphs: readonly VerticalGlyph[];
  /** Column height (sum of cells and tracking) and width (one em). */
  readonly height: number;
  readonly width: number;
  /** Union ink box; column coordinates: x centred on 0, y from 0 at the top. */
  readonly inkBox: GlyphBox | null;
  readonly pathD: string;
}

/**
 * Lay out a top-to-bottom column. CJK, kana and full-width forms stand upright
 * (using the face's 'vert' alternates for brackets, long vowel marks, ellipsis…);
 * Latin, digits and other symbols are set sideways, rotated 90° clockwise, unless
 * uprightLatin is set. Each cell is one em (upright) or the glyph advance (sideways).
 */
export function layoutVertical(text: string, options: LayoutOptions & { readonly uprightLatin?: boolean }): VerticalLayout {
  if (typeof text !== "string") throw new Error("layoutVertical needs a string");
  assertSize(options.size);
  const size = canonical(options.size);
  assertSize(size);
  const trackingInput = options.tracking ?? 0;
  if (!Number.isFinite(trackingInput) || Math.abs(trackingInput) > 4) throw new Error("tracking is in em and must be within -4..4");
  const tracking = canonical(trackingInput);
  const { faceId } = resolveMotionFace(options);
  const key = `V\u0000${faceId}\u0000${size}\u0000${tracking}\u0000${options.uprightLatin ? 1 : 0}\u0000${text}`;
  return cached(key, () => {
    const face = faceFor(faceId), scale = size / face.unitsPerEm;
    const emTop = face.typoAscender * scale, emBottom = -face.typoDescender * scale, emHeight = emTop + emBottom;
    const middle = (emBottom - emTop) / 2;
    const alternates = verticalAlternates(face);
    const glyphs: VerticalGlyph[] = [];
    let y = 0, inkBox: GlyphBox | null = null, pathD = "", textIndex = 0;
    for (const character of text) {
      const { record: base, whitespace } = recordForChar(face, character, textIndex);
      if (textIndex > 0) y += tracking * size;
      const alternate = base.index > 0 && !whitespace ? alternates.get(base.index) : undefined;
      const record = alternate !== undefined ? glyphRecordByIndex(face, alternate) : base;
      const upright = alternate !== undefined || Boolean(options.uprightLatin) || isUprightInVertical(character);
      const rotated = !upright && !whitespace;
      // A sideways blank (ASCII space) keeps its own advance; an ideographic space is a full em.
      const advancePx = upright ? emHeight : record.advance * scale;
      // Upright: centre the advance on the column axis, baseline at the em top. Sideways: rotate 90° CW about the em-box middle.
      const map = rotated
        ? (x: number, gy: number) => [middle - gy * scale, x * scale] as const
        : (x: number, gy: number) => [x * scale - (record.advance * scale) / 2, gy * scale + emTop] as const;
      const localPath = whitespace ? "" : commandsToPath(record.commands, map);
      let bbox: GlyphBox | null = null;
      if (!whitespace && record.ink) {
        const corners = [map(record.ink.x0, record.ink.y0), map(record.ink.x1, record.ink.y1)];
        bbox = { x0: Math.min(corners[0][0], corners[1][0]), y0: Math.min(corners[0][1], corners[1][1]),
          x1: Math.max(corners[0][0], corners[1][0]), y1: Math.max(corners[0][1], corners[1][1]) };
      }
      glyphs.push({ char: character, codePoint: character.codePointAt(0)!, index: textIndex, glyphId: record.index,
        pathD: localPath, y, advance: advancePx, rotated, bbox, whitespace });
      if (!whitespace) {
        pathD += commandsToPath(record.commands, (x, gy) => { const [px, py] = map(x, gy); return [px, py + y]; });
        inkBox = unionBox(inkBox, offsetBox(bbox, 0, y));
      }
      y += advancePx;
      textIndex += 1;
    }
    return deepFreeze({ text, size, tracking, glyphs, height: y, width: emHeight, inkBox, pathD });
  });
}

// ---------------------------------------------------------------------------
// Text on a path
// ---------------------------------------------------------------------------

/** A point on a path with its tangent direction in degrees (0 = +x, clockwise positive, SVG y-down). */
export interface PathSample { readonly x: number; readonly y: number; readonly angle: number }
/** Maps a distance along the path (px) to a point and tangent. */
export type PathSampler = (distance: number) => PathSample;

export interface PathGlyph {
  readonly char: string;
  readonly codePoint: number;
  readonly index: number;
  readonly glyphId: number;
  /** Outline in px, origin at the glyph's advance centre on the baseline (shifted by baselineShift). */
  readonly pathD: string;
  /** Distance of the glyph centre along the path. */
  readonly distance: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly advance: number;
  /** translate(x y) rotate(angle): place pathD on the path. */
  readonly transform: string;
  readonly whitespace: boolean;
}

export interface PathLayout {
  readonly glyphs: readonly PathGlyph[];
  /** Total advance of the text along the path. */
  readonly length: number;
}

/**
 * Set text along a sampled path. Glyph centres sit at startOffset + pen
 * position (align "center" centres the run on startOffset). baselineShift
 * moves glyphs perpendicular to the path (positive = down in glyph space).
 */
export function layoutOnPath(text: string, options: LayoutOptions & { readonly startOffset?: number; readonly baselineShift?: number;
  readonly align?: "start" | "center" }, sample: PathSampler): PathLayout {
  const line = layoutLine(text, options);
  const face = faceFor(line.faceId), scale = line.size / face.unitsPerEm;
  const start = (options.startOffset ?? 0) - (options.align === "center" ? line.width / 2 : 0);
  const shift = options.baselineShift ?? 0;
  const glyphs: PathGlyph[] = [];
  for (const glyph of line.glyphs) {
    const distance = start + glyph.x + glyph.advance / 2;
    const point = sample(distance);
    if (![point.x, point.y, point.angle].every(Number.isFinite)) throw new Error("Path sampler returned a non-finite point");
    const record = glyph.whitespace ? null : glyphRecordByIndex(face, glyph.glyphId);
    glyphs.push({ char: glyph.char, codePoint: glyph.codePoint, index: glyph.index, glyphId: glyph.glyphId,
      pathD: record ? scaledPath(record.commands, scale, -glyph.advance / 2, shift) : "",
      distance, x: point.x, y: point.y, angle: point.angle, advance: glyph.advance,
      transform: `translate(${fmt(point.x)} ${fmt(point.y)}) rotate(${fmt(point.angle)})`, whitespace: glyph.whitespace });
  }
  return deepFreeze({ glyphs, length: line.width });
}

/** Circle sampler: distance 0 at startDegrees (0 = right, -90 = top), clockwise by default (glyph tops face outward). */
export function circleSampler(cx: number, cy: number, radius: number, startDegrees = -90, clockwise = true): PathSampler {
  if (!(radius > 0)) throw new Error("circleSampler needs a positive radius");
  const direction = clockwise ? 1 : -1;
  return distance => {
    const theta = (startDegrees * Math.PI) / 180 + direction * (distance / radius);
    return { x: cx + radius * Math.cos(theta), y: cy + radius * Math.sin(theta), angle: (theta * 180) / Math.PI + direction * 90 };
  };
}

/** Arc-length sampler over a polyline; distances beyond the ends extend along the end segments. */
export function polylineSampler(points: ReadonlyArray<readonly [number, number]>, closed = false): PathSampler & { readonly totalLength: number } {
  if (points.length < 2) throw new Error("polylineSampler needs at least two points");
  const vertices = closed ? [...points, points[0]] : [...points];
  const cumulative = [0];
  for (let index = 1; index < vertices.length; index += 1) {
    cumulative.push(cumulative[index - 1] + Math.hypot(vertices[index][0] - vertices[index - 1][0], vertices[index][1] - vertices[index - 1][1]));
  }
  const length = cumulative[cumulative.length - 1];
  if (!(length > 0)) throw new Error("polylineSampler needs a path with positive length");
  const sampler = (distance: number): PathSample => {
    let d = distance;
    if (closed) d = ((d % length) + length) % length;
    let segment = 1;
    if (d >= length) segment = vertices.length - 1;
    else if (d > 0) {
      let low = 1, high = vertices.length - 1;
      while (low < high) { const mid = (low + high) >> 1; if (cumulative[mid] < d) low = mid + 1; else high = mid; }
      segment = low;
    }
    // Skip zero-length segments for the tangent.
    while (segment > 1 && cumulative[segment] - cumulative[segment - 1] <= 0) segment -= 1;
    const [x0, y0] = vertices[segment - 1], [x1, y1] = vertices[segment];
    const segmentLength = Math.max(1e-9, cumulative[segment] - cumulative[segment - 1]);
    const t = (d - cumulative[segment - 1]) / segmentLength;
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, angle: (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI };
  };
  return Object.assign(sampler, { totalLength: length });
}

/** Arc-length sampler for a parametric curve fn(u), u in 0..1, approximated by `steps` chords. */
export function curveSampler(fn: (u: number) => { x: number; y: number }, steps = 256): PathSampler & { readonly totalLength: number } {
  if (!Number.isInteger(steps) || steps < 2 || steps > 100_000) throw new Error("curveSampler steps must be an integer in 2..100000");
  const points: Array<[number, number]> = [];
  for (let index = 0; index <= steps; index += 1) { const point = fn(index / steps); points.push([point.x, point.y]); }
  return polylineSampler(points);
}

/** For tests and diagnostics: drop cached layouts (faces stay loaded). */
export function clearMotionLibraryLayoutCache(): void {
  layoutCache.clear();
}
