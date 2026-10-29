import { seededRandom } from "./raster";

/**
 * Deterministic Lindenmayer systems (browser-safe, pure) for S9 lsystem_growth: one seeded expander and one turtle,
 * shared by the 2D stroke renderer and the 3D (mesh3d tube_set) renderer.
 *
 * - **Expansion.** The axiom is rewritten `iterations` times. A rule maps one symbol to one successor or to weighted
 *   successors (a stochastic L-system); the choice is made with a seeded generator, so a seed always gives the same
 *   string. Every symbol carries the generation it was created in; a symbol a rule keeps (F → FF) keeps its generation,
 *   so subdividing a branch does not make it younger.
 * - **Turtle** (3D, Y up; 2D grammars simply never pitch or roll):
 *   F draw forward · f move forward · + − yaw by the angle · & ^ pitch · \ / roll · | turn around · [ ] push / pop a
 *   branch · ! thinner · " shorter and thinner (`shrink`) · L (or any `tipSymbols`) a tip: leaf, flower, synapse, pad.
 *   Other letters are placeholders.
 * - **Output.** Segments with generation, branch depth, path distance from the root and width; tips; bounds. The
 *   expander refuses to grow past a symbol budget, so callers clamp iterations before rendering.
 */

export type Vec3V1 = readonly [number, number, number];

export interface LSystemGrammarV1 {
  readonly axiom: string;
  /** symbol → successor, or weighted successors (stochastic). */
  readonly rules: Readonly<Record<string, string | ReadonlyArray<{ readonly to: string; readonly weight: number }>>>;
  /** Yaw angle for + and − (degrees). */
  readonly angle: number;
  /** Pitch for & ^ and roll for \ / (degrees; default: the angle). */
  readonly pitch?: number;
  readonly roll?: number;
  /** F length at the root. */
  readonly step: number;
  /** Length multiplier per branch depth (default 1). */
  readonly lengthScale?: number;
  /** Width at the root and its multiplier per branch depth (and per !). */
  readonly width: number;
  readonly widthScale?: number;
  /** Seeded variation: ± degrees on every turn, ± fraction on every F. */
  readonly jitter?: { readonly angle: number; readonly length: number };
  /** Gravity-like bend: each F turns the heading toward (0, −1, 0) by this fraction (negative: toward up). */
  readonly tropism?: number;
  /** Start heading (default up: (0, 1, 0)). */
  readonly heading?: Vec3V1;
  /** Symbols that mark a tip where they stand (default "L"; e.g. "LX" makes the last buds tips too). */
  readonly tipSymbols?: string;
  /** `"` multiplies the current step and width by this (default 1): a tightening curl, a thinning shoot. */
  readonly shrink?: number;
}

export interface LSymbolV1 { readonly char: string; readonly generation: number }

export interface LSegmentV1 {
  readonly index: number;
  readonly a: Vec3V1;
  readonly b: Vec3V1;
  /** Expansion generation the segment was created in (0 = axiom). */
  readonly generation: number;
  /** Branch nesting depth ([ … ]). */
  readonly depth: number;
  /** Path length from the root to the segment's start. */
  readonly distance: number;
  readonly width: number;
  /** Segment this one continues from (−1 at the root). */
  readonly parent: number;
}

export interface LTipV1 { readonly at: Vec3V1; readonly heading: Vec3V1; readonly generation: number; readonly depth: number; readonly distance: number; readonly segment: number }

export interface LSystemResultV1 {
  readonly segments: readonly LSegmentV1[];
  readonly tips: readonly LTipV1[];
  readonly bounds: { readonly min: Vec3V1; readonly max: Vec3V1 };
  readonly generations: number;
  readonly symbols: number;
}

export class LSystemBudgetError extends Error {
  constructor(readonly symbols: number, readonly limit: number) { super(`L-system grows past ${limit} symbols (${symbols})`); this.name = "LSystemBudgetError"; }
}

