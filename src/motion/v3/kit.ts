import type { EditProject, MotionGraphic } from "../../domain/types";
import { motionV3Lines } from "../../domain/motionCompositionV3Contract";
import { lerp } from "./easing";
import { roundRectPath, translatePath } from "./geometry";
import { baselineOffset, measureText, splitFaceRuns, type V3Font } from "./textMetrics";
import type { V3Canvas, V3Context, V3Paint, V3Palette, V3PathCommand, V3Rect, V3ShapeOp, V3TextOp } from "./types";

export const SANS = "Noto Sans TC";
export const SERIF = "Noto Serif TC";
export const DISPLAY = "Bebas Neue";

export function paint(hex: string, alphaScale = 1): V3Paint {
  const clean = hex.replace("#", "");
  const alpha = clean.length >= 8 ? Number.parseInt(clean.slice(6, 8), 16) / 255 : 1;
  return { color: `#${clean.slice(0, 6).toUpperCase()}`, alpha: alpha * alphaScale };
}

export function luminance(color: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(color.slice(1 + offset, 3 + offset), 16) / 255;
    return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  return .2126 * channel(0) + .7152 * channel(2) + .0722 * channel(4);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + .05) / (lo + .05);
}

/** Near-black or near-white, whichever reads better on `background`. */
export function inkOn(background: string): V3Paint {
  const dark = "#0E1014", light = "#FFFFFF";
  return { color: contrastRatio(dark, background) >= contrastRatio(light, background) ? dark : light, alpha: 1 };
}

export function paletteFor(graphic: MotionGraphic): V3Palette {
  const accent = paint(graphic.accentColor);
  return { text: paint(graphic.textColor), surface: paint(graphic.backgroundColor), accent, onAccent: inkOn(accent.color) };
}

/** Title-safe area: vertical formats keep clear of platform UI top and bottom. */
export function canvasFor(project: Pick<EditProject, "width" | "height">): V3Canvas {
  const { width, height } = project;
  const portrait = height > width;
  const unit = Math.min(width, height) / 1080;
  const safe = portrait
    ? { x: width * .074, y: height * .11, width: width * .852, height: height * .67 }
    : { x: width * .06, y: height * .075, width: width * .88, height: height * .85 };
  return { width, height, unit, portrait, safe };
}

/** ASS reads backslashes and braces as markup; both renderers draw the same full-width stand-ins. */
export function normalizeV3Copy(line: string): string {
  return line.replaceAll("\\", "＼").replaceAll("{", "｛").replaceAll("}", "｝");
}

export function contextFor(project: Pick<EditProject, "width" | "height" | "fps">, graphic: MotionGraphic): V3Context {
  const canvas = canvasFor(project);
  // v3 sizes are design pixels at a 1080-pixel short side, so a preset reads the same at 720p and 4K.
  const scaled = canvas.unit === 1 ? graphic : {
    ...graphic, fontSize: graphic.fontSize * canvas.unit,
    ...(graphic.letterSpacing !== undefined ? { letterSpacing: graphic.letterSpacing * canvas.unit } : {}),
  };
  return {
    project, graphic: scaled, canvas, palette: paletteFor(graphic), lines: motionV3Lines(graphic.text).map(normalizeV3Copy),
    fps: project.fps, durationFrames: Math.max(1, Math.round(graphic.duration * project.fps)),
  };
}

/** Anchor the block at the authored x/y (left, centre or right edge), then keep it title-safe. */
export function placeBlock(context: V3Context, width: number, height: number, align: "left" | "center" | "right"): V3Rect {
  const { canvas, graphic } = context;
  const anchorX = graphic.x * canvas.width, anchorY = graphic.y * canvas.height;
  const left = align === "center" ? anchorX - width / 2 : align === "right" ? anchorX - width : anchorX;
  const clampAxis = (value: number, size: number, start: number, span: number) =>
    size >= span ? start + (span - size) / 2 : Math.max(start, Math.min(start + span - size, value));
  return {
    x: clampAxis(left, width, canvas.safe.x, canvas.safe.width),
    y: clampAxis(anchorY, height, canvas.safe.y, canvas.safe.height),
    width, height,
  };
}

/** Largest text block width the template may use at this anchor. */
export function availableWidth(context: V3Context, align: "left" | "center" | "right"): number {
  const { canvas, graphic } = context;
  const authored = graphic.width * canvas.width;
  const anchor = graphic.x * canvas.width, safeRight = canvas.safe.x + canvas.safe.width;
  const room = align === "center" ? Math.min(anchor - canvas.safe.x, safeRight - anchor) * 2
    : align === "right" ? anchor - canvas.safe.x : safeRight - Math.max(anchor, canvas.safe.x);
  return Math.max(canvas.unit * 120, Math.min(authored, room > canvas.unit * 120 ? room : canvas.safe.width));
}

