import { fmt } from "../../motionLibrary/svg/document";
import { layoutLine, MotionLibraryGlyphError, translatePathD, type LineLayout, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import { clamp01 } from "../../motionLibrary/svg/easing";

/**
 * Type helpers shared by the composited templates (browser-safe): every string is laid out with Editkin's bundled faces
 * as glyph outlines (motionLibrary/svg/glyphs), centred on its ink box, fitted to a width, and animated per glyph.
 */

/** A Latin label face (Bebas Neue) when it draws every character, else Noto Sans TC (the same role ladder VA's captions use). */
export function labelFace(text: string, fallbackWeight = 700): MotionFontSelector {
  try { layoutLine(text, { font: "latin", size: 100 }); return { font: "latin", weight: 400 }; } catch (error) {
    if (error instanceof MotionLibraryGlyphError) return { font: "display", weight: fallbackWeight };
    throw error;
  }
}

/** True when every character has a glyph in the face. */
export function faceDraws(text: string, face: MotionFontSelector): boolean {
  try { layoutLine(text, { ...face, size: 100 }); return true; } catch (error) {
    if (error instanceof MotionLibraryGlyphError) return false;
    throw error;
  }
}

/** Ink width of a line at `size` px. */
export function inkWidth(text: string, face: MotionFontSelector, size: number, tracking = 0): number {
  const line = layoutLine(text, { ...face, size, tracking });
  return line.inkBox ? line.inkBox.x1 - line.inkBox.x0 : line.width;
}

/** The size (≤ maxSize) at which the line's ink fits maxWidth. */
export function fitLine(text: string, face: MotionFontSelector, maxSize: number, tracking: number, maxWidth: number): number {
  const width = inkWidth(text, face, 100, tracking);
  return Math.min(maxSize, (maxWidth / Math.max(width, 1e-6)) * 100);
}

export interface PlacedLineV1 {
  readonly layout: LineLayout;
  /** Translation that puts the ink box where it was asked to be. */
  readonly dx: number;
  readonly dy: number;
  /** Ink box in frame px. */
  readonly box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  readonly d: string;
}

/**
 * One line with its ink box anchored at (x, y): align "center" centres it, "start" puts the ink's left edge at x;
 * vertical "middle" centres the ink, "top" puts the ink top at y, "baseline" puts the baseline at y.
 */
export function placeLine(text: string, face: MotionFontSelector, size: number, tracking: number, x: number, y: number,
  align: "center" | "start" | "end" = "center", vertical: "middle" | "top" | "baseline" = "middle"): PlacedLineV1 {
  const layout = layoutLine(text, { ...face, size, tracking });
  const ink = layout.inkBox ?? { x0: 0, y0: -size * 0.75, x1: layout.width, y1: 0 };
  const dx = align === "center" ? x - (ink.x0 + ink.x1) / 2 : align === "start" ? x - ink.x0 : x - ink.x1;
  const dy = vertical === "middle" ? y - (ink.y0 + ink.y1) / 2 : vertical === "top" ? y - ink.y0 : y;
  return { layout, dx, dy, box: { x0: ink.x0 + dx, y0: ink.y0 + dy, x1: ink.x1 + dx, y1: ink.y1 + dy }, d: translatePathD(layout.pathD, dx, dy) };
}

/** Per-glyph outlines of a placed line (blanks skipped), each with its ink centre in frame px. */
export function placedGlyphs(line: PlacedLineV1): Array<{ d: string; cx: number; cy: number; index: number; x0: number; x1: number }> {
  return line.layout.glyphs.flatMap(glyph => {
    if (glyph.whitespace || !glyph.bbox) return [];
    const ox = glyph.x + line.dx, oy = line.dy;
    return [{ d: translatePathD(glyph.pathD, ox, oy), cx: ox + (glyph.bbox.x0 + glyph.bbox.x1) / 2, cy: oy + (glyph.bbox.y0 + glyph.bbox.y1) / 2,
      index: glyph.index, x0: ox + glyph.bbox.x0, x1: ox + glyph.bbox.x1 }];
  });
}

/** Stagger: local progress of item i of n for a group entering over [start, start + duration] with `step` between items. */
export function stagger(t: number, start: number, duration: number, step: number, index: number): number {
  return clamp01((t - start - step * index) / Math.max(1e-6, duration));
}

/** SVG transform of a scale/rotation about (cx, cy) plus a translation (undefined when it is the identity). */
export function poseAbout(cx: number, cy: number, pose: { dx?: number; dy?: number; scale?: number; scaleX?: number; scaleY?: number; rotate?: number; skewX?: number }): string | undefined {
  const sx = pose.scaleX ?? pose.scale ?? 1, sy = pose.scaleY ?? pose.scale ?? 1, r = pose.rotate ?? 0, k = pose.skewX ?? 0, dx = pose.dx ?? 0, dy = pose.dy ?? 0;
  if (sx === 1 && sy === 1 && !r && !k && !dx && !dy) return undefined;
  const parts = [`translate(${fmt(cx + dx, 2)} ${fmt(cy + dy, 2)})`];
  if (r) parts.push(`rotate(${fmt(r, 3)})`);
  if (k) parts.push(`skewX(${fmt(k, 3)})`);
  if (sx !== 1 || sy !== 1) parts.push(`scale(${fmt(sx, 3)} ${fmt(sy, 3)})`);
  parts.push(`translate(${fmt(-cx, 2)} ${fmt(-cy, 2)})`);
  return parts.join(" ");
}

/** Frame-size SVG document with a transparent background. */
export function svgFrame(width: number, height: number, body: string, defs = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
}
