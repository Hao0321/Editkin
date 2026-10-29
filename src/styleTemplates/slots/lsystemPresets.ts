import { growLSystemV1, type LSegmentV1, type LSystemGrammarV1, type LSystemResultV1, type LTipV1, type Vec3V1 } from "./lsystem";

/**
 * S9 presets (browser-safe): a grammar, how it is arranged (one plant, or radial arms), its default palette and look, and
 * where the title goes. The same grammar drives the 2D strokes and the 3D tubes.
 */

export const LSYSTEM_PRESET_IDS_V1 = ["tree", "fern", "coral", "lightning", "neuron", "circuit", "vine_frame"] as const;
export type LSystemPresetIdV1 = typeof LSYSTEM_PRESET_IDS_V1[number];

export interface LSystemPresetV1 {
  readonly id: LSystemPresetIdV1;
  readonly grammar: LSystemGrammarV1;
  /** Default iterations (2D); 3D clamps further by the mesh budget. */
  readonly iterations: number;
  /** Radial arrangement: `count` arms around the origin (each `lanes` parallel traces `laneSpacing` apart), starting `radius` out. */
  readonly arms?: { readonly count: number; readonly lanes?: number; readonly laneSpacing?: number; readonly radius?: number; readonly startDegrees?: number };
  readonly anchor: "bottom" | "center" | "top" | "frame";
  readonly palette: { readonly bg: string; readonly branch: string; readonly tip: string; readonly bloom: string; readonly accent: string };
  /** Root stroke width at 1080 px (2D), how fast it tapers per depth, the tip mark, glow strength. */
  readonly look: { readonly widthPx: number; readonly taper: number; readonly minWidthPx: number; readonly tip: "blossom" | "dot" | "pad" | "leaf" | "spark" | "bud"; readonly tipPx: number; readonly glow: number; readonly linecap: "round" | "butt" };
  readonly title: "bloom" | "center" | "strike" | "frame";
}

const tree: LSystemPresetV1 = {
  id: "tree", iterations: 9, anchor: "bottom", title: "bloom",
  // A spreading crown: a trunk, then forks (sometimes with a leader), each depth shorter, bending up a little.
  grammar: { axiom: "X", rules: { X: [{ to: "F[+X][-X]", weight: 1 }, { to: "F[++X][-X][X]", weight: 0.4 }, { to: "F[+X][--X][X]", weight: 0.4 }, { to: "F[+X]X", weight: 0.25 }, { to: "F[-X]X", weight: 0.25 }] },
    angle: 27, step: 1, width: 1, widthScale: 0.72, lengthScale: 0.85, tropism: -0.03, jitter: { angle: 9, length: 0.18 }, tipSymbols: "X" },
  palette: { bg: "#07090C", branch: "#E9DCC6", tip: "#F7B8CC", bloom: "#FFE3A6", accent: "#F7B8CC" },
  look: { widthPx: 34, taper: 0.72, minWidthPx: 1.1, tip: "blossom", tipPx: 10, glow: 0.8, linecap: "round" },
};

const fern: LSystemPresetV1 = {
  id: "fern", iterations: 5, anchor: "bottom", title: "bloom",
  grammar: { axiom: "X", rules: { X: "F+[[X]-X]-F[-FX]+X", F: "FF" }, angle: 22.5, step: 1, width: 1, widthScale: 0.78, jitter: { angle: 3, length: 0.08 }, tipSymbols: "X" },
  palette: { bg: "#050A08", branch: "#7FE0A0", tip: "#D8FFE0", bloom: "#A8FFD0", accent: "#7FE0A0" },
  look: { widthPx: 9, taper: 0.8, minWidthPx: 1, tip: "dot", tipPx: 3, glow: 1, linecap: "round" },
};

