import type { ColorAdjustments, ColorManagementSettings, MediaAsset } from "../domain/types";
import { resolveAcesInput } from "./primaryGrade";

export interface OcioGpuTexture {
  name: string;
  sampler: string;
  width: number;
  height: number;
  channels: 1 | 3;
  interpolation: "nearest" | "linear";
  values: number[];
}

export interface OcioGpuStage {
  schema: "editkin.ocio-gpu-stage/v1";
  ocioVersion: string;
  key: string;
  stage: "input" | "grade" | "output";
  functionName: string;
  cacheId: string;
  shaderText: string;
  textures: OcioGpuTexture[];
  uniforms: Array<{
    name: string;
    type: "bool" | "float" | "vec3";
    default: boolean | number | number[];
  }>;
}

const cache = new Map<string, Promise<OcioGpuStage>>();

function stageUrl(stage: "input" | "grade" | "output", key: string): string {
  return new URL(`color/aces2/gpu/${stage}-${key}.json`, document.baseURI).toString();
}

export function loadOcioGpuStage(stage: "input" | "grade" | "output", key: string): Promise<OcioGpuStage> {
  const url = stageUrl(stage, key);
  const relativePath = `gpu/${stage}-${key}.json`;
  const cacheKey = window.haoDesktop?.readColorAsset ? `desktop:${relativePath}` : url;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const source = window.haoDesktop?.readColorAsset
    ? window.haoDesktop.readColorAsset(relativePath)
    : fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`OCIO GPU shader 載入失敗：${stage}/${key} (${response.status})`);
      return response.text();
    });
  const request = source.then((text) => {
    const value = JSON.parse(text) as OcioGpuStage;
    if (value.schema !== "editkin.ocio-gpu-stage/v1" || value.stage !== stage || value.key !== key || !value.shaderText || !value.functionName) {
      throw new Error(`OCIO GPU shader manifest 不合法：${stage}/${key}`);
    }
    return value;
  });
  cache.set(cacheKey, request);
  return request;
}

export async function resolveOcioGpuPipeline(asset: MediaAsset, management: ColorManagementSettings): Promise<{ input: OcioGpuStage; grade: OcioGpuStage; output: OcioGpuStage }> {
  if (management.mode !== "aces2") throw new Error("OCIO GPU pipeline 只適用於 ACES 2.0 模式");
  const inputKey = resolveAcesInput(asset);
  if (inputKey === "blocked_log") throw new Error(`素材「${asset.name}」尚未指定 Input Transform`);
  const [input, grade, output] = await Promise.all([
    loadOcioGpuStage("input", inputKey),
    loadOcioGpuStage("grade", "primary-tone"),
    loadOcioGpuStage("output", management.outputTransform),
  ]);
  return { input, grade, output };
}

function fauxCubic(t: number, x0: number, x2: number, y0: number, y2: number, m0: number, m2: number, reverse: boolean): number {
  const x1 = x0 + (x2 - x0) * 0.5;
  const y1 = (0.5 / (x2 - x0)) * ((2 * y0 + m0 * (x1 - x0)) * (x2 - x1) + (2 * y2 - m2 * (x2 - x1)) * (x1 - x0));
  if (!reverse) {
    const tl = (t - x0) / (x1 - x0), tr = (t - x1) / (x2 - x1);
    const left = y0 * (1 - tl * tl) + y1 * tl * tl + m0 * (1 - tl) * tl * (x1 - x0);
    const right = y1 * (1 - tr) ** 2 + y2 * (2 - tr) * tr + m2 * (tr - 1) * tr * (x2 - x1);
    return t < x0 ? y0 + (t - x0) * m0 : t > x2 ? y2 + (t - x2) * m2 : t < x1 ? left : right;
  }
  const c0 = y0 - t, b0 = m0 * (x1 - x0), a0 = y1 - y0 - m0 * (x1 - x0);
  const c1 = y1 - t, b1 = 2 * y2 - 2 * y1 - m2 * (x2 - x1), a1 = y1 - y2 + m2 * (x2 - x1);
  const left = (-2 * c0) / (Math.sqrt(b0 * b0 - 4 * a0 * c0) + b0) * (x1 - x0) + x0;
  const right = (-2 * c1) / (Math.sqrt(b1 * b1 - 4 * a1 * c1) + b1) * (x2 - x1) + x1;
  return t < y0 ? x0 + (t - y0) / m0 : t > y2 ? x2 + (t - y2) / m2 : t < y1 ? left : right;
}

function highlightForward(t: number, start: number, pivot: number, value: number): number {
  const slope = 2 - value;
  return slope <= 1
    ? fauxCubic(t, start, pivot, start, pivot, 1, Math.max(.01, slope), false)
    : fauxCubic(t, start, pivot, start, pivot, 1, Math.max(.01, 2 - slope), true);
}

