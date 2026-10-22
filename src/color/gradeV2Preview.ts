import type { ColorAdjustments } from "../domain/visualTypes";
import { ACESCCT_VIGNETTE_DEPTH } from "./gradeV2Ffmpeg";
import { BLOOM_TINT, finishingThresholdInWorkingSpace, grainNoiseStrength, HALATION_TINT, vignetteAngle, type ResolvedFinishingV2 } from "./gradeV2";
import type { GradeWorkingSpace } from "./gradeV2Color";

/**
 * GLSL ES 3.0 pieces for the Color Grade v2 preview (GradedMedia). The 3D LUT is the
 * same Float32Array the export writes, sampled with vf_lut3d's tetrahedral rule through
 * texelFetch (no hardware filtering), so preview and export share one table.
 */

/** Data layout: texImage3D(width = red, height = green, depth = blue) == .cube order (red fastest). */
export const GRADE_V2_LUT_GLSL = `
uniform highp sampler3D editkin_grade_lut;
uniform float editkin_grade_lut_size;
uniform bool editkin_grade_lut_enabled;
vec3 editkin_lut_at(ivec3 index) { return texelFetch(editkin_grade_lut, index, 0).rgb; }
vec3 editkin_grade_v2_lut(vec3 rgb) {
  if (!editkin_grade_lut_enabled) return rgb;
  float lutMax = editkin_grade_lut_size - 1.0;
  vec3 s = clamp(rgb, 0.0, 1.0) * lutMax;
  ivec3 p = ivec3(min(floor(s), vec3(lutMax - 1.0)));
  vec3 d = s - vec3(p);
  ivec3 n = p + ivec3(1);
  vec3 c000 = editkin_lut_at(p);
  vec3 c111 = editkin_lut_at(n);
  if (d.r > d.g) {
    if (d.g > d.b) {
      vec3 c100 = editkin_lut_at(ivec3(n.r, p.g, p.b)); vec3 c110 = editkin_lut_at(ivec3(n.r, n.g, p.b));
      return (1.0 - d.r) * c000 + (d.r - d.g) * c100 + (d.g - d.b) * c110 + d.b * c111;
    } else if (d.r > d.b) {
      vec3 c100 = editkin_lut_at(ivec3(n.r, p.g, p.b)); vec3 c101 = editkin_lut_at(ivec3(n.r, p.g, n.b));
      return (1.0 - d.r) * c000 + (d.r - d.b) * c100 + (d.b - d.g) * c101 + d.g * c111;
    } else {
      vec3 c001 = editkin_lut_at(ivec3(p.r, p.g, n.b)); vec3 c101 = editkin_lut_at(ivec3(n.r, p.g, n.b));
      return (1.0 - d.b) * c000 + (d.b - d.r) * c001 + (d.r - d.g) * c101 + d.g * c111;
    }
  } else {
    if (d.b > d.g) {
      vec3 c001 = editkin_lut_at(ivec3(p.r, p.g, n.b)); vec3 c011 = editkin_lut_at(ivec3(p.r, n.g, n.b));
      return (1.0 - d.b) * c000 + (d.b - d.g) * c001 + (d.g - d.r) * c011 + d.r * c111;
    } else if (d.b > d.r) {
      vec3 c010 = editkin_lut_at(ivec3(p.r, n.g, p.b)); vec3 c011 = editkin_lut_at(ivec3(p.r, n.g, n.b));
      return (1.0 - d.g) * c000 + (d.g - d.b) * c010 + (d.b - d.r) * c011 + d.r * c111;
    } else {
      vec3 c010 = editkin_lut_at(ivec3(p.r, n.g, p.b)); vec3 c110 = editkin_lut_at(ivec3(n.r, n.g, p.b));
      return (1.0 - d.g) * c000 + (d.g - d.r) * c010 + (d.r - d.b) * c110 + d.b * c111;
    }
  }
}`;

/**
 * The same texelFetch + vf_lut3d tetrahedral sampler for another 3D table on the unit domain:
 * `vec3 <name>(vec3 rgb)` reading `uniform sampler3D <name>_lut` of size `<name>_size`. Used by the
 * ACES 2.0 SDR display-referred preview for the display inverse and the shipped SDR output LUT.
 */
