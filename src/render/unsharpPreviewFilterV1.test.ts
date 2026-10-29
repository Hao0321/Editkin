import { describe, expect, it } from "vitest";
import { EFFECT_PRESETS, previewEffectFilter } from "../creative/corePack";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { initializeWave2Registry } from "../creative/wave2Registry";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";
import { effectFilters } from "./creativeFilters";
import { PREVIEW_APPROXIMATE_EFFECT_RENDERERS_V1, FFMPEG_CRISP_PREVIEW_FILTER_V1, FFMPEG_CRISP_UNSHARP_V1, UNSHARP_LUMA_WEIGHTS_V1, ffmpegUnsharpArgumentV1,
  unsharpBlurWeightsV1, unsharpCssFilterV1, unsharpSvgFilterV1 } from "./unsharpPreviewFilterV1";

/** previewEffectFilter([id]) for every registered effect, captured before the ffmpeg-crisp changes (2026-10-23). */
const PREVIEW_FILTERS_BEFORE: Readonly<Record<string, string>> = {
  film_grain_soft: "contrast(1.04)", analog_print_soft: "contrast(1.04)", mono_halftone: "grayscale(1) contrast(1.16)", xerox_pulse: "grayscale(1) contrast(1.16)",
  high_key_bloom: "brightness(1.08)", scanline_focus: "contrast(1.1)", studio_vignette_soft: "contrast(1.04)", studio_clean_denoise: "contrast(.99)",
  studio_detail_pop: "contrast(1.12) saturate(1.04)", studio_pastel_wash: "brightness(1.04) contrast(.94) saturate(.9)",
  studio_night_depth: "brightness(.92) contrast(1.16) saturate(1.06)", studio_highlight_rolloff: "brightness(1.03) contrast(.97)",
  studio_backdrop_soft: "blur(10px) brightness(.68)", exp26w2_documentary_crisp: "contrast(1.1)", exp26w2_ui_focus_crisp: "contrast(1.1)",
  exp26w2_soft_product_bloom: "brightness(1.08)", exp26w2_memory_bloom: "brightness(1.08)", exp26w2_archival_mono: "grayscale(1) contrast(1.16)",
  exp26w2_proof_mono: "grayscale(1) contrast(1.16)", exp26w2_paper_grain_light: "contrast(1.04)", exp26w2_night_grain_fine: "contrast(1.04)",
  exp26w2_signal_crisp: "contrast(1.1)", exp26w2_quiet_bloom: "brightness(1.08)", exp26w2_xerox_context: "grayscale(1) contrast(1.16)",
  exp26w2_tactile_document: "contrast(1.04)",
};

function clip(effectPresetIds: string[]): TimelineClip {
  return { id: "c", assetId: "a", trackId: "t", timelineStart: 0, sourceStart: 0, duration: 1, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], creative: { effectPresetIds } };
}

function kernels(svg: string): { chroma: number[]; luma: number[]; weights: number[] } {
  const matrices = [...svg.matchAll(/kernelMatrix="([^"]+)"/g)].map(match => match[1].split(" ").map(Number));
  const luma = /result="luma"/.test(svg) ? [...svg.matchAll(/type="matrix" values="([^"]+)"/g)][1][1].split(" ").map(Number) : [];
  return { chroma: matrices[0], luma: matrices[1], weights: luma.slice(0, 3) };
}

/** Clamp-to-edge separable blur with FFmpeg unsharp's binomial weights. */
function blur(plane: Float64Array, width: number, height: number, size: number): Float64Array {
  const weights = unsharpBlurWeightsV1(size), r = (size - 1) / 2, row = new Float64Array(plane.length), out = new Float64Array(plane.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let sum = 0; for (let i = -r; i <= r; i += 1) sum += weights[i + r] * plane[y * width + Math.min(width - 1, Math.max(0, x + i))]; row[y * width + x] = sum;
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let sum = 0; for (let i = -r; i <= r; i += 1) sum += weights[i + r] * row[Math.min(height - 1, Math.max(0, y + i)) * width + x]; out[y * width + x] = sum;
  }
  return out;
}

/** feConvolveMatrix with edgeMode="duplicate" (symmetric kernels, so the 180° rotation does not matter). */
function convolve(plane: Float64Array, width: number, height: number, kernel: number[]): Float64Array {
  const order = Math.sqrt(kernel.length), r = (order - 1) / 2, out = new Float64Array(plane.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let j = -r; j <= r; j += 1) for (let i = -r; i <= r; i += 1) {
      sum += kernel[(j + r) * order + i + r] * plane[Math.min(height - 1, Math.max(0, y + j)) * width + Math.min(width - 1, Math.max(0, x + i))];
    }
    out[y * width + x] = sum;
  }
  return out;
}

const CRISP_IDS = ["scanline_focus", "exp26w2_documentary_crisp", "exp26w2_ui_focus_crisp", "exp26w2_signal_crisp"];

