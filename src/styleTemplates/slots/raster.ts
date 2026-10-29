/**
 * Float raster toolkit of the template compositor (browser-safe, pure, deterministic).
 *
 * Composited template clips (S4/S7 on the mesh3d engine, S5's collage) are built from a few kinds of layers: engine
 * passes, SVG art rasterized by librsvg (pieces once, type per frame) and light drawn here (glow fields, streaks, bloom,
 * vignette, grain). Every layer is a Float32 raster in display-referred RGB 0..1 (the values an sRGB/BT.709 file holds),
 * premultiplied when it carries alpha. Blurs are three box passes (a Gaussian to within a few percent), large radii run
 * at reduced resolution. The same inputs always give the same bytes, on any machine and thread count.
 */

export interface RasterV1 {
  readonly width: number;
  readonly height: number;
  /** 3 = opaque RGB, 4 = premultiplied RGBA. */
  readonly channels: 3 | 4;
  readonly data: Float32Array;
}

export type Rgb = readonly [number, number, number];

export function createRaster(width: number, height: number, channels: 3 | 4, fill?: readonly number[]): RasterV1 {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("raster size must be positive integers");
  const data = new Float32Array(width * height * channels);
  if (fill && fill.some(value => value !== 0)) for (let i = 0; i < data.length; i += channels) for (let c = 0; c < channels; c += 1) data[i + c] = fill[c] ?? 0;
  return { width, height, channels, data };
}

export function hexRgb(hex: string): Rgb {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) throw new Error(`colour ${hex} is not #RRGGBB`);
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
}