const coral: LSystemPresetV1 = {
  id: "coral", iterations: 5, anchor: "bottom", title: "bloom",
  grammar: { axiom: "X", rules: { X: [{ to: "F[+X]F[-X]X", weight: 1 }, { to: "F[-X][+X]", weight: 0.7 }, { to: "FF[+X]X", weight: 0.5 }, { to: "FF[-X]X", weight: 0.5 }] },
    angle: 32, step: 1, width: 1, widthScale: 0.8, lengthScale: 0.9, jitter: { angle: 12, length: 0.25 }, tipSymbols: "X" },
  palette: { bg: "#0A0610", branch: "#FF7A6B", tip: "#FFD3A8", bloom: "#FF9A8A", accent: "#FFB86B" },
  look: { widthPx: 30, taper: 0.8, minWidthPx: 6, tip: "bud", tipPx: 9, glow: 0.7, linecap: "round" },
};

const lightning: LSystemPresetV1 = {
  id: "lightning", iterations: 14, anchor: "top", title: "strike",
  grammar: { axiom: "A", rules: { A: [{ to: "F-F+A", weight: 3 }, { to: "F+F-A", weight: 3 }, { to: "F[+FF-F!F]A", weight: 1 }, { to: "F[-FF+F!F]A", weight: 1 }] },
    angle: 16, step: 1, width: 1, widthScale: 0.55, jitter: { angle: 16, length: 0.35 }, heading: [0, -1, 0], tipSymbols: "" },
  palette: { bg: "#04060E", branch: "#FFFFFF", tip: "#8FE6FF", bloom: "#8FE6FF", accent: "#B9A8FF" },
  look: { widthPx: 7, taper: 0.55, minWidthPx: 1, tip: "spark", tipPx: 6, glow: 1.4, linecap: "round" },
};

const neuron: LSystemPresetV1 = {
  id: "neuron", iterations: 8, anchor: "center", title: "center", arms: { count: 7, radius: 3.2 },
  grammar: { axiom: "A", rules: { A: [{ to: "F[+A][-A]", weight: 1.3 }, { to: "FA", weight: 1.2 }, { to: "F[+A]A", weight: 0.6 }, { to: "F[-A]A", weight: 0.6 }, { to: "FL", weight: 0.25 }] },
    angle: 28, step: 1, width: 1, widthScale: 0.72, lengthScale: 0.93, jitter: { angle: 14, length: 0.3 }, tipSymbols: "AL" },
  palette: { bg: "#04050D", branch: "#8E8CFF", tip: "#E8F0FF", bloom: "#9C7CFF", accent: "#5CE4F4" },
  look: { widthPx: 9, taper: 0.72, minWidthPx: 1, tip: "dot", tipPx: 4, glow: 1.2, linecap: "round" },
};

const circuit: LSystemPresetV1 = {
  id: "circuit", iterations: 7, anchor: "center", title: "center", arms: { count: 4, lanes: 4, laneSpacing: 2.2, radius: 7 },
  grammar: { axiom: "A", rules: { A: [{ to: "FFA", weight: 2.4 }, { to: "F[+FFA]FA", weight: 0.4 }, { to: "F[-FFA]FA", weight: 0.4 }, { to: "FF+FFA", weight: 0.6 }, { to: "FF-FFA", weight: 0.6 }, { to: "FFL", weight: 0.5 }] },
    angle: 90, step: 1, width: 1, widthScale: 1, tipSymbols: "AL" },
  palette: { bg: "#03100C", branch: "#33E0A0", tip: "#F6D06A", bloom: "#7CFFD0", accent: "#F6D06A" },
  look: { widthPx: 3.4, taper: 1, minWidthPx: 3, tip: "pad", tipPx: 7, glow: 1, linecap: "round" },
};

