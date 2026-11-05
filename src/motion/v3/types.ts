import type { EditProject, MotionDesignV3TemplateId, MotionGraphic } from "../../domain/types";

export interface V3Rect { x: number; y: number; width: number; height: number }

/** Absolute canvas pixels; "b" carries three points (two controls, then the end point). */
export interface V3PathCommand { op: "m" | "l" | "b"; points: number[] }

interface V3OpBase {
  /** Stable within one graphic, so adapters can merge identical consecutive frames. */
  id: string;
  /** Paint order inside the graphic; higher draws on top. */
  layer: number;
  opacity: number;
  /** Gaussian softness in canvas pixels (both adapters map it to their own blur). */
  blur?: number;
  clip?: V3Rect;
}

export interface V3ShapeOp extends V3OpBase {
  kind: "shape";
  path: V3PathCommand[];
  color: string;
}

export interface V3TextOp extends V3OpBase {
  kind: "text";
  text: string;
  /** Left edge and top of the CSS line box. */
  x: number;
  y: number;
  lineHeight: number;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  letterSpacing: number;
  color: string;
  /** Uniform scale around the line box's top-left corner. */
  scale?: number;
}

export type V3Op = V3ShapeOp | V3TextOp;

export interface V3Paint { color: string; alpha: number }

export interface V3Palette {
  text: V3Paint;
  surface: V3Paint;
  accent: V3Paint;
  /** Readable ink for text drawn on the accent colour. */
  onAccent: V3Paint;
}

export interface V3Canvas {
  width: number;
  height: number;
  /** Design unit: 1 at 1080 on the short side. */
  unit: number;
  portrait: boolean;
  /** Title-safe rectangle for this aspect ratio. */
  safe: V3Rect;
}

export interface V3Context {
  project: Pick<EditProject, "width" | "height" | "fps">;
  graphic: MotionGraphic;
  canvas: V3Canvas;
  palette: V3Palette;
  lines: string[];
  fps: number;
  durationFrames: number;
}

export interface V3Layout<T = unknown> {
  /** Block bounds after safe-area clamping; adapters never need it, previews and tests do. */
  box: V3Rect;
  /** Template-private geometry computed once per layout. */
  data: T;
}

export interface V3Template<T = unknown> {
  id: MotionDesignV3TemplateId;
  /** Where x/y anchor the block: its left, centre or right edge. */
  align: "left" | "center" | "right";
  layout(context: V3Context): V3Layout<T>;
  frame(context: V3Context, layout: V3Layout<T>, localFrame: number): V3Op[];
  /** Every bundled face the template may draw with, for physical-font verification. */
  faces(graphic: MotionGraphic): Array<{ family: string; weight: number }>;
}

/** Erase a template's private layout type for the registry (layout and frame pair up at runtime). */
export function defineTemplate<T>(template: V3Template<T>): V3Template<unknown> {
  return template as unknown as V3Template<unknown>;
}
