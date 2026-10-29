/**
 * FFmpeg `unsharp` as an SVG filter for the CSS preview of the ffmpeg-crisp renderer: the legacy effect
 * `scanline_focus` (「掃描聚焦」) and the wave-2 presets exp26w2_documentary_crisp, exp26w2_ui_focus_crisp and
 * exp26w2_signal_crisp, which all export the same sharpen. The export is the reference (23 saved projects and the
 * gaming / short-form auto-appliers deliver it, see exportFeatureGuardV1).
 *
 * What the export does: `unsharp=5:5:0.65:3:3:0.25` (creativeFilters.ts, renderer ffmpeg-crisp) on the clip's
 * canvas-padded straight-alpha RGBA layer. unsharp takes planar YUV only, so FFmpeg converts rgba → yuva444p
 * (swscale's default BT.601 matrix, limited range) and back. Each plane gets out = in + amount·(in − blur(in)),
 * where blur is the binomial kernel ([1,1] convolved 2·steps times: 1-4-6-4-1 for size 5, 1-2-1 for size 3)
 * with clamp-to-edge borders: luma 5×5 at 0.65, both chroma planes 3×3 at 0.25; alpha is not touched.
 *
 * The same thing in RGB (the conversion is linear, so the chroma planes' detail is the RGB detail minus its luma):
 *   out = rgb + c·(rgb − B₃·rgb) + [a·(Y − B₅·Y) − c·(Y − B₃·Y)]·(1, 1, 1),   Y = 0.299 R + 0.587 G + 0.114 B
 * The filter makes the layer opaque (a transparent letterbox reads as black, like FFmpeg's black@0 pad), takes the
 * per-channel chroma detail (3×3) and the luma detail (BT.601 matrix, then 5×5), each signed and biased by 128/255
 * (exactly one 8-bit code, so the bias cancels without rounding drift), adds both to the layer with arithmetic
 * composites so only the final sum is clamped, and restores the layer's own alpha.
 *
 * Exactness (src/render/parity/scanlineFocusPreviewParityV1.ts, Chrome/Edge 155, 2026-10-23): at one device pixel
 * per project pixel the real Preview, put through the export's own delivery, differs from the export by at most
 * 6 codes (p99.9 ≤ 4, p99 ≤ 3, mean ≤ 0.86) on grey edges/lines/glyphs, saturated colour edges with noise, the
 * demo fixture frame and a real screen-recorded game UI frame; the former contrast(1.1) was 33–75 (p99 13–32).
 * The rest is FFmpeg's integer rounding and its clamping per YUV plane. Chromium runs feConvolveMatrix in device
 * pixels, so a preview drawn smaller (or at another device scale) sharpens at the display's scale instead of the
 * project's: at half size it is about as close to the export as no sharpening at all. It stays an approximation,
 * and clips using it show 「預覽近似」.
 */
export interface UnsharpParamsV1 {
  /** Odd luma matrix size (FFmpeg luma_msize_x/y). */
  readonly lumaSize: number;
  readonly lumaAmount: number;
  /** Odd chroma matrix size (FFmpeg chroma_msize_x/y). */
  readonly chromaSize: number;
  readonly chromaAmount: number;
}

/** Renderer ffmpeg-crisp (scanline_focus and the three wave-2 crisp presets): the export's `unsharp=5:5:0.65:3:3:0.25`. */
export const FFMPEG_CRISP_UNSHARP_V1: UnsharpParamsV1 = Object.freeze({ lumaSize: 5, lumaAmount: 0.65, chromaSize: 3, chromaAmount: 0.25 });

/** BT.601 luma weights: the matrix of FFmpeg's automatic rgba → yuva444p conversion in front of unsharp. */
export const UNSHARP_LUMA_WEIGHTS_V1 = Object.freeze({ red: 0.299, green: 0.587, blue: 0.114 });

/** The signed-detail bias: 128/255 is one exact 8-bit code. */
const BIAS = 128 / 255;
const FILTER_ID = "editkin-unsharp";

function assertParams(params: UnsharpParamsV1): void {
  for (const size of [params.lumaSize, params.chromaSize]) {
    if (!Number.isInteger(size) || size < 3 || size > 7 || size % 2 === 0) throw new Error(`unsharp preview matrix size must be odd 3–7: ${size}`);
  }
  for (const amount of [params.lumaAmount, params.chromaAmount]) {
    if (!Number.isFinite(amount) || amount < -2 || amount > 5) throw new Error(`unsharp preview amount out of range: ${amount}`);
  }
}

