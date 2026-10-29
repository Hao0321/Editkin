import { fmt } from "./document";
import { flattenPathD } from "./pathOps";
import { hashString32, mulberry32 } from "./random";

/**
 * Baked edge roughness (distressed print, torn paper, ink stamps) without SVG
 * filters. Measured on the bundled FFmpeg/librsvg: a feTurbulence +
 * feDisplacementMap pass over a ~830×430 px word costs about 1.7 s per frame,
 * the same word as plain paths about 11 ms. So the outline itself is
 * perturbed once: curves are flattened, the contour is resampled every `step`
 * px and each point moves along the contour normal by seeded noise that is
 * periodic around the contour (closed shapes stay seamless). The result is
 * cached, deterministic and renders the same in Chromium and librsvg.
 *
 * Input: absolute path data with M/L/H/V/Q/C/Z (what glyphs.ts and the
 * document builders emit). Output: polygon path data (M/L/Z).
 */

export interface RoughenOptions {
  /** Peak displacement in px (the slow wobble); grain adds about a third more. */
  readonly amplitude: number;
  /** Dominant feature length in px along the edge. */
  readonly wavelength: number;
  readonly seed: number;
  /** Resampling distance in px (default wavelength / 4, at least 0.75). */
  readonly step?: number;
  /** Fine per-point jitter as a fraction of amplitude (default 0.35). */
  readonly grain?: number;
  /** Decimal places in the output (default 2). */
  readonly decimals?: 0 | 1 | 2 | 3;
}

type Point = readonly [number, number];

const MAX_POINTS = 400_000;

function roughenContour(contour: readonly Point[], options: Required<Pick<RoughenOptions, "amplitude" | "wavelength" | "step" | "grain">>,
  random: () => number): Point[] {
  const count = contour.length;
  const lengths: number[] = [];
  let perimeter = 0;
  for (let index = 0; index < count; index += 1) {
    const a = contour[index], b = contour[(index + 1) % count];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(length);
    perimeter += length;
  }
  if (!(perimeter > 0)) return [...contour];
  // Three seeded harmonics with whole cycles around the contour: seamless at the closing point.
  const harmonics = [1, 0.55, 0.3].map((weight, k) => ({
    cycles: Math.max(1, Math.round(perimeter / (options.wavelength * [1, 0.47, 0.21][k]))),
    phase: random() * 2 * Math.PI,
    weight,
  }));
  const norm = harmonics.reduce((sum, harmonic) => sum + harmonic.weight, 0);
  const noise = (s: number) => harmonics.reduce((sum, h) => sum + h.weight * Math.sin((2 * Math.PI * h.cycles * s) / perimeter + h.phase), 0) / norm;
  const result: Point[] = [];
  let travelled = 0;
  for (let index = 0; index < count; index += 1) {
    const a = contour[index], b = contour[(index + 1) % count], length = lengths[index];
    const pieces = Math.max(1, Math.ceil(length / options.step));
    const tx = (b[0] - a[0]) / (length || 1), ty = (b[1] - a[1]) / (length || 1);
    for (let piece = 0; piece < pieces; piece += 1) {
      const t = piece / pieces;
      let nx = -ty, ny = tx;
      if (piece === 0) {
        // Corner: average the incoming and outgoing normals so the vertex moves sensibly.
        const p = contour[(index - 1 + count) % count], pl = lengths[(index - 1 + count) % count] || 1;
        const px = (a[0] - p[0]) / pl, py = (a[1] - p[1]) / pl;
        const ax = -py + nx, ay = px + ny, al = Math.hypot(ax, ay);
        if (al > 1e-6) { nx = ax / al; ny = ay / al; }
      }
      const s = travelled + length * t;
      const offset = options.amplitude * noise(s) + options.amplitude * options.grain * (random() * 2 - 1);
      result.push([a[0] + (b[0] - a[0]) * t + nx * offset, a[1] + (b[1] - a[1]) * t + ny * offset]);
      if (result.length > MAX_POINTS) throw new Error("roughen: path too long to resample");
    }
    travelled += length;
  }
  return result;
}

const CACHE_LIMIT = 64;
const cache = new Map<string, { d: string; result: string }>();

/** Roughen absolute path data (see module doc). Deterministic and cached. */
export function roughenPathD(d: string, options: RoughenOptions): string {
  if (!d) return "";
  if (!(options.amplitude >= 0) || !(options.wavelength > 0) || !Number.isInteger(options.seed)) {
    throw new Error("roughen needs amplitude >= 0, wavelength > 0 and an integer seed");
  }
  // Inputs are rounded to 3 decimals before use, so a cached result never depends on which caller built it.
  const amplitude = Number(fmt(options.amplitude)), wavelength = Math.max(0.001, Number(fmt(options.wavelength)));
  const step = Number(fmt(Math.max(0.75, options.step ?? wavelength / 4)));
  const grain = Number(fmt(options.grain ?? 0.35)), decimals = options.decimals ?? 2;
  const key = `${options.seed}|${amplitude}|${wavelength}|${step}|${grain}|${decimals}|${d.length}|${hashString32(d)}`;
  const hit = cache.get(key);
  if (hit && hit.d === d) return hit.result;
  const random = mulberry32(hashString32(`roughen|${options.seed}|${d.length}`));
  let result = "";
  for (const contour of flattenPathD(d, { label: "roughen" })) {
    const points = amplitude > 0 ? roughenContour(contour, { amplitude, wavelength, step, grain }, random) : contour;
    result += `M${fmt(points[0][0], decimals)} ${fmt(points[0][1], decimals)}`;
    for (let index = 1; index < points.length; index += 1) result += `L${fmt(points[index][0], decimals)} ${fmt(points[index][1], decimals)}`;
    result += "Z";
  }
  cache.set(key, { d, result });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}
