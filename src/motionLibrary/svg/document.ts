import { assertMotionFrameSize, type MotionFrameSize } from "../types";

/**
 * Deterministic, escaped SVG 1.1 string builders for motion library frames.
 *
 * - Numbers go through fmt(): fixed to at most 3 decimals (toFixed rounding is
 *   exactly specified by ECMAScript), no exponent, no signed zero, and a
 *   non-finite value throws instead of reaching the rasterizer.
 * - Only the element whitelist below can be produced; there is no <text>,
 *   <image>, <script>, <foreignObject> or external reference. Attribute values
 *   are escaped, event-handler attributes are refused, and every url(...) or
 *   href must point at an id inside the same document.
 * - Ids come from a per-document counter, so the same calls give the same ids.
 *
 * Coordinates are pixels: the root viewBox is "0 0 width height".
 */

export function fmt(value: number, decimals = 3): string {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`SVG number must be finite (got ${String(value)})`);
  if (Math.abs(value) >= 1e9) throw new RangeError(`SVG number out of range (${value})`);
  if (decimals !== 0 && decimals !== 1 && decimals !== 2 && decimals !== 3) throw new RangeError("SVG numbers keep 0..3 decimals");
  let text = value.toFixed(decimals);
  if (decimals > 0) {
    // toFixed always prints the point here: drop trailing fractional zeros, then a bare point.
    let end = text.length;
    while (text.charCodeAt(end - 1) === 48) end -= 1;
    if (text.charCodeAt(end - 1) === 46) end -= 1;
    text = text.slice(0, end);
  }
  return text === "-0" ? "0" : text;
}

export type SvgAttrValue = string | number | boolean | null | undefined;
export type SvgAttrs = { readonly [name: string]: SvgAttrValue };
export type SvgChild = string | false | null | undefined | readonly SvgChild[];