export function rgbHex(color: Rgb): string {
  return `#${color.map(value => Math.max(0, Math.min(255, Math.round(value * 255))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function scaleRgb(a: Rgb, k: number): Rgb {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/** HSL-style saturation boost of a colour (0 = unchanged), clamped to 0..1. */
export function saturateRgb(color: Rgb, amount: number): Rgb {
  const mean = (color[0] + color[1] + color[2]) / 3;
  return color.map(value => Math.max(0, Math.min(1, mean + (value - mean) * (1 + amount)))) as unknown as Rgb;
}

export function luminance(color: Rgb): number {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

// ---------------------------------------------------------------------------
// Blur
// ---------------------------------------------------------------------------

function boxRadius(sigma: number): number {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let width = Math.floor(ideal);
  if (width % 2 === 0) width -= 1;
  return Math.max(0, (width - 1) / 2);
}

function boxRows(src: Float32Array, dst: Float32Array, w: number, h: number, channels: number, r: number): void {
  const inv = 1 / (2 * r + 1), last = w - 1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w * channels;
    for (let c = 0; c < channels; c += 1) {
      const base = row + c;
      let acc = src[base] * (r + 1);
      for (let i = 1; i <= r; i += 1) acc += src[base + (i < last ? i : last) * channels];
      for (let x = 0; x < w; x += 1) {
        dst[base + x * channels] = acc * inv;
        const add = x + r + 1, sub = x - r;
        acc += src[base + (add < last ? add : last) * channels] - src[base + (sub > 0 ? sub : 0) * channels];
      }
    }
  }
}

function boxColumns(src: Float32Array, dst: Float32Array, w: number, h: number, channels: number, r: number): void {
  const inv = 1 / (2 * r + 1), stride = w * channels;
  const acc = new Float64Array(stride);
  const rowAt = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y) * stride;
  for (let i = -r; i <= r; i += 1) { const o = rowAt(i); for (let k = 0; k < stride; k += 1) acc[k] += src[o + k]; }
  for (let y = 0; y < h; y += 1) {
    const out = y * stride, add = rowAt(y + r + 1), sub = rowAt(y - r);
    for (let k = 0; k < stride; k += 1) {
      dst[out + k] = acc[k] * inv;
      acc[k] += src[add + k] - src[sub + k];
    }
  }
}

function resample(src: Float32Array, sw: number, sh: number, channels: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh * channels), kx = sw / dw, ky = sh / dh;
  // Per-column source taps, computed once.
  const xa = new Int32Array(dw), xb = new Int32Array(dw), xt = new Float32Array(dw);
  for (let x = 0; x < dw; x += 1) {
    const fx = Math.max(0, Math.min(sw - 1, (x + 0.5) * kx - 0.5)), x0 = Math.floor(fx);
    xa[x] = x0 * channels; xb[x] = Math.min(sw - 1, x0 + 1) * channels; xt[x] = fx - x0;
  }
  for (let y = 0; y < dh; y += 1) {
    const fy = Math.max(0, Math.min(sh - 1, (y + 0.5) * ky - 0.5)), y0 = Math.floor(fy), ty = fy - y0;
    const r0 = y0 * sw * channels, r1 = Math.min(sh - 1, y0 + 1) * sw * channels, o0 = y * dw * channels;
    for (let x = 0; x < dw; x += 1) {
      const tx = xt[x], a = r0 + xa[x], b = r0 + xb[x], c = r1 + xa[x], d = r1 + xb[x], o = o0 + x * channels;
      for (let k = 0; k < channels; k += 1) {
        const top = src[a + k] + (src[b + k] - src[a + k]) * tx, bottom = src[c + k] + (src[d + k] - src[c + k]) * tx;
        out[o + k] = top + (bottom - top) * ty;
      }
    }
  }
  return out;
}

function shrink(src: Float32Array, w: number, h: number, channels: number, k: number): { data: Float32Array; w: number; h: number } {
  const sw = Math.max(1, Math.floor(w / k)), sh = Math.max(1, Math.floor(h / k)), out = new Float32Array(sw * sh * channels), inv = 1 / (k * k);
  const row = new Float32Array(w * channels), span = sw * k * channels;
  for (let y = 0; y < sh; y += 1) {
    row.fill(0);
    for (let dy = 0; dy < k; dy += 1) {
      const base = (y * k + dy) * w * channels;
      for (let i = 0; i < span; i += 1) row[i] += src[base + i];
    }
    const o0 = y * sw * channels;
    for (let x = 0; x < sw; x += 1) {
      const xi = x * k * channels, o = o0 + x * channels;
      for (let c = 0; c < channels; c += 1) {
        let sum = 0;
        for (let dx = 0; dx < k; dx += 1) sum += row[xi + dx * channels + c];
        out[o + c] = sum * inv;
      }
    }
  }
  return { data: out, w: sw, h: sh };
}

/**
 * Gaussian blur (σ in pixels) of an interleaved plane; returns a new array (σ ≤ 0.3 returns a copy). Above σ 2 the plane
 * is box-reduced so the blur runs at σ ≈ 2 and is resampled back (bilinear): the same look at a fraction of the cost.
 */
export function gaussianBlur(src: Float32Array, w: number, h: number, channels: number, sigma: number): Float32Array {
  if (!(sigma > 0.3)) return src.slice();
  if (sigma > 2.4 && w >= 8 && h >= 8) {
    const k = Math.max(2, Math.min(Math.floor(sigma / 2), Math.floor(Math.min(w, h) / 4)));
    const small = shrink(src, w, h, channels, k);
    const blurred = gaussianBlur(small.data, small.w, small.h, channels, sigma / k);
    return resample(blurred, small.w, small.h, channels, w, h);
  }
  const r = boxRadius(sigma);
  const a = src.slice(), b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass += 1) {
    boxRows(a, b, w, h, channels, r);
    boxColumns(b, a, w, h, channels, r);
  }
  return a;
}

/** One channel of a raster as a plane (alpha of RGBA, or a colour channel). */
export function channelPlane(raster: RasterV1, channel: number): Float32Array {
  const n = raster.width * raster.height, out = new Float32Array(n), c = raster.channels;
  for (let i = 0; i < n; i += 1) out[i] = raster.data[i * c + channel];
  return out;
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

/** dst = src over dst (src premultiplied RGBA of the same size), with an extra opacity. */
export function over(dst: RasterV1, src: RasterV1, opacity = 1): void {
  if (src.channels !== 4 || src.width !== dst.width || src.height !== dst.height) throw new Error("over needs a same-size RGBA source");
  const n = dst.width * dst.height, d = dst.data, s = src.data, dc = dst.channels;
  for (let i = 0; i < n; i += 1) {
    const so = i * 4, a = s[so + 3] * opacity;
    if (a <= 0) continue;
    const o = i * dc, k = 1 - a;
    d[o] = d[o] * k + s[so] * opacity; d[o + 1] = d[o + 1] * k + s[so + 1] * opacity; d[o + 2] = d[o + 2] * k + s[so + 2] * opacity;
    if (dc === 4) d[o + 3] = d[o + 3] * k + a;
  }
}

/** dst = colour (with coverage `mask × opacity`) over dst. */
export function fillMask(dst: RasterV1, mask: Float32Array, color: Rgb, opacity = 1): void {
  const n = dst.width * dst.height, d = dst.data, dc = dst.channels;
  for (let i = 0; i < n; i += 1) {
    const a = mask[i] * opacity;
    if (a <= 0) continue;
    const o = i * dc, k = 1 - a;
    d[o] = d[o] * k + color[0] * a; d[o + 1] = d[o + 1] * k + color[1] * a; d[o + 2] = d[o + 2] * k + color[2] * a;
    if (dc === 4) d[o + 3] = d[o + 3] * k + a;
  }
}

/** Multiplies the colour (and alpha) of dst by (1 − mask × k): a shadow that darkens what is there. */
export function darken(dst: RasterV1, mask: Float32Array, k: number, tint: Rgb = [0, 0, 0]): void {
  const n = dst.width * dst.height, d = dst.data, dc = dst.channels;
  for (let i = 0; i < n; i += 1) {
    const a = mask[i] * k;
    if (a <= 0) continue;
    const o = i * dc;
    d[o] += (tint[0] * (dc === 4 ? d[o + 3] : 1) - d[o]) * a; d[o + 1] += (tint[1] * (dc === 4 ? d[o + 3] : 1) - d[o + 1]) * a; d[o + 2] += (tint[2] * (dc === 4 ? d[o + 3] : 1) - d[o + 2]) * a;
  }
}

/** Adds light: dst.rgb += mask × colour × k (mask is a plane; RGBA destinations also gain coverage). */
export function addMask(dst: RasterV1, mask: Float32Array, color: Rgb, k = 1): void {
  const n = dst.width * dst.height, d = dst.data, dc = dst.channels, r = color[0] * k, g = color[1] * k, b = color[2] * k;
  for (let i = 0; i < n; i += 1) {
    const m = mask[i];
    if (m <= 0) continue;
    const o = i * dc;
    d[o] += m * r; d[o + 1] += m * g; d[o + 2] += m * b;
    if (dc === 4) d[o + 3] = Math.min(1, d[o + 3] + m * Math.max(r, g, b));
  }
}

/** Adds an RGB plane (3 channels) scaled by k. */
export function addRgb(dst: RasterV1, light: Float32Array, k = 1): void {
  const n = dst.width * dst.height, d = dst.data, dc = dst.channels;
  for (let i = 0; i < n; i += 1) {
    const s = i * 3, o = i * dc;
    d[o] += light[s] * k; d[o + 1] += light[s + 1] * k; d[o + 2] += light[s + 2] * k;
  }
}

/** Gaussian lobe exp(−((x−cx)/rx)² − ((y−cy)/ry)²)^(power/2) of colour × k, added. */
export function addRadial(dst: RasterV1, cx: number, cy: number, rx: number, ry: number, color: Rgb, k: number, power = 2): void {
  const { width: w, height: h, data: d, channels: dc } = dst;
  const reach = Math.pow(Math.log(1 / 0.002), 1 / power);
  const x0 = Math.max(0, Math.floor(cx - rx * reach)), x1 = Math.min(w, Math.ceil(cx + rx * reach));
  const y0 = Math.max(0, Math.floor(cy - ry * reach)), y1 = Math.min(h, Math.ceil(cy + ry * reach));
  if (x1 <= x0 || y1 <= y0) return;
  // A Gaussian lobe is separable: exp(−u²−v²) = exp(−u²)·exp(−v²).
  const ex = new Float32Array(x1 - x0), qx = new Float32Array(x1 - x0);
  for (let x = x0; x < x1; x += 1) { const u = (x + 0.5 - cx) / rx; qx[x - x0] = u * u; ex[x - x0] = Math.exp(-u * u); }
  const r = color[0] * k, g = color[1] * k, b = color[2] * k;
  for (let y = y0; y < y1; y += 1) {
    const v = (y + 0.5 - cy) / ry, v2 = v * v, ey = Math.exp(-v2);
    const row = y * w;
    for (let x = x0; x < x1; x += 1) {
      const value = power === 2 ? ex[x - x0] * ey : Math.exp(-Math.pow(qx[x - x0] + v2, power / 2));
      if (value < 0.002) continue;
      const o = (row + x) * dc;
      d[o] += r * value; d[o + 1] += g * value; d[o + 2] += b * value;
    }
  }
}

/** Vertical light streak at x (core width σ px, soft halo 9σ) fading along y around yc over `length` px. */
export function addStreak(dst: RasterV1, x: number, width: number, color: Rgb, k: number, yc: number, length: number): void {
  const { width: w, height: h, data: d, channels: dc } = dst;
  const reach = width * 9 * 2.6, x0 = Math.max(0, Math.floor(x - reach)), x1 = Math.min(w, Math.ceil(x + reach));
  const prof = new Float32Array(x1 - x0);
  for (let i = x0; i < x1; i += 1) { const u = (i + 0.5 - x) / width; prof[i - x0] = Math.exp(-u * u) + 0.25 * Math.exp(-(u / 9) * (u / 9)); }
  for (let y = 0; y < h; y += 1) {
    const v = (y + 0.5 - yc) / length, fy = Math.exp(-v * v) * k;
    if (fy < 1e-4) continue;
    for (let i = x0; i < x1; i += 1) {
      const s = prof[i - x0] * fy, o = (y * w + i) * dc;
      d[o] += color[0] * s; d[o + 1] += color[1] * s; d[o + 2] += color[2] * s;
    }
  }
}

/** Multiplies by 1 − strength·r² (clamped to floor), r normalised by (rx·W, ry·H) about the centre. */
export function vignette(dst: RasterV1, strength: number, rx: number, ry: number, floor: number): void {
  const { width: w, height: h, data: d, channels: dc } = dst;
  for (let y = 0; y < h; y += 1) {
    const vy = (y + 0.5 - h / 2) / (h * ry), vy2 = vy * vy;
    for (let x = 0; x < w; x += 1) {
      const vx = (x + 0.5 - w / 2) / (w * rx), k = Math.max(floor, Math.min(1, 1 - strength * (vx * vx + vy2)));
      if (k >= 1) continue;
      const o = (y * w + x) * dc;
      d[o] *= k; d[o + 1] *= k; d[o + 2] *= k;
    }
  }
}

/** Mulberry32: a small seeded generator (deterministic everywhere). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Film grain weighted toward the mid-tones (σ of the noise in display units), a new pattern per frame. */
export function grain(dst: RasterV1, sigma: number, seed: number, frame: number): void {
  const rand = seededRandom((seed * 7919 + frame * 104729 + 17) >>> 0);
  const { width: w, height: h, data: d, channels: dc } = dst, n = w * h, k = sigma * 1.7320508;
  for (let i = 0; i < n; i += 1) {
    // Sum of two uniforms (triangular, σ = 1/√6 per unit) scaled to σ ≈ sigma.
    const noise = (rand() + rand() - 1) * k * 1.4142136;
    const o = i * dc, l = (d[o] + d[o + 1] + d[o + 2]) / 3, a = dc === 4 ? d[o + 3] : 1;
    const weight = (0.55 + 3.6 * Math.max(0, l) * Math.max(0, 1 - l)) * 0.8 * a;
    const v = noise * weight;
    d[o] += v; d[o + 1] += v; d[o + 2] += v;
  }
}

/** Sum of blurred copies (σ, weight) of a plane, built at a reduced resolution (the smallest σ ≥ ~2.5 px there) and resampled once. */
function layeredBlur(src: Float32Array, w: number, h: number, channels: number, layers: ReadonlyArray<readonly [number, number]>): Float32Array {
  const smallest = Math.min(...layers.map(([radius]) => radius));
  const k = Math.max(1, Math.min(Math.floor(smallest / 2.5), Math.floor(Math.min(w, h) / 8)));
  const small = k > 1 ? shrink(src, w, h, channels, k) : { data: src, w, h };
  const sum = new Float32Array(small.data.length);
  for (const [radius, weight] of layers) {
    const blurred = gaussianBlur(small.data, small.w, small.h, channels, radius / k);
    for (let i = 0; i < sum.length; i += 1) sum[i] += blurred[i] * weight;
  }
  return k > 1 ? resample(sum, small.w, small.h, channels, w, h) : sum;
}

/** Bloom: the parts brighter than `threshold` (max channel), blurred at several radii (px), added back. */
export function bloom(dst: RasterV1, threshold: number, layers: ReadonlyArray<readonly [number, number]>, tint?: Rgb): void {
  const { width: w, height: h, data: d, channels: dc } = dst, n = w * h;
  const bright = new Float32Array(n * 3), span = Math.max(1e-3, 1 - threshold);
  let any = false;
  for (let i = 0; i < n; i += 1) {
    const o = i * dc, m = Math.max(d[o], d[o + 1], d[o + 2]), k = Math.max(0, Math.min(1, (m - threshold) / span));
    if (k <= 0) continue;
    any = true;
    let r = d[o] * k, g = d[o + 1] * k, b = d[o + 2] * k;
    if (tint) { const mean = (r + g + b) / 3; r = r * 0.5 + mean * tint[0] * 0.5; g = g * 0.5 + mean * tint[1] * 0.5; b = b * 0.5 + mean * tint[2] * 0.5; }
    bright[i * 3] = r; bright[i * 3 + 1] = g; bright[i * 3 + 2] = b;
  }
  if (!any) return;
  addRgb(dst, layeredBlur(bright, w, h, 3, layers), 1);
}

/** Glow of a coverage plane: blurred copies of mask × colour added at several radii. */
export function glow(dst: RasterV1, mask: Float32Array, color: Rgb, layers: ReadonlyArray<readonly [number, number]>): void {
  addMask(dst, layeredBlur(mask, dst.width, dst.height, 1, layers), color, 1);
}

/** Layered soft shadow of a coverage plane: blurred, offset copies darkening dst. */
export function dropShadow(dst: RasterV1, mask: Float32Array, layers: ReadonlyArray<readonly [blur: number, dy: number, opacity: number]>, dxPerDy = 0, tint: Rgb = [0, 0, 0]): void {
  for (const [blur, dy, opacity] of layers) {
    const shifted = shiftPlane(mask, dst.width, dst.height, Math.round(dy * dxPerDy), Math.round(dy));
    darken(dst, gaussianBlur(shifted, dst.width, dst.height, 1, blur), opacity, tint);
  }
}

export function shiftPlane(src: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  if (!dx && !dy) return src;
  const out = new Float32Array(w * h);
  for (let y = Math.max(0, dy); y < Math.min(h, h + dy); y += 1) {
    const sy = y - dy, row = y * w, srow = sy * w;
    for (let x = Math.max(0, dx); x < Math.min(w, w + dx); x += 1) out[row + x] = src[srow + x - dx];
  }
  return out;
}

/** Clamps to 0..1 and writes 8-bit RGB or premultiplied RGBA (with ordered rounding). */
export function toBytes(src: RasterV1, out: Uint8Array): void {
  const n = src.width * src.height, d = src.data, c = src.channels;
  if (out.length !== n * c) throw new Error("toBytes: output size mismatch");
  for (let i = 0; i < n * c; i += 1) { const v = d[i]; out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255); }
  if (c === 4) for (let i = 0; i < n; i += 1) {
    // Premultiplied: colour never above alpha after rounding.
    const a = out[i * 4 + 3];
    if (out[i * 4] > a) out[i * 4] = a; if (out[i * 4 + 1] > a) out[i * 4 + 1] = a; if (out[i * 4 + 2] > a) out[i * 4 + 2] = a;
  }
}

/** Premultiplied 8-bit RGBA (librsvg output) as a float raster. */
export function rasterFromPremultipliedBytes(width: number, height: number, bytes: Uint8Array): RasterV1 {
  if (bytes.length !== width * height * 4) throw new Error("rasterFromPremultipliedBytes: size mismatch");
  const data = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) data[i] = bytes[i] / 255;
  return { width, height, channels: 4, data };
}

// ---------------------------------------------------------------------------
// Placed pictures: affine, bilinear, mipmapped
// ---------------------------------------------------------------------------

/** dst = [a c e; b d f] · src. */
export interface AffineV1 { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number }

export const affine = Object.freeze({
  identity: (): AffineV1 => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  multiply: (m: AffineV1, n: AffineV1): AffineV1 => ({ a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f }),
  translate: (x: number, y: number): AffineV1 => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }),
  scale: (sx: number, sy = sx): AffineV1 => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }),
  rotate: (degrees: number): AffineV1 => { const r = (degrees * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return { a: c, b: s, c: -s, d: c, e: 0, f: 0 }; },
  /** Centre of a w×h picture at (cx, cy), rotated (deg) and scaled about its centre. */
  place: (w: number, h: number, cx: number, cy: number, rotation = 0, scale = 1, scaleY = scale): AffineV1 => {
    const r = (rotation * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
    const a = cs * scale, b = sn * scale, c = -sn * scaleY, d = cs * scaleY;
    return { a, b, c, d, e: cx - (a * w) / 2 - (c * h) / 2, f: cy - (b * w) / 2 - (d * h) / 2 };
  },
});

export interface MipChainV1 { readonly levels: readonly RasterV1[] }

/** Box-filtered mip chain of a premultiplied RGBA raster (down to 16 px). */
export function mipChain(base: RasterV1): MipChainV1 {
  const levels: RasterV1[] = [base];
  let current = base;
  while (current.width >= 32 && current.height >= 32 && levels.length < 8) {
    const small = shrink(current.data, current.width, current.height, current.channels, 2);
    current = { width: small.w, height: small.h, channels: current.channels, data: small.data };
    levels.push(current);
  }
  return { levels };
}

/**
 * Draws a premultiplied RGBA picture (or its mip chain) through `m` over dst, bilinear, with an opacity. The level is
 * chosen from the transform's scale, so shrinking pictures stay smooth.
 */
export function drawImage(dst: RasterV1, image: RasterV1 | MipChainV1, m: AffineV1, opacity = 1): void {
  if (!(opacity > 0)) return;
  const levels = "levels" in image ? image.levels : [image];
  const base = levels[0];
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  let level = 0;
  while (level + 1 < levels.length && scale * (1 << (level + 1)) <= 1.0001) level += 1;
  const src = levels[level], k = base.width / src.width, ky = base.height / src.height;
  // Level pixels → base pixels → dst.
  const lm: AffineV1 = affine.multiply(m, affine.scale(k, ky));
  const det = lm.a * lm.d - lm.b * lm.c;
  if (Math.abs(det) < 1e-12) return;
  const ia = lm.d / det, ib = -lm.b / det, ic = -lm.c / det, id = lm.a / det, ie = -(ia * lm.e + ic * lm.f), iff = -(ib * lm.e + id * lm.f);
  const corners = [[0, 0], [src.width, 0], [0, src.height], [src.width, src.height]].map(([x, y]) => [lm.a * x + lm.c * y + lm.e, lm.b * x + lm.d * y + lm.f]);
  const { width: W, height: H, data: d, channels: dc } = dst, sw = src.width, sh = src.height, s = src.data;
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p[0])) - 1)), x1 = Math.min(W, Math.ceil(Math.max(...corners.map(p => p[0])) + 1));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p[1])) - 1)), y1 = Math.min(H, Math.ceil(Math.max(...corners.map(p => p[1])) + 1));
  for (let y = y0; y < y1; y += 1) {
    const py = y + 0.5;
    for (let x = x0; x < x1; x += 1) {
      const px = x + 0.5;
      const u = ia * px + ic * py + ie - 0.5, v = ib * px + id * py + iff - 0.5;
      if (u <= -1 || v <= -1 || u >= sw || v >= sh) continue;
      const ux = Math.floor(u), vy = Math.floor(v), tx = u - ux, ty = v - vy;
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < 2; j += 1) {
        const yy = vy + j;
        if (yy < 0 || yy >= sh) continue;
        const wy = j ? ty : 1 - ty;
        for (let i = 0; i < 2; i += 1) {
          const xx = ux + i;
          if (xx < 0 || xx >= sw) continue;
          const wgt = wy * (i ? tx : 1 - tx), o = (yy * sw + xx) * 4;
          r += s[o] * wgt; g += s[o + 1] * wgt; b += s[o + 2] * wgt; a += s[o + 3] * wgt;
        }
      }
      if (a <= 1e-5) continue;
      a *= opacity;
      const o = (y * W + x) * dc, inv = 1 - a;
      d[o] = d[o] * inv + r * opacity; d[o + 1] = d[o + 1] * inv + g * opacity; d[o + 2] = d[o + 2] * inv + b * opacity;
      if (dc === 4) d[o + 3] = d[o + 3] * inv + a;
    }
  }
}

/** Box-downsamples an engine frame (RGBA8 at ss×) to output size: colour (premultiplied by `coverage` when given), coverage and nearest depth. */
export function downsampleEngine(rgba: Uint8Array | Uint8ClampedArray, depth: Float32Array, width: number, height: number, ss: number,
  coverage: "opaque" | "depth"): { color: Float32Array; alpha: Float32Array; depth: Float32Array } {
  const W = width * ss, n = width * height, color = new Float32Array(n * 3), alpha = new Float32Array(n), near = new Float32Array(n).fill(Infinity);
  const inv = 1 / (ss * ss * 255), invA = 1 / (ss * ss);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let r = 0, g = 0, b = 0, a = 0, z = Infinity;
    for (let dy = 0; dy < ss; dy += 1) {
      const row = (y * ss + dy) * W + x * ss;
      for (let dx = 0; dx < ss; dx += 1) {
        const p = row + dx, zz = depth[p];
        const covered = coverage === "opaque" || Number.isFinite(zz);
        if (zz < z) z = zz;
        if (!covered) continue;
        a += 1; r += rgba[p * 4]; g += rgba[p * 4 + 1]; b += rgba[p * 4 + 2];
      }
    }
    const o = y * width + x;
    color[o * 3] = r * inv; color[o * 3 + 1] = g * inv; color[o * 3 + 2] = b * inv; alpha[o] = a * invA; near[o] = z;
  }
  return { color, alpha, depth: near };
}

/** Exact premultiplied colour and alpha from two renders over black and over white (any linear post blur included). */
export function differenceMatte(black: Uint8Array | Uint8ClampedArray, white: Uint8Array | Uint8ClampedArray, width: number, height: number, ss: number): { color: Float32Array; alpha: Float32Array } {
  const W = width * ss, n = width * height, color = new Float32Array(n * 3), alpha = new Float32Array(n), inv = 1 / (ss * ss * 255);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < ss; dy += 1) {
      const row = (y * ss + dy) * W + x * ss;
      for (let dx = 0; dx < ss; dx += 1) {
        const p = (row + dx) * 4;
        r += black[p]; g += black[p + 1]; b += black[p + 2];
        a += 765 - ((white[p] - black[p]) + (white[p + 1] - black[p + 1]) + (white[p + 2] - black[p + 2]));
      }
    }
    const o = y * width + x, al = Math.max(0, Math.min(1, (a / 3) * inv));
    alpha[o] = al;
    color[o * 3] = Math.min(al, r * inv); color[o * 3 + 1] = Math.min(al, g * inv); color[o * 3 + 2] = Math.min(al, b * inv);
  }
  return { color, alpha };
}

/**
 * Two-level depth of field of a premultiplied layer: each pixel blends the sharp layer with a blurred copy (σ px) by its
 * circle of confusion (0..1). The weights are spread with the blur, so a defocused edge also softens over what is
 * behind it (the near-field spill an exact matte keeps).
 */
export function depthOfField(color: Float32Array, alpha: Float32Array, coc: Float32Array, w: number, h: number, sigma: number): { color: Float32Array; alpha: Float32Array } {
  const n = w * h, weighted = new Float32Array(n);
  for (let i = 0; i < n; i += 1) weighted[i] = coc[i] * alpha[i];
  const spreadW = gaussianBlur(weighted, w, h, 1, sigma), spreadA = gaussianBlur(alpha, w, h, 1, sigma);
  const blurredC = gaussianBlur(color, w, h, 3, sigma), blurredA = gaussianBlur(alpha, w, h, 1, sigma);
  const outC = new Float32Array(n * 3), outA = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const k = Math.max(0, Math.min(1, alpha[i] > 0.02 ? coc[i] * alpha[i] + spreadW[i] * (1 - alpha[i]) / Math.max(spreadA[i], 1e-3) : spreadW[i] / Math.max(spreadA[i], 1e-3)));
    outA[i] = alpha[i] + (blurredA[i] - alpha[i]) * k;
    for (let c = 0; c < 3; c += 1) outC[i * 3 + c] = color[i * 3 + c] + (blurredC[i * 3 + c] - color[i * 3 + c]) * k;
  }
  return { color: outC, alpha: outA };
}

/** Eye distance of an engine NDC depth (perspective camera near/far). */
export function ndcToDistance(depth: number, near: number, far: number): number {
  return (2 * near * far) / (far + near - depth * (far - near));
}

/** RGB + alpha planes as a premultiplied RGBA raster. */
export function rgbaFromPlanes(width: number, height: number, color: Float32Array, alpha: Float32Array): RasterV1 {
  const n = width * height, data = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) { data[i * 4] = color[i * 3]; data[i * 4 + 1] = color[i * 3 + 1]; data[i * 4 + 2] = color[i * 3 + 2]; data[i * 4 + 3] = alpha[i]; }
  return { width, height, channels: 4, data };
}

/** Barrel distortion (k > 0) of an interleaved plane about (cx, cy), bilinear; radius normalised by the frame half-height. */
export function fisheyePlane(src: Float32Array, w: number, h: number, channels: number, k: number, cx = w / 2, cy = h / 2): Float32Array {
  const out = new Float32Array(src.length), half = h / 2;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const nx = (x + 0.5 - cx) / half, ny = (y + 0.5 - cy) / half, f = 1 + k * (nx * nx + ny * ny);
    const sx = Math.max(0, Math.min(w - 1.001, cx + (nx / f) * half * (1 + k * 0.5) - 0.5)), sy = Math.max(0, Math.min(h - 1.001, cy + (ny / f) * half * (1 + k * 0.5) - 0.5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0, o = (y * w + x) * channels;
    for (let c = 0; c < channels; c += 1) {
      const a = src[(y0 * w + x0) * channels + c], b = src[(y0 * w + x0 + 1) * channels + c], cc = src[((y0 + 1) * w + x0) * channels + c], dd = src[((y0 + 1) * w + x0 + 1) * channels + c];
      out[o + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + dd * tx) * ty;
    }
  }
  return out;
}