export function shape(id: string, layer: number, path: V3PathCommand[], fill: V3Paint, opacity = 1,
  extra: Partial<Pick<V3ShapeOp, "blur" | "clip">> = {}): V3ShapeOp {
  return { kind: "shape", id, layer, path, color: fill.color, opacity: fill.alpha * opacity, ...extra };
}

export function text(id: string, layer: number, props: Omit<V3TextOp, "kind" | "id" | "layer">): V3TextOp {
  return { kind: "text", id, layer, ...props };
}

/** Diffuse drop shadow under a panel: large, soft and low-contrast instead of a hard offset. */
export function panelShadow(id: string, layer: number, path: V3PathCommand[], unit: number, opacity: number, strength = 1): V3ShapeOp {
  return shape(id, layer, translatePath(path, 0, 10 * unit * strength), { color: "#000000", alpha: 1 }, .34 * strength * opacity, { blur: 22 * unit * strength });
}

/** Light ink (white-ish text) needs a dark scrim and shadow; dark ink needs neither. */
export const isLightInk = (color: string): boolean => luminance(color) > .35;

/** Soft contact shadow that keeps light text legible on bright footage without a box. */
export function textShadow(op: V3TextOp, opacity = .5): V3TextOp {
  return {
    ...op, id: `${op.id}:shadow`, layer: op.layer - 1, color: "#000000", opacity: isLightInk(op.color) ? op.opacity * opacity : 0,
    blur: Math.max(2, op.fontSize * .09), y: op.y + op.fontSize * .035,
  };
}

/** Masked line reveal: the line rises into its own box and leaves upward. */
export function revealLine(op: V3TextOp, enter: number, exit: number, clip: V3Rect, distance = op.lineHeight * .92): V3TextOp {
  const offset = lerp(distance, 0, enter) - distance * exit;
  return { ...op, y: op.y + offset, clip, opacity: op.opacity * Math.min(1, enter * 2.4) * (1 - exit * exit) };
}

export function rounded(rect: V3Rect, radius: number): V3PathCommand[] {
  return roundRectPath(rect.x, rect.y, rect.width, rect.height, radius);
}

export function expand(rect: V3Rect, dx: number, dy = dx): V3Rect {
  return { x: rect.x - dx, y: rect.y - dy, width: rect.width + dx * 2, height: rect.height + dy * 2 };
}

export const visibleOpacity = (enter: number, exit: number): number => Math.min(1, enter) * (1 - exit);

/** Set copy in a display face, handing characters it lacks (e.g. CJK units) to `fallback`. */
export function mixedRuns(copy: string, display: V3Font, fallback: V3Font): Array<{ text: string; font: V3Font; width: number }> {
  return splitFaceRuns(copy, display).map(run => {
    const font = run.primary ? display : fallback;
    return { text: run.text, font, width: measureText(run.text, font) };
  });
}

/** A text op set in `font` and `fill`, with `opacity` on top of the paint's alpha. */
export function setText(id: string, layer: number, font: V3Font, copy: string, x: number, y: number, fill: V3Paint, opacity = 1): V3TextOp {
  return text(id, layer, { text: copy, x, y, lineHeight: font.lineHeight, fontFamily: font.family, fontWeight: font.weight, fontSize: font.size, letterSpacing: font.letterSpacing, color: fill.color, opacity: fill.alpha * opacity });
}

/** Line-box top that puts the optical centre of caps, figures and ideographs at `centerY`. */
export function opticalTop(font: V3Font, centerY: number): number {
  return centerY + font.size * .37 - baselineOffset(font);
}

export const dim = (fill: V3Paint, alphaScale: number): V3Paint => ({ color: fill.color, alpha: fill.alpha * alphaScale });

/**
 * Soft scrim under panel-less copy. Nearly invisible on dark footage; on bright
 * footage it darkens just enough behind light ink (or lightens behind dark ink).
 */
export function scrim(id: string, rect: V3Rect, context: V3Context, presence: number, strength = 1): V3ShapeOp {
  const size = context.graphic.fontSize, light = isLightInk(context.palette.text.color);
  // Wide padding with a blur close to it reads as a vignette, not as a grey box.
  const area = expand(rect, size * .9, size * .7);
  return shape(id, 0, roundRectPath(area.x, area.y, area.width, area.height, size * .9), { color: light ? "#000000" : "#FFFFFF", alpha: 1 },
    (light ? .27 : .36) * strength * presence, { blur: size * .85 });
}
