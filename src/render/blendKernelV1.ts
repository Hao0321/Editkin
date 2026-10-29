import type { LayerBlendMode } from "../domain/types";

/**
 * Editkin blend kernel v1: the single definition of layer blending (design D1, AUDIT_AND_PLAN 2026-10-22).
 *
 * Maths: W3C Compositing and Blending Level 1, straight alpha, source-over with a blend function:
 *   αo = αs + αb·(1 − αs)
 *   co = (1 − αs)·αb·Cb + αs·((1 − αb)·Cs + αb·B(Cb, Cs))      (premultiplied), Co = co / αo
 * With an opaque backdrop this is Co = (1 − αs)·Cb + αs·B(Cb, Cs): opacity is source-over of the blended colour,
 * never a mix toward a "neutral" colour. B is evaluated on operands in [0, 1].
 *
 * This module owns:
 * - the JS reference (`w3cBlendV1`, `w3cCompositeV1`), used by the parity harness and tests;
 * - the FFmpeg lowering (`blendKernelColourGraphV1` and the composite graphs below; the ACES 2 scene-linear lowering
 *   is blendKernelSceneLinearV1);
 * - the WGSL source of truth, pinned here as text (`BLEND_KERNEL_WGSL_SOFT_LIGHT_V1`). The native shaders copy it.
 */

export type NonNormalBlendModeV1 = Exclude<LayerBlendMode, "normal">;

export const BLEND_MODES_V1: readonly LayerBlendMode[] = Object.freeze([
  "normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn",
]);

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** W3C soft-light D(Cb). */
function softLightD(cb: number): number {
  return cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
}

/** W3C B(Cb, Cs) for one channel. `add` is CSS `plus-lighter` (min(1, Cb + Cs)). Operands are used as given. */
export function w3cBlendV1(mode: LayerBlendMode, cb: number, cs: number): number {
  switch (mode) {
    case "normal": return cs;
    case "add": return Math.min(1, cb + cs);
    case "multiply": return cb * cs;
    case "screen": return cb + cs - cb * cs;
    case "overlay": return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case "hard_light": return cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case "soft_light": return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (softLightD(cb) - cb);
    case "difference": return Math.abs(cb - cs);
    case "darken": return Math.min(cb, cs);
    case "lighten": return Math.max(cb, cs);
    case "color_dodge": return cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs));
    case "color_burn": return cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
  }
}

/**
 * Scene-linear operands (ACES 2 projects, design D2, with the 2026-10-22 P2 amendment for Claude's review).
 * ACES 2 phone projects reconstruct display-referred sources through the output transform's inverse, so display
 * white is a scene value near 96–152, not 1. Literal D2 (clamp every operand except add/multiply) turns a black
 * screen over white footage into display 184 and leaves display-white multiply at ×96. The amended rule:
 * - add: Cb + Cs (unclamped, as D2);
 * - multiply: Cb · clamp(Cs) (source clamped, so a display-white layer is the identity);
 * - darken / lighten / difference: min / max / |Cb − Cs| (well defined for any scene value);
 * - screen, overlay, soft light, hard light, dodge, burn: B(clamp Cb, clamp Cs) + (Cb − clamp Cb), i.e. D2's clamped
 *   W3C blend for in-range backdrops, with the backdrop's out-of-range excess passed through so every identity
 *   (black screen, mid-grey overlay/soft/hard light, black dodge, white burn) holds for any backdrop.
 */
export function sceneLinearBlendV1(mode: LayerBlendMode, cb: number, cs: number): number {
  switch (mode) {
    case "normal": return cs;
    case "add": return cb + cs;
    case "multiply": return cb * clamp01(cs);
    case "darken": return Math.min(cb, cs);
    case "lighten": return Math.max(cb, cs);
    case "difference": return Math.abs(cb - cs);
    default: return w3cBlendV1(mode, clamp01(cb), clamp01(cs)) + (cb - clamp01(cb));
  }
}

/** Straight-alpha colour, every component normalized. */
export interface StraightColourV1 { r: number; g: number; b: number; a: number }