function shadowForward(t: number, start: number, pivot: number, value: number): number {
  return value <= 1
    ? fauxCubic(t, start, pivot, start, pivot, Math.max(.01, value), 1, false)
    : fauxCubic(t, start, pivot, start, pivot, Math.max(.01, 2 - value), 1, true);
}

export function ocioGradeUniformValues(color: ColorAdjustments): Record<string, boolean | number | number[]> {
  const clamp = (value: number) => Math.max(0.01, Math.min(1.99, value));
  const exposureStep = 1 / 17.52;
  const master = color.brightness * 0.1 + color.exposure * exposureStep;
  const brightnessScale = 6.25 / 1023;
  const highlights = clamp(1 + color.highlights * 0.5);
  const shadows = clamp(1 + color.shadows * 0.5);
  const highlightStart = .3, highlightPivot = 1;
  const shadowStart = .5, shadowPivot = 0;
  const whiteStart = highlightForward(.4, highlightStart, highlightPivot, highlights);
  const whiteEnd = highlightForward(.9, highlightStart, highlightPivot, highlights);
  const blackStart = shadowForward(.4, shadowPivot, shadowStart, shadows);
  const blackEnd = shadowForward(0, shadowPivot, shadowStart, shadows);
  return {
    editkin_grade_grading_primary_brightness: [master + color.temperature * 0.025, master + color.tint * 0.02, master - color.temperature * 0.025].map((value) => value * brightnessScale),
    editkin_grade_grading_primary_contrast: [color.contrast, color.contrast, color.contrast],
    editkin_grade_grading_primary_pivot: 0.5 + (0.4 + (color.pivot - 0.5) * 0.4) * 0.5,
    editkin_grade_grading_primary_clampBlack: -65504,
    editkin_grade_grading_primary_clampWhite: 65504,
    editkin_grade_grading_primary_saturation: color.saturation,
    editkin_grade_grading_primary_localBypass: false,
    editkin_grade_grading_tone_blacksM: clamp(1 + color.blacks * 0.5),
    editkin_grade_grading_tone_blacksStart: blackStart,
    editkin_grade_grading_tone_blacksWidth: blackStart - blackEnd,
    editkin_grade_grading_tone_shadowsM: shadows,
    editkin_grade_grading_tone_shadowsStart: shadowStart,
    editkin_grade_grading_tone_shadowsWidth: shadowPivot,
    editkin_grade_grading_tone_highlightsM: highlights,
    editkin_grade_grading_tone_highlightsStart: highlightStart,
    editkin_grade_grading_tone_highlightsWidth: highlightPivot,
    editkin_grade_grading_tone_whitesM: clamp(1 + color.whites * 0.5),
    editkin_grade_grading_tone_whitesStart: whiteStart,
    editkin_grade_grading_tone_whitesWidth: whiteEnd - whiteStart,
    editkin_grade_grading_tone_localBypass: false,
    editkin_grade_hue_radians: color.hue * Math.PI / 180,
  };
}

export function buildOcioFragmentShader(input: OcioGpuStage, grade: OcioGpuStage, output: OcioGpuStage): string {
  return `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 editkin_uv;
uniform sampler2D editkin_source;
uniform float editkin_grade_hue_radians;
out vec4 editkin_fragment;
${input.shaderText}
${grade.shaderText}
${output.shaderText}
vec3 editkin_hue_rotate(vec3 rgb) {
  float y = dot(rgb, vec3(0.299, 0.587, 0.114));
  float i = dot(rgb, vec3(0.595716, -0.274453, -0.321263));
  float q = dot(rgb, vec3(0.211456, -0.522591, 0.311135));
  float c = cos(editkin_grade_hue_radians);
  float s = sin(editkin_grade_hue_radians);
  float ri = i * c - q * s;
  float rq = i * s + q * c;
  return vec3(y + 0.9563 * ri + 0.6210 * rq, y - 0.2721 * ri - 0.6474 * rq, y - 1.107 * ri + 1.7046 * rq);
}
void main() {
  vec4 editkin_working = ${input.functionName}(texture(editkin_source, editkin_uv));
  editkin_working = ${grade.functionName}(editkin_working);
  editkin_working.rgb = editkin_hue_rotate(editkin_working.rgb);
  editkin_fragment = ${output.functionName}(editkin_working);
}`;
}

export const OCIO_VERTEX_SHADER = `#version 300 es
in vec2 editkin_position;
out vec2 editkin_uv;
void main() {
  editkin_uv = editkin_position * 0.5 + 0.5;
  gl_Position = vec4(editkin_position, 0.0, 1.0);
}`;