export function lut3dSamplerGlsl(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`invalid GLSL LUT name: ${name}`);
  return `
uniform highp sampler3D ${name}_lut;
uniform float ${name}_size;
vec3 ${name}_at(ivec3 index) { return texelFetch(${name}_lut, index, 0).rgb; }
vec3 ${name}(vec3 rgb) {
  float lutMax = ${name}_size - 1.0;
  vec3 s = clamp(rgb, 0.0, 1.0) * lutMax;
  ivec3 p = ivec3(min(floor(s), vec3(lutMax - 1.0)));
  vec3 d = s - vec3(p);
  ivec3 n = p + ivec3(1);
  vec3 c000 = ${name}_at(p);
  vec3 c111 = ${name}_at(n);
  if (d.r > d.g) {
    if (d.g > d.b) {
      vec3 c100 = ${name}_at(ivec3(n.r, p.g, p.b)); vec3 c110 = ${name}_at(ivec3(n.r, n.g, p.b));
      return (1.0 - d.r) * c000 + (d.r - d.g) * c100 + (d.g - d.b) * c110 + d.b * c111;
    } else if (d.r > d.b) {
      vec3 c100 = ${name}_at(ivec3(n.r, p.g, p.b)); vec3 c101 = ${name}_at(ivec3(n.r, p.g, n.b));
      return (1.0 - d.r) * c000 + (d.r - d.b) * c100 + (d.b - d.g) * c101 + d.g * c111;
    } else {
      vec3 c001 = ${name}_at(ivec3(p.r, p.g, n.b)); vec3 c101 = ${name}_at(ivec3(n.r, p.g, n.b));
      return (1.0 - d.b) * c000 + (d.b - d.r) * c001 + (d.r - d.g) * c101 + d.g * c111;
    }
  } else {
    if (d.b > d.g) {
      vec3 c001 = ${name}_at(ivec3(p.r, p.g, n.b)); vec3 c011 = ${name}_at(ivec3(p.r, n.g, n.b));
      return (1.0 - d.b) * c000 + (d.b - d.g) * c001 + (d.g - d.r) * c011 + d.r * c111;
    } else if (d.b > d.r) {
      vec3 c010 = ${name}_at(ivec3(p.r, n.g, p.b)); vec3 c011 = ${name}_at(ivec3(p.r, n.g, n.b));
      return (1.0 - d.g) * c000 + (d.g - d.b) * c010 + (d.b - d.r) * c011 + d.r * c111;
    } else {
      vec3 c010 = ${name}_at(ivec3(p.r, n.g, p.b)); vec3 c110 = ${name}_at(ivec3(n.r, n.g, p.b));
      return (1.0 - d.g) * c000 + (d.g - d.r) * c010 + (d.r - d.b) * c110 + d.b * c111;
    }
  }
}`;
}

/** Rec.709 primary preview: the same piecewise tone points, exposure, contrast, temperature/tint and saturation as `gradeRgb`. */
export const REC709_PRIMARY_GLSL = `
uniform vec2 editkin_primary_points[5];
uniform float editkin_primary_exposure;
uniform float editkin_primary_contrast;
uniform float editkin_primary_pivot;
uniform float editkin_primary_brightness;
uniform float editkin_primary_temperature;
uniform float editkin_primary_tint;
uniform float editkin_primary_saturation;
float editkin_primary_curve(float value) {
  float x = clamp(value, 0.0, 1.0);
  for (int i = 1; i < 5; i++) {
    if (x <= editkin_primary_points[i].x) {
      vec2 a = editkin_primary_points[i - 1]; vec2 b = editkin_primary_points[i];
      return a.y + (b.y - a.y) * ((x - a.x) / max(0.0001, b.x - a.x));
    }
  }
  return editkin_primary_points[4].y;
}
vec3 editkin_rec709_primary(vec3 rgb) {
  vec3 c = vec3(editkin_primary_curve(rgb.r), editkin_primary_curve(rgb.g), editkin_primary_curve(rgb.b));
  c = clamp(((c - editkin_primary_pivot) * editkin_primary_contrast + editkin_primary_pivot) * editkin_primary_exposure + editkin_primary_brightness, 0.0, 1.0);
  c = clamp(c + vec3(editkin_primary_temperature * 0.055, editkin_primary_tint * 0.045, -editkin_primary_temperature * 0.055), 0.0, 1.0);
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return clamp(vec3(y) + (c - vec3(y)) * editkin_primary_saturation, 0.0, 1.0);
}`;

export const HUE_ROTATE_GLSL = `
uniform float editkin_grade_hue_radians;
vec3 editkin_hue_rotate(vec3 rgb) {
  if (editkin_grade_hue_radians == 0.0) return rgb;
  float y = dot(rgb, vec3(0.299, 0.587, 0.114));
  float i = dot(rgb, vec3(0.595716, -0.274453, -0.321263));
  float q = dot(rgb, vec3(0.211456, -0.522591, 0.311135));
  float c = cos(editkin_grade_hue_radians);
  float s = sin(editkin_grade_hue_radians);
  float ri = i * c - q * s;
  float rq = i * s + q * c;
  return vec3(y + 0.9563 * ri + 0.6210 * rq, y - 0.2721 * ri - 0.6474 * rq, y - 1.107 * ri + 1.7046 * rq);
}`;