/** W3C source-over with blend of straight-alpha colours. */
export function w3cCompositeV1(backdrop: StraightColourV1, source: StraightColourV1, mode: LayerBlendMode,
  blend: (mode: LayerBlendMode, cb: number, cs: number) => number = w3cBlendV1): StraightColourV1 {
  const as = clamp01(source.a), ab = clamp01(backdrop.a);
  const ao = as + ab * (1 - as);
  if (ao <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (cb: number, cs: number) => ((1 - as) * ab * cb + as * ((1 - ab) * cs + ab * blend(mode, cb, cs))) / ao;
  return { r: channel(backdrop.r, source.r), g: channel(backdrop.g, source.g), b: channel(backdrop.b, source.b), a: ao };
}

export function isBlendModeV1(value: unknown): value is LayerBlendMode {
  return typeof value === "string" && (BLEND_MODES_V1 as readonly string[]).includes(value);
}

/** Validates an internal blend mode before it reaches a filter graph. */
export function assertBlendModeV1(value: string): LayerBlendMode {
  if (!isBlendModeV1(value)) throw Error("Invalid internal blend mode");
  return value;
}

function label(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw Error("Invalid internal blend kernel label");
  return value;
}

/** One mode's FFmpeg lowering. */
export interface BlendKernelEntryV1 {
  /**
   * FFmpeg `blend` mode and operand order. FFmpeg's first input is its "top" A; Editkin's backdrop goes first unless
   * `order` says otherwise. `exact`: equal to W3C up to rounding for every operand pair, so the native mode may be used.
   */
  ffmpeg: { mode: string; order: "backdrop-first" | "source-first"; exact: boolean };
  /** W3C B(b, s) as an FFmpeg expression of two normalized operand expressions. */
  w3c: (b: string, s: string) => string;
}

/**
 * Measured on planar RGB with FFmpeg 8.1.3 (AUDIT_AND_PLAN §1.3): overlay is keyed on A and hard light on B, so both
 * take the backdrop first; dodge(A,B) = B/(1−A) and burn(A,B) = 1−(1−B)/A need the source first and still differ from
 * W3C at the 0/0 corners (Cb = 0, Cs = 1 and Cb = 1, Cs = 0); FFmpeg's soft light is a different formula.
 */
export const BLEND_KERNEL_V1: Readonly<Record<NonNormalBlendModeV1, BlendKernelEntryV1>> = Object.freeze({
  add: { ffmpeg: { mode: "addition", order: "backdrop-first", exact: true }, w3c: (b, s) => `min(1,${b}+${s})` },
  screen: { ffmpeg: { mode: "screen", order: "backdrop-first", exact: true }, w3c: (b, s) => `${b}+${s}-${b}*${s}` },
  multiply: { ffmpeg: { mode: "multiply", order: "backdrop-first", exact: true }, w3c: (b, s) => `${b}*${s}` },
  overlay: { ffmpeg: { mode: "overlay", order: "backdrop-first", exact: true }, w3c: (b, s) => `if(lte(${b},0.5),2*${b}*${s},1-2*(1-${b})*(1-${s}))` },
  soft_light: { ffmpeg: { mode: "softlight", order: "backdrop-first", exact: false },
    w3c: (b, s) => `if(lte(${s},0.5),${b}-(1-2*${s})*${b}*(1-${b}),${b}+(2*${s}-1)*(if(lte(${b},0.25),((16*${b}-12)*${b}+4)*${b},sqrt(${b}))-${b}))` },
  hard_light: { ffmpeg: { mode: "hardlight", order: "backdrop-first", exact: true }, w3c: (b, s) => `if(lte(${s},0.5),2*${b}*${s},1-2*(1-${b})*(1-${s}))` },
  difference: { ffmpeg: { mode: "difference", order: "backdrop-first", exact: true }, w3c: (b, s) => `abs(${b}-${s})` },
  darken: { ffmpeg: { mode: "darken", order: "backdrop-first", exact: true }, w3c: (b, s) => `min(${b},${s})` },
  lighten: { ffmpeg: { mode: "lighten", order: "backdrop-first", exact: true }, w3c: (b, s) => `max(${b},${s})` },
  color_dodge: { ffmpeg: { mode: "dodge", order: "source-first", exact: false }, w3c: (b, s) => `if(eq(${b},0),0,if(gte(${s},1),1,min(1,${b}/(1-${s}))))` },
  color_burn: { ffmpeg: { mode: "burn", order: "source-first", exact: false }, w3c: (b, s) => `if(gte(${b},1),1,if(lte(${s},0),0,1-min(1,(1-${b})/${s})))` },
});

/** A quoted filter option value; commas are escaped as ffmpegExpressions.escapeExpression does. */
const quoted = (expression: string) => `'${expression.replaceAll(",", "\\,")}'`;

/**
 * Planes 0–2 of `output` = B(backdrop, source) per channel; plane 3 = the backdrop's alpha. Both inputs share one
 * planar RGBA format: `gbrap` (depth 8: an exact W3C `lut2` table) or `gbrap16le` (depth 16: FFmpeg's native mode where
 * it is exact, otherwise the W3C expression). Never feed packed RGBA here: `blend` would auto-convert to YUV (BUG-1).
 */
export function blendKernelColourGraphV1(backdrop: string, source: string, output: string, mode: NonNormalBlendModeV1, depth: 8 | 16): string[] {
  [backdrop, source, output].forEach(label);
  const entry = BLEND_KERNEL_V1[assertBlendModeV1(mode) as NonNormalBlendModeV1];
  if (!entry) throw Error("Invalid internal blend mode");
  if (depth === 8) {
    const expression = quoted(`clip(floor(255*(${entry.w3c("(x/255)", "(y/255)")})+0.5),0,255)`);
    return [`[${backdrop}][${source}]lut2=c0=${expression}:c1=${expression}:c2=${expression}:c3=x:shortest=0:repeatlast=0[${output}]`];
  }
  if (entry.ffmpeg.exact && entry.ffmpeg.order === "backdrop-first") {
    const m = entry.ffmpeg.mode;
    return [`[${backdrop}][${source}]blend=c0_mode=${m}:c1_mode=${m}:c2_mode=${m}:c3_mode=normal:shortest=0:repeatlast=0[${output}]`];
  }
  const expression = quoted(`clip(floor(65535*(${entry.w3c("(A/65535)", "(B/65535)")})+0.5),0,65535)`);
  return [`[${backdrop}][${source}]blend=c0_expr=${expression}:c1_expr=${expression}:c2_expr=${expression}:c3_mode=normal:shortest=0:repeatlast=0[${output}]`];
}

/** Copies the alpha plane into r, g and b (0/1 coefficients, exact). */
const ALPHA_TO_ALL = "colorchannelmixer=rr=0:ra=1:gg=0:ga=1:bb=0:ba=1";

/**
 * 8-bit compositor (packed `rgba` labels, as the default Rec.709 export composite): `layer` is a positioned straight
 * RGBA canvas; output = W3C source-over with blend onto `backdrop`. The foreground colour is (1 − αb)·Cs + αb·B(Cb, Cs)
 * with the layer's alpha, then the same straight-alpha `overlay` the normal path uses; on an opaque backdrop this is
 * (1 − αs)·Cb + αs·B(Cb, Cs). Every blend runs on planar `gbrap`.
 */
export function blendKernelOverRgba8GraphV1(backdrop: string, layer: string, output: string, mode: NonNormalBlendModeV1): string[] {
  [backdrop, layer, output].forEach(label);
  const p = `${output}kernel`;
  return [
    `[${backdrop}]format=gbrap,split=3[${p}bd][${p}bdblend][${p}bdcover]`,
    `[${layer}]format=gbrap,split[${p}ly][${p}lyblend]`,
    ...blendKernelColourGraphV1(`${p}bdblend`, `${p}lyblend`, `${p}mix`, mode, 8),
    `[${p}bdcover]${ALPHA_TO_ALL}[${p}bdmask]`,
    // maskedmerge keeps plane 3 of its first input: the layer's alpha.
    `[${p}ly][${p}mix][${p}bdmask]maskedmerge=planes=7,format=rgba[${p}fg]`,
    `[${p}bd]format=rgba[${p}base]`,
    `[${p}base][${p}fg]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=auto[${output}]`,
  ];
}

/**
 * 16-bit straight (`gbrap16le`) blend foreground: `foreground` = ((1 − αb)·Cs + αb·B(Cb, Cs), αs), ready for the normal
 * 16-bit source-over; `backdropOut` passes the backdrop through for that over.
 */
export function blendKernelForeground16GraphV1(backdrop: string, layer: string, backdropOut: string, foreground: string, mode: NonNormalBlendModeV1): string[] {
  [backdrop, layer, backdropOut, foreground].forEach(label);
  const p = `${foreground}kernel`;
  return [
    `[${backdrop}]split=3[${backdropOut}][${p}bdblend][${p}bdcover]`,
    `[${layer}]split[${p}ly][${p}lyblend]`,
    ...blendKernelColourGraphV1(`${p}bdblend`, `${p}lyblend`, `${p}mix`, mode, 16),
    `[${p}bdcover]${ALPHA_TO_ALL}[${p}bdmask]`,
    `[${p}ly][${p}mix][${p}bdmask]maskedmerge=planes=7,format=gbrap16le[${foreground}]`,
  ];
}

/**
 * WGSL source of truth (pinned; blendKernelV1.shaderPin.test checks every native copy). Encoded-space compositors
 * (compositor*.wgsl, windows_video.rs) evaluate soft light (mode 5) with exactly this W3C statement; the other modes
 * there were already W3C (dodge/burn ε-guarded). The scene-linear compositor (scene_linear_video.wgsl) and the CPU
 * compositor (main.rs) implement sceneLinearBlendV1.
 */
export const BLEND_KERNEL_WGSL_SOFT_LIGHT_V1 = "let d = select(sqrt(max(backdrop, vec3<f32>(0.0))), ((16.0 * backdrop - vec3<f32>(12.0)) * backdrop + vec3<f32>(4.0)) * backdrop, backdrop <= vec3<f32>(0.25)); return select(backdrop + (2.0 * source - vec3<f32>(1.0)) * (d - backdrop), backdrop - (vec3<f32>(1.0) - 2.0 * source) * backdrop * (vec3<f32>(1.0) - backdrop), source <= vec3<f32>(0.5));";

/** The retired Pegtop soft light the native shaders used before blend kernel v1 (must not reappear). */
export const RETIRED_PEGTOP_SOFT_LIGHT_WGSL = "(vec3<f32>(1.0) - 2.0 * source) * backdrop * backdrop + 2.0 * source * backdrop";