/** Tendrils that grow off a framing stem (the stem itself is laid along the frame by the renderer). */
const vineFrame: LSystemPresetV1 = {
  id: "vine_frame", iterations: 5, anchor: "frame", title: "frame",
  // A tendril: a curl that tightens (each " shortens the step) with leaves on short stalks, or a leafy sprig.
  grammar: { axiom: "C", rules: { C: [{ to: 'F"+F"+[-FL]F"+F"+C', weight: 1 }, { to: 'F"+[+FL]F"+F"+C', weight: 1 }, { to: "F[+FL][-FL]FL", weight: 0.35 }] },
    angle: 26, step: 1, width: 1, widthScale: 0.8, shrink: 0.86, jitter: { angle: 7, length: 0.15 }, tipSymbols: "L" },
  palette: { bg: "#F3EDE1", branch: "#2E5A3C", tip: "#C4506A", bloom: "#F6E2B4", accent: "#2E5A3C" },
  look: { widthPx: 5, taper: 0.8, minWidthPx: 1.2, tip: "leaf", tipPx: 16, glow: 0, linecap: "round" },
};

export const LSYSTEM_PRESETS_V1: Readonly<Record<LSystemPresetIdV1, LSystemPresetV1>> = { tree, fern, coral, lightning, neuron, circuit, vine_frame: vineFrame };

/** Merges several results (re-indexing segments and parents). */
export function mergeLSystemResultsV1(parts: readonly LSystemResultV1[]): LSystemResultV1 {
  const segments: LSegmentV1[] = [], tips: LTipV1[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let generations = 0, symbols = 0;
  for (const part of parts) {
    const offset = segments.length;
    for (const segment of part.segments) segments.push({ ...segment, index: segment.index + offset, parent: segment.parent >= 0 ? segment.parent + offset : -1 });
    for (const tip of part.tips) tips.push({ ...tip, segment: tip.segment >= 0 ? tip.segment + offset : -1 });
    for (let i = 0; i < 3; i += 1) { min[i] = Math.min(min[i], part.bounds.min[i]); max[i] = Math.max(max[i], part.bounds.max[i]); }
    generations = Math.max(generations, part.generations); symbols += part.symbols;
  }
  return { segments, tips, bounds: { min, max }, generations, symbols };
}

/** Moves and turns a result in the x/y plane (2D arrangement of arms and lanes). */
export function placeLSystemResultV1(result: LSystemResultV1, degrees: number, dx: number, dy: number): LSystemResultV1 {
  const r = (degrees * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const p = (v: Vec3V1): Vec3V1 => [v[0] * c - v[1] * s + dx, v[0] * s + v[1] * c + dy, v[2]];
  const d = (v: Vec3V1): Vec3V1 => [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
  const segments = result.segments.map(segment => ({ ...segment, a: p(segment.a), b: p(segment.b) }));
  const tips = result.tips.map(tip => ({ ...tip, at: p(tip.at), heading: d(tip.heading) }));
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const segment of segments) for (const v of [segment.a, segment.b]) for (let i = 0; i < 3; i += 1) { min[i] = Math.min(min[i], v[i]); max[i] = Math.max(max[i], v[i]); }
  return { ...result, segments, tips, bounds: { min, max } };
}

/** Grows a preset (one plant, or its radial arms and lanes), deterministic for the seed. */
export function growPresetV1(preset: LSystemPresetV1, seed: number, iterations = preset.iterations): LSystemResultV1 {
  if (!preset.arms) return growLSystemV1(preset.grammar, iterations, seed);
  const { count, lanes = 1, laneSpacing = 1, radius = 0, startDegrees = 0 } = preset.arms;
  const parts: LSystemResultV1[] = [];
  for (let arm = 0; arm < count; arm += 1) {
    const degrees = startDegrees + (360 * arm) / count, r = (degrees * Math.PI) / 180;
    // The arm grows "up" in its own frame; turned so up points outward at this angle.
    const out: [number, number] = [-Math.sin(r), Math.cos(r)], side: [number, number] = [Math.cos(r), Math.sin(r)];
    for (let lane = 0; lane < lanes; lane += 1) {
      const offset = (lane - (lanes - 1) / 2) * laneSpacing;
      const grown = growLSystemV1(preset.grammar, iterations, seed + arm * 7919 + lane * 104729);
      parts.push(placeLSystemResultV1(grown, degrees, out[0] * radius + side[0] * offset, out[1] * radius + side[1] * offset));
    }
  }
  return mergeLSystemResultsV1(parts);
}
