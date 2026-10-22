/**
 * Pure colour math shared by the Color Grade v2 CPU reference, the 65³ LUT bake and
 * the browser preview. No Node or DOM imports: the export bake and the preview bake
 * must run the same code.
 *
 * Working spaces follow the existing export graph:
 * - "rec709_display": display-referred BT.709 code values (Rec.709 projects, HLG/PQ
 *   already tone-mapped to SDR). Linearised with BT.1886 γ2.4 for Oklab work.
 * - "acescct": ACEScct (AP1) values produced by the shipped OCIO input LUTs (ACES 2.0 projects).
 */
export type GradeWorkingSpace = "rec709_display" | "acescct";

export type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

export const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 === edge0) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  return [0, 1, 2].map(row => [0, 1, 2].map(column => a[row][0] * b[0][column] + a[row][1] * b[1][column] + a[row][2] * b[2][column])) as Mat3;
}

export function invert3(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (Math.abs(determinant) < 1e-12) throw new Error("singular colour matrix");
  return [
    [A / determinant, -(b * i - c * h) / determinant, (b * f - c * e) / determinant],
    [B / determinant, (a * i - c * g) / determinant, -(a * f - c * d) / determinant],
    [C / determinant, -(a * h - b * g) / determinant, (a * e - b * d) / determinant],
  ];
}

function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

// ACES AP1 → XYZ (SMPTE ST 2065-1 / S-2014-004), Bradford D60 → D65, XYZ → linear Rec.709.
const AP1_TO_XYZ: Mat3 = [
  [0.6624541811, 0.1340042065, 0.1561876870],
  [0.2722287168, 0.6740817658, 0.0536895174],
  [-0.0055746495, 0.0040607335, 1.0103391003],
];
const XYZ_TO_REC709: Mat3 = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.9692660, 1.8760108, 0.0415560],
  [0.0556434, -0.2040259, 1.0572252],
];
const BRADFORD: Mat3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
function whiteXyz(x: number, y: number): Vec3 { return [x / y, 1, (1 - x - y) / y]; }
function bradfordAdaptation(source: Vec3, destination: Vec3): Mat3 {
  const s = apply(BRADFORD, source), d = apply(BRADFORD, destination);
  const scale: Mat3 = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
  return multiply(invert3(BRADFORD), multiply(scale, BRADFORD));
}
const D60_TO_D65 = bradfordAdaptation(whiteXyz(0.32168, 0.33767), whiteXyz(0.3127, 0.3290));
const AP1_TO_REC709_RAW = multiply(XYZ_TO_REC709, multiply(D60_TO_D65, AP1_TO_XYZ));
// Normalise rows so ACES neutral (1,1,1) maps exactly to Rec.709 neutral.
const AP1_TO_REC709 = AP1_TO_REC709_RAW.map(row => {
  const sum = row[0] + row[1] + row[2];
  return row.map(value => value / sum);
}) as Mat3;
const REC709_TO_AP1 = invert3(AP1_TO_REC709);

// Oklab (Björn Ottosson 2020), defined on linear sRGB/Rec.709 primaries. The published
// constants are re-normalised by < 4e-8 so neutral RGB maps to exactly a = b = 0 (LMS rows
// sum to 1, opponent rows sum to 0); inverses are computed in double precision.
const LMS_FROM_REC709: Mat3 = ([
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
] as Mat3).map(row => { const sum = row[0] + row[1] + row[2]; return row.map(value => value / sum); }) as Mat3;
const LAB_FROM_LMS: Mat3 = ([
  [0.2104542553, 0.7936177850, -0.0040720468],
  [1.9779984951, -2.4285922050, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.8086757660],
] as Mat3).map((row, index) => {
  const sum = row[0] + row[1] + row[2];
  return index === 0 ? row.map(value => value / sum) : [row[0], row[1] - sum, row[2]];
}) as Mat3;
const REC709_FROM_LMS = invert3(LMS_FROM_REC709);
const LMS_FROM_LAB = invert3(LAB_FROM_LMS);

export const ACESCCT_LINEAR_BREAK = 0.0078125;
const ACESCCT_A = 10.5402377416545;
const ACESCCT_B = 0.0729055341958355;
const ACESCCT_CODE_BREAK = 0.155251141552511;

