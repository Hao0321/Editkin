import type { ColorManagementSettings } from "../domain/visualTypes";
import type { CubeLut } from "./cubeLut";

/**
 * Display-referred input for the ACES 2.0 SDR path (Color Grade v2 only).
 *
 * Phone footage is display-referred: the camera already tone-mapped it for a Rec.709 (or HLG)
 * display. The shipped ACES input transforms treat it as scene-referred instead — "Camera Rec.709"
 * inverts the BT.709 camera OETF (display white becomes scene 1.0) and "Rec.2100-HLG - Display"
 * reaches the scene through the config's Un-tone-mapped view — and the ACES 2.0 SDR output transform
 * then tone-maps a second time. Measured on a Rec.709 chart (pro-w1-1/aces/ACES_ROOT_CAUSE.json):
 * white 1.0 → 0.707, mid-grey L* 49.5 → 41.5, mid contrast ×0.76, chroma ×0.78 — the washed-out look.
 *
 * The standard remedy for display-referred material in a scene-referred pipeline is the inverse of
 * the output transform. This module derives it from the shipped 65³ output LUT itself (no new colour
 * resources): for every node of a display-code grid it solves F(a) = d, where F is the vf_lut3d
 * tetrahedral interpolant of output-acescct-to-rec709_sdr.cube. The solve walks from the neutral axis
 * (exactly invertible on the LUT diagonal) to the target in small steps with damped, box-projected
 * Gauss–Newton updates on the piecewise-affine F, so the table is continuous and F(G(d)) = d wherever
 * the shipped LUT can reach d. A few extreme display colours (pure cyan/blue corners) are outside the
 * LUT's reach; they land on the closest reachable colour and are counted in `unreachableNodes`.
 *
 * Pure arithmetic (no Node or DOM): export and the GradedMedia preview build bit-identical tables.
 */
export const ACES_DISPLAY_INVERSE_SIZE = 65;
export const ACES_DISPLAY_INVERSE_SCHEMA = "editkin.aces2-sdr-display-inverse/v1" as const;
export const ACES_SDR_OUTPUT_LUT = "luts/output-acescct-to-rec709_sdr.cube";

const ACESCCT_BLACK = 0.0729055341958355;
const CONTINUATION_STEPS = 8;
const INNER_ITERATIONS = 6;
const FINAL_ITERATIONS = 12;
const MAX_STEP = 0.05;
const CONVERGED = 1e-7;
const UNREACHABLE = 1e-3;

/**
 * Display code → ACEScct along the neutral axis of the display inverse (the diagonal of the table built from the
 * shipped SDR output LUT; pinned by acesDisplayInverse.test.ts). Where display tones land in ACEScct for
 * reconstructed footage — and, equivalently, which ACEScct the shipped SDR output renders at a display level:
 * mid-grey 0.4895 → 0.469, display 0.7 → 0.552, white → 0.969.
 */
export const ACES_SDR_DISPLAY_NEUTRAL: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [0, 0.0622], [0.02, 0.2033], [0.05, 0.244], [0.1, 0.2855], [0.15, 0.3179], [0.2, 0.3456], [0.3, 0.3928], [0.4, 0.434], [0.5, 0.4727],
  [0.6, 0.5111], [0.7, 0.552], [0.8, 0.6002], [0.85, 0.6303], [0.9, 0.6695], [0.95, 0.73], [0.98, 0.8036], [1, 0.9688],
].map(pair => Object.freeze(pair) as readonly [number, number]));