/** Same monotone tone points as primaryGrade.ts (`monotonicPoints`). */
export function rec709PrimaryUniforms(color: ColorAdjustments): Record<string, number | number[]> {
  const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
  const raw: Array<[number, number]> = [
    [0, clamp(color.blacks * 0.08, 0, 0.18)],
    [0.18, clamp(0.18 + color.shadows * 0.13, 0.02, 0.42)],
    [0.5, clamp(0.5 + (0.5 - color.pivot) * 0.26, 0.24, 0.76)],
    [0.82, clamp(0.82 + color.highlights * 0.13, 0.58, 0.98)],
    [1, clamp(1 + color.whites * 0.08, 0.82, 1)],
  ];
  for (let index = 1; index < raw.length; index += 1) raw[index][1] = Math.max(raw[index][1], raw[index - 1][1] + 0.002);
  for (let index = raw.length - 2; index >= 0; index -= 1) raw[index][1] = Math.min(raw[index][1], raw[index + 1][1] - 0.002);
  return {
    editkin_primary_points: raw.flatMap(([x, y]) => [x, clamp(y, 0, 1)]),
    editkin_primary_exposure: 2 ** clamp(color.exposure, -3, 3),
    editkin_primary_contrast: color.contrast,
    editkin_primary_pivot: color.pivot,
    editkin_primary_brightness: color.brightness,
    editkin_primary_temperature: color.temperature,
    editkin_primary_tint: color.tint,
    editkin_primary_saturation: color.saturation,
  };
}

/** Preview-side finishing parameters, derived with the same helpers as the FFmpeg graph. */
export interface PreviewFinishing {
  glows: Array<{ kind: "halation" | "bloom"; threshold: number; tint: [number, number, number]; sigmaPixels: number }>;
  vignetteAngle: number;
  vignetteLogDepth: number;
  grainSigma: number;
}

export function previewFinishing(finishing: ResolvedFinishingV2 | undefined, space: GradeWorkingSpace, canvasHeight: number): PreviewFinishing {
  const glows: PreviewFinishing["glows"] = [];
  const glow = (kind: "halation" | "bloom", settings: { amount: number; threshold: number; radius: number } | undefined, tint: readonly number[]) => {
    if (!settings) return;
    glows.push({ kind, threshold: finishingThresholdInWorkingSpace(settings.threshold, space),
      tint: [settings.amount * tint[0], settings.amount * tint[1], settings.amount * tint[2]], sigmaPixels: Math.max(0.5, Math.min(200, settings.radius * canvasHeight)) });
  };
  glow("halation", finishing?.halation, HALATION_TINT);
  glow("bloom", finishing?.bloom, BLOOM_TINT);
  const strength = finishing?.grain ? Math.max(1, Math.round(grainNoiseStrength(finishing.grain.amount, finishing.grain.size) * (space === "acescct" ? 0.6 : 1))) : 0;
  return {
    glows,
    vignetteAngle: finishing?.vignette ? vignetteAngle(finishing.vignette.amount) : 0,
    vignetteLogDepth: space === "acescct" ? ACESCCT_VIGNETTE_DEPTH : 0,
    // vf_noise Gaussian: σ ≈ strength/√3 code values.
    grainSigma: strength / Math.sqrt(3) / 255,
  };
}

export const FINISH_GLSL = `
uniform sampler2D editkin_glow0;
uniform sampler2D editkin_glow1;
uniform int editkin_glow_count;
uniform float editkin_vignette_angle;
uniform float editkin_vignette_log_depth;
uniform float editkin_grain_sigma;
uniform float editkin_grain_seed;
uniform vec2 editkin_canvas_size;
float editkin_hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + editkin_grain_seed) * 43758.5453); }
vec3 editkin_finish(vec3 working, vec2 uv) {
  vec3 c = working;
  if (editkin_glow_count > 0) c = 1.0 - (1.0 - c) * (1.0 - texture(editkin_glow0, uv).rgb);
  if (editkin_glow_count > 1) c = 1.0 - (1.0 - c) * (1.0 - texture(editkin_glow1, uv).rgb);
  if (editkin_vignette_angle > 0.0) {
    vec2 pixel = floor(uv * editkin_canvas_size);
    vec2 offset = trunc(pixel - editkin_canvas_size * 0.5);
    float distance01 = length(offset) / length(editkin_canvas_size * 0.5);
    float f = distance01 > 1.0 ? 0.0 : pow(cos(editkin_vignette_angle * distance01), 4.0);
    f = floor(255.0 * f) / 255.0;
    c = editkin_vignette_log_depth > 0.0 ? c - (1.0 - f) * editkin_vignette_log_depth : c * f;
  }
  if (editkin_grain_sigma > 0.0) {
    vec2 pixel = floor(uv * editkin_canvas_size);
    float u1 = max(1e-6, editkin_hash(pixel));
    float u2 = editkin_hash(pixel + 17.0);
    c += sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2) * editkin_grain_sigma;
  }
  return c;
}`;
