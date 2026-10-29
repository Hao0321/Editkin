import { circle, createSvgDocument, ellipse, fmt, g, path, roundRect, transform, tf, type SvgDocument } from "../../motionLibrary/svg/document";
import { clamp01, curve, lerp } from "../../motionLibrary/svg/easing";
import { layoutLine, translatePathD, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import { valueNoise1D } from "../../motionLibrary/svg/random";
import { dropShadow } from "../svgFx";

/**
 * C4 annotation kit (R2's hand-drawn marks, R3/R6's pins and callouts), original drawings:
 * hand-drawn dashed arrows and circles/underlines that draw on, a map pin that drops and settles,
 * a callout card with an arc to its target, numbered markers with a pulse. Strokes are polylines
 * with a slow seeded wobble (hand feel), drawn on by revealing the polyline up to the progress
 * (dashes stay put while the line grows). Coordinates are frame px.
 */

export const ANNOTATION_REVISION = 1;
export type AnnotationMark = "arrow" | "circle" | "underline" | "pin" | "callout" | "marker";

export interface AnnotationParams {
  readonly component: "annotation";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly mark: AnnotationMark;
  readonly duration: number;
  readonly em: number;
  readonly seed: number;
  readonly colors: { readonly stroke: string; readonly pin: string; readonly pinCore: string; readonly label: string; readonly labelPlate: string;
    readonly marker: string; readonly markerText: string; readonly shadow: string };
  readonly strokeWidth: number;
  readonly dash: boolean;
  /** Opacity of the soft shadow under strokes, pins' drop shadow excluded (0 = none); more over busy or bright footage. */
  readonly strokeShadow?: number;
  readonly target: { readonly box?: { x0: number; y0: number; x1: number; y1: number }; readonly point?: { x: number; y: number } };
  readonly from?: { readonly x: number; readonly y: number };
  readonly label?: { readonly text: string; readonly font: MotionFontSelector; readonly size: number; readonly x: number; readonly y: number };
  readonly number?: number;
}

type Pt = readonly [number, number];
const EXIT = 0.25;
const op = (value: number) => (value < 0.999 ? Number(fmt(Math.max(0, value), 3)) : undefined);

function polylineD(points: readonly Pt[]): string {
  if (points.length < 2) return "";
  return `M${points.map(([x, y]) => `${fmt(x, 1)} ${fmt(y, 1)}`).join("L")}`;
}

/** Points up to `progress` (0..1) of the polyline's length (the last one interpolated). */
function revealed(points: readonly Pt[], progress: number): Pt[] {
  if (progress >= 1) return [...points];
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const target = lengths[lengths.length - 1] * Math.max(0, progress);
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    if (lengths[i] <= target) { out.push(points[i]); continue; }
    const u = (target - lengths[i - 1]) / Math.max(1e-9, lengths[i] - lengths[i - 1]);
    out.push([lerp(points[i - 1][0], points[i][0], u), lerp(points[i - 1][1], points[i][1], u)]);
    break;
  }
  return out;
}

/** Hand wobble: each point moves along the local normal by slow seeded noise (amplitude px). */
function wobble(points: readonly Pt[], amplitude: number, seed: number): Pt[] {
  return points.map(([x, y], i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const n = valueNoise1D(i * 0.18, seed) * amplitude;
    return [x - (dy / len) * n, y + (dx / len) * n] as Pt;
  });
}

function textPath(text: string, font: MotionFontSelector, size: number, cx: number, cy: number): { d: string; w: number; h: number } {
  const line = layoutLine(text, { ...font, size });
  const ink = line.inkBox ?? { x0: 0, y0: -size * 0.8, x1: line.width, y1: 0 };
  return { d: translatePathD(line.pathD, cx - (ink.x0 + ink.x1) / 2, cy - (ink.y0 + ink.y1) / 2), w: ink.x1 - ink.x0, h: ink.y1 - ink.y0 };
}

function stroke(params: AnnotationParams, points: readonly Pt[], extra: Record<string, string | number | undefined> = {}): string {
  return path(polylineD(points), { fill: "none", stroke: params.colors.stroke, "stroke-width": Number(fmt(params.strokeWidth, 2)), "stroke-linecap": "round",
    "stroke-linejoin": "round", ...(params.dash ? { "stroke-dasharray": `${fmt(params.strokeWidth * 2.6, 1)} ${fmt(params.strokeWidth * 2.2, 1)}` } : {}), ...extra });
}

function labelCard(doc: SvgDocument, params: AnnotationParams, appear: number): string {
  const label = params.label!;
  const text = textPath(label.text, label.font, label.size, label.x, label.y);
  const padX = label.size * 0.55, padY = label.size * 0.38;
  const box = { x0: label.x - text.w / 2 - padX, y0: label.y - text.h / 2 - padY, x1: label.x + text.w / 2 + padX, y1: label.y + text.h / 2 + padY };
  const e = curve("backOutSoft", appear);
  return g({ transform: transform(tf.translate(label.x, label.y), tf.scale(lerp(0.6, 1, e)), tf.translate(-label.x, -label.y)), opacity: op(Math.min(1, appear * 4)),
    filter: dropShadow(doc, { box, sigma: label.size * 0.22, dy: label.size * 0.1, color: params.colors.shadow, opacity: 0.45 }) },
  roundRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, label.size * 0.4, { fill: params.colors.labelPlate }),
  path(text.d, { fill: params.colors.label }));
}