/** The FFmpeg argument these parameters stand for (the export's own string for scanline_focus). */
export function ffmpegUnsharpArgumentV1(params: UnsharpParamsV1): string {
  return `unsharp=${params.lumaSize}:${params.lumaSize}:${params.lumaAmount}:${params.chromaSize}:${params.chromaSize}:${params.chromaAmount}`;
}

/** FFmpeg unsharp's blur weights for one axis: binomial coefficients of order size − 1, normalised. */
export function unsharpBlurWeightsV1(size: number): number[] {
  let row = [1];
  for (let step = 1; step < size; step += 1) row = [...row, 0].map((value, index) => value + (index > 0 ? row[index - 1] : 0));
  const total = row.reduce((sum, value) => sum + value, 0);
  return row.map(value => value / total);
}

/** Row-major `order`×`order` kernel of amount·(δ − blur), the blur centred. */
function detailKernel(order: number, size: number, amount: number): number[] {
  const weights = unsharpBlurWeightsV1(size), offset = (order - size) / 2, centre = (order - 1) / 2;
  const kernel: number[] = [];
  for (let y = 0; y < order; y += 1) for (let x = 0; x < order; x += 1) {
    const inside = y >= offset && y < offset + size && x >= offset && x < offset + size;
    kernel.push(amount * ((x === centre && y === centre ? 1 : 0) - (inside ? weights[y - offset] * weights[x - offset] : 0)));
  }
  return kernel;
}

const number = (value: number) => {
  const text = (Math.abs(value) < 1e-12 ? 0 : value).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
};

/** The SVG document holding the filter (`#editkin-unsharp`). */
export function unsharpSvgFilterV1(params: UnsharpParamsV1): string {
  assertParams(params);
  const { red, green, blue } = UNSHARP_LUMA_WEIGHTS_V1;
  const lumaOrder = Math.max(params.lumaSize, params.chromaSize);
  const chroma = detailKernel(params.chromaSize, params.chromaSize, params.chromaAmount);
  const lumaDetail = detailKernel(lumaOrder, params.lumaSize, params.lumaAmount);
  const chromaOnLuma = detailKernel(lumaOrder, params.chromaSize, params.chromaAmount);
  const luma = lumaDetail.map((value, index) => value - chromaOnLuma[index]);
  const bias = number(BIAS), weights = [red, green, blue, 0, 0].map(number).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg"><filter id="${FILTER_ID}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">`
    + `<feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1" result="opaque"/>`
    + `<feConvolveMatrix in="opaque" order="${params.chromaSize}" kernelMatrix="${chroma.map(number).join(" ")}" divisor="1" bias="${bias}" edgeMode="duplicate" preserveAlpha="true" result="chroma"/>`
    + `<feColorMatrix in="opaque" type="matrix" values="${weights} ${weights} ${weights} 0 0 0 0 1" result="luma"/>`
    + `<feConvolveMatrix in="luma" order="${lumaOrder}" kernelMatrix="${luma.map(number).join(" ")}" divisor="1" bias="${bias}" edgeMode="duplicate" preserveAlpha="true" result="lumaDetail"/>`
    + `<feComposite in="chroma" in2="lumaDetail" operator="arithmetic" k1="0" k2="1" k3="1" k4="-${bias}" result="detail"/>`
    + `<feComposite in="opaque" in2="detail" operator="arithmetic" k1="0" k2="1" k3="1" k4="-${bias}" result="sharpened"/>`
    + `<feComposite in="sharpened" in2="SourceGraphic" operator="in"/>`
    + `</filter></svg>`;
}

/** A self-contained CSS filter function (`url("data:image/svg+xml,…#editkin-unsharp")`); no DOM definitions needed. */
export function unsharpCssFilterV1(params: UnsharpParamsV1): string {
  return `url("data:image/svg+xml,${encodeURIComponent(unsharpSvgFilterV1(params))}#${FILTER_ID}")`;
}

/** The preview filter of every ffmpeg-crisp effect. */
export const FFMPEG_CRISP_PREVIEW_FILTER_V1 = unsharpCssFilterV1(FFMPEG_CRISP_UNSHARP_V1);

/** Effect renderers whose CSS preview approximates the export (the interface marks their effects 「預覽近似」). */
export const PREVIEW_APPROXIMATE_EFFECT_RENDERERS_V1: ReadonlySet<string> = new Set(["ffmpeg-crisp"]);
