import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acescctToLinear, displayToLinear, linearToAcescct, linearToDisplay } from "../color/gradeV2Color";
import { ffmpegFilterPath } from "../color/gradeV2Ffmpeg";
import { createRenderWorkDirectory, removeRenderWorkDirectory } from "./renderWorkspace";
import type { TransitionWorkingEncodingV1 } from "./timelineTransitionMixV1";

/**
 * The matte transition kernel on native FFmpeg filters (no per-pixel expressions). Same definition as the CPU reference
 * timelineTransitionMatteMixV1:  out = mix(A, B, m) ⊕ overlay, scene-linear, premultiplied coverage.
 *
 * Pipeline, all inside the transition window:
 * - 16-bit straight inputs → float with zscale (exact k/65535; swscale's RGB float conversion is not exact).
 * - Working encoding → linear with a 65536-entry 1D LUT whose nodes are the 16-bit codes (exact at every input code).
 * - premultiply, then `maskedmerge` by the matte (m = 0 and m = 1 pass A and B through bit-exactly), then the overlay
 *   as a straight-alpha "over": maskedmerge(P, overlay with alpha 1, overlay alpha) gives rgb·(1-oa) + O·oa and
 *   alpha + (1-alpha)·oa in one pass.
 * - Unpremultiply by `blend` divide (the float `unpremultiply` filter is not usable in FFmpeg 8.1), with alpha floored at
 *   1e-30 so zero coverage stays zero.
 * - Linear → working encoding with nested LUT ranges where one uniform LUT is not accurate enough (γ1/2.4 near black,
 *   ACEScct's linear range up to 222.86), selected per pixel by a two-entry step LUT and `maskedmerge`. Every LUT stage
 *   is accurate to under 0.1/65535 and every 16-bit code round-trips exactly (see the render tests).
 * - Back to 16 bits with zscale (rounds to nearest).
 */

export const TIMELINE_TRANSITION_MATTE_LUT_SIZE_V1 = 65536;
/** rec709_display encode: four ranges, each 2^-10 of the previous ([0,1], [0,2^-10], [0,2^-20], [0,2^-30]). */
const DISPLAY_RANGE_BITS = 10, DISPLAY_RANGES = 4;
/** ACEScct encode: [x·(1-2^-7)+2^-7] covers the negative linear codes (cct < 0.0729) up to 0.5; DOMAIN 256 covers the rest. */
const ACESCCT_LOW_SCALE = 1 - 2 ** -7, ACESCCT_LOW_OFFSET = 2 ** -7, ACESCCT_HIGH_DOMAIN = 256;

export interface TimelineTransitionMatteLutSpecV1 { name: string; size: number; domainMax: number; value: (u: number) => number }
/** Paths of the written LUT files, by spec name, for one working encoding. */
export interface TimelineTransitionMatteLutsV1 { space: TransitionWorkingEncodingV1; files: Readonly<Record<string, string>> }

/** The LUT files a working encoding needs: decode, the encode ranges and the selection step. Linear needs none. */
export function timelineTransitionMatteLutSpecsV1(space: TransitionWorkingEncodingV1): TimelineTransitionMatteLutSpecV1[] {
  const size = TIMELINE_TRANSITION_MATTE_LUT_SIZE_V1, step = { name: "step", size: 2, domainMax: 1, value: (u: number) => u };
  if (space === "linear") return [];
  if (space === "rec709_display") return [{ name: "decode", size, domainMax: 1, value: displayToLinear },
    ...Array.from({ length: DISPLAY_RANGES }, (_, range) => ({ name: `encode${range}`, size, domainMax: 1,
      value: (u: number) => linearToDisplay(u / 2 ** (DISPLAY_RANGE_BITS * range)) })), step];
  if (space === "acescct") return [{ name: "decode", size, domainMax: 1, value: acescctToLinear },
    { name: "encodeLow", size, domainMax: 1, value: (u: number) => linearToAcescct((u - ACESCCT_LOW_OFFSET) / ACESCCT_LOW_SCALE) },
    { name: "encodeHigh", size, domainMax: ACESCCT_HIGH_DOMAIN, value: linearToAcescct }, step];
  throw Error("TIMELINE_TRANSITION_WORKING_ENCODING_INVALID");
}

