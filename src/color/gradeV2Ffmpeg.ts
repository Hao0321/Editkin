import {
  BLOOM_TINT, finishingThresholdInWorkingSpace, grainNoiseStrength, HALATION_TINT, vignetteAngle,
  type ResolvedFinishingV2,
} from "./gradeV2";
import type { GradeWorkingSpace } from "./gradeV2Color";

/**
 * FFmpeg wiring for Color Grade v2.
 *
 * Measured on the bundled FFmpeg 8.1: packed rgba ↔ planar 8-bit gbrap is lossless, but
 * 8-bit → 16-bit/float planar up-conversion is off by up to ~1.1 code values. The LUT
 * therefore runs directly on the 8-bit rgba surface with a truncation-compensated render
 * copy (see `ffmpegRenderCubeText`), and spatial blends run on lossless planar gbrap.
 * Every spatial mask is derived from the frame itself, so dimensions and timestamps
 * always match, and blend `c3_mode=normal` passes the layer's own alpha through.
 */

/** Same escaping as the shipped ACES lut3d paths (drive colon and quotes). */
export function ffmpegFilterPath(path: string): string {
  return path.replaceAll("\\", "/").replace(":", "\\:").replaceAll("'", "\\'");
}

const n = (value: number) => Number(value.toFixed(6)).toString();

export function gradeV2LutFilters(lutPath: string, highBitDepth: boolean): string[] {
  return [`format=${highBitDepth ? "gbrap16le" : "rgba"}`, `lut3d=file='${ffmpegFilterPath(lutPath)}':interp=tetrahedral`];
}

const LUMA_MIXER = "colorchannelmixer=rr=.2126:rg=.7152:rb=.0722:gr=.2126:gg=.7152:gb=.0722:br=.2126:bg=.7152:bb=.0722";
/** ACEScct vignette depth: (1 - mask) × this ≈ the γ2.4 display multiply, in log units. */
export const ACESCCT_VIGNETTE_DEPTH = 2.4 / (17.52 * Math.LN2);

function glowBranch(threshold: number, amount: number, tint: readonly number[], sigma: number, surface: string): string {
  const k = 1 / (1 - threshold);
  const ramp = `'clip((val-${n(threshold)}*maxval)*${n(k)},0,maxval)'`;
  return [
    "format=gbrap16le", LUMA_MIXER,
    `lutrgb=r=${ramp}:g=${ramp}:b=${ramp}`,
    `colorchannelmixer=rr=${n(amount * tint[0])}:rg=0:rb=0:gr=0:gg=${n(amount * tint[1])}:gb=0:br=0:bg=0:bb=${n(amount * tint[2])}`,
    `gblur=sigma=${n(Math.max(0.5, Math.min(200, sigma)))}:steps=3:planes=7`,
    `format=${surface}`,
  ].join(",");
}

/**
 * Spatial finishing sub-graph from `[input]` to `[output]`, in order halation → bloom →
 * vignette → grain. Returns complete filter chains (to be joined with ";"). The output
 * stays on the planar surface; callers convert back to their compositing format.
 */
export function gradeV2SpatialChains(input: string, output: string, finishing: ResolvedFinishingV2, options: {
  space: GradeWorkingSpace; canvasHeight: number; labelPrefix: string; highBitDepth?: boolean;
}): string[] {
  const surface = options.highBitDepth ? "gbrap16le" : "gbrap";
  const chains: string[] = [];
  let current = input;
  let index = 0;
  const next = () => `${options.labelPrefix}${index++}`;
  const first = () => current === input ? `[${input}]format=${surface},` : `[${current}]`;
  const glow = (settings: { amount: number; threshold: number; radius: number }, tint: readonly number[]) => {
    const base = next(), branch = next(), light = next(), result = next();
    chains.push(`${first()}split=2[${base}][${branch}]`);
    chains.push(`[${branch}]${glowBranch(finishingThresholdInWorkingSpace(settings.threshold, options.space), settings.amount, tint, settings.radius * options.canvasHeight, surface)}[${light}]`);
    chains.push(`[${base}][${light}]blend=c0_mode=screen:c1_mode=screen:c2_mode=screen:c3_mode=normal[${result}]`);
    current = result;
  };
  if (finishing.halation) glow(finishing.halation, HALATION_TINT);
  if (finishing.bloom) glow(finishing.bloom, BLOOM_TINT);
  if (finishing.vignette) {
    const base = next(), branch = next(), mask = next(), result = next();
    const vignette = `vignette=angle=${n(vignetteAngle(finishing.vignette.amount))}:mode=forward:eval=init:dither=0`;
    chains.push(`${first()}split=2[${base}][${branch}]`);
    if (options.space === "acescct") {
      // Multiplying log code values would crush shadows; subtract the equivalent stops instead.
      chains.push(`[${branch}]format=gbrp,lutrgb=r=255:g=255:b=255,${vignette},negate,format=${surface},colorchannelmixer=rr=${n(ACESCCT_VIGNETTE_DEPTH)}:gg=${n(ACESCCT_VIGNETTE_DEPTH)}:bb=${n(ACESCCT_VIGNETTE_DEPTH)}[${mask}]`);
      chains.push(`[${base}][${mask}]blend=c0_mode=subtract:c1_mode=subtract:c2_mode=subtract:c3_mode=normal[${result}]`);
    } else {
      chains.push(`[${branch}]format=gbrp,lutrgb=r=255:g=255:b=255,${vignette},format=${surface}[${mask}]`);
      chains.push(`[${base}][${mask}]blend=c0_mode=multiply:c1_mode=multiply:c2_mode=multiply:c3_mode=normal[${result}]`);
    }
    current = result;
  }
  if (finishing.grain) {
    const base = next(), branch = next(), plate = next(), result = next();
    const strength = Math.max(1, Math.round(grainNoiseStrength(finishing.grain.amount, finishing.grain.size) * (options.space === "acescct" ? 0.6 : 1)));
    const clump = finishing.grain.size > 1 ? `,gblur=sigma=${n((finishing.grain.size - 1) * 0.6)}:steps=2` : "";
    chains.push(`${first()}split=2[${base}][${branch}]`);
    // Monochrome film grain: one temporal Gaussian luma plate (fixed seed), added equally to R, G and B.
    chains.push(`[${branch}]format=gray,lut=c0=128,noise=c0s=${strength}:c0f=t${clump},format=${surface}[${plate}]`);
    chains.push(`[${base}][${plate}]blend=c0_mode=grainmerge:c1_mode=grainmerge:c2_mode=grainmerge:c3_mode=normal[${result}]`);
    current = result;
  }
  chains.push(`[${current}]null[${output}]`);
  return chains;
}
