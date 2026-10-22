import { createSvgDocument, fe, fmt, g, path, rect, transform, tf } from "../../motionLibrary/svg/document";
import { clamp01, curve, lerp } from "../../motionLibrary/svg/easing";
import { fitFontSize, layoutLine, translatePathD, type GlyphBox, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import type { SectionStyle } from "../types";

/**
 * C2 section titles (design §2.1; brief §4).
 *
 * - bleed: huge display or serif words that run off one frame edge (R1's
 *   「動畫」/「一鍵」 look). Settle-in entry: per-character stagger, blur-in
 *   (≤ 8 px) and a scale settle, then a slow outward drift, then a clean exit
 *   (fast fade with a small push and blur).
 * - punchCard: a full-colour card with one big word (R1's 「再換！」). The card
 *   cuts in, the word pops with overshoot, the card cuts out.
 */

export const SECTION_TITLE_REVISION = 1;

export interface SectionTitleParams {
  readonly component: "section";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly style: SectionStyle;
  readonly text: string;
  readonly font: MotionFontSelector;
  readonly tracking: number;
  /** Glyph size in px (resolved by the compiler). */
  readonly size: number;
  readonly color: string;
  readonly duration: number;
  /** bleed: which edge the word runs off, the share of its ink width beyond that edge, and its vertical centre (px). */
  readonly edge: "left" | "right" | "bottom" | "top";
  readonly bleed: number;
  readonly centerY: number;
  readonly scrim?: { readonly color: string; readonly opacity: number };
  /** punchCard: the plate colour. */
  readonly plate?: string;
}

/** Layout (ink-aligned glyph paths in frame px) for a bleed or punch-card word. */
export function layoutSectionTitle(params: SectionTitleParams): { glyphs: Array<{ pathD: string; ink: GlyphBox }>; ink: GlyphBox } {
  const line = layoutLine(params.text, { ...params.font, size: params.size, tracking: params.tracking });
  const ink = line.inkBox ?? { x0: 0, y0: -params.size * 0.8, x1: line.width, y1: 0 };
  const inkW = ink.x1 - ink.x0, inkH = ink.y1 - ink.y0;
  let ox: number, oy: number;
  if (params.style === "punchCard") {
    ox = params.width / 2 - (ink.x0 + inkW / 2);
    oy = params.height / 2 - (ink.y0 + inkH / 2);
  } else {
    const cut = inkW * params.bleed, cutY = inkH * params.bleed;
    switch (params.edge) {
      case "left": ox = -cut - ink.x0; oy = params.centerY - (ink.y0 + inkH / 2); break;
      case "right": ox = params.width + cut - ink.x1; oy = params.centerY - (ink.y0 + inkH / 2); break;
      case "top": ox = params.width / 2 - (ink.x0 + inkW / 2); oy = -cutY - ink.y0; break;
      default: ox = params.width / 2 - (ink.x0 + inkW / 2); oy = params.height + cutY - ink.y1;
    }
  }
  const glyphs = line.glyphs.filter(glyph => !glyph.whitespace && glyph.bbox).map(glyph => ({
    pathD: translatePathD(glyph.pathD, glyph.x + ox, oy),
    ink: { x0: glyph.bbox!.x0 + glyph.x + ox, y0: glyph.bbox!.y0 + oy, x1: glyph.bbox!.x1 + glyph.x + ox, y1: glyph.bbox!.y1 + oy },
  }));
  return { glyphs, ink: { x0: ink.x0 + ox, y0: ink.y0 + oy, x1: ink.x1 + ox, y1: ink.y1 + oy } };
}

/** Size a bleed word: its visible part spans the frame to the far margin, capped by a height share. */
export function sectionBleedSize(text: string, font: MotionFontSelector, tracking: number, frame: { width: number; height: number },
  bleed: number, maxHeightShare: number): number {
  const margin = 0.05;
  const visible = frame.width * (1 - margin);
  const targetInkWidth = visible / Math.max(0.01, 1 - bleed);
  return fitFontSize([text], { ...font, tracking }, { maxWidth: targetInkWidth, maxHeight: frame.height * maxHeightShare, maxSize: 4000, minSize: 40 });
}

export function sectionTitleFrame(params: SectionTitleParams, t: number): string {
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "st" });
  const layout = layoutSectionTitle(params);
  if (params.style === "punchCard") return punchCardFrame(doc, params, layout, t);
  const exitStart = params.duration - 0.26;
  const exitP = clamp01((t - exitStart) / 0.26), exitE = curve("snapIn", exitP);
  const drift = (params.edge === "left" ? -1 : params.edge === "right" ? 1 : 0) * params.width * 0.018 * clamp01(t / params.duration);
  const driftY = (params.edge === "top" ? -1 : params.edge === "bottom" ? 1 : 0) * params.height * 0.012 * clamp01(t / params.duration);
  const parts: string[] = [];
  if (params.scrim && params.scrim.opacity > 0) {
    const fade = clamp01(t / 0.3) * (1 - exitE);
    const inkH = layout.ink.y1 - layout.ink.y0, cy = (layout.ink.y0 + layout.ink.y1) / 2, band = inkH * 1.9;
    const fill = doc.linearGradient({ x1: 0, y1: cy - band / 2, x2: 0, y2: cy + band / 2, units: "userSpaceOnUse", stops: [
      { offset: 0, color: params.scrim.color, opacity: 0 }, { offset: 0.5, color: params.scrim.color, opacity: params.scrim.opacity }, { offset: 1, color: params.scrim.color, opacity: 0 }] });
    parts.push(g({ opacity: fade < 0.999 ? Number(fmt(fade, 3)) : undefined }, rect(0, cy - band / 2, params.width, band, { fill })));
  }
  const count = layout.glyphs.length;
  layout.glyphs.forEach((glyph, index) => {
    // Settle-in: characters arrive in reading order 50 ms apart (outer edge last for a left bleed reads as a sweep).
    const local = t - index * Math.min(0.05, 0.3 / Math.max(1, count));
    if (local < 0) return;
    const pIn = clamp01(local / 0.62), eScale = curve("expoOut", pIn), eBlur = curve("quintOut", clamp01(local / 0.42));
    const opacity = Math.min(1, local / 0.2) * (1 - exitE);
    if (opacity <= 0.001) return;
    const blur = Math.max(8 * (1 - eBlur), 6 * exitE);
    const scale = lerp(1.16, 1, eScale) * (1 + 0.05 * exitE);
    const cx = (glyph.ink.x0 + glyph.ink.x1) / 2, cy = (glyph.ink.y0 + glyph.ink.y1) / 2;
    const pad = blur * 3 + 4;
    const filter = blur >= 0.05 ? doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: Number(fmt(blur, 2)) }),
      { x: Number(fmt(glyph.ink.x0 - pad - params.size * 0.2, 1)), y: Number(fmt(glyph.ink.y0 - pad - params.size * 0.2, 1)),
        width: Number(fmt(glyph.ink.x1 - glyph.ink.x0 + 2 * pad + params.size * 0.4, 1)), height: Number(fmt(glyph.ink.y1 - glyph.ink.y0 + 2 * pad + params.size * 0.4, 1)) }) : undefined;
    parts.push(g({ transform: transform(tf.translate(cx + drift, cy + driftY), tf.scale(scale), tf.translate(-cx, -cy)), opacity: opacity < 0.999 ? Number(fmt(opacity, 3)) : undefined },
      filter ? g({ filter }, path(glyph.pathD, { fill: params.color })) : path(glyph.pathD, { fill: params.color })));
  });
  return doc.render(...parts);
}

function punchCardFrame(doc: ReturnType<typeof createSvgDocument>, params: SectionTitleParams, layout: ReturnType<typeof layoutSectionTitle>, t: number): string {
  const plate = rect(0, 0, params.width, params.height, { fill: params.plate ?? "#000000" });
  // The word pops with overshoot; a 2% breath keeps the hold alive; the card leaves on a cut.
  const p = clamp01(t / 0.42);
  const scale = lerp(0.45, 1, curve("springPop", p)) * (1 + 0.02 * clamp01((t - 0.42) / Math.max(0.1, params.duration - 0.42)));
  const rotation = -6 * (1 - curve("backOutSoft", p));
  const cx = (layout.ink.x0 + layout.ink.x1) / 2, cy = (layout.ink.y0 + layout.ink.y1) / 2;
  const word = g({ transform: transform(tf.translate(cx, cy), rotation ? tf.rotate(rotation) : false, tf.scale(scale), tf.translate(-cx, -cy)),
    opacity: t < 0.05 ? Number(fmt(clamp01(0.3 + t / 0.05), 3)) : undefined }, path(layout.glyphs.map(glyph => glyph.pathD).join(""), { fill: params.color }));
  return doc.render(plate, word);
}
