import { acescctToLinear, linearRec709ToWorking, linearToAcescct, workingToLinearRec709 } from "../color/gradeV2Color";
import { BLEND_KERNEL_V1, assertBlendModeV1, type NonNormalBlendModeV1 } from "./blendKernelV1";
import { TIMELINE_TRANSITION_FLOAT_KIT_V1 as KIT, type TimelineTransitionMatteLutsV1 } from "./timelineTransitionMatteNativeV1";

/**
 * Blend kernel v1, ACES 2 lowering (design D2, P2). ACES 2 projects composite ACEScct codes; a non-normal layer is
 * blended in scene-linear Rec.709 (the native ACES 2 preview's space): both operands ACEScct → linear AP1 (the exact
 * 65536-node decode LUT) → linear Rec.709 (3×3, float), the scene-linear operand rule of blendKernelV1
 * (sceneLinearBlendV1), W3C source-over of the blended colour in linear, then back to ACEScct (the nested-range encode LUTs) and
 * the working precision. Only this layer's composite step changes; normal layers keep mixing ACEScct codes, so
 * normal-only ACES projects render byte-identically.
 *
 * Pixels the layer does not cover (alpha 0) keep the backdrop's exact working code: the result is selected by a
 * coverage mask, so the float round trip never touches them.
 */

type Matrix = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

/** AP1 ↔ linear Rec.709 (D65), the colour module's own matrices (gradeV2Color), read back column by column. */
export function acesRec709MatricesV1(): { ap1ToRec709: Matrix; rec709ToAp1: Matrix } {
  const zero = linearToAcescct(0), one = linearToAcescct(1);
  const columns = (map: (index: number) => readonly [number, number, number]) => [0, 1, 2].map(map);
  const ap1Columns = columns(index => workingToLinearRec709([0, 1, 2].map(channel => (channel === index ? one : zero)) as [number, number, number], "acescct"));
  const rec709Columns = columns(index => linearRec709ToWorking([0, 1, 2].map(channel => (channel === index ? 1 : 0)) as [number, number, number], "acescct")
    .map(acescctToLinear) as [number, number, number]);
  const transpose = (cols: ReadonlyArray<readonly [number, number, number]>): Matrix =>
    [0, 1, 2].map(row => [cols[0][row], cols[1][row], cols[2][row]] as const) as unknown as Matrix;
  return { ap1ToRec709: transpose(ap1Columns), rec709ToAp1: transpose(rec709Columns) };
}

/** colorchannelmixer for out = M · rgb (alpha untouched). Float coefficients with 12 significant digits. */
export function colorMatrixFilterV1(matrix: Matrix): string {
  const value = (number: number) => Number(number.toPrecision(12)).toString();
  const names = ["r", "g", "b"] as const;
  return `colorchannelmixer=${names.flatMap((out, row) => names.map((input, column) => `${out}${input}=${value(matrix[row][column])}`)).join(":")}`;
}

/**
 * blendKernelV1.sceneLinearBlendV1 as an FFmpeg `blend` expression of float operands (A = backdrop, B = source):
 * add and the min/max/difference modes unclamped, multiply with the source clamped, the others clamped W3C plus the
 * backdrop's out-of-range excess.
 */
export function sceneLinearBlendExpressionV1(mode: NonNormalBlendModeV1): string {
  assertBlendModeV1(mode);
  if (mode === "add") return "A+B";
  if (mode === "multiply") return "A*clip(B,0,1)";
  if (mode === "darken") return "min(A,B)";
  if (mode === "lighten") return "max(A,B)";
  if (mode === "difference") return "abs(A-B)";
  return `(${BLEND_KERNEL_V1[mode].w3c("clip(A,0,1)", "clip(B,0,1)")})+(A-clip(A,0,1))`;
}

/** One 8-bit code: colorlevels maps 0 → 0 and every code ≥ 1 → 255. */
const COVERAGE_STEP_8 = Number((1 / 255).toPrecision(12)).toString();

function label(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw Error("Invalid internal ACES blend label");
  return value;
}

export interface SceneLinearBlendGraphV1 {
  backdrop: string;
  layer: string;
  output: string;
  mode: NonNormalBlendModeV1;
  /** The project's ACEScct decode/encode LUT files (prepareTimelineTransitionMatteLutsV1("acescct")). */
  luts: TimelineTransitionMatteLutsV1;
  /** Working precision of both inputs and the output: 16-bit planar (`gbrap16le`) or the 8-bit packed `rgba` composite. */
  precision: "gbrap16le" | "rgba";
  /** The backdrop is opaque everywhere (the composite canvas); otherwise the straight-alpha premultiplied over is used. */
  opaqueBackdrop: boolean;
}

