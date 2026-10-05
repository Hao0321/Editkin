import type { EditProject, MotionGraphic, MotionGraphicV2Easing, MotionGraphicV2Motion, MotionGraphicV2Phase, MotionVectorShapeCommand } from "../domain/types";
import { motionGraphicV2UnitCount } from "../domain/motionCompositionV2Contract";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import {
  buildOriginalElement, graphemes, validateOriginalElement, type ElementIr, type ElementMeasure, type ElementShape, type OriginalElementConfig,
} from "../creative/originalElements";
import { canonicalJson } from "../shared/canonicalJson";
import { resolveBundledFontFace } from "../typography/fontFaces";
import type { PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { createMotionGraphic } from "./composition";
import { motionGraphicV2PhysicalLayoutReceipt, type MotionGraphicV2LayoutReceipt } from "./compositionV2";
import { MOTION_CURVES, MOTION_ENERGY_PROFILES, kineticTextMotion, type KineticTextStyle, type MotionEnergy } from "./motionLanguage";

/**
 * Native adapter for Editkin Original Elements (Collection 01): every authored
 * shape becomes an editable flat `shape` vector and every text line a physical
 * glyph text layer. Instead of the research preview's single 0.24s group move,
 * the layers build in staged beats (see `stage`): decorative parts such as grid
 * lines, perforations, sparks and bracket corners are kept as separate layers so
 * they can arrive one by one. Exits stay whole: the entire element leaves
 * together, as the design asks.
 */
export const ORIGINAL_ELEMENT_GRAPHICS_VERSION = "hao.original-element-graphics/v1" as const;

type Point = { x: number; y: number };
type Command = MotionVectorShapeCommand;
const K = .5522847498;
// `|| 0` folds -0 (e.g. a zero sweep negated) into 0, which is what JSON saves.
const round = (value: number) => Math.round(value * 100) / 100 || 0;

// ---------------------------------------------------------------- geometry
function polygon(points: Point[]): Command[] {
  if (points.length < 3) return [];
  // Non-zero fills union only when every contour shares one orientation.
  const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
  const ordered = area < 0 ? [...points].reverse() : points;
  return [{ type: "M", x: ordered[0].x, y: ordered[0].y }, ...ordered.slice(1).map((p): Command => ({ type: "L", x: p.x, y: p.y })), { type: "Z" }];
}
function circleCommands(cx: number, cy: number, r: number, reverse = false): Command[] {
  const ry = reverse ? -r : r;
  return [{ type: "M", x: cx + r, y: cy },
    { type: "C", x1: cx + r, y1: cy + ry * K, x2: cx + r * K, y2: cy + ry, x: cx, y: cy + ry },
    { type: "C", x1: cx - r * K, y1: cy + ry, x2: cx - r, y2: cy + ry * K, x: cx - r, y: cy },
    { type: "C", x1: cx - r, y1: cy - ry * K, x2: cx - r * K, y2: cy - ry, x: cx, y: cy - ry },
    { type: "C", x1: cx + r * K, y1: cy - ry, x2: cx + r, y2: cy - ry * K, x: cx + r, y: cy }, { type: "Z" }];
}
function roundedRect(x: number, y: number, w: number, h: number, radius: number, reverse = false): Command[] {
  if (w <= 0 || h <= 0) return [];
  const r = Math.max(0, Math.min(radius, w / 2, h / 2)), k = r * K;
  const forward: Command[] = [{ type: "M", x: x + r, y }, { type: "L", x: x + w - r, y },
    { type: "C", x1: x + w - r + k, y1: y, x2: x + w, y2: y + r - k, x: x + w, y: y + r }, { type: "L", x: x + w, y: y + h - r },
    { type: "C", x1: x + w, y1: y + h - r + k, x2: x + w - r + k, y2: y + h, x: x + w - r, y: y + h }, { type: "L", x: x + r, y: y + h },
    { type: "C", x1: x + r - k, y1: y + h, x2: x, y2: y + h - r + k, x, y: y + h - r }, { type: "L", x, y: y + r },
    { type: "C", x1: x, y1: y + r - k, x2: x + r - k, y2: y, x: x + r, y }, { type: "Z" }];
  if (!reverse) return forward;
  // Reverse orientation: walk the same contour backwards to punch a hole.
  const points = forward.slice(0, -1);
  const out: Command[] = [{ type: "M", x: x + r, y }];
  for (let index = points.length - 1; index >= 1; index--) {
    const command = points[index], previous = points[index - 1] as Exclude<Command, { type: "Z" }>;
    if (command.type === "C") out.push({ type: "C", x1: command.x2, y1: command.y2, x2: command.x1, y2: command.y1, x: previous.x, y: previous.y });
    else out.push({ type: "L", x: previous.x, y: previous.y });
  }
  return [...out, { type: "Z" }];
}
/** Round-capped stroke of one segment as a closed capsule. */
function capsule(a: Point, b: Point, width: number): Command[] {
  const half = width / 2, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (length < 1e-6) return circleCommands(a.x, a.y, half);
  const ux = dx / length, uy = dy / length, nx = -uy * half, ny = ux * half, cx = ux * half * K, cy = uy * half * K;
  const p1 = { x: a.x + nx, y: a.y + ny }, p2 = { x: b.x + nx, y: b.y + ny }, p3 = { x: b.x - nx, y: b.y - ny }, p4 = { x: a.x - nx, y: a.y - ny };
  const tipB = { x: b.x + ux * half, y: b.y + uy * half }, tipA = { x: a.x - ux * half, y: a.y - uy * half };
  const contour: Command[] = [{ type: "M", x: p1.x, y: p1.y }, { type: "L", x: p2.x, y: p2.y },
    { type: "C", x1: p2.x + cx, y1: p2.y + cy, x2: tipB.x + nx * K, y2: tipB.y + ny * K, x: tipB.x, y: tipB.y },
    { type: "C", x1: tipB.x - nx * K, y1: tipB.y - ny * K, x2: p3.x + cx, y2: p3.y + cy, x: p3.x, y: p3.y },
    { type: "L", x: p4.x, y: p4.y },
    { type: "C", x1: p4.x - cx, y1: p4.y - cy, x2: tipA.x - nx * K, y2: tipA.y - ny * K, x: tipA.x, y: tipA.y },
    { type: "C", x1: tipA.x + nx * K, y1: tipA.y + ny * K, x2: p1.x - cx, y2: p1.y - cy, x: p1.x, y: p1.y }, { type: "Z" }];
  // Keep the same orientation as polygon()/roundedRect() so strokes union.
  const signed = (p2.x - p1.x) * (p4.y - p1.y) - (p2.y - p1.y) * (p4.x - p1.x);
  return signed < 0 ? reverseCapsule(contour) : contour;
}
function reverseCapsule(contour: Command[]): Command[] {
  const points = contour.slice(0, -1);
  const start = points[0] as { x: number; y: number };
  const out: Command[] = [{ type: "M", x: start.x, y: start.y }];
  for (let index = points.length - 1; index >= 1; index--) {
    const command = points[index], previous = points[index - 1] as Exclude<Command, { type: "Z" }>;
    if (command.type === "C") out.push({ type: "C", x1: command.x2, y1: command.y2, x2: command.x1, y2: command.y1, x: previous.x, y: previous.y });
    else out.push({ type: "L", x: previous.x, y: previous.y });
  }
  return [...out, { type: "Z" }];
}
/** The source paths use only M/L/H/V/Z; each subpath becomes a point list. */
function parsePath(d: string): Array<{ points: Point[]; closed: boolean }> {
  const tokens = d.match(/[MLHVZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const subpaths: Array<{ points: Point[]; closed: boolean }> = [];
  let current: { points: Point[]; closed: boolean } | undefined, op = "", at: Point = { x: 0, y: 0 };
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (/^[MLHVZ]$/i.test(token)) { op = token.toUpperCase(); index++; if (op === "Z" && current) current.closed = true; continue; }
    const value = () => Number(tokens[index++]);
    if (op === "M") { at = { x: value(), y: value() }; current = { points: [at], closed: false }; subpaths.push(current); op = "L"; }
    else if (op === "L") { at = { x: value(), y: value() }; current!.points.push(at); }
    else if (op === "H") { at = { x: value(), y: at.y }; current!.points.push(at); }
    else if (op === "V") { at = { x: at.x, y: value() }; current!.points.push(at); }
    else throw new Error(`原創元素路徑含不支援的指令：${op}`);
  }
  return subpaths;
}

type Paint = { color: string; commands: Command[] };

/** Fill contours, then stroke contours, exactly as SVG paints one element. Each
 * entry is one primitive; `split` keeps every subpath of a path apart. */
function shapePaint(shape: ElementShape, split = false): Paint[][] {
  const a = shape.attrs, out: Paint[] = [];
  const fill = String(a.fill ?? "none"), stroke = String(a.stroke ?? "none"), sw = Number(a["stroke-width"] ?? 0);
  const keep = (paints: Paint[]) => paints.filter(item => item.commands.length);
  if (shape.type === "path") {
    const subpaths = parsePath(String(a.d));
    const strokeOf = (path: { points: Point[]; closed: boolean }) => {
      const points = path.closed ? [...path.points, path.points[0]] : path.points;
      return points.slice(1).flatMap((point, index) => capsule(points[index], point, sw));
    };
    return (split ? subpaths.map(path => [path]) : [subpaths]).map(paths => keep([
      ...(fill !== "none" ? [{ color: fill, commands: paths.flatMap(path => polygon(path.points)) }] : []),
      ...(stroke !== "none" && sw > 0 ? [{ color: stroke, commands: paths.flatMap(strokeOf) }] : []),
    ])).filter(paints => paints.length);
  }
  if (shape.type === "rect") {
    const x = Number(a.x), y = Number(a.y), w = Number(a.width), h = Number(a.height), r = Number(a.rx ?? 0);
    if (fill !== "none") out.push({ color: fill, commands: roundedRect(x, y, w, h, r) });
    if (stroke !== "none" && sw > 0) out.push({ color: stroke, commands: [...roundedRect(x - sw / 2, y - sw / 2, w + sw, h + sw, r + sw / 2), ...roundedRect(x + sw / 2, y + sw / 2, w - sw, h - sw, Math.max(0, r - sw / 2), true)] });
  } else if (shape.type === "circle") {
    const cx = Number(a.cx), cy = Number(a.cy), r = Number(a.r);
    if (fill !== "none") out.push({ color: fill, commands: circleCommands(cx, cy, r) });
    // A stroked circle is a ring: outer contour plus a reversed inner one.
    if (stroke !== "none" && sw > 0) out.push({ color: stroke, commands: [...circleCommands(cx, cy, r + sw / 2), ...circleCommands(cx, cy, Math.max(0, r - sw / 2), true)] });
  } else if (shape.type === "line") {
    out.push({ color: stroke, commands: capsule({ x: Number(a.x1), y: Number(a.y1) }, { x: Number(a.x2), y: Number(a.y2) }, sw) });
  }
  return [keep(out)].filter(paints => paints.length);
}

// ---------------------------------------------------------------- measure
type FaceMetrics = { unitsPerEm: number; glyphs: Map<string, { advance: number; ink: { xMin: number; yMin: number; xMax: number; yMax: number } | null }>; kerning: Map<string, number> };

/** Text runs the generator will measure or draw, with the face it uses. */
export function originalElementTextRequests(config: OriginalElementConfig): Array<{ text: string; family: string; weight: number }> {
  const tagFont = (value: string) => /[^\x20-\x7E’]/.test(value) ? { family: "Noto Sans TC", weight: 700 } : { family: "Bebas Neue", weight: 400 };
  const requests = [{ text: config.title, family: "Noto Sans TC", weight: 900 }];
  if (config.detail) requests.push({ text: config.detail, family: "Noto Sans TC", weight: 700 });
  if (config.tag) requests.push({ text: config.tag, ...tagFont(config.tag) });
  if (config.id === "chapter-ticket") requests.push({ text: config.number, family: "Bebas Neue", weight: 400 });
  if (config.id === "step-path" || config.id === "recap-strip") {
    for (const step of config.detail.split("／")) requests.push({ text: step, family: "Noto Sans TC", weight: 900 });
    if (config.id === "step-path") requests.push({ text: "010203", family: "Bebas Neue", weight: 400 });
  }
  return requests.filter(request => request.text.length > 0);
}

/** Synchronous measure built from prepared physical runs (per-glyph advance, kerning, ink). */
export function createRunMeasure(runs: ReadonlyMap<string, PreparedGlyphRun>): ElementMeasure {
  const faces = new Map<string, FaceMetrics>();
  for (const run of runs.values()) {
    const face = faces.get(run.faceId) ?? { unitsPerEm: run.unitsPerEm, glyphs: new Map(), kerning: new Map() };
    run.glyphs.forEach((glyph, index) => {
      face.glyphs.set(glyph.text, { advance: glyph.advanceEm, ink: glyph.inkEm });
      const next = run.glyphs[index + 1];
      if (next) face.kerning.set(glyph.text + "\u0000" + next.text, glyph.kerningAfterEm);
    });
    faces.set(run.faceId, face);
  }
  const metrics = (family: string, weight: number) => {
    const spec = resolveBundledFontFace(family, weight);
    const face = spec && faces.get(spec.faceId);
    if (!face) throw new Error(`FONT_BYTES_REQUIRED: ${family} ${weight}`);
    return face;
  };
  const layout = (text: string, size: number, family: string, weight: number) => {
    const face = metrics(family, weight), chars = graphemes(text);
    let pen = 0, left = 0, right = 0, ascent = 0, descent = 0, first = true;
    chars.forEach((ch, index) => {
      const glyph = face.glyphs.get(ch);
      if (!glyph) throw new Error(`Missing prepared glyph metrics: ${ch}`);
      if (glyph.ink) {
        if (first) { left = -glyph.ink.xMin * size; first = false; }
        right = Math.max(right, pen + glyph.ink.xMax * size);
        ascent = Math.max(ascent, -glyph.ink.yMin * size); descent = Math.max(descent, glyph.ink.yMax * size);
      }
      pen += glyph.advance * size + (index < chars.length - 1 ? (face.kerning.get(ch + "\u0000" + chars[index + 1]) ?? 0) * size : 0);
    });
    return { width: pen, left, right, ascent, descent };
  };
  const measure = ((text: string, size: number, family: string, weight: number) => layout(text, size, family, weight).width) as ElementMeasure;
  measure.bounds = (text, size, family, weight) => { const value = layout(text, size, family, weight); return { left: value.left, right: value.right, ascent: value.ascent, descent: value.descent }; };
  return measure;
}

// ---------------------------------------------------------------- adapter
export interface OriginalElementTiming { startFrame: number; durationFrames: number; energy?: MotionEnergy }
/** One editable layer and the authored part it came from; `index` orders a part's primitives or lines. */
type Layer = { role: string; group: string; kind: "shape" | "text"; index: number; shape: ElementShape; graphic: MotionGraphic };
type RevealFrom = "left" | "right" | "top" | "bottom";
/**
 * A layer's beat: start (seconds at standard energy), entrance, and an optional
 * wipe reveal. `once` marks a one-shot effect that plays its own in/out and is
 * gone before the element exits (`until` stretches it to a later beat);
 * `drift` turns the entrance into a slow linear float across the whole hold.
 */
interface Cue { at: number; motion: MotionGraphicV2Motion; reveal?: { frames: number; from: RevealFrom }; once?: true; until?: number; drift?: { dx: number; dy: number } }

/** Decorative parts whose primitives each become their own layer, so they can arrive one by one. */
const SPLIT_ROLES = new Set(["grid", "stitch", "spark", "dot", "corner", "corner-under", "connector",
  "fx-typing", "fx-ring", "fx-packet", "fx-streak", "sparkle", "tick", "tick-under", "rail-fill"]);
const FULL = { top: 0, right: 0, bottom: 0, left: 0 };
const LINEAR = { type: "linear" } as const, EASE_IN = { type: "ease_in" } as const, EASE_OUT = { type: "ease_out" } as const;
/** One-shot effect layers carry this marker in their id (`…:fx:fx-shine`). */
export const isOriginalElementEffect = (graphic: Pick<MotionGraphic, "id">) => graphic.id.includes(":fx-");

export async function prepareOriginalElementGraphics(project: EditProject, config: OriginalElementConfig, timing: OriginalElementTiming,
  prepareText: (faceId: string, text: string) => Promise<PreparedGlyphRun>, options: { finish?: boolean } = {}): Promise<MotionGraphic[]> {
  const runs = new Map<string, PreparedGlyphRun>();
  const prepare = async (text: string, family: string, weight: number) => {
    const face = resolveBundledFontFace(family, weight);
    if (!face) throw new Error(`FONT_BYTES_REQUIRED: ${family} ${weight}`);
    const key = canonicalJson([face.faceId, text]);
    if (!runs.has(key)) runs.set(key, await prepareText(face.faceId, text));
  };
  const owned: OriginalElementConfig = { ...structuredClone(config), aspect: project.height > project.width ? "portrait" : "landscape", duration: timing.durationFrames / project.fps };
  for (const request of originalElementTextRequests(owned)) await prepare(request.text, request.family, request.weight);
  // The studio finish is the default look; `finish: false` reproduces the authored source only.
  const ir = buildOriginalElement(owned, createRunMeasure(runs), { finish: options.finish ?? true });
  // Exact text layers need a run for every drawn line (lines are substrings).
  for (const shape of ir.shapes.filter(item => item.type === "text")) await prepare(String(shape.attrs["data-content"]), String(shape.attrs["font-family"]), Number(shape.attrs["font-weight"]));
  return compileOriginalElementGraphics(project, ir, timing, graphic => {
    const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
    const run = face && runs.get(canonicalJson([face.faceId, graphic.text]));
    if (!run) throw new Error(`原創元素缺少實體字形：${graphic.text}`);
    return motionGraphicV2PhysicalLayoutReceipt(project, graphic, run);
  });
}

export function compileOriginalElementGraphics(project: EditProject, ir: ElementIr, timing: OriginalElementTiming,
  layoutForGraphic: (graphic: MotionGraphic) => MotionGraphicV2LayoutReceipt): MotionGraphic[] {
  const { fps, width: W, height: H } = project;
  // Design space → project. Overlay mode carries the authored group transform
  // (smaller, placed clear of the subject), folded into one scale and offset.
  const fit = Math.min(W / ir.width, H / ir.height);
  const group = /^translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)$/.exec(ir.sceneTransform);
  if (ir.sceneTransform && !group) throw new Error(`原創元素不支援的群組變換：${ir.sceneTransform}`);
  const [tx, ty, s] = group ? group.slice(1).map(Number) : [0, 0, 1];
  const scale = fit * s, offsetX = (W - ir.width * fit) / 2 + tx * fit, offsetY = (H - ir.height * fit) / 2 + ty * fit;
  const toProject = (command: Command): Command => command.type === "Z" ? command : command.type === "C"
    ? { type: "C", x1: offsetX + command.x1 * scale, y1: offsetY + command.y1 * scale, x2: offsetX + command.x2 * scale, y2: offsetY + command.y2 * scale, x: offsetX + command.x * scale, y: offsetY + command.y * scale }
    : { type: command.type, x: offsetX + command.x * scale, y: offsetY + command.y * scale };
  const id = `oe-${ir.config.id}-${timing.startFrame}`;
  const layers: Layer[] = [];
  let serial = 0;

  function shapeGraphic(name: string, color: string, commands: Command[]): MotionGraphic {
    const projected = commands.map(toProject), points = projected.flatMap(c => c.type === "Z" ? [] : c.type === "C" ? [[c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]] : [[c.x, c.y]]);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    // Pad tiny shapes (perforations, dots) to the vector slot minimum.
    const pad = Math.max(0, (24 - (Math.max(...xs) - Math.min(...xs))) / 2), padY = Math.max(0, (24 - (Math.max(...ys) - Math.min(...ys))) / 2);
    const x0 = Math.max(0, Math.min(...xs) - pad), y0 = Math.max(0, Math.min(...ys) - padY);
    const x1 = Math.min(W, Math.max(...xs) + pad), y1 = Math.min(H, Math.max(...ys) + padY);
    const local = projected.map((c): Command => c.type === "Z" ? c : c.type === "C"
      ? { type: "C", x1: round(c.x1 - x0), y1: round(c.y1 - y0), x2: round(c.x2 - x0), y2: round(c.y2 - y0), x: round(c.x - x0), y: round(c.y - y0) }
      : { type: c.type, x: round(c.x - x0), y: round(c.y - y0) });
    const seed = structuredClone(findMotionGraphicPreset("reel_native_panel").seed);
    const graphic = { ...createMotionGraphic(`${id}:${serial++}:${name}`, "card", "", timing.startFrame / fps, timing.durationFrames / fps, undefined, seed),
      x: x0 / W, y: y0 / H, width: (x1 - x0) / W, backgroundColor: color, accentColor: color, outlineWidth: 0, cornerRadius: 0,
      vectorV2: { schema: "editkin.motion-vector-shape/v1" as const, kind: "shape" as const, heightPixels: round(y1 - y0), revealFrames: 1 as const, commands: local },
      layoutV2: { safeArea: FULL, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" as const } };
    delete (graphic as Partial<MotionGraphic>).presetId;
    return graphic;
  }
  function textGraphic(name: string, shape: ElementShape): MotionGraphic {
    const a = shape.attrs, size = Number(a["font-size"]) * scale, content = String(a["data-content"]);
    const baselineX = offsetX + Number(a.x) * scale, baselineY = offsetY + Number(a.y) * scale;
    const seed = structuredClone(findMotionGraphicPreset("kinetic_rise").seed);
    const graphic: MotionGraphic = { ...createMotionGraphic(`${id}:${serial++}:${name}`, "title", content, timing.startFrame / fps, timing.durationFrames / fps, undefined, seed),
      x: baselineX / W, y: (baselineY - size) / H, width: Math.min(1 - baselineX / W, (graphemes(content).length * size * 1.3 + size * 2) / W),
      fontSize: size, fontFamily: String(a["font-family"]), fontWeight: Number(a["font-weight"]), letterSpacing: 0, textColor: String(a.fill),
      backgroundColor: "#00000000", accentColor: "#00000000", outlineWidth: 0, shadowDepth: 0, cornerRadius: 0,
      layoutV2: { safeArea: FULL, maxLines: 1, minFontSize: Math.max(8, Math.floor(size)), lineGap: 0, align: "left", widthMode: "fit_content" } };
    delete (graphic as Partial<MotionGraphic>).presetId;
    // Place the true pen origin and baseline exactly where the design draws them.
    const segment = layoutForGraphic(graphic).segments[0];
    if (!segment) throw new Error(`原創元素文字沒有可量測的字形：${content}`);
    graphic.x += (baselineX - segment.x) / W;
    graphic.y += (baselineY - (segment.y + (segment.baselinePixels ?? size))) / H;
    // A slot that crosses the frame edge would be clamped back and break the alignment.
    graphic.width = Math.min(graphic.width, 1 - graphic.x);
    return graphic;
  }

  // Paint order is preserved. Consecutive same-colour paint of one part merges
  // into one layer; split parts keep every primitive (grid line, stitch, corner…)
  // apart so each can take its own beat.
  const ordinals = new Map<string, number>();
  const ordinal = (key: string) => { const value = ordinals.get(key) ?? 0; ordinals.set(key, value + 1); return value; };
  const nameOf = (shape: ElementShape) => shape.role === shape.group ? shape.group : `${shape.group}:${shape.role}`;
  let pending: { shape: ElementShape; index: number; color: string; commands: Command[] } | undefined;
  const flush = () => {
    if (pending) layers.push({ role: pending.shape.role, group: pending.shape.group, kind: "shape", index: pending.index, shape: pending.shape,
      graphic: shapeGraphic(nameOf(pending.shape), pending.color, pending.commands) });
    pending = undefined;
  };
  for (const shape of ir.shapes) {
    if (shape.type === "text") {
      flush();
      layers.push({ role: shape.role, group: shape.group, kind: "text", index: ordinal(`text|${shape.role}|${shape.group}`), shape, graphic: textGraphic(nameOf(shape), shape) });
      continue;
    }
    const split = SPLIT_ROLES.has(shape.role);
    for (const paints of shapePaint(shape, split)) {
      const index = split ? ordinal(`shape|${shape.role}|${shape.group}`) : 0;
      for (const paint of paints) {
        if (!split && pending && pending.shape.role === shape.role && pending.shape.group === shape.group && pending.color === paint.color) pending.commands.push(...paint.commands);
        else { flush(); pending = { shape, index, color: paint.color, commands: [...paint.commands] }; }
      }
      if (split) flush();
    }
  }
  flush();
  return stage(layers, ir, timing, fps, Math.min(W, H) / 1080, scale);
}

// ---------------------------------------------------------------- choreography
/**
 * Builds the element in beats instead of landing every layer at once: the
 * ground (paper, then grid lines drawn one by one), the container (plates wipe
 * or land, hard shadows slide out from behind them), the headline line by line,
 * tag and supporting copy, then accents (sparks twinkle, perforations and dots
 * pop in sequence, connectors draw between steps). The studio finish adds
 * accent leads that run ahead of plate wipes, glints across finished plates,
 * bursts, rings and flashes on impacts, typing dots, a progress rail with a
 * riding packet, and a scene grid that floats through the hold. Beat times are
 * seconds at standard energy; energy rescales them, and a short slot compresses
 * the build so the finished layout still holds for ≥0.9s. Lasting layers exit
 * together; one-shot `fx-*` effects finish before that exit.
 */
function stage(layers: Layer[], ir: ElementIr, timing: OriginalElementTiming, fps: number, unit: number, scale: number): MotionGraphic[] {
  const energy = timing.energy ?? "standard", profile = MOTION_ENERGY_PROFILES[energy];
  const support: MotionEnergy = profile.tier >= 2 ? "standard" : "calm";
  const frames = (seconds: number) => Math.max(1, Math.round(seconds * profile.time * fps));
  const travel = (pixels: number) => round(pixels * unit * profile.amplitude);
  const exit: MotionGraphicV2Phase = { durationFrames: frames(.25), offsetXPixels: 0, offsetYPixels: round(-12 * unit), scale: 1, opacity: 0, easing: MOTION_CURVES.snapIn };
  const whole = (seconds: number, easing: MotionGraphicV2Easing, pose: { dx?: number; dy?: number; scale?: number; opacity?: number } = {}): MotionGraphicV2Motion => ({
    sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, exitStaggerFrames: 0, scaleOrigin: "center" },
    entrance: { durationFrames: frames(seconds), offsetXPixels: pose.dx ?? 0, offsetYPixels: pose.dy ?? 0,
      scale: round(Math.max(.05, 1 + ((pose.scale ?? 1) - 1) * profile.scaleDepth)), opacity: pose.opacity ?? 0, easing },
    exit,
  });
  const cue = {
    /** Grounds: a plain soft fade. */
    fade: (at: number, seconds = .2): Cue => ({ at, motion: whole(seconds, MOTION_CURVES.quintOut) }),
    /** Draw a shape on from one edge; optional travel rides along with the wipe. */
    wipe: (at: number, from: RevealFrom, seconds = .4, dx = 0, dy = 0): Cue => ({ at, reveal: { frames: Math.max(2, frames(seconds)), from },
      motion: whole(seconds, MOTION_CURVES.expoOut, { dx: travel(dx), dy: travel(dy), opacity: 1 }) }),
    /** Whole-shape landing for plates, nodes and bracket corners. */
    land: (at: number, pose: { dx?: number; dy?: number; scale?: number }, seconds = .5, easing: MotionGraphicV2Easing = MOTION_CURVES.springLand): Cue =>
      ({ at, motion: whole(seconds, easing, { dx: travel(pose.dx ?? 0), dy: travel(pose.dy ?? 0), scale: pose.scale }) }),
    /** Small accents spring up from a point. */
    pop: (at: number, from = .15, seconds = .42): Cue => ({ at, motion: whole(seconds, MOTION_CURVES.springPop, { scale: from }) }),
    /** A hard shadow starts exactly behind its settled plate and slides out to its authored offset,
     * fully opaque: fading it in reads as a grey ghost for a frame or two. */
    shadow: (at: number, offsetX: number, offsetY: number, seconds = .34): Cue =>
      ({ at, motion: whole(seconds, MOTION_CURVES.expoOut, { dx: round(-offsetX * scale), dy: round(-offsetY * scale), opacity: 1 }) }),
    /** Kinetic copy; `travel` trims the entrance distance for text that must stay inside its plate. */
    text: (at: number, style: KineticTextStyle, text: string, options: { energy?: MotionEnergy; travel?: number; keepHold?: boolean } = {}): Cue => {
      const motion = kineticTextMotion(style, { fps, unit, energy: options.energy ?? energy, text });
      const k = options.travel ?? 1, { holdScale, ...sequence } = motion.sequence;
      const entrance: MotionGraphicV2Phase = { ...motion.entrance, offsetXPixels: round(motion.entrance.offsetXPixels * k), offsetYPixels: round(motion.entrance.offsetYPixels * k) };
      if (entrance.spreadPixels !== undefined) entrance.spreadPixels = round(entrance.spreadPixels * k);
      // A settled layout holds still; only a free-standing numeral keeps its slow push.
      return { at, motion: { ...motion, sequence: options.keepHold && holdScale !== undefined ? { ...sequence, holdScale } : sequence, entrance } };
    },
    /** A tiny accent that keeps breathing (slow 12% push) through the hold. */
    twinkle: (at: number): Cue => { const popped = cue.pop(at, .1, .42); return { ...popped, motion: { ...popped.motion, sequence: { ...popped.motion.sequence, holdScale: 1.12 } } }; },
    // ---- one-shot effects: their own in and out, finished before the element exits
    burst: (at: number) => once(at, phase(.14, MOTION_CURVES.expoOut, { scale: .5 }), phase(.26, MOTION_CURVES.quintOut, { scale: 1.28, opacity: 0 })),
    ring: (at: number) => once(at, phase(.18, MOTION_CURVES.expoOut, { scale: .3 }), phase(.32, MOTION_CURVES.quintOut, { scale: 1.5, opacity: 0 })),
    /** Full-strength on the impact frame, then gone. */
    flash: (at: number) => once(at, { ...phase(0, LINEAR, { opacity: 1 }), durationFrames: 1 }, phase(.22, MOTION_CURVES.quintOut, { opacity: 0 })),
    /** A lock-on pulse: the landed shape echoes outward and fades. */
    echo: (at: number) => once(at, { ...phase(0, LINEAR, { opacity: 1 }), durationFrames: 1 }, phase(.34, MOTION_CURVES.quintOut, { scale: 1.14, opacity: 0 })),
    /** A glint crosses its plate: it rests mid-sweep, eases in from one side and out the other, brightest in the middle. */
    sweepX: (at: number, distance: number, seconds: number) => once(at, phase(seconds / 2, EASE_IN, { dx: round(-distance / 2) }), phase(seconds / 2, EASE_OUT, { dx: round(distance / 2), opacity: 0 })),
    /** A scan line passes over a target at an even, mechanical pace. */
    sweepY: (at: number, distance: number, seconds: number) => once(at, phase(seconds / 2, LINEAR, { dy: round(-distance / 2) }), phase(seconds / 2, LINEAR, { dy: round(distance / 2), opacity: 0 })),
    /** A packet rides a drawing line to its end, then pings. */
    packet: (at: number, dx: number, dy: number, seconds: number) => once(at, phase(seconds, MOTION_CURVES.quintOut, { dx: round(-dx), dy: round(-dy), opacity: 1 }), phase(.14, MOTION_CURVES.quintOut, { scale: 2.2, opacity: 0 })),
    /** A speed line shoots in alongside a wipe and keeps going as it fades. */
    streak: (at: number) => once(at, phase(.16, MOTION_CURVES.expoOut, { dx: travel(-90) }), phase(.2, EASE_IN, { dx: travel(70), opacity: 0 })),
    /** Typing dots bounce in and hold until the copy they stand in for arrives. */
    typing: (at: number, until: number): Cue => ({ ...once(at, phase(.22, MOTION_CURVES.springPop, { scale: .2 }), phase(.1, MOTION_CURVES.snapIn, { scale: .6, opacity: 0 })), until }),
  };
  function phase(seconds: number, easing: MotionGraphicV2Easing, pose: { dx?: number; dy?: number; scale?: number; opacity?: number } = {}): MotionGraphicV2Phase {
    return { durationFrames: frames(seconds), offsetXPixels: pose.dx ?? 0, offsetYPixels: pose.dy ?? 0, scale: pose.scale ?? 1, opacity: pose.opacity ?? 0, easing };
  }
  function once(at: number, entrance: MotionGraphicV2Phase, out: MotionGraphicV2Phase): Cue {
    return { at, once: true, motion: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, exitStaggerFrames: 0, scaleOrigin: "center" }, entrance, exit: out } };
  }

  const portrait = ir.height > ir.width;
  const line = (layer: Layer) => layer.index * .08;
  const slot = (layer: Layer) => Number(/^(?:step|row):(\d+)$/.exec(layer.group)?.[1] ?? layer.index);
  const vertical = (layer: Layer) => layer.shape.type === "line" && Number(layer.shape.attrs.x1) === Number(layer.shape.attrs.x2);
  const tagAt = (layer: Layer, at: number) => layer.kind === "shape" ? cue.wipe(at - .04, "left", .28) : cue.text(at, "swipe", layer.graphic.text, { energy: support });
  const detailAt = (layer: Layer, at: number) => layer.kind === "shape" ? cue.wipe(at - .06, "left", .32)
    : cue.text(at + line(layer), "focus", layer.graphic.text, { energy: support });

  /** Travel of a sweeping effect, authored in design pixels on the shape. */
  const sweep = (layer: Layer) => ({ x: Number(layer.shape.attrs["data-sweep-x"] ?? 0) * scale, y: Number(layer.shape.attrs["data-sweep-y"] ?? 0) * scale });

  function beat(layer: Layer): Cue | undefined {
    const text = layer.graphic.text, s = sweep(layer);
    if (layer.role === "paper") return cue.fade(0, .2);
    // Blueprint lines draw one by one (verticals from the top, then horizontals from
    // the left); the scene grid then floats for the whole hold so the frame never freezes.
    if (layer.role === "grid") {
      const drawn = cue.wipe((layer.group === "background" ? .08 : .5) + layer.index * .035, vertical(layer) ? "top" : "left", .3);
      return layer.group === "background" ? { ...drawn, drift: { dx: travel(14), dy: travel(10) } } : drawn;
    }
    switch (ir.config.id) {
      case "keyword-sticker": switch (layer.role) {
        // Two-tone wipe: an accent lead runs a beat ahead of the plate.
        case "lead": return cue.wipe(.03, "left", .4, -40);
        case "plate": return cue.wipe(.06, "left", .4, -40);
        case "fx-streak": return cue.streak(.02 + layer.index * .035);
        case "title": return cue.text(.2 + line(layer), "rise", text, { travel: .5 });
        case "tag": return tagAt(layer, .4);
        // After the wipe completes, so the shadow trails the plate instead of leading its edge.
        case "shadow": return cue.shadow(.46, 16, 18);
        case "spark": return cue.pop(.5 + layer.index * .07);
        case "fx-burst": return cue.burst(.52);
        case "quote-bar": return cue.wipe(.58, "top", .3);
        case "detail": return detailAt(layer, .62);
        case "fx-shine": return cue.sweepX(.8, s.x, .5);
      } break;
      case "conversation-bubble": switch (layer.role) {
        case "plate": return cue.land(.04, { dy: 30, scale: .88 }, .55);
        case "fx-typing": return cue.typing(.18 + layer.index * .07, .64);
        case "shadow": return cue.shadow(.28, 16, 20);
        case "tail": return cue.wipe(.34, "top", .26);
        case "speech": return cue.pop(.44, .2, .4);
        case "pill": return cue.wipe(.5, "left", .32);
        case "tag": return cue.text(.56, "swipe", text, { energy: support });
        case "title": return cue.text(.66 + line(layer), "rise", text, { travel: .5 });
        case "detail": return detailAt(layer, .92);
        case "dot": return cue.pop(1.02 + layer.index * .1);
        case "fx-ring": return cue.ring(1.02 + layer.index * .1);
      } break;
      case "field-note": switch (layer.role) {
        case "plate": return cue.land(.05, { dx: 60 }, .5, MOTION_CURVES.expoOut);
        case "title": return cue.text(.22 + line(layer), "rise", text, { travel: .5 });
        case "tag": return tagAt(layer, .32);
        case "bar": return cue.wipe(.34, "top", .42);
        case "shadow": return cue.shadow(.36, 18, 20);
        case "tape": return cue.pop(.46, .5, .42);
        case "ruler": return cue.wipe(.56, "left", .45);
        case "rule": return cue.wipe(.62, "left", .42);
        case "detail": return detailAt(layer, .76);
        case "arrow": return cue.pop(.98, .3, .35);
        case "fx-ring": return cue.ring(1.02);
      } break;
      case "chapter-ticket": switch (layer.role) {
        case "plate": return cue.wipe(.05, "left", .5);
        case "panel": return cue.wipe(.18, portrait ? "left" : "top", .4);
        case "number": return cue.text(.3, "slam", text, { keepHold: true });
        case "stitch": return cue.pop(.4 + layer.index * .025, .1, .3);
        // The panel flashes as the numeral lands, once the panel is fully drawn.
        case "fx-flash": return cue.flash(.44);
        case "tag": return tagAt(layer, .44);
        case "title": return cue.text(.5 + line(layer), "rise", text, { travel: .5 });
        case "barcode": return cue.wipe(.7, "left", .45);
        case "detail": return detailAt(layer, .74);
        case "fx-shine": return cue.sweepX(1, s.x, .7);
      } break;
      case "focus-bracket": {
        // Corners converge from their own diagonals, clockwise; under-stroke and stroke share a beat.
        const order = [0, .04, .12, .08][layer.index] ?? 0, [x, y] = ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)[layer.index] ?? [0, 0];
        switch (layer.role) {
          case "corner-under": case "corner": return cue.land(order, { dx: x * 34, dy: y * 34 }, .42, MOTION_CURVES.expoOut);
          case "label": return cue.wipe(.26, "left", .3);
          case "fx-scan": return cue.sweepY(.3, s.y, .5);
          case "tick-under": case "tick": return cue.pop(.36 + layer.index * .05, .2, .3);
          // A pointer must read at once: one focus-pull, no per-character cascade.
          case "title": return cue.text(.36, "focus", text, { energy: support, travel: .5 });
          case "leader": return cue.wipe(.44, "top", .2);
          case "fx-echo": return cue.echo(.46);
          case "fx-shine": return cue.sweepX(.66, s.x, .4);
        }
      } break;
      case "reaction-seal": switch (layer.role) {
        case "seal": return cue.pop(.04, .3, .55);
        case "fx-burst": return cue.burst(.2);
        case "fx-flash": return cue.flash(.22);
        case "title": return cue.text(.24 + line(layer), "pop", text);
        case "tag": return tagAt(layer, .38);
        case "spark": return cue.pop(.5 + layer.index * .07);
        case "sparkle": return cue.twinkle(.58 + layer.index * .08);
        case "dot": return cue.pop(.64);
        case "fx-ring": return cue.ring(.64);
        case "detail": return detailAt(layer, .7);
      } break;
      case "step-path": {
        // node → connector → node: each step lands, then the line draws on to the next while
        // the progress rail fills under it with a packet riding the fill.
        const node = (i: number) => .32 + i * .3, axis = portrait ? "top" : "left";
        switch (layer.role) {
          case "tag": return tagAt(layer, .06);
          case "title": return layer.group === "headline" ? cue.text(.1 + line(layer), "rise", text, { travel: .6 })
            : cue.text(node(slot(layer)) + .14 + line(layer), "rise", text, { energy: support, travel: .5 });
          case "rail-track": return cue.wipe(.24, axis, .5);
          case "rail-fill": return cue.wipe(node(layer.index) + .12, axis, .34);
          case "fx-packet": return cue.packet(node(layer.index) + .12, s.x, s.y, .34);
          case "connector": return cue.wipe(node(layer.index) + .2, axis, .3);
          case "shadow": return cue.shadow(node(slot(layer)) + .16, 9, 11, .3);
          case "plate": return cue.land(node(slot(layer)), { dy: 24, scale: .9 }, .45);
          case "number": return cue.text(node(layer.index) + .1, "swipe", text, { energy: support });
          case "fx-shine": return cue.sweepX(node(2) + .42, s.x, .45);
        }
      } break;
      case "recap-strip": {
        const row = (i: number) => .36 + i * .14;
        switch (layer.role) {
          case "tag": return tagAt(layer, .06);
          case "title": return layer.group === "headline" ? cue.text(.1 + line(layer), "rise", text, { travel: .6 })
            : cue.text(row(slot(layer)) + .12 + line(layer), "swipe", text, { energy: support, travel: .6 });
          case "lead": return cue.wipe(row(slot(layer)) - .03, "left", .4, -24);
          case "row": return cue.wipe(row(slot(layer)), "left", .4, -24);
          case "chevron": return cue.wipe(row(slot(layer)) + .2, "left", .18);
          case "check": return cue.wipe(row(slot(layer)) + .5, "left", .22);
          case "fx-shine": return cue.sweepX(.92, s.x, .55);
        }
      } break;
    }
    return undefined;
  }
  const cues = layers.map(layer => beat(layer)
    ?? (layer.kind === "text" ? cue.text(.4, "focus", layer.graphic.text, { energy: support }) : cue.land(.3, { dy: 10, scale: .96 }, .35, MOTION_CURVES.expoOut)));

  const span = (index: number) => {
    const { motion, reveal, drift } = cues[index], units = motionGraphicV2UnitCount({ text: layers[index].graphic.text, motionV2: motion });
    // A drifting layer is in place once drawn; its float spans the hold by design.
    return Math.max(drift ? 1 : motion.entrance.durationFrames + Math.max(0, units - 1) * motion.sequence.staggerFrames, reveal?.frames ?? 1);
  };
  // Energy sets the tempo; a slot too short for the full build compresses the beat times (not the moves).
  const lasting = cues.flatMap((item, index) => item.once ? [] : [index]);
  const latest = Math.max(...lasting.map(index => cues[index].at)), room = timing.durationFrames - exit.durationFrames - .9 * fps;
  const longest = Math.max(...lasting.map(span));
  const pace = profile.time * Math.min(1, Math.max(.5, latest > 0 ? (room - longest) / (latest * profile.time * fps) : 1));
  const end = timing.startFrame + timing.durationFrames;
  return layers.flatMap((layer, index): MotionGraphic[] => {
    const item = cues[index], at = timing.startFrame + Math.round(item.at * pace * fps);
    if (item.once) {
      // One-shot effects never overlap the element's exit; without room they are left out.
      const life = Math.max(item.motion.entrance.durationFrames + item.motion.exit.durationFrames, item.until === undefined ? 0 : Math.round((item.until - item.at) * pace * fps));
      return at + life > end - exit.durationFrames ? [] : [{ ...layer.graphic, timelineStart: at / fps, duration: life / fps, motionV2: item.motion }];
    }
    const need = span(index) + exit.durationFrames + 1;
    const start = Math.max(timing.startFrame, Math.min(at, end - Math.max(need, Math.round(.8 * fps))));
    const motion = item.drift ? { ...item.motion, entrance: { durationFrames: Math.max(1, end - start - exit.durationFrames),
      offsetXPixels: item.drift.dx, offsetYPixels: item.drift.dy, scale: 1, opacity: 1, easing: LINEAR } } : item.motion;
    // The whole element leaves together: no exit stagger, one upward snap. A full-frame
    // ground only fades, so lifting it never exposes a strip of the shot underneath.
    const graphic: MotionGraphic = { ...layer.graphic, timelineStart: start / fps, duration: (end - start) / fps,
      motionV2: { ...motion, sequence: { ...motion.sequence, exitStaggerFrames: 0 }, exit: layer.role === "paper" ? { ...exit, offsetYPixels: 0 } : exit } };
    if (item.reveal && graphic.vectorV2?.kind === "shape") graphic.vectorV2 = { ...graphic.vectorV2, revealFrames: item.reveal.frames, revealFrom: item.reveal.from };
    return [graphic];
  });
}