/** .cube 1D text. Values are rounded to float32 first and printed with 9 significant digits, so FFmpeg's parser
 * reads back exactly the float the table means. Nodes are u_i = domainMax · i / (size - 1). */
export function timelineTransitionMatteCubeTextV1(spec: TimelineTransitionMatteLutSpecV1): string {
  const lines = [`TITLE "Editkin matte ${spec.name}"`, `LUT_1D_SIZE ${spec.size}`];
  if (spec.domainMax !== 1) lines.push("DOMAIN_MIN 0 0 0", `DOMAIN_MAX ${spec.domainMax} ${spec.domainMax} ${spec.domainMax}`);
  for (let i = 0; i < spec.size; i += 1) {
    const value = Math.fround(spec.value(spec.domainMax * i / (spec.size - 1)));
    if (!Number.isFinite(value)) throw Error("TIMELINE_TRANSITION_MATTE_LUT_NONFINITE");
    const text = Number(value.toPrecision(9)).toString();
    lines.push(`${text} ${text} ${text}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Writes the LUT files of one working encoding into a private render work directory (removed by the caller). */
export async function prepareTimelineTransitionMatteLutsV1(space: TransitionWorkingEncodingV1): Promise<{ luts: TimelineTransitionMatteLutsV1; workDirectory?: string }> {
  const specs = timelineTransitionMatteLutSpecsV1(space);
  if (!specs.length) return { luts: { space, files: {} } };
  const workDirectory = await createRenderWorkDirectory("editkin-filtergraph-");
  try {
    const files: Record<string, string> = {};
    for (const spec of specs) {
      files[spec.name] = join(workDirectory, `matte-${space}-${spec.name}.cube`);
      await writeFile(files[spec.name], timelineTransitionMatteCubeTextV1(spec), { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    return { luts: { space, files }, workDirectory };
  } catch (error) {
    await removeRenderWorkDirectory(workDirectory);
    throw error;
  }
}

function label(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw Error("TIMELINE_TRANSITION_GRAPH_LABEL_INVALID");
  return value;
}
function lutFile(luts: TimelineTransitionMatteLutsV1, name: string): string {
  const path = luts.files[name];
  if (!path) throw Error(`TIMELINE_TRANSITION_MATTE_LUT_MISSING:${name}`);
  return path;
}
const lut1d = (path: string, nearest = false) => `lut1d=file='${ffmpegFilterPath(path)}'${nearest ? ":interp=nearest" : ""}`;
/** 16-bit planar RGBA ↔ float, no resampling or dither: exact k/65535 in, round to nearest out (zimg treats RGB as full
 * range). No range/colour options: a declared range would propagate through FFmpeg's colour negotiation to the
 * delivery link and turn the whole export into full-range YUV. */
const TO_FLOAT = "zscale=filter=point:dither=none,format=gbrapf32le";
const TO_16 = "zscale=filter=point:dither=none,format=gbrap16le";
/** Copies the alpha plane into r, g and b (0/1 coefficients, exact in float). */
const ALPHA_TO_ALL = "colorchannelmixer=rr=0:ra=1:gg=0:ga=1:bb=0:ba=1";
/** Sets alpha to exactly 1 and leaves r, g and b untouched. */
const OPAQUE_ALPHA = "colorlevels=aomin=1";
/** FFmpeg 8 frames carry an alpha mode, and `premultiply` does nothing to a frame already marked premultiplied. The
 * native over marks its result premultiplied (props follow the premultiplied base), so a second over silently skipped
 * its premultiply. Every premultiply therefore first declares the (straight) truth, and every result is re-marked. */
const PREMULTIPLY = "setparams=alpha_mode=straight,premultiply=inplace=1";
const STRAIGHT = "setparams=alpha_mode=straight";
/** x + 1e-30: a zero divisor becomes 1e-30 (so 0 / 0 → 0); every coverage the kernel can produce (≥ 65535^-3) is unchanged. */
const DIVISOR_FLOOR = "colorlevels=romin=1e-30:gomin=1e-30:bomin=1e-30";

/** Straight colour from premultiplied float RGBA: rgb / max(alpha, 1e-30), alpha unchanged. */
function unpremultiplyGraph(input: string, output: string, prefix: string): string[] {
  return [`[${input}]split[${prefix}num][${prefix}den]`, `[${prefix}den]${ALPHA_TO_ALL},${DIVISOR_FLOOR}[${prefix}div]`,
    `[${prefix}num][${prefix}div]blend=c0_mode=divide:c1_mode=divide:c2_mode=divide:c3_mode=normal,${STRAIGHT}[${output}]`];
}

/** Float linear (straight) → float working encoding. */
function encodeGraph(input: string, output: string, luts: TimelineTransitionMatteLutsV1, prefix: string): string[] {
  if (luts.space === "linear") return [`[${input}]null[${output}]`];
  if (luts.space === "acescct") {
    const low = `${ACESCCT_LOW_OFFSET}`;
    return [`[${input}]split=3[${prefix}low][${prefix}high][${prefix}pick]`,
      `[${prefix}low]colorlevels=romin=${low}:gomin=${low}:bomin=${low},${lut1d(lutFile(luts, "encodeLow"))}[${prefix}lowcct]`,
      `[${prefix}high]${lut1d(lutFile(luts, "encodeHigh"))}[${prefix}highcct]`,
      // x < 0.5 → low range, x ≥ 0.5 → high range (both are accurate across the switch).
      `[${prefix}pick]${lut1d(lutFile(luts, "step"), true)}[${prefix}step]`,
      `[${prefix}lowcct][${prefix}highcct][${prefix}step]maskedmerge,split[${prefix}cct][${prefix}cover]`,
      // ACEScct encodes linear 0 as 0.0729; zero coverage must stay transparent black (0, 0, 0, 0), as in the reference.
      // alpha / (alpha + 1e-30) is exactly 1 for every coverage the kernel can produce and exactly 0 for none.
      `[${prefix}cover]${ALPHA_TO_ALL},split[${prefix}covernum][${prefix}coverden]`, `[${prefix}coverden]${DIVISOR_FLOOR}[${prefix}coverdiv]`,
      `[${prefix}covernum][${prefix}coverdiv]blend=c0_mode=divide:c1_mode=divide:c2_mode=divide:c3_mode=normal[${prefix}covered]`,
      `[${prefix}cct][${prefix}covered]blend=c0_mode=multiply:c1_mode=multiply:c2_mode=multiply:c3_mode=normal[${output}]`];
  }
  if (luts.space !== "rec709_display") throw Error("TIMELINE_TRANSITION_WORKING_ENCODING_INVALID");
  const filters: string[] = [], scale = `${2 ** -DISPLAY_RANGE_BITS}`;
  filters.push(`[${input}]split[${prefix}x0][${prefix}x0next]`, `[${prefix}x0]${lut1d(lutFile(luts, "encode0"))}[${prefix}out0]`);
  for (let range = 1; range < DISPLAY_RANGES; range += 1) {
    const x = `${prefix}x${range}`, last = range === DISPLAY_RANGES - 1;
    // x_r = x · 2^(10r), exact (power-of-two scale).
    filters.push(`[${prefix}x${range - 1}next]colorlevels=rimax=${scale}:gimax=${scale}:bimax=${scale},split=${last ? 2 : 3}[${x}lut][${x}pick]${last ? "" : `[${x}next]`}`);
    filters.push(`[${x}lut]${lut1d(lutFile(luts, `encode${range}`))}[${x}enc]`, `[${x}pick]${lut1d(lutFile(luts, "step"), true)}[${x}step]`);
    // x_r < 0.5 → this finer range; otherwise keep the coarser result.
    filters.push(`[${x}enc][${prefix}out${range - 1}][${x}step]maskedmerge[${last ? output : `${prefix}out${range}`}]`);
  }
  return filters;
}

/**
 * Straight-alpha source-over of two 16-bit straight canvases in their working encoding, as aces16AlphaOverGraphV1:
 * colour = (F·af + B·ab·(1-af)) / a, a = af + ab·(1-af), rounded once to 16 bits. Opaque foregrounds and m = 0/1 style
 * endpoints are exact; elsewhere float32 can differ from the double-precision expression by at most one code at a
 * rounding tie. A blend mode replaces the foreground colour by (1-ab)·F + ab·blend(B, F) first, as the geq graph does.
 */
export function timelineTransitionNativeAlphaOverV1(base: string, foreground: string, output: string, mode = "normal"): string[] {
  [base, foreground, output].forEach(label);
  if (!/^[a-z0-9_]+$/.test(mode)) throw Error("TIMELINE_TRANSITION_BLEND_MODE_INVALID");
  const p = `${output}over`, filters: string[] = [];
  let colour = `${p}fgcolour`;
  if (mode === "normal") filters.push(`[${base}]${TO_FLOAT},${PREMULTIPLY}[${p}bg]`, `[${foreground}]${TO_FLOAT},split[${colour}][${p}fgalpha]`);
  else {
    filters.push(`[${base}]split[${p}base][${p}blendbase]`, `[${foreground}]split[${p}fg][${p}blendfg]`,
      `[${p}blendbase][${p}blendfg]blend=c0_mode=${mode}:c1_mode=${mode}:c2_mode=${mode}:c3_mode=normal:shortest=0:repeatlast=0,${TO_FLOAT}[${p}blended]`,
      // premultiply runs in place without a writability check: never on a split branch (it corrupts its siblings).
      `[${p}base]${TO_FLOAT},${PREMULTIPLY},split[${p}bg][${p}bgcoverage]`,
      `[${p}bgcoverage]${ALPHA_TO_ALL}[${p}bgmask]`, `[${p}fg]${TO_FLOAT},split[${p}fgraw][${p}fgalpha]`,
      // Blend colour applies only where the background has coverage; the foreground keeps its own alpha (planes 0-2).
      `[${p}fgraw][${p}blended][${p}bgmask]maskedmerge=planes=7[${colour}]`);
  }
  filters.push(`[${p}fgalpha]${ALPHA_TO_ALL}[${p}fgmask]`, `[${colour}]${OPAQUE_ALPHA}[${p}fgopaque]`,
    `[${p}bg][${p}fgopaque][${p}fgmask]maskedmerge[${p}premul]`, ...unpremultiplyGraph(`${p}premul`, `${p}straight`, `${p}u`),
    `[${p}straight]${TO_16}[${output}]`);
  return filters;
}

/**
 * The matte kernel graph. Inputs are 16-bit straight-alpha canvases on the same frames (the transition window):
 * from, to, the matte (coverage in its alpha plane, full 16-bit scale) and optionally the overlay, all in the working
 * encoding of `luts`. Output: 16-bit straight RGBA in the working encoding.
 */
export function timelineTransitionMatteMixGraphV1(from: string, to: string, matte: string, overlay: string | undefined, output: string,
  luts: TimelineTransitionMatteLutsV1): string[] {
  [from, to, matte, output, ...(overlay ? [overlay] : [])].forEach(label);
  const p = `${output}kernel`, decode = luts.space === "linear" ? "" : `,${lut1d(lutFile(luts, "decode"))}`;
  if (!["linear", "acescct", "rec709_display"].includes(luts.space)) throw Error("TIMELINE_TRANSITION_WORKING_ENCODING_INVALID");
  const filters = [`[${from}]${TO_FLOAT}${decode},${PREMULTIPLY}[${p}a]`, `[${to}]${TO_FLOAT}${decode},${PREMULTIPLY}[${p}b]`,
    `[${matte}]${TO_FLOAT},${ALPHA_TO_ALL}[${p}m]`, `[${p}a][${p}b][${p}m]maskedmerge[${p}mix]`];
  let premultiplied = `${p}mix`;
  if (overlay) {
    filters.push(`[${overlay}]${TO_FLOAT},split[${p}ocolour][${p}oalpha]`, `[${p}oalpha]${ALPHA_TO_ALL}[${p}omask]`,
      `[${p}ocolour]${OPAQUE_ALPHA}${decode}[${p}oopaque]`, `[${p}mix][${p}oopaque][${p}omask]maskedmerge[${p}over]`);
    premultiplied = `${p}over`;
  }
  filters.push(...unpremultiplyGraph(premultiplied, `${p}linear`, `${p}u`), ...encodeGraph(`${p}linear`, `${p}encoded`, luts, `${p}e`),
    `[${p}encoded]${TO_16}[${output}]`);
  return filters;
}