export function acescctToLinear(value: number): number {
  return value <= ACESCCT_CODE_BREAK ? (value - ACESCCT_B) / ACESCCT_A : Math.pow(2, value * 17.52 - 9.72);
}

export function linearToAcescct(value: number): number {
  return value <= ACESCCT_LINEAR_BREAK ? ACESCCT_A * value + ACESCCT_B : (Math.log2(value) + 9.72) / 17.52;
}

/** BT.1886 (γ2.4, Lw=1, Lb=0) display decode; sign-preserving so the round trip is exact. */
export function displayToLinear(value: number): number {
  return value < 0 ? -Math.pow(-value, 2.4) : Math.pow(value, 2.4);
}

export function linearToDisplay(value: number): number {
  return value < 0 ? -Math.pow(-value, 1 / 2.4) : Math.pow(value, 1 / 2.4);
}

/** Luma weights of the working primaries (BT.709 or AP1). */
export function workingLumaWeights(space: GradeWorkingSpace): Vec3 {
  return space === "acescct" ? [AP1_TO_XYZ[1][0], AP1_TO_XYZ[1][1], AP1_TO_XYZ[1][2]] : [0.2126, 0.7152, 0.0722];
}

/** Working code values → linear Rec.709 (D65), without clamping (wide-gamut AP1 stays representable). */
export function workingToLinearRec709(rgb: Vec3, space: GradeWorkingSpace): Vec3 {
  if (space === "acescct") return apply(AP1_TO_REC709, [acescctToLinear(rgb[0]), acescctToLinear(rgb[1]), acescctToLinear(rgb[2])]);
  return [displayToLinear(rgb[0]), displayToLinear(rgb[1]), displayToLinear(rgb[2])];
}

export function linearRec709ToWorking(rgb: Vec3, space: GradeWorkingSpace): Vec3 {
  if (space === "acescct") {
    const ap1 = apply(REC709_TO_AP1, rgb);
    return [linearToAcescct(ap1[0]), linearToAcescct(ap1[1]), linearToAcescct(ap1[2])];
  }
  return [linearToDisplay(rgb[0]), linearToDisplay(rgb[1]), linearToDisplay(rgb[2])];
}

export function linearRec709ToOklab(rgb: Vec3): Vec3 {
  const lms = apply(LMS_FROM_REC709, rgb);
  return apply(LAB_FROM_LMS, [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])]);
}

export function oklabToLinearRec709(lab: Vec3): Vec3 {
  const root = apply(LMS_FROM_LAB, lab);
  return apply(REC709_FROM_LMS, [root[0] ** 3, root[1] ** 3, root[2] ** 3]);
}

export function workingToOklab(rgb: Vec3, space: GradeWorkingSpace): Vec3 {
  return linearRec709ToOklab(workingToLinearRec709(rgb, space));
}

export function oklabToWorking(lab: Vec3, space: GradeWorkingSpace): Vec3 {
  return linearRec709ToWorking(oklabToLinearRec709(lab), space);
}