export function originalElementHoldSeconds(config: OriginalElementConfig): number { return validateOriginalElement(config).hold; }

/** When the staged build finishes and how long the finished layout holds before the exit.
 * One-shot effects are reported separately; the floating scene grid counts once drawn. */
export function originalElementTimeline(graphics: readonly MotionGraphic[], fps: number) {
  const lasting = graphics.filter(graphic => !isOriginalElementEffect(graphic));
  const first = Math.min(...lasting.map(graphic => graphic.timelineStart));
  const end = Math.max(...lasting.map(graphic => graphic.timelineStart + graphic.duration));
  const built = Math.max(...lasting.map(graphic => {
    const motion = graphic.motionV2!, units = motionGraphicV2UnitCount(graphic);
    const reveal = graphic.vectorV2?.kind === "shape" ? graphic.vectorV2.revealFrames : 1;
    const entrance = graphic.id.endsWith(":background:grid") ? 1 : motion.entrance.durationFrames + Math.max(0, units - 1) * motion.sequence.staggerFrames;
    return graphic.timelineStart + Math.max(entrance, reveal) / fps;
  }));
  const exitStart = end - Math.max(...lasting.map(graphic => graphic.motionV2!.exit.durationFrames)) / fps;
  const seconds = (value: number) => Math.round(value * 1000) / 1000;
  return { layers: graphics.length, effects: graphics.length - lasting.length, buildSeconds: seconds(built - first),
    holdAfterBuildSeconds: seconds(exitStart - built), exitSeconds: seconds(end - exitStart) };
}
