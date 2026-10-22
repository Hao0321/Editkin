import type { Vec3 } from "./gradeV2Color";

/** CIELAB D65 and CIEDE2000, kL = kC = kH = 1. Independent implementation of
 * the published equations, not the authors' Matlab/Excel programs:
 * https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/ciede2000noteCRNA.pdf
 * Oklab coordinates must never be passed to this CIELAB metric. */
function assertTriple(value: Vec3, bound: number): void {
  if (!Array.isArray(value) || value.length !== 3
    || !value.every(channel => Number.isFinite(channel) && Math.abs(channel) <= bound)) {
    throw new Error("Invalid or oversized colour triple");
  }
}

/** Relative linear Rec.709, D65 white Y=1. Signed values remain signed; there is
 * no hidden gamut clamp, display transform, or absolute-luminance calibration. */
export function linearRec709ToCieLabD65V1(rgb: Vec3): Vec3 {
  assertTriple(rgb, 64);
  // BT.709/sRGB primaries, D65 (x=.3127, y=.3290). Normalize by the matrix's
  // reference white so neutral RGB has exactly zero opponent coordinates.
  const x = (.4123907992659595 * rgb[0] + .357584339383878 * rgb[1] + .1804807884018343 * rgb[2]) / .9504559270516718;
  const y = .2126390058715104 * rgb[0] + .7151686787677559 * rgb[1] + .0721923153607337 * rgb[2];
  const z = (.0193308187155918 * rgb[0] + .119194779794626 * rgb[1] + .9505321522496607 * rgb[2]) / 1.0890577507598785;
  const f = (v: number) => v > 216 / 24389 ? Math.cbrt(v) : ((24389 / 27) * v + 16) / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const radians = (degrees: number) => degrees * Math.PI / 180;
const hue = (a: number, b: number) => {
  if (a === 0 && b === 0) return 0;
  const degrees = Math.atan2(b, a) * 180 / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
};
const chromaRatio = (c: number) => c ** 7 / (c ** 7 + 25 ** 7);

export function cieDeltaE2000V1(first: Vec3, second: Vec3): number {
  assertTriple(first, 10000); assertTriple(second, 10000);
  const [l1, a1, b1] = first, [l2, a2, b2] = second;
  const averageChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = .5 * (1 - Math.sqrt(chromaRatio(averageChroma)));
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1), cp2 = Math.hypot(ap2, b2);
  const hp1 = hue(ap1, b1), hp2 = hue(ap2, b2);
  const achromatic = cp1 === 0 || cp2 === 0;
  const deltaL = l2 - l1, deltaC = cp2 - cp1;
  let deltaHue = achromatic ? 0 : hp2 - hp1;
  if (deltaHue > 180) deltaHue -= 360;
  else if (deltaHue < -180) deltaHue += 360;
  const deltaH = 2 * Math.sqrt(cp1) * Math.sqrt(cp2) * Math.sin(radians(deltaHue / 2));
  const meanL = (l1 + l2) / 2, meanC = (cp1 + cp2) / 2;
  let meanH: number;
  if (achromatic) meanH = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) meanH = (hp1 + hp2) / 2;
  else meanH = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  const t = 1 - .17 * Math.cos(radians(meanH - 30)) + .24 * Math.cos(radians(2 * meanH))
    + .32 * Math.cos(radians(3 * meanH + 6)) - .20 * Math.cos(radians(4 * meanH - 63));
  const theta = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
  const sl = 1 + .015 * (meanL - 50) ** 2 / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + .045 * meanC, sh = 1 + .015 * meanC * t;
  const rt = -2 * Math.sqrt(chromaRatio(meanC)) * Math.sin(radians(2 * theta));
  const dl = deltaL / sl, dc = deltaC / sc, dh = deltaH / sh;
  return Math.sqrt(Math.max(0, dl * dl + dc * dc + dh * dh + rt * dc * dh));
}
