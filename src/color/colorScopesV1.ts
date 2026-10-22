/** Display-encoded SDR RGB8 scopes. Input is bounded GPU readback, never a second grade approximation. */
export const COLOR_SCOPE_LIMITS_V1 = { pixels: 320 * 180, samples: 22_000, columns: 256, levels: 128, vectorSize: 128 } as const;
/** Conventional hue guide in Cb/Cr coordinates, not a skin detector or a target for every skin tone. */
export const SKIN_HUE_RAY_V1 = 123 * Math.PI / 180;
export interface ColorScopePixelsV1 { width: number; height: number; data: Uint8ClampedArray }
export interface ColorScopeBinsV1 {
  waveform: Uint32Array; histogram: Uint32Array; vectors: Uint32Array; samples: number;
  width: number; height: number;
}
export function scopeSampleSizeV1(width: number, height: number): { width: number; height: number } {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error("Invalid scope dimensions");
  const scale = Math.min(1, 320 / width, 180 / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
export function colorScopeBinsV1(image: ColorScopePixelsV1): ColorScopeBinsV1 {
  const { width, height, data } = image, { columns, levels, vectorSize, pixels, samples: sampleCap } = COLOR_SCOPE_LIMITS_V1;
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0) || width * height > pixels || data.length !== width * height * 4) throw new Error("Invalid bounded RGBA8 scope input");
  const waveform = new Uint32Array(3 * columns * levels), histogram = new Uint32Array(4 * 256), vectors = new Uint32Array(vectorSize * vectorSize);
  let samples = 0;
  const stride = Math.max(1, Math.ceil(width * height / sampleCap));
  for (let pixel = 0; pixel < width * height; pixel += stride) {
    const offset = pixel * 4;
    if (data[offset + 3] === 0) continue;
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    const x = Math.min(columns - 1, Math.floor((pixel % width) * columns / width));
    for (let channel = 0; channel < 3; channel++) {
      const value = data[offset + channel], level = Math.floor(value * (levels - 1) / 255);
      waveform[(channel * levels + level) * columns + x]++;
      histogram[channel * 256 + value]++;
    }
    // R'G'B' -> Y'CbCr (Rec.709 coefficients), not scene-linear luminance or nits.
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    histogram[3 * 256 + Math.round(y)]++;
    const cb = (b - y) / (1.8556 * 255), cr = (r - y) / (1.5748 * 255);
    const vx = Math.max(0, Math.min(vectorSize - 1, Math.round((0.5 + cb * 0.92) * (vectorSize - 1))));
    const vy = Math.max(0, Math.min(vectorSize - 1, Math.round((0.5 - cr * 0.92) * (vectorSize - 1))));
    vectors[vy * vectorSize + vx]++;
    samples++;
  }
  return { waveform, histogram, vectors, samples, width, height };
}