/** One non-normal layer composited onto an ACEScct backdrop, blended in scene-linear Rec.709 (see the module note). */
export function blendKernelSceneLinearGraphV1(options: SceneLinearBlendGraphV1): string[] {
  const { backdrop, layer, output, mode, luts, precision, opaqueBackdrop } = options;
  [backdrop, layer, output].forEach(label);
  if (luts.space !== "acescct") throw Error("ACES scene-linear blend needs the ACEScct LUTs");
  const p = `${output}aceslin`;
  const { ap1ToRec709, rec709ToAp1 } = acesRec709MatricesV1();
  // Exact conversions: zimg maps k/(2^n − 1) to float and rounds back to nearest (swscale's RGB float paths are not exact).
  const toFloat = precision === "rgba" ? `format=gbrap,${KIT.TO_FLOAT}` : KIT.TO_FLOAT;
  const toWorking = precision === "rgba" ? "zscale=filter=point:dither=none,format=gbrap" : KIT.TO_16;
  const working = precision === "rgba" ? "gbrap" : "gbrap16le";
  const linear = `${toFloat},${KIT.decodeFilter(luts)},${colorMatrixFilterV1(ap1ToRec709)}`;
  const expression = `'${sceneLinearBlendExpressionV1(mode).replaceAll(",", "\\,")}'`;
  const filters = [
    `[${backdrop}]format=${working},split=${opaqueBackdrop ? 2 : 3}[${p}bdkeep][${p}bdwork]${opaqueBackdrop ? "" : `[${p}bdpremul]`}`,
    `[${layer}]format=${working},split[${p}lywork][${p}lyalpha]`,
    `[${p}bdwork]${linear},split=${opaqueBackdrop ? 3 : 2}${opaqueBackdrop ? `[${p}bdlin]` : ""}[${p}bdblend][${p}bdcov]`,
    `[${p}lywork]${linear},split[${p}lylin][${p}lyblend]`,
    `[${p}bdblend][${p}lyblend]blend=c0_expr=${expression}:c1_expr=${expression}:c2_expr=${expression}:c3_mode=normal:shortest=0:repeatlast=0[${p}mix]`,
    `[${p}bdcov]${KIT.ALPHA_TO_ALL}[${p}bdmask]`,
    // (1 − αb)·Cs + αb·B(Cb, Cs), alpha αs (maskedmerge keeps its first input's alpha plane).
    `[${p}lylin][${p}mix][${p}bdmask]maskedmerge=planes=7[${p}fg]`,
  ];
  if (opaqueBackdrop) {
    filters.push(`[${p}fg]split[${p}fgcolour][${p}fgcov]`, `[${p}fgcov]${KIT.ALPHA_TO_ALL}[${p}fgmask]`,
      // (1 − αs)·Cb + αs·colour; the backdrop's (opaque) alpha is kept.
      `[${p}bdlin][${p}fgcolour][${p}fgmask]maskedmerge=planes=7[${p}outlin]`);
  } else {
    // premultiply runs in place: it gets its own converted copy of the backdrop, never a split branch.
    filters.push(`[${p}bdpremul]${linear},${KIT.PREMULTIPLY}[${p}bg]`, `[${p}fg]split[${p}fgcolour][${p}fgcov]`, `[${p}fgcov]${KIT.ALPHA_TO_ALL}[${p}fgmask]`,
      `[${p}fgcolour]${KIT.OPAQUE_ALPHA}[${p}fgopaque]`, `[${p}bg][${p}fgopaque][${p}fgmask]maskedmerge[${p}premul]`,
      ...KIT.unpremultiplyGraph(`${p}premul`, `${p}outlin`, `${p}u`));
  }
  filters.push(`[${p}outlin]${colorMatrixFilterV1(rec709ToAp1)}[${p}outap1]`, ...KIT.encodeGraph(`${p}outap1`, `${p}outcct`, luts, `${p}e`),
    `[${p}outcct]${toWorking}[${p}result]`,
    // Coverage selection: 1 where the layer has any alpha, 0 elsewhere (exact on the working codes).
    // 8 bit: colorlevels with a one-code input range is an exact step. 16 bit: lut/lutrgb/colorlevels would round-trip
    // through 8 bit or overflow (measured with FFmpeg 8.1.3), so geq writes the step on the native planes.
    `[${p}lyalpha]${precision === "rgba"
      ? `${KIT.ALPHA_TO_ALL},colorlevels=rimax=${COVERAGE_STEP_8}:gimax=${COVERAGE_STEP_8}:bimax=${COVERAGE_STEP_8}:aimax=${COVERAGE_STEP_8}`
      : "geq=r='gt(alpha(X\\,Y)\\,0)*65535':g='gt(alpha(X\\,Y)\\,0)*65535':b='gt(alpha(X\\,Y)\\,0)*65535':a='gt(alpha(X\\,Y)\\,0)*65535':interpolation=nearest"}[${p}covered]`,
    `[${p}bdkeep][${p}result][${p}covered]maskedmerge=planes=15${precision === "rgba" ? ",format=rgba" : ",format=gbrap16le"}[${output}]`);
  return filters;
}