describe("ffmpeg-crisp preview filter (FFmpeg unsharp as SVG)", () => {
  it("changes only the four ffmpeg-crisp effects: the other 21 registered effects keep their former preview filter", () => {
    initializeStudioCreativeAssets(); initializeWave2Registry();
    const ids = EFFECT_PRESETS.map(preset => preset.id);
    expect([...ids].sort()).toEqual(Object.keys(PREVIEW_FILTERS_BEFORE).sort());
    expect(EFFECT_PRESETS.filter(preset => preset.renderer === "ffmpeg-crisp").map(preset => preset.id)).toEqual(CRISP_IDS);
    for (const id of ids) expect(previewEffectFilter([id]), id).toBe(CRISP_IDS.includes(id) ? FFMPEG_CRISP_PREVIEW_FILTER_V1 : PREVIEW_FILTERS_BEFORE[id]);
    expect(ids.filter(id => !CRISP_IDS.includes(id))).toHaveLength(21);
    expect(previewEffectFilter(["film_grain_soft", "scanline_focus"])).toBe(`contrast(1.04) ${FFMPEG_CRISP_PREVIEW_FILTER_V1}`);
    expect([...PREVIEW_APPROXIMATE_EFFECT_RENDERERS_V1]).toEqual(["ffmpeg-crisp"]);
  });

  it("stands for the export's own unsharp argument, unchanged and the same for every ffmpeg-crisp effect", () => {
    initializeStudioCreativeAssets(); initializeWave2Registry();
    for (const id of CRISP_IDS) expect(effectFilters(clip([id])), id).toEqual([ffmpegUnsharpArgumentV1(FFMPEG_CRISP_UNSHARP_V1)]);
    expect(ffmpegUnsharpArgumentV1(FFMPEG_CRISP_UNSHARP_V1)).toBe("unsharp=5:5:0.65:3:3:0.25");
    expect(unsharpBlurWeightsV1(5).map(value => value * 16)).toEqual([1, 4, 6, 4, 1]);
    expect(unsharpBlurWeightsV1(3).map(value => value * 4)).toEqual([1, 2, 1]);
  });

  it("is a self-contained data-URL filter with sRGB maths, the layer's own box, duplicated edges and signed details", () => {
    const svg = unsharpSvgFilterV1(FFMPEG_CRISP_UNSHARP_V1);
    expect(FFMPEG_CRISP_PREVIEW_FILTER_V1).toBe(unsharpCssFilterV1(FFMPEG_CRISP_UNSHARP_V1));
    const match = /^url\("data:image\/svg\+xml,([^"#]+)#editkin-unsharp"\)$/.exec(FFMPEG_CRISP_PREVIEW_FILTER_V1);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe(svg);
    expect(svg).toContain('<filter id="editkin-unsharp" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">');
    expect(svg.match(/edgeMode="duplicate"/g)).toHaveLength(2);
    expect(svg.match(/bias="0.5019607843"/g)).toHaveLength(2);
    expect(svg.match(/k4="-0.5019607843"/g)).toHaveLength(2);
    expect(svg).toContain('<feComposite in="sharpened" in2="SourceGraphic" operator="in"/>');
    const { chroma, luma, weights } = kernels(svg);
    expect(chroma).toHaveLength(9); expect(luma).toHaveLength(25);
    expect(chroma.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 9);
    expect(luma.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 9);
    expect(weights).toEqual([UNSHARP_LUMA_WEIGHTS_V1.red, UNSHARP_LUMA_WEIGHTS_V1.green, UNSHARP_LUMA_WEIGHTS_V1.blue]);
    expect(() => unsharpSvgFilterV1({ ...FFMPEG_CRISP_UNSHARP_V1, lumaSize: 4 })).toThrow(/odd/);
    expect(() => unsharpSvgFilterV1({ ...FFMPEG_CRISP_UNSHARP_V1, chromaAmount: Number.NaN })).toThrow(/amount/);
  });

  it("its RGB maths equals FFmpeg's per-plane unsharp in BT.601 Y'CbCr (before rounding and clamping)", () => {
    const width = 13, height = 9, size = width * height;
    let seed = 7;
    const random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
    const [red, green, blue] = [0, 1, 2].map(() => Float64Array.from({ length: size }, random));
    const { red: kr, green: kg, blue: kb } = UNSHARP_LUMA_WEIGHTS_V1;
    // Reference: Y, Cb ∝ B − Y, Cr ∝ R − Y; each plane sharpened on its own (luma 5×5 0.65, chroma 3×3 0.25).
    const y = red.map((r, i) => kr * r + kg * green[i] + kb * blue[i]), cb = blue.map((b, i) => b - y[i]), cr = red.map((r, i) => r - y[i]);
    const sharpen = (plane: Float64Array, matrix: number, amount: number) => { const blurred = blur(plane, width, height, matrix); return plane.map((v, i) => v + amount * (v - blurred[i])); };
    const y2 = sharpen(y, 5, 0.65), cb2 = sharpen(cb, 3, 0.25), cr2 = sharpen(cr, 3, 0.25);
    const reference = [y2.map((v, i) => v + cr2[i]), y2.map((v, i) => (v - kr * (v + cr2[i]) - kb * (v + cb2[i])) / kg), y2.map((v, i) => v + cb2[i])];
    // The SVG filter's maths with its own kernels (biases cancel): out = rgb + chroma3×3(rgb) + luma5×5(Y).
    const { chroma, luma } = kernels(unsharpSvgFilterV1(FFMPEG_CRISP_UNSHARP_V1));
    const lumaDetail = convolve(y, width, height, luma);
    const filtered = [red, green, blue].map(plane => { const detail = convolve(plane, width, height, chroma); return plane.map((v, i) => v + detail[i] + lumaDetail[i]); });
    let worst = 0;
    for (let c = 0; c < 3; c += 1) for (let i = 0; i < size; i += 1) worst = Math.max(worst, Math.abs(filtered[c][i] - reference[c][i]));
    // Kernel values are written with 10 decimals.
    expect(worst).toBeLessThan(1e-8);
  });
});