export function oklabHueDegrees(a: number, b: number): number {
  const degrees = Math.atan2(b, a) * 180 / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

// Hue wheel: Oklab hue piecewise-linearly remapped so the Rec.709 primaries and
// secondaries land on the familiar 0/60/120/180/240/300 positions.
const WHEEL_ANCHORS = [0, 60, 120, 180, 240, 300];
const OKLAB_ANCHORS = ([[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [1, 0, 1]] as Vec3[]).map(rgb => {
  const lab = linearRec709ToOklab(rgb);
  return oklabHueDegrees(lab[1], lab[2]);
});

function mapPiecewise(value: number, from: number[], to: number[]): number {
  // Unwrap into [from[0], from[0] + 360) so exactly one segment always contains the value.
  let candidate = value;
  while (candidate < from[0]) candidate += 360;
  while (candidate >= from[0] + 360) candidate -= 360;
  let index = from.length - 1;
  while (index > 0 && candidate < from[index]) index -= 1;
  const start = from[index];
  const end = index + 1 < from.length ? from[index + 1] : from[0] + 360;
  const outStart = to[index];
  const outEnd = index + 1 < to.length ? to[index + 1] : to[0] + 360;
  const mapped = outStart + (candidate - start) / (end - start) * (outEnd - outStart);
  return ((mapped % 360) + 360) % 360;
}

export function oklabHueToWheel(hue: number): number { return mapPiecewise(hue, OKLAB_ANCHORS, WHEEL_ANCHORS); }
export function wheelToOklabHue(hue: number): number { return mapPiecewise(hue, WHEEL_ANCHORS, OKLAB_ANCHORS); }
export function oklabHueAnchors(): number[] { return [...OKLAB_ANCHORS]; }

/** Signed shortest angular difference to - from, in degrees (-180, 180]. */
export function angleDifference(from: number, to: number): number {
  let delta = ((to - from) % 360 + 360) % 360;
  if (delta > 180) delta -= 360;
  return delta;
}

// ---------------------------------------------------------------- monotone cubic curves

/** Fritsch–Carlson monotone cubic Hermite spline (no overshoot between control points). */
export interface MonotoneCurve {
  xs: Float64Array;
  ys: Float64Array;
  ms: Float64Array;
}

export function buildMonotoneCurve(xs: readonly number[], ys: readonly number[]): MonotoneCurve {
  const n = xs.length;
  if (n < 2 || ys.length !== n) throw new Error("monotone curve needs ≥2 points");
  const slopes = new Float64Array(n - 1);
  for (let index = 0; index < n - 1; index += 1) slopes[index] = (ys[index + 1] - ys[index]) / (xs[index + 1] - xs[index]);
  const ms = new Float64Array(n);
  ms[0] = slopes[0];
  ms[n - 1] = slopes[n - 2];
  for (let index = 1; index < n - 1; index += 1) {
    ms[index] = slopes[index - 1] * slopes[index] <= 0 ? 0 : (slopes[index - 1] + slopes[index]) / 2;
  }
  for (let index = 0; index < n - 1; index += 1) {
    if (slopes[index] === 0) { ms[index] = 0; ms[index + 1] = 0; continue; }
    const alpha = ms[index] / slopes[index];
    const beta = ms[index + 1] / slopes[index];
    const magnitude = alpha * alpha + beta * beta;
    if (magnitude > 9) {
      const tau = 3 / Math.sqrt(magnitude);
      ms[index] = tau * alpha * slopes[index];
      ms[index + 1] = tau * beta * slopes[index];
    }
  }
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), ms };
}

export function evaluateMonotoneCurve(curve: MonotoneCurve, x: number): number {
  const { xs, ys, ms } = curve;
  const last = xs.length - 1;
  if (x <= xs[0]) return ys[0] + ms[0] * (x - xs[0]);
  if (x >= xs[last]) return ys[last] + ms[last] * (x - xs[last]);
  let low = 0, high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (xs[middle] <= x) low = middle; else high = middle;
  }
  const h = xs[high] - xs[low];
  const t = (x - xs[low]) / h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[low] + (t3 - 2 * t2 + t) * h * ms[low]
    + (-2 * t3 + 3 * t2) * ys[high] + (t3 - t2) * h * ms[high];
}

/** Periodic (360°) curve: the control points wrap, so the seam has matching tangents. */
export function buildPeriodicCurve(hues: readonly number[], values: readonly number[]): MonotoneCurve {
  const n = hues.length;
  const xs = [hues[n - 2 < 0 ? 0 : n - 2] - 360, hues[n - 1] - 360, ...hues, hues[0] + 360, hues[Math.min(1, n - 1)] + 360];
  const ys = [values[n - 2 < 0 ? 0 : n - 2], values[n - 1], ...values, values[0], values[Math.min(1, n - 1)]];
  if (n === 1) { xs.splice(0, 1); ys.splice(0, 1); xs.pop(); ys.pop(); }
  return buildMonotoneCurve(xs, ys);
}

export function evaluatePeriodicCurve(curve: MonotoneCurve, hue: number): number {
  return evaluateMonotoneCurve(curve, ((hue % 360) + 360) % 360);
}