export function annotationFrame(params: AnnotationParams, t: number): string {
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "an" });
  const exit = 1 - curve("snapIn", clamp01((t - (params.duration - EXIT)) / EXIT));
  const { em } = params;
  const parts: string[] = [], strokes: string[] = [];
  switch (params.mark) {
    case "arrow": {
      const tip = params.target.point ?? { x: (params.target.box!.x0 + params.target.box!.x1) / 2, y: params.target.box!.y0 };
      const from = params.from ?? { x: tip.x - 6 * em, y: tip.y + 5 * em };
      const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
      const ux = (tip.x - from.x) / len, uy = (tip.y - from.y) / len;
      const end = { x: tip.x - ux * 0.5 * em, y: tip.y - uy * 0.5 * em };
      const bow = (params.seed % 2 ? 1 : -1) * 0.22 * len;
      const ctrl = { x: (from.x + end.x) / 2 - uy * bow, y: (from.y + end.y) / 2 + ux * bow };
      const points: Pt[] = Array.from({ length: 40 }, (_, i) => {
        const u = i / 39;
        return [(1 - u) ** 2 * from.x + 2 * (1 - u) * u * ctrl.x + u * u * end.x, (1 - u) ** 2 * from.y + 2 * (1 - u) * u * ctrl.y + u * u * end.y] as Pt;
      });
      const shaped = wobble(points, 0.12 * em, params.seed);
      const p = curve("quintOut", clamp01(t / 0.6));
      strokes.push(stroke(params, revealed(shaped, p)));
      const headP = clamp01((p - 0.82) / 0.18);
      if (headP > 0) {
        const last = shaped[shaped.length - 1], prev = shaped[shaped.length - 4];
        const angle = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
        const head = 1.0 * em * curve("backOutSoft", headP);
        for (const side of [-1, 1]) {
          const a = angle + Math.PI + side * 0.5;
          strokes.push(stroke(params, [last, [last[0] + Math.cos(a) * head, last[1] + Math.sin(a) * head]], { "stroke-dasharray": undefined }));
        }
      }
      // A hand-written note at the arrow's tail (R2).
      if (params.label) parts.push(labelCard(doc, params, clamp01((t - 0.05) / 0.4)));
      break;
    }
    case "circle": {
      const box = params.target.box!;
      const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
      const rx = (box.x1 - box.x0) / 2 * 1.16 + 0.5 * em, ry = (box.y1 - box.y0) / 2 * 1.22 + 0.5 * em;
      const tilt = -6 * Math.PI / 180;
      const points: Pt[] = Array.from({ length: 72 }, (_, i) => {
        const a = -1.9 + (i / 71) * (2 * Math.PI + 0.55);
        const r = 1 + 0.035 * valueNoise1D(i * 0.2, params.seed + 7) + 0.03 * (i / 71);
        const x = Math.cos(a) * rx * r, y = Math.sin(a) * ry * r;
        return [cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)] as Pt;
      });
      strokes.push(stroke(params, revealed(points, curve("quintOut", clamp01(t / 0.55))), { "stroke-dasharray": undefined }));
      if (params.label) parts.push(labelCard(doc, params, clamp01((t - 0.35) / 0.4)));
      break;
    }
    case "underline": {
      const box = params.target.box!;
      const y = box.y1 + 0.3 * em, x0 = box.x0 - 0.2 * em, x1 = box.x1 + 0.35 * em;
      const points: Pt[] = Array.from({ length: 30 }, (_, i) => {
        const u = i / 29;
        return [lerp(x0, x1, u), y - u * 0.25 * em + Math.sin(u * Math.PI * 1.3) * 0.12 * em] as Pt;
      });
      strokes.push(stroke(params, revealed(wobble(points, 0.08 * em, params.seed), curve("quintOut", clamp01(t / 0.38))), { "stroke-dasharray": undefined }));
      if (params.label) parts.push(labelCard(doc, params, clamp01((t - 0.25) / 0.4)));
      break;
    }
    case "pin": {
      const point = params.target.point!;
      const drop = curve("springLand", clamp01(t / 0.55));
      const y = lerp(point.y - 3.2 * em, point.y, drop);
      const r = 0.95 * em, top = y - 2.2 * em;
      const pinD = `M${fmt(point.x, 1)} ${fmt(y, 1)}C${fmt(point.x - 0.25 * em, 1)} ${fmt(y - 0.7 * em, 1)} ${fmt(point.x - r, 1)} ${fmt(top + r * 0.55, 1)} ${fmt(point.x - r, 1)} ${fmt(top, 1)}`
        + `A${fmt(r, 1)} ${fmt(r, 1)} 0 1 1 ${fmt(point.x + r, 1)} ${fmt(top, 1)}C${fmt(point.x + r, 1)} ${fmt(top + r * 0.55, 1)} ${fmt(point.x + 0.25 * em, 1)} ${fmt(y - 0.7 * em, 1)} ${fmt(point.x, 1)} ${fmt(y, 1)}Z`;
      parts.push(ellipse(point.x, point.y, 0.75 * em * lerp(0.4, 1, drop), 0.22 * em * lerp(0.4, 1, drop), { fill: params.colors.shadow, opacity: op(0.35 * drop) }));
      parts.push(g({ filter: dropShadow(doc, { box: { x0: point.x - r, y0: top - r, x1: point.x + r, y1: y }, sigma: 0.2 * em, dy: 0.1 * em, color: params.colors.shadow, opacity: 0.4 }),
        opacity: op(Math.min(1, t / 0.08)) }, path(pinD, { fill: params.colors.pin }), circle(point.x, top, r * 0.42, { fill: params.colors.pinCore })));
      if (params.label) parts.push(labelCard(doc, params, clamp01((t - 0.32) / 0.45)));
      break;
    }
    case "callout": {
      const target = params.target.point ?? { x: (params.target.box!.x0 + params.target.box!.x1) / 2, y: (params.target.box!.y0 + params.target.box!.y1) / 2 };
      const label = params.label!;
      const start = { x: label.x, y: label.y + (target.y > label.y ? 1 : -1) * label.size * 0.9 };
      const mid = { x: (start.x + target.x) / 2 + (target.y - start.y) * 0.25, y: (start.y + target.y) / 2 - (target.x - start.x) * 0.25 };
      const points: Pt[] = Array.from({ length: 30 }, (_, i) => {
        const u = i / 29;
        return [(1 - u) ** 2 * start.x + 2 * (1 - u) * u * mid.x + u * u * target.x, (1 - u) ** 2 * start.y + 2 * (1 - u) * u * mid.y + u * u * target.y] as Pt;
      });
      const p = curve("quintOut", clamp01((t - 0.25) / 0.5));
      strokes.push(stroke(params, revealed(points, p)));
      if (p > 0.95) parts.push(circle(target.x, target.y, 0.32 * em * curve("backOutSoft", clamp01((p - 0.95) / 0.05)), { fill: params.colors.stroke }));
      parts.push(labelCard(doc, params, clamp01(t / 0.45)));
      break;
    }
    case "marker": {
      const point = params.target.point!;
      const pop = curve("springPop", clamp01(t / 0.45));
      for (const delay of [0.2, 0.55]) {
        const p = clamp01((t - delay) / 0.6);
        if (p > 0 && p < 1) parts.push(circle(point.x, point.y, lerp(0.9, 2.4, curve("expoOut", p)) * em, { fill: "none", stroke: params.colors.marker,
          "stroke-width": Number(fmt(0.12 * em, 2)), opacity: op(1 - p) }));
      }
      const number = textPath(String(params.number ?? 1), { font: "display", weight: 900 }, 1.0 * em, point.x, point.y);
      parts.push(g({ transform: transform(tf.translate(point.x, point.y), tf.scale(lerp(0.3, 1, pop)), tf.translate(-point.x, -point.y)),
        filter: dropShadow(doc, { box: { x0: point.x - em, y0: point.y - em, x1: point.x + em, y1: point.y + em }, sigma: 0.2 * em, dy: 0.1 * em, color: params.colors.shadow, opacity: 0.45 }) },
      circle(point.x, point.y, 0.9 * em, { fill: params.colors.marker }), path(number.d, { fill: params.colors.markerText })));
      if (params.label) parts.push(labelCard(doc, params, clamp01((t - 0.25) / 0.45)));
      break;
    }
  }
  // Strokes sit on a soft shadow so they read over bright or busy footage.
  let strokeLayer = strokes.join("");
  if (strokes.length && (params.strokeShadow ?? 0) > 0) {
    const xs: number[] = [], ys: number[] = [];
    const add = (x: number, y: number) => { xs.push(x); ys.push(y); };
    if (params.target.box) { add(params.target.box.x0, params.target.box.y0); add(params.target.box.x1, params.target.box.y1); }
    if (params.target.point) add(params.target.point.x, params.target.point.y);
    if (params.from) add(params.from.x, params.from.y);
    if (params.label) add(params.label.x, params.label.y);
    if (params.mark === "arrow" && !params.from && params.target.point) add(params.target.point.x - 6 * em, params.target.point.y + 5 * em);
    const pad = 2.5 * em;
    const box = { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
    strokeLayer = g({ filter: dropShadow(doc, { box, sigma: params.strokeWidth * 0.9, dy: params.strokeWidth * 0.4, color: params.colors.shadow, opacity: params.strokeShadow! }) }, strokes);
  }
  return doc.render(g({ opacity: op(exit) }, strokeLayer, parts));
}