/** Piecewise-linear ACEScct of a neutral SDR display code (0–1) under the ACES 2.0 SDR output transform. */
export function acescctOfSdrDisplay(code: number): number {
  const table = ACES_SDR_DISPLAY_NEUTRAL;
  if (code <= 0) return table[0][1];
  for (let index = 1; index < table.length; index += 1) {
    if (code <= table[index][0]) {
      const [x0, y0] = table[index - 1], [x1, y1] = table[index];
      return y0 + (y1 - y0) * (code - x0) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/** ACES input keys whose pixels are display-referred (already rendered for a display). */
const DISPLAY_REFERRED_INPUTS: ReadonlySet<string> = new Set(["rec709", "srgb", "hlg", "pq"]);

/**
 * Whether a Color Grade v2 clip is reconstructed with the inverse ACES 2.0 SDR output transform.
 * Only ACES 2.0 projects delivering Rec.709 SDR, only display-referred sources; camera log, ACEScct
 * and scene-linear inputs keep their scene-referred input transform. Clips without a v2 grade never
 * reach this (their render graph stays byte-identical).
 */
export function usesAcesDisplayReconstruction(acesInput: string, management: Pick<ColorManagementSettings, "mode" | "outputTransform"> | undefined): boolean {
  return management?.mode === "aces2" && management.outputTransform === "rec709_sdr" && DISPLAY_REFERRED_INPUTS.has(acesInput);
}

export interface AcesDisplayInverse extends CubeLut {
  schema: typeof ACES_DISPLAY_INVERSE_SCHEMA;
  /** Grid nodes whose display colour the output LUT cannot reach (|F(G(d)) − d| > 1e-3). */
  unreachableNodes: number;
  /** Largest per-node residual |F(G(d)) − d| (display code units 0–1). */
  maxResidual: number;
}

interface Workspace {
  f: Float64Array; j: Float64Array; jtj: Float64Array; g: Float64Array; step: Float64Array; cand: Float64Array; fc: Float64Array;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** vf_lut3d tetrahedral value (and, with `jacobian`, d value / d input) of `lut` at a ∈ [0,1]³. */
function evaluate(lut: CubeLut, a0: number, a1: number, a2: number, out: Float64Array, jacobian?: Float64Array): void {
  const size = lut.size, n = size - 1, values = lut.values;
  const sr = clamp01(a0) * n, sg = clamp01(a1) * n, sb = clamp01(a2) * n;
  const r = Math.min(n - 1, Math.floor(sr)), g = Math.min(n - 1, Math.floor(sg)), b = Math.min(n - 1, Math.floor(sb));
  const fr = sr - r, fg = sg - g, fb = sb - b;
  const R = 3, G = size * 3, B = size * size * 3;
  const i000 = (r + g * size + b * size * size) * 3;
  // Each tetrahedron is c000 + fr·eR + fg·eG + fb·eB with three edge vectors (same order as cubeLut.sampleCubeLut).
  let oR0: number, oR1: number, oG0: number, oG1: number, oB0: number, oB1: number;
  if (fr >= fg) {
    if (fg >= fb) { oR0 = R; oR1 = 0; oG0 = R + G; oG1 = R; oB0 = R + G + B; oB1 = R + G; }
    else if (fr >= fb) { oR0 = R; oR1 = 0; oG0 = R + G + B; oG1 = R + B; oB0 = R + B; oB1 = R; }
    else { oR0 = R + B; oR1 = B; oG0 = R + G + B; oG1 = R + B; oB0 = B; oB1 = 0; }
  } else if (fb >= fg) { oR0 = R + G + B; oR1 = G + B; oG0 = G + B; oG1 = B; oB0 = B; oB1 = 0; }
  else if (fb >= fr) { oR0 = R + G + B; oR1 = G + B; oG0 = G; oG1 = 0; oB0 = G + B; oB1 = G; }
  else { oR0 = R + G; oR1 = G; oG0 = G; oG1 = 0; oB0 = R + G + B; oB1 = R + G; }
  for (let channel = 0; channel < 3; channel += 1) {
    const base = i000 + channel;
    const c000 = values[base];
    const eR = values[base + oR0] - values[base + oR1];
    const eG = values[base + oG0] - values[base + oG1];
    const eB = values[base + oB0] - values[base + oB1];
    out[channel] = c000 + fr * eR + fg * eG + fb * eB;
    if (jacobian) { jacobian[channel * 3] = eR * n; jacobian[channel * 3 + 1] = eG * n; jacobian[channel * 3 + 2] = eB * n; }
  }
}

function solveSymmetric3(m: Float64Array, v: Float64Array, out: Float64Array): void {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-300) { out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; return; }
  const inv = 1 / determinant;
  out[0] = (A * v[0] - (b * i - c * h) * v[1] + (b * f - c * e) * v[2]) * inv;
  out[1] = (B * v[0] + (a * i - c * g) * v[1] - (a * f - c * d) * v[2]) * inv;
  out[2] = (C * v[0] - (a * h - b * g) * v[1] + (a * e - b * d) * v[2]) * inv;
}

/** Damped Gauss–Newton on the piecewise-affine interpolant, kept inside the LUT domain. */
function newton(lut: CubeLut, a: Float64Array, t0: number, t1: number, t2: number, iterations: number, w: Workspace): void {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    evaluate(lut, a[0], a[1], a[2], w.f, w.j);
    const r0 = t0 - w.f[0], r1 = t1 - w.f[1], r2 = t2 - w.f[2];
    if (Math.max(Math.abs(r0), Math.abs(r1), Math.abs(r2)) < CONVERGED) return;
    const j = w.j;
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        w.jtj[row * 3 + column] = j[row] * j[column] + j[3 + row] * j[3 + column] + j[6 + row] * j[6 + column] + (row === column ? 1e-6 : 0);
      }
      w.g[row] = j[row] * r0 + j[3 + row] * r1 + j[6 + row] * r2;
    }
    solveSymmetric3(w.jtj, w.g, w.step);
    for (let channel = 0; channel < 3; channel += 1) w.step[channel] = Math.max(-MAX_STEP, Math.min(MAX_STEP, w.step[channel]));
    for (let channel = 0; channel < 3; channel += 1) w.cand[channel] = clamp01(a[channel] + w.step[channel]);
    evaluate(lut, w.cand[0], w.cand[1], w.cand[2], w.fc);
    const before = r0 * r0 + r1 * r1 + r2 * r2;
    const after = (t0 - w.fc[0]) ** 2 + (t1 - w.fc[1]) ** 2 + (t2 - w.fc[2]) ** 2;
    if (after <= before) { a[0] = w.cand[0]; a[1] = w.cand[1]; a[2] = w.cand[2]; }
    else for (let channel = 0; channel < 3; channel += 1) a[channel] = clamp01(a[channel] + 0.25 * w.step[channel]);
  }
}