/** Rewrites the axiom; throws LSystemBudgetError past `maxSymbols`. */
export function expandLSystemV1(grammar: LSystemGrammarV1, iterations: number, seed: number, maxSymbols = 400_000): LSymbolV1[] {
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 16) throw new Error("iterations must be an integer in 0..16");
  const rand = seededRandom((seed * 2654435761) >>> 0);
  let current: LSymbolV1[] = [...grammar.axiom].map(char => ({ char, generation: 0 }));
  for (let generation = 1; generation <= iterations; generation += 1) {
    const next: LSymbolV1[] = [];
    for (const symbol of current) {
      const rule = grammar.rules[symbol.char];
      if (rule === undefined) { next.push(symbol); continue; }
      let successor: string;
      if (typeof rule === "string") successor = rule;
      else {
        const total = rule.reduce((sum, option) => sum + option.weight, 0);
        let pick = rand() * total;
        successor = rule[rule.length - 1].to;
        for (const option of rule) { pick -= option.weight; if (pick < 0) { successor = option.to; break; } }
      }
      for (const char of successor) next.push({ char, generation: char === symbol.char ? symbol.generation : generation });
      if (next.length > maxSymbols) throw new LSystemBudgetError(next.length, maxSymbols);
    }
    current = next;
  }
  return current;
}

/** The largest iteration count (≤ wanted) whose drawn segment count stays within `maxSegments`. */
export function clampLSystemIterationsV1(grammar: LSystemGrammarV1, wanted: number, seed: number, maxSegments: number): number {
  for (let iterations = wanted; iterations > 0; iterations -= 1) {
    try {
      const count = expandLSystemV1(grammar, iterations, seed, maxSegments * 40).filter(symbol => symbol.char === "F").length;
      if (count <= maxSegments) return iterations;
    } catch (error) {
      if (!(error instanceof LSystemBudgetError)) throw error;
    }
  }
  return 0;
}

type Mutable3 = [number, number, number];
const cross = (a: Vec3V1, b: Vec3V1): Mutable3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3V1): Mutable3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Rotates v about the unit axis k by angle (Rodrigues). */
function rotate(v: Vec3V1, k: Vec3V1, degrees: number): Mutable3 {
  const t = (degrees * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], x = cross(k, v);
  return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)];
}

interface Turtle { at: Mutable3; h: Mutable3; l: Mutable3; u: Mutable3; depth: number; width: number; distance: number; segment: number; scale: number }

