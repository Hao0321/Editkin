import type { MotionFontSelector } from "../motionLibrary/svg/glyphs";
import { boxFromNormalized, type Box } from "./placement";
import { StylePlanError, type StyleFontRole, type StylePlanV1, type StyleTemplateV1, type StyleTextRefV1 } from "./types";

/** Helpers shared by the Phase A compiler (captions, sections, finish) and the Phase B kits (explainer, annotation, insert, sound). */

export const EPS = 1e-6;

export type StyleIssueSeverity = "error" | "warning";
export interface StyleCompileIssue { readonly severity: StyleIssueSeverity; readonly code: string; readonly beatIndex?: number; readonly detail: string }

export function fontOf(template: StyleTemplateV1, role: StyleFontRole): MotionFontSelector {
  const font = template.fonts[role];
  return font.weight === undefined ? { font: font.font } : { font: font.font, weight: font.weight };
}

/** Important regions (faces, passers-by, the subject, a UI focus area, a product) on screen during [from, to], in px. */
export function subjectBoxes(plan: StylePlanV1, from: number, to: number, frame: { width: number; height: number }): Box[] {
  return (plan.subjects ?? []).filter(subject => subject.from < to && subject.to > from).map(subject => boxFromNormalized(subject.box, frame));
}

/**
 * On-screen text for a widget: the spoken words of a wordRange (M10, preferred) or editorial text, which is
 * allowed but reported so the seal gate fact-checks it. A range may not span an untimed spoken word.
 */
export function resolveTextRef(plan: StylePlanV1, ref: StyleTextRefV1, issues: StyleCompileIssue[], beatIndex: number):
  { text: string; words?: StylePlanV1["words"] } {
  if ("wordRange" in ref) {
    const [a, b] = ref.wordRange;
    if (b >= plan.words.length) throw new StylePlanError("STYLE_WORD_RANGE", `word ${b} does not exist`);
    for (let index = a + 1; index <= b; index += 1) {
      if (plan.words[index].gapBefore) throw new StylePlanError("STYLE_WORD_GAP", `an untimed spoken word lies before "${plan.words[index].text}" (M10)`);
    }
    const words = plan.words.slice(a, b + 1);
    return { text: words.map(word => word.text).join(""), words };
  }
  issues.push({ severity: "warning", code: "STYLE_EDITORIAL_TEXT", beatIndex, detail: `"${ref.text}" is not from speech; the seal gate must fact-check it (M10)` });
  return { text: ref.text };
}

/** Frame-aligned time (s). */
export const frameTime = (seconds: number, fps: number) => Math.round(seconds * fps) / fps;
export const round2 = (value: number) => Math.round(value * 100) / 100;
export const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
export const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** A box kept clear for later layers (captions avoid widgets, PIP cards and annotation labels on screen at the same time). */
export interface OccupiedBox { readonly box: Box; readonly from: number; readonly to: number; readonly beatIndex: number }

export function occupiedDuring(occupied: readonly OccupiedBox[], from: number, to: number, except?: number): Box[] {
  return occupied.filter(entry => entry.beatIndex !== except && entry.from < to && entry.to > from).map(entry => entry.box);
}