const ALLOWED_ELEMENTS = new Set([
  "g", "defs", "path", "rect", "circle", "ellipse", "polygon", "polyline", "line",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "filter",
  "feGaussianBlur", "feOffset", "feColorMatrix", "feFlood", "feComposite", "feMerge", "feMergeNode",
  "feMorphology", "feTurbulence", "feDisplacementMap",
]);
const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9.:-]*$/;
const INTERNAL_URL = /url\(#[A-Za-z0-9_-]+\)/g;
const STYLE_VALUE = /^(?:\s*(?:mix-blend-mode:\s*(?:normal|multiply|screen|plus-lighter|overlay|darken|lighten)|isolation:\s*(?:auto|isolate))\s*;?)+$/;

export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

function attributeText(name: string, value: SvgAttrValue): string {
  if (value === undefined || value === null || value === false) return "";
  if (!ATTRIBUTE_NAME.test(name) || /^on/i.test(name)) throw new Error(`SVG attribute ${name} is not allowed`);
  let text: string;
  if (value === true) text = "true";
  else if (typeof value === "number") text = fmt(value);
  else text = value;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error(`SVG attribute ${name} contains control characters`);
  if (/url\(/i.test(text) && text.replace(INTERNAL_URL, "").match(/url\(/i)) throw new Error(`SVG attribute ${name} may only reference ids in the same document`);
  if (/^(?:href|xlink:href)$/.test(name) && !/^#[A-Za-z0-9_-]+$/.test(text)) throw new Error("SVG href may only reference ids in the same document");
  if (name === "style" && !STYLE_VALUE.test(text)) throw new Error("SVG style may only set mix-blend-mode or isolation");
  return ` ${name}="${escapeAttribute(text)}"`;
}

function attributesText(attrs: SvgAttrs | undefined): string {
  if (!attrs) return "";
  let text = "";
  for (const name of Object.keys(attrs)) text += attributeText(name, attrs[name]);
  return text;
}

function childText(children: SvgChild): string {
  if (children === undefined || children === null || children === false) return "";
  if (typeof children === "string") return children;
  let text = "";
  for (const child of children) text += childText(child);
  return text;
}

/** Generic element builder (whitelisted tags only). */
export function el(tag: string, attrs?: SvgAttrs, children?: SvgChild): string {
  if (!ALLOWED_ELEMENTS.has(tag)) throw new Error(`SVG element <${tag}> is not allowed in motion library frames`);
  const inner = childText(children);
  return inner ? `<${tag}${attributesText(attrs)}>${inner}</${tag}>` : `<${tag}${attributesText(attrs)}/>`;
}

export function g(attrs: SvgAttrs | undefined, ...children: SvgChild[]): string {
  const inner = childText(children);
  return inner ? `<g${attributesText(attrs)}>${inner}</g>` : "";
}

export function path(d: string, attrs?: SvgAttrs): string {
  return d ? el("path", { d, ...attrs }) : "";
}

export function rect(x: number, y: number, width: number, height: number, attrs?: SvgAttrs): string {
  if (!(width > 0) || !(height > 0)) return "";
  return el("rect", { x, y, width, height, ...attrs });
}

/** Rounded rectangle; the radius is clamped to half of the shorter side. */
export function roundRect(x: number, y: number, width: number, height: number, radius: number, attrs?: SvgAttrs): string {
  if (!(width > 0) || !(height > 0)) return "";
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  return el("rect", { x, y, width, height, ...(r > 0 ? { rx: r, ry: r } : {}), ...attrs });
}

export function circle(cx: number, cy: number, r: number, attrs?: SvgAttrs): string {
  return r > 0 ? el("circle", { cx, cy, r, ...attrs }) : "";
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, attrs?: SvgAttrs): string {
  return rx > 0 && ry > 0 ? el("ellipse", { cx, cy, rx, ry, ...attrs }) : "";
}

export type Point2 = readonly [number, number];

export function pointsText(points: readonly Point2[]): string {
  return points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");
}

export function polygon(points: readonly Point2[], attrs?: SvgAttrs): string {
  return points.length >= 3 ? el("polygon", { points: pointsText(points), ...attrs }) : "";
}

export function polyline(points: readonly Point2[], attrs?: SvgAttrs): string {
  return points.length >= 2 ? el("polyline", { points: pointsText(points), fill: "none", ...attrs }) : "";
}

export function line(x1: number, y1: number, x2: number, y2: number, attrs?: SvgAttrs): string {
  return el("line", { x1, y1, x2, y2, ...attrs });
}

/** Style attribute for an allowed blend mode (render-checked in librsvg and Chromium: normal, multiply, screen, plus-lighter). */
export function blendMode(mode: "normal" | "multiply" | "screen" | "plus-lighter"): SvgAttrs {
  return { style: `mix-blend-mode:${mode}` };
}

/**
 * Fill + outline for glyph paths. paint-order="stroke" draws the stroke behind
 * the fill: a centred stroke drawn on top eats thin glyph counters. Pass
 * fill "none" for hollow outline text (the stroke is then fully visible).
 */
export function outlinedAttrs(fill: string, stroke: string, width: number, extra: SvgAttrs = {}): SvgAttrs {
  return { fill, stroke, "stroke-width": width, "stroke-linejoin": "round", "stroke-linecap": "round",
    ...(fill === "none" ? {} : { "paint-order": "stroke" }), ...extra };
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

export const tf = Object.freeze({
  translate: (x: number, y = 0) => `translate(${fmt(x)} ${fmt(y)})`,
  /** Clockwise degrees (SVG y-down), optionally about (cx, cy). */
  rotate: (degrees: number, cx?: number, cy?: number) => cx === undefined || cy === undefined
    ? `rotate(${fmt(degrees)})` : `rotate(${fmt(degrees)} ${fmt(cx)} ${fmt(cy)})`,
  scale: (sx: number, sy = sx) => sx === sy ? `scale(${fmt(sx, 3)})` : `scale(${fmt(sx, 3)} ${fmt(sy, 3)})`,
  skewX: (degrees: number) => `skewX(${fmt(degrees)})`,
  skewY: (degrees: number) => `skewY(${fmt(degrees)})`,
  matrix: (a: number, b: number, c: number, d: number, e: number, f: number) =>
    `matrix(${fmt(a)} ${fmt(b)} ${fmt(c)} ${fmt(d)} ${fmt(e)} ${fmt(f)})`,
});

/** Join transform parts (falsy parts are skipped). Applied right-to-left as in SVG. */
export function transform(...parts: Array<string | false | null | undefined>): string | undefined {
  const text = parts.filter((part): part is string => Boolean(part)).join(" ");
  return text || undefined;
}

/** translate(cx, cy) · rotate · scale · translate(-cx, -cy): transform about a pivot. */
export function aboutPivot(cx: number, cy: number, options: { rotate?: number; scale?: number; scaleX?: number; scaleY?: number;
  translateX?: number; translateY?: number }): string | undefined {
  const sx = options.scaleX ?? options.scale ?? 1, sy = options.scaleY ?? options.scale ?? 1;
  const dx = options.translateX ?? 0, dy = options.translateY ?? 0;
  if (sx === 1 && sy === 1 && !options.rotate && !dx && !dy) return undefined;
  return transform(tf.translate(cx + dx, cy + dy), options.rotate ? tf.rotate(options.rotate) : false,
    sx !== 1 || sy !== 1 ? tf.scale(sx, sy) : false, tf.translate(-cx, -cy));
}

// ---------------------------------------------------------------------------
// Path data
// ---------------------------------------------------------------------------

export class PathBuilder {
  private readonly parts: string[] = [];
  constructor(private readonly decimals = 3) {}
  private n(value: number): string { return fmt(value, this.decimals); }
  M(x: number, y: number): this { this.parts.push(`M${this.n(x)} ${this.n(y)}`); return this; }
  L(x: number, y: number): this { this.parts.push(`L${this.n(x)} ${this.n(y)}`); return this; }
  H(x: number): this { this.parts.push(`H${this.n(x)}`); return this; }
  V(y: number): this { this.parts.push(`V${this.n(y)}`); return this; }
  Q(x1: number, y1: number, x: number, y: number): this { this.parts.push(`Q${this.n(x1)} ${this.n(y1)} ${this.n(x)} ${this.n(y)}`); return this; }
  C(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    this.parts.push(`C${this.n(x1)} ${this.n(y1)} ${this.n(x2)} ${this.n(y2)} ${this.n(x)} ${this.n(y)}`); return this;
  }
  A(rx: number, ry: number, rotation: number, largeArc: boolean, sweep: boolean, x: number, y: number): this {
    this.parts.push(`A${this.n(rx)} ${this.n(ry)} ${this.n(rotation)} ${largeArc ? 1 : 0} ${sweep ? 1 : 0} ${this.n(x)} ${this.n(y)}`); return this;
  }
  Z(): this { this.parts.push("Z"); return this; }
  get empty(): boolean { return this.parts.length === 0; }
  toString(): string { return this.parts.join(""); }
}

export function pathData(decimals = 3): PathBuilder { return new PathBuilder(decimals); }

/** Closed polygon as path data (several polygons can be concatenated into one path). */
export function polygonPathD(points: readonly Point2[], decimals = 3): string {
  if (points.length < 3) return "";
  const builder = pathData(decimals).M(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) builder.L(points[index][0], points[index][1]);
  return builder.Z().toString();
}

/** Rectangle as path data (useful to union many rectangles into one <path>). */
export function rectPathD(x: number, y: number, width: number, height: number, decimals = 3): string {
  if (!(width > 0) || !(height > 0)) return "";
  return pathData(decimals).M(x, y).H(x + width).V(y + height).H(x).Z().toString();
}

/** Cubic circle constant: control points at k·r reproduce a circle within 0.03% of r. */
const CIRCLE_KAPPA = 0.5522847498;

/**
 * Full circle as four absolute cubic quarter-arcs (M/C/Z): unlike circlePathD's
 * relative arcs, pathOps (flattenPathD, transformPathD) and glyphCells accept it,
 * so it can be rasterized, merged or transformed. Starts at the right and runs
 * clockwise in SVG y-down. Empty for r ≤ 0.
 */
export function circleBezierPathD(cx: number, cy: number, r: number, decimals = 3): string {
  if (!(r > 0)) return "";
  const k = CIRCLE_KAPPA * r;
  return pathData(decimals).M(cx + r, cy)
    .C(cx + r, cy + k, cx + k, cy + r, cx, cy + r).C(cx - k, cy + r, cx - r, cy + k, cx - r, cy)
    .C(cx - r, cy - k, cx - k, cy - r, cx, cy - r).C(cx + k, cy - r, cx + r, cy - k, cx + r, cy).Z().toString();
}

/** Full circle as two relative arcs (path data). Many circles can share one <path> (fast for dot fields). */
export function circlePathD(cx: number, cy: number, r: number, decimals = 3): string {
  if (!(r > 0)) return "";
  const radius = fmt(r, decimals), across = fmt(2 * r, decimals), back = fmt(-2 * r, decimals);
  return `M${fmt(cx - r, decimals)} ${fmt(cy, decimals)}a${radius} ${radius} 0 1 0 ${across} 0a${radius} ${radius} 0 1 0 ${back} 0Z`;
}

// ---------------------------------------------------------------------------
// Filter primitives
// ---------------------------------------------------------------------------

type FeCommon = { in?: string; result?: string };

export const fe = Object.freeze({
  blur: (options: FeCommon & { stdDeviation: number | readonly [number, number]; edgeMode?: "duplicate" | "wrap" | "none" }) =>
    el("feGaussianBlur", { in: options.in, stdDeviation: Array.isArray(options.stdDeviation)
      ? `${fmt(options.stdDeviation[0])} ${fmt(options.stdDeviation[1])}` : fmt(options.stdDeviation as number),
    edgeMode: options.edgeMode, result: options.result }),
  offset: (options: FeCommon & { dx: number; dy: number }) => el("feOffset", { in: options.in, dx: options.dx, dy: options.dy, result: options.result }),
  /** type "matrix" takes 20 numbers; "saturate" one; "hueRotate" degrees; "luminanceToAlpha" none. */
  colorMatrix: (options: FeCommon & { type: "matrix" | "saturate" | "hueRotate" | "luminanceToAlpha"; values?: readonly number[] | number }) => {
    if (options.type === "matrix" && (!Array.isArray(options.values) || options.values.length !== 20)) throw new Error("feColorMatrix matrix needs 20 values");
    const values = options.values === undefined ? undefined : Array.isArray(options.values) ? options.values.map(value => fmt(value)).join(" ") : fmt(options.values as number);
    return el("feColorMatrix", { in: options.in, type: options.type, values, result: options.result });
  },
  morphology: (options: FeCommon & { operator: "erode" | "dilate"; radius: number | readonly [number, number] }) =>
    el("feMorphology", { in: options.in, operator: options.operator, radius: Array.isArray(options.radius)
      ? `${fmt(options.radius[0])} ${fmt(options.radius[1])}` : fmt(options.radius as number), result: options.result }),
  /** Seeded noise. Keep baseFrequency in user units (filter region userSpaceOnUse) for size independence. */
  turbulence: (options: { type?: "fractalNoise" | "turbulence"; baseFrequency: number | readonly [number, number]; numOctaves?: number;
    seed: number; stitchTiles?: "stitch" | "noStitch"; result?: string }) => {
    if (!Number.isInteger(options.seed) || options.seed < 0) throw new Error("feTurbulence seed must be a non-negative integer");
    return el("feTurbulence", { type: options.type ?? "fractalNoise", baseFrequency: Array.isArray(options.baseFrequency)
      ? `${fmt(options.baseFrequency[0], 3)} ${fmt(options.baseFrequency[1], 3)}` : fmt(options.baseFrequency as number, 3),
    numOctaves: options.numOctaves ?? 1, seed: options.seed, stitchTiles: options.stitchTiles, result: options.result });
  },
  displacementMap: (options: FeCommon & { in2: string; scale: number; xChannelSelector?: "R" | "G" | "B" | "A"; yChannelSelector?: "R" | "G" | "B" | "A" }) =>
    el("feDisplacementMap", { in: options.in, in2: options.in2, scale: options.scale,
      xChannelSelector: options.xChannelSelector ?? "R", yChannelSelector: options.yChannelSelector ?? "G", result: options.result }),
  flood: (options: { color: string; opacity?: number; result?: string }) =>
    el("feFlood", { "flood-color": options.color, "flood-opacity": options.opacity, result: options.result }),
  composite: (options: FeCommon & { in2: string; operator: "over" | "in" | "out" | "atop" | "xor" | "arithmetic";
    k1?: number; k2?: number; k3?: number; k4?: number }) =>
    el("feComposite", { in: options.in, in2: options.in2, operator: options.operator,
      k1: options.k1, k2: options.k2, k3: options.k3, k4: options.k4, result: options.result }),
  merge: (inputs: readonly string[], result?: string) =>
    el("feMerge", { result }, inputs.map(input => el("feMergeNode", { in: input }))),
});

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface GradientStop {
  readonly offset: number;
  readonly color: string;
  readonly opacity?: number;
}

export interface RegionOptions {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface SvgDocumentOptions {
  /** Prefix for generated ids (letters/digits/underscore/dash). Use distinct prefixes if documents are ever nested. */
  readonly idPrefix?: string;
  /** Opaque full-frame background colour; omit for a transparent frame. */
  readonly background?: string;
}

export class SvgDocument {
  readonly width: number;
  readonly height: number;
  private readonly prefix: string;
  private readonly background?: string;
  private readonly defs: string[] = [];
  private counter = 0;

  constructor(size: MotionFrameSize, options: SvgDocumentOptions = {}) {
    assertMotionFrameSize(size);
    this.width = size.width;
    this.height = size.height;
    const prefix = options.idPrefix ?? "m";
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(prefix)) throw new Error("SVG id prefix must start with a letter (max 32 chars)");
    this.prefix = prefix;
    this.background = options.background;
  }

  /** A fresh id, stable for the same sequence of calls. */
  id(hint = "id"): string {
    const clean = hint.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "id";
    this.counter += 1;
    return `${this.prefix}${clean}${this.counter}`;
  }

  /** Append raw markup produced by these builders to <defs>. */
  def(markup: string): void {
    if (markup) this.defs.push(markup);
  }

  /** Returns "url(#id)". */
  linearGradient(spec: { x1: number; y1: number; x2: number; y2: number; stops: readonly GradientStop[];
    units?: "userSpaceOnUse" | "objectBoundingBox"; spread?: "pad" | "reflect" | "repeat"; gradientTransform?: string }): string {
    const id = this.id("lg");
    this.def(el("linearGradient", { id, x1: spec.x1, y1: spec.y1, x2: spec.x2, y2: spec.y2,
      gradientUnits: spec.units ?? "userSpaceOnUse", spreadMethod: spec.spread, gradientTransform: spec.gradientTransform }, stopsMarkup(spec.stops)));
    return `url(#${id})`;
  }

  /** Returns "url(#id)". */
  radialGradient(spec: { cx: number; cy: number; r: number; fx?: number; fy?: number; stops: readonly GradientStop[];
    units?: "userSpaceOnUse" | "objectBoundingBox"; spread?: "pad" | "reflect" | "repeat"; gradientTransform?: string }): string {
    const id = this.id("rg");
    this.def(el("radialGradient", { id, cx: spec.cx, cy: spec.cy, r: spec.r, fx: spec.fx, fy: spec.fy,
      gradientUnits: spec.units ?? "userSpaceOnUse", spreadMethod: spec.spread, gradientTransform: spec.gradientTransform }, stopsMarkup(spec.stops)));
    return `url(#${id})`;
  }

  /** Returns "url(#id)" for clip-path. Children are in user space. */
  clipPath(children: SvgChild, options: { transform?: string } = {}): string {
    const id = this.id("clip");
    this.def(el("clipPath", { id, clipPathUnits: "userSpaceOnUse", transform: options.transform }, children));
    return `url(#${id})`;
  }

  /** Luminance mask (white keeps, black removes). Default region: the whole frame. Returns "url(#id)". */
  mask(children: SvgChild, region: RegionOptions = {}): string {
    const id = this.id("mask");
    this.def(el("mask", { id, maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse",
      x: region.x ?? 0, y: region.y ?? 0, width: region.width ?? this.width, height: region.height ?? this.height }, children));
    return `url(#${id})`;
  }

  /**
   * Filter (color-interpolation-filters sRGB). With a region the units are
   * userSpaceOnUse; without one the SVG default bounding box (-10%, 120%) applies.
   * Returns "url(#id)".
   */
  filter(primitives: SvgChild, region?: RegionOptions): string {
    const id = this.id("fx");
    this.def(el("filter", { id, "color-interpolation-filters": "sRGB",
      ...(region ? { filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", x: region.x ?? 0, y: region.y ?? 0,
        width: region.width ?? this.width, height: region.height ?? this.height } : {}) }, primitives));
    return `url(#${id})`;
  }

  /** Serialize the complete, self-contained document. */
  render(...children: SvgChild[]): string {
    const defs = this.defs.length ? `<defs>${this.defs.join("")}</defs>` : "";
    const background = this.background ? rect(0, 0, this.width, this.height, { fill: this.background }) : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">`
      + `${defs}${background}${childText(children)}</svg>`;
  }
}

/** Alpha threshold of the goo filter: alpha' = 18·alpha − 7 (opaque from alpha 0.44, clear below 0.39). */
export const GOO_ALPHA_MATRIX: readonly number[] = Object.freeze([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 18, -7]);

/**
 * Goo filter (DESIGN §8, T76): Gaussian blur (σ px), then an alpha threshold
 * through feColorMatrix (GOO_ALPHA_MATRIX), so shapes within about σ of each
 * other melt together with a rounded neck and thin parts round off. Draw the goo
 * group in one flat colour: colour passes through the blur unchanged only when it
 * is uniform. The region is the box (frame px, x0 < x1, y0 < y1) grown by 3σ: keep
 * it tight, since librsvg pays per filtered pixel. Returns "url(#id)" for the
 * filter attribute, or undefined when σ < 0.05 px (draw without the filter: a
 * zero blur is not portable across renderers).
 *
 * Measured (bundled FFmpeg/librsvg decode, 1080×1920, 「墨跡/暈開」 at 389 px, ink
 * box 760×781): about 65 ms/frame at σ = 15 px (4% of the glyph height) and 70 ms
 * at σ = 33 px (9%), against 2–4 ms for the same frame without the filter. A
 * weight-900 word is already blobs at 4%. The threshold leaves an edge ramp only
 * about 0.14σ wide and pulls straight edges in by about 0.2σ, so below σ ≈ 7 px
 * edges look aliased: crossfade to the unfiltered shapes there instead of
 * thresholding a nearly sharp edge.
 *
 * Usage (T76, σ eased from 0 to 9% of the glyph height and back):
 *   const goo = gooFilter(doc, sigma, inkBoxInFrame);
 *   g({ filter: goo }, path(wordPathD, { fill: ink }), circle(...dropletsInInk))
 */
export function gooFilter(doc: SvgDocument, sigmaPx: number, box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }): string | undefined {
  if (!Number.isFinite(sigmaPx) || sigmaPx < 0) throw new Error("gooFilter needs a non-negative σ");
  if (![box?.x0, box?.y0, box?.x1, box?.y1].every(Number.isFinite) || !(box.x1 > box.x0) || !(box.y1 > box.y0)) {
    throw new Error("gooFilter needs a box with x0 < x1 and y0 < y1");
  }
  if (sigmaPx < 0.05) return undefined;
  const pad = 3 * sigmaPx;
  const x0 = Math.max(box.x0 - pad, -pad), y0 = Math.max(box.y0 - pad, -pad);
  const x1 = Math.min(box.x1 + pad, doc.width + pad), y1 = Math.min(box.y1 + pad, doc.height + pad);
  if (!(x1 > x0) || !(y1 > y0)) return undefined;
  return doc.filter([fe.blur({ in: "SourceGraphic", stdDeviation: sigmaPx }), fe.colorMatrix({ type: "matrix", values: GOO_ALPHA_MATRIX })],
    { x: Number(fmt(x0, 2)), y: Number(fmt(y0, 2)), width: Number(fmt(x1 - x0, 2)), height: Number(fmt(y1 - y0, 2)) });
}

function stopsMarkup(stops: readonly GradientStop[]): string {
  if (stops.length < 1) throw new Error("A gradient needs at least one stop");
  return stops.map(stop => el("stop", { offset: Math.max(0, Math.min(1, stop.offset)), "stop-color": stop.color,
    "stop-opacity": stop.opacity === undefined ? undefined : Math.max(0, Math.min(1, stop.opacity)) })).join("");
}

export function createSvgDocument(size: MotionFrameSize, options?: SvgDocumentOptions): SvgDocument {
  return new SvgDocument(size, options);
}

/** An empty, transparent frame of the given size (e.g. a transition overlay with nothing to draw). */
export function emptySvg(size: MotionFrameSize): string {
  return new SvgDocument(size).render();
}