/** Interprets an expanded string with the turtle. Deterministic for (grammar, symbols, seed). */
export function interpretLSystemV1(grammar: LSystemGrammarV1, symbols: readonly LSymbolV1[], seed: number): LSystemResultV1 {
  const rand = seededRandom((seed * 40503 + 977) >>> 0);
  const jitterAngle = grammar.jitter?.angle ?? 0, jitterLength = grammar.jitter?.length ?? 0;
  const turn = (base: number) => base + (jitterAngle ? (rand() * 2 - 1) * jitterAngle : 0);
  const heading = norm(grammar.heading ?? [0, 1, 0]);
  // A left vector perpendicular to the heading (the turtle's yaw axis is "up" = h × l).
  const left = norm(Math.abs(heading[2]) < 0.9 ? cross([0, 0, 1], heading) : cross([1, 0, 0], heading));
  let turtle: Turtle = { at: [0, 0, 0], h: heading, l: left, u: norm(cross(heading, left)), depth: 0, width: grammar.width, distance: 0, segment: -1, scale: 1 };
  const stack: Turtle[] = [], segments: LSegmentV1[] = [], tips: LTipV1[] = [];
  const min: Mutable3 = [0, 0, 0], max: Mutable3 = [0, 0, 0];
  const grow = (p: Vec3V1) => { for (let i = 0; i < 3; i += 1) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); } };
  const tipSymbols = grammar.tipSymbols ?? "L";
  const pitch = grammar.pitch ?? grammar.angle, roll = grammar.roll ?? grammar.angle, lengthScale = grammar.lengthScale ?? 1, widthScale = grammar.widthScale ?? 1;
  let generations = 0;
  for (const symbol of symbols) {
    switch (symbol.char) {
      case "F": case "f": {
        const length = grammar.step * turtle.scale * Math.pow(lengthScale, turtle.depth) * (1 + (jitterLength ? (rand() * 2 - 1) * jitterLength : 0));
        if (grammar.tropism) turtle.h = norm([turtle.h[0], turtle.h[1] - grammar.tropism, turtle.h[2]]);
        const b: Mutable3 = [turtle.at[0] + turtle.h[0] * length, turtle.at[1] + turtle.h[1] * length, turtle.at[2] + turtle.h[2] * length];
        if (symbol.char === "F") {
          segments.push({ index: segments.length, a: [...turtle.at], b, generation: symbol.generation, depth: turtle.depth, distance: turtle.distance, width: turtle.width, parent: turtle.segment });
          turtle.segment = segments.length - 1;
          generations = Math.max(generations, symbol.generation);
          grow(turtle.at); grow(b);
        }
        turtle.at = b; turtle.distance += length;
        break;
      }
      case "+": { const a = turn(grammar.angle); turtle.h = rotate(turtle.h, turtle.u, a); turtle.l = rotate(turtle.l, turtle.u, a); break; }
      case "-": { const a = turn(-grammar.angle); turtle.h = rotate(turtle.h, turtle.u, a); turtle.l = rotate(turtle.l, turtle.u, a); break; }
      case "&": { const a = turn(pitch); turtle.h = rotate(turtle.h, turtle.l, a); turtle.u = rotate(turtle.u, turtle.l, a); break; }
      case "^": { const a = turn(-pitch); turtle.h = rotate(turtle.h, turtle.l, a); turtle.u = rotate(turtle.u, turtle.l, a); break; }
      case "\\": { const a = turn(roll); turtle.l = rotate(turtle.l, turtle.h, a); turtle.u = rotate(turtle.u, turtle.h, a); break; }
      case "/": { const a = turn(-roll); turtle.l = rotate(turtle.l, turtle.h, a); turtle.u = rotate(turtle.u, turtle.h, a); break; }
      case "|": { turtle.h = rotate(turtle.h, turtle.u, 180); turtle.l = rotate(turtle.l, turtle.u, 180); break; }
      case "[": stack.push({ ...turtle, at: [...turtle.at], h: [...turtle.h], l: [...turtle.l], u: [...turtle.u] }); turtle = { ...turtle, depth: turtle.depth + 1, width: turtle.width * widthScale }; break;
      case "]": { const popped = stack.pop(); if (popped) turtle = popped; break; }
      case "!": turtle.width *= widthScale; break;
      case '"': turtle.scale *= grammar.shrink ?? 1; turtle.width *= grammar.shrink ?? 1; break;
      default:
        if (tipSymbols.includes(symbol.char)) tips.push({ at: [...turtle.at], heading: [...turtle.h], generation: Math.max(symbol.generation, segments[turtle.segment]?.generation ?? 0), depth: turtle.depth, distance: turtle.distance, segment: turtle.segment });
        break;
    }
  }
  return { segments, tips, bounds: { min, max }, generations, symbols: symbols.length };
}

/** Expand and interpret in one call. */
export function growLSystemV1(grammar: LSystemGrammarV1, iterations: number, seed: number, maxSymbols?: number): LSystemResultV1 {
  return interpretLSystemV1(grammar, expandLSystemV1(grammar, iterations, seed, maxSymbols), seed);
}

/**
 * Growth timing, generation-major with a per-segment stagger: generation g grows in its own window, and inside it the
 * segments start in order of their distance from the root, so growth flows outward along every branch. Returns each
 * segment's [start, end] in 0..1 of the growth.
 */
export function lsystemGrowthScheduleV1(result: LSystemResultV1, options: { overlap?: number; segmentShare?: number } = {}): Array<readonly [number, number]> {
  const overlap = options.overlap ?? 0.35, share = options.segmentShare ?? 0.18;
  const byGeneration = new Map<number, LSegmentV1[]>();
  for (const segment of result.segments) { const list = byGeneration.get(segment.generation) ?? []; list.push(segment); byGeneration.set(segment.generation, list); }
  const generations = [...byGeneration.keys()].sort((a, b) => a - b), n = generations.length;
  // n windows of length w, each starting (1 − overlap)·w after the previous one, fill 0..1 exactly.
  const w = 1 / (1 + Math.max(0, n - 1) * (1 - overlap)), d = w * share;
  const schedule = new Array<readonly [number, number]>(result.segments.length);
  generations.forEach((g, i) => {
    const list = byGeneration.get(g)!, start = i * w * (1 - overlap);
    let lo = Infinity, hi = -Infinity;
    for (const segment of list) { lo = Math.min(lo, segment.distance); hi = Math.max(hi, segment.distance); }
    const span = Math.max(1e-9, hi - lo);
    for (const segment of list) {
      const s0 = start + ((segment.distance - lo) / span) * (w - d);
      schedule[segment.index] = [s0, Math.min(1, s0 + d)];
    }
  });
  return schedule;
}