/** Monotone neutral response of the LUT along its diagonal (exact: the diagonal is shared by all tetrahedra). */
function neutralCurve(lut: CubeLut): Float64Array {
  const size = lut.size, curve = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    const offset = (index + index * size + index * size * size) * 3;
    curve[index] = Math.max(index ? curve[index - 1] : -Infinity, (lut.values[offset] + lut.values[offset + 1] + lut.values[offset + 2]) / 3);
  }
  return curve;
}

/** Smallest diagonal position whose neutral response reaches `value`, never below scene black. */
function neutralInverse(curve: Float64Array, value: number): number {
  const n = curve.length - 1;
  if (value <= curve[0]) return ACESCCT_BLACK;
  let k = 1;
  while (k < n && curve[k] < value) k += 1;
  const low = curve[k - 1], high = curve[k];
  const fraction = high > low ? Math.min(1, Math.max(0, (value - low) / (high - low))) : 0;
  return Math.max(ACESCCT_BLACK, (k - 1 + fraction) / n);
}

/**
 * Builds the display-code → ACEScct table that inverts `output` (an ACEScct → display 3D LUT on
 * the unit domain). Values are rounded to six decimals so the .cube text and the in-memory table
 * are bit-identical after parsing.
 */
export function buildAcesDisplayInverse(output: CubeLut, size = ACES_DISPLAY_INVERSE_SIZE): AcesDisplayInverse {
  if (!Number.isInteger(size) || size < 2 || size > 129) throw new Error("ACES display inverse 尺寸必須介於 2–129");
  if (output.domainMin.some(value => value !== 0) || output.domainMax.some(value => value !== 1)) throw new Error("ACES Output LUT 的定義域必須是 0–1");
  const curve = neutralCurve(output);
  const values = new Float32Array(size * size * size * 3);
  const w: Workspace = { f: new Float64Array(3), j: new Float64Array(9), jtj: new Float64Array(9), g: new Float64Array(3), step: new Float64Array(3), cand: new Float64Array(3), fc: new Float64Array(3) };
  const a = new Float64Array(3), check = new Float64Array(3);
  const step = 1 / (size - 1);
  let unreachableNodes = 0, maxResidual = 0, offset = 0;
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const d0 = red * step, d1 = green * step, d2 = blue * step;
        const mean = (d0 + d1 + d2) / 3;
        a[0] = a[1] = a[2] = neutralInverse(curve, mean);
        for (let k = 1; k <= CONTINUATION_STEPS; k += 1) {
          const t = k / CONTINUATION_STEPS;
          newton(output, a, mean + t * (d0 - mean), mean + t * (d1 - mean), mean + t * (d2 - mean), INNER_ITERATIONS, w);
        }
        newton(output, a, d0, d1, d2, FINAL_ITERATIONS, w);
        for (let channel = 0; channel < 3; channel += 1) values[offset + channel] = Math.round(clamp01(a[channel]) * 1e6) / 1e6;
        evaluate(output, values[offset], values[offset + 1], values[offset + 2], check);
        const residual = Math.max(Math.abs(check[0] - d0), Math.abs(check[1] - d1), Math.abs(check[2] - d2));
        if (residual > UNREACHABLE) unreachableNodes += 1;
        if (residual > maxResidual) maxResidual = residual;
        offset += 3;
      }
    }
  }
  return { schema: ACES_DISPLAY_INVERSE_SCHEMA, size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], values, unreachableNodes, maxResidual };
}

const cache = new WeakMap<CubeLut, Map<number, AcesDisplayInverse>>();

/** Cached per parsed output LUT (the preview's loadCubeLut and the export reader both reuse their parse). */
export function acesDisplayInverseFor(output: CubeLut, size = ACES_DISPLAY_INVERSE_SIZE): AcesDisplayInverse {
  let bySize = cache.get(output);
  if (!bySize) { bySize = new Map(); cache.set(output, bySize); }
  let inverse = bySize.get(size);
  if (!inverse) { inverse = buildAcesDisplayInverse(output, size); bySize.set(size, inverse); }
  return inverse;
}
