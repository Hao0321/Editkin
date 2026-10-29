import { gaussianBlur, seededRandom, type RasterV1, type Rgb } from "./raster";

/**
 * Collage kit (S5, browser-safe, deterministic): owned procedural paper — value noise, fibrous torn-paper masks, AM
 * halftone screens, paper and newsprint fills, a sky key for photo cut-outs, and layered shadows baked into pieces.
 * Ported from the S5 style-frame library (sf_lib.py: noise1d/noise2d/torn_masks/halftone/sky_mask) so the template keeps
 * the frames' finish. Planes are Float32 (1 channel) or premultiplied RGBA rasters.
 */

/** 1D value noise (octaves of smooth-stepped random values), roughly −1..1. */
export function noise1d(n: number, seed: number, octaves = 5, period = 60): Float32Array {
  const out = new Float32Array(n), rand = seededRandom(seed);
  let amp = 1, p = period;
  for (let o = 0; o < octaves; o += 1) {
    const k = Math.floor(n / p) + 3, values = new Float32Array(k);
    for (let i = 0; i < k; i += 1) values[i] = rand() * 2 - 1;
    for (let x = 0; x < n; x += 1) {
      const u = x / p, i = Math.floor(u); let t = u - i; t = t * t * (3 - 2 * t);
      out[x] += amp * (values[i] * (1 - t) + values[i + 1] * t);
    }
    amp *= 0.5; p /= 2.3;
  }
  for (let x = 0; x < n; x += 1) out[x] /= 1.9;
  return out;
}

/** 2D value noise (bilinear-smoothstep lattice per octave), roughly −1..1. */
export function noise2d(h: number, w: number, seed: number, scale = 64, octaves = 4): Float32Array {
  const out = new Float32Array(w * h), rand = seededRandom(seed);
  let amp = 1, s = scale;
  for (let o = 0; o < octaves && s >= 1.5; o += 1) {
    const gw = Math.floor(w / s) + 3, gh = Math.floor(h / s) + 3, grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i += 1) grid[i] = rand() * 2 - 1;
    const tx = new Float32Array(w), ix = new Int32Array(w);
    for (let x = 0; x < w; x += 1) { const u = x / s, i = Math.floor(u); let t = u - i; t = t * t * (3 - 2 * t); ix[x] = i; tx[x] = t; }
    for (let y = 0; y < h; y += 1) {
      const v = y / s, j = Math.floor(v); let ty = v - j; ty = ty * ty * (3 - 2 * ty);
      const r0 = j * gw, r1 = (j + 1) * gw, row = y * w;
      for (let x = 0; x < w; x += 1) {
        const i = ix[x], t = tx[x];
        const a = grid[r0 + i] * (1 - t) + grid[r0 + i + 1] * t, b = grid[r1 + i] * (1 - t) + grid[r1 + i + 1] * t;
        out[row + x] += amp * (a + (b - a) * ty);
      }
    }
    amp *= 0.5; s /= 2;
  }
  return out;
}

/** Polygon coverage (nonzero), 3× supersampled per axis, of points in pixel units. */
export function polygonMask(w: number, h: number, points: ReadonlyArray<readonly [number, number]>): Float32Array {
  const ss = 3, out = new Float32Array(w * h), n = points.length;
  const xs: number[] = [];
  for (let sy = 0; sy < h * ss; sy += 1) {
    const y = (sy + 0.5) / ss;
    xs.length = 0;
    for (let i = 0; i < n; i += 1) {
      const [x0, y0] = points[i], [x1, y1] = points[(i + 1) % n];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    const row = Math.floor(sy / ss) * w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, xs[k] * ss), b = Math.min(w * ss, xs[k + 1] * ss);
      for (let sx = Math.ceil(a - 0.5); sx < b - 0.5; sx += 1) if (sx >= 0) out[row + Math.floor(sx / ss)] += 1 / (ss * ss);
    }
  }
  for (let i = 0; i < out.length; i += 1) if (out[i] > 1) out[i] = 1;
  return out;
}

export interface TornMasksV1 {
  /** Full piece incl. the fibrous white margin. */
  readonly paper: Float32Array;
  /** The printed area inside. */
  readonly print: Float32Array;
  /** Margin (px) around the w × h rectangle on every side. */
  readonly margin: number;
  readonly width: number;
  readonly height: number;
}

/** Torn-paper rectangle: wavy noisy edges on the chosen sides, a fibrous white margin between print and paper edge. */
export function tornMasks(w: number, h: number, amp: number, seed: number, edges = "trbl", fiber = 7): TornMasksV1 {
  const m = Math.ceil(amp * 3 + fiber + 6), W = w + 2 * m, H = h + 2 * m;
  const has = (e: string) => edges.includes(e);
  const top = noise1d(w, seed, 5, 55), right = noise1d(h, seed + 1, 5, 55), bottom = noise1d(w, seed + 2, 5, 55), left = noise1d(h, seed + 3, 5, 55);
  const perimeter = (offset: number): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < w; i += 2) pts.push([m + i, m + (has("t") ? top[i] * amp - offset : 0)]);
    for (let i = 0; i < h; i += 2) pts.push([m + w + (has("r") ? right[i] * amp + offset : 0), m + i]);
    for (let i = w - 1; i >= 0; i -= 2) pts.push([m + i, m + h + (has("b") ? bottom[i] * amp + offset : 0)]);
    for (let i = h - 1; i >= 0; i -= 2) pts.push([m + (has("l") ? left[i] * amp - offset : 0), m + i]);
    return pts;
  };
  const outer = polygonMask(W, H, perimeter(fiber * 0.6)), print = polygonMask(W, H, perimeter(-fiber * 0.5));
  const fibres = noise2d(H, W, seed + 9, 7, 3), band = new Float32Array(W * H);
  for (let i = 0; i < band.length; i += 1) band[i] = Math.max(0, outer[i] - print[i]) * Math.max(0, Math.min(1, 0.8 + 0.7 * fibres[i]));
  const soft = gaussianBlur(band, W, H, 1, 0.6), paper = new Float32Array(W * H);
  for (let i = 0; i < paper.length; i += 1) paper[i] = Math.min(1, print[i] + soft[i]);
  return { paper, print, margin: m, width: W, height: H };
}

/** AM halftone ink coverage of a grey plane (1 = paper, 0 = ink), cell px at `angle` degrees. */
export function halftone(gray: Float32Array, w: number, h: number, cell = 10, angle = 45, scale = 1): Float32Array {
  const out = new Float32Array(w * h), a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const u = x * c + y * s, v = -x * s + y * c;
    const cu = (Math.floor(u / cell) + 0.5) * cell, cv = (Math.floor(v / cell) + 0.5) * cell, du = u - cu, dv = v - cv;
    const px = Math.max(0, Math.min(w - 1, Math.floor(cu * c - cv * s))), py = Math.max(0, Math.min(h - 1, Math.floor(cu * s + cv * c)));
    const dark = Math.max(0, Math.min(1, 1 - gray[py * w + px])), r = cell * 0.62 * Math.sqrt(dark) * scale;
    out[y * w + x] = Math.max(0, Math.min(1, r - Math.sqrt(du * du + dv * dv) + 0.5));
  }
  return out;
}

/** Luminance plane (0..1) of a premultiplied RGBA raster. */
export function grayOf(raster: RasterV1): Float32Array {
  const n = raster.width * raster.height, out = new Float32Array(n), d = raster.data, c = raster.channels;
  for (let i = 0; i < n; i += 1) out[i] = (d[i * c] + d[i * c + 1] + d[i * c + 2]) / 3;
  return out;
}

/**
 * Sky key for a photo cut-out: sky-like pixels (blue-dominant, or bright and unsaturated) connected to the top edge,
 * cleaned into a per-column skyline (median smoothed). Returns sky coverage 0..1 at the raster's size.
 */
export function skyMask(raster: RasterV1, threshold = 0.55): Float32Array {
  const W = raster.width, H = raster.height, k = 4, w = Math.max(1, Math.floor(W / k)), h = Math.max(1, Math.floor(H / k));
  const d = raster.data, ch = raster.channels, skyish = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const o = (y * k * W + x * k) * ch, a = ch === 4 ? Math.max(d[o + 3], 1e-4) : 1;
    const r = d[o] / a, g = d[o + 1] / a, b = d[o + 2] / a, mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = (mx - mn) / (mx + 1e-4);
    skyish[y * w + x] = ((b > r + 0.04 && b > 0.45) || (mx > threshold + 0.2 && sat < 0.22) || (mx > threshold && b >= r && sat < 0.35)) ? 1 : 0;
  }
  // Flood from the top row through sky-like pixels (4-neighbour).
  const sky = new Uint8Array(w * h), stack: number[] = [];
  for (let x = 0; x < w; x += 1) if (skyish[x]) { sky[x] = 1; stack.push(x); }
  while (stack.length) {
    const i = stack.pop()!, x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && skyish[j] && !sky[j]) { sky[j] = 1; stack.push(j); }
  }
  // Skyline per column: the first non-sky row from the top, median-smoothed over 11 columns.
  const run = new Float32Array(w);
  for (let x = 0; x < w; x += 1) { let y = 0; while (y < h && sky[y * w + x]) y += 1; run[x] = y; }
  const smooth = new Float32Array(w);
  for (let x = 0; x < w; x += 1) {
    const win: number[] = [];
    for (let i = -5; i <= 5; i += 1) win.push(run[Math.max(0, Math.min(w - 1, x + i))]);
    win.sort((a, b) => a - b); smooth[x] = win[5];
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const fx = Math.min(w - 1, (x + 0.5) / k - 0.5 < 0 ? 0 : (x + 0.5) / k - 0.5), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), t = fx - x0;
    const line = (smooth[x0] * (1 - t) + smooth[x1] * t) * k;
    out[y * W + x] = Math.max(0, Math.min(1, line - (y + 0.5) + 0.5));
  }
  return gaussianBlur(out, W, H, 1, 1.2);
}

/** Paper fill: colour modulated by a paper texture plane (k = depth of the modulation). */
export function paperFill(w: number, h: number, color: Rgb, texture: Float32Array, k = 0.22, offset = 0, textureWidth = w): Float32Array {
  const out = new Float32Array(w * h * 3), tw = textureWidth, th = Math.floor(texture.length / tw);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const t = texture[((y + offset) % th) * tw + ((x + offset * 3) % tw)], m = 1 + (t - 0.5) * k * 2, o = (y * w + x) * 3;
    out[o] = color[0] * m; out[o + 1] = color[1] * m; out[o + 2] = color[2] * m;
  }
  return out;
}

/** A procedural paper texture plane (0..1, mean 0.5): broad mottling, fine tooth and specks. */
export function paperTexture(w: number, h: number, seed: number): Float32Array {
  const broad = noise2d(h, w, seed, 260, 5), fine = noise2d(h, w, seed + 1, 2.5, 2), out = new Float32Array(w * h), rand = seededRandom(seed + 2);
  for (let i = 0; i < out.length; i += 1) out[i] = 0.5 + broad[i] * 0.1 + fine[i] * 0.06 - (rand() > 0.9993 ? 0.5 : 0);
  return out;
}

/** Composes a torn piece: `fill` (premultiplied RGB at the piece size incl. margin) on the print, a paper-white fibrous margin. */
export function tornPiece(masks: TornMasksV1, fill: Float32Array, paper: Rgb): RasterV1 {
  const n = masks.width * masks.height, data = new Float32Array(n * 4), core: Rgb = [paper[0] * 0.45 + 0.55, paper[1] * 0.45 + 0.55, paper[2] * 0.45 + 0.55];
  for (let i = 0; i < n; i += 1) {
    const pr = masks.print[i], band = Math.max(0, masks.paper[i] - pr), a = masks.paper[i];
    data[i * 4] = fill[i * 3] * pr + core[0] * band; data[i * 4 + 1] = fill[i * 3 + 1] * pr + core[1] * band; data[i * 4 + 2] = fill[i * 3 + 2] * pr + core[2] * band; data[i * 4 + 3] = a;
  }
  return { width: masks.width, height: masks.height, channels: 4, data };
}

/** Bakes a layered drop shadow under a premultiplied piece (the canvas grows by `pad` on every side). */
export function withShadow(piece: RasterV1, layers: ReadonlyArray<readonly [blur: number, dy: number, opacity: number]>, pad: number, dxPerDy = 0.5): RasterV1 {
  const W = piece.width + 2 * pad, H = piece.height + 2 * pad, alpha = new Float32Array(W * H);
  for (let y = 0; y < piece.height; y += 1) for (let x = 0; x < piece.width; x += 1) alpha[(y + pad) * W + x + pad] = piece.data[(y * piece.width + x) * 4 + 3];
  const shadow = new Float32Array(W * H);
  for (const [blur, dy, opacity] of layers) {
    const dx = Math.round(dy * dxPerDy), oy = Math.round(dy), blurred = gaussianBlur(alpha, W, H, 1, blur);
    for (let y = 0; y < H; y += 1) {
      const sy = y - oy;
      if (sy < 0 || sy >= H) continue;
      for (let x = 0; x < W; x += 1) {
        const sx = x - dx;
        if (sx < 0 || sx >= W) continue;
        const v = blurred[sy * W + sx] * opacity, i = y * W + x;
        shadow[i] = shadow[i] + v - shadow[i] * v;
      }
    }
  }
  const data = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i += 1) data[i * 4 + 3] = shadow[i];
  for (let y = 0; y < piece.height; y += 1) for (let x = 0; x < piece.width; x += 1) {
    const s = (y * piece.width + x) * 4, o = ((y + pad) * W + x + pad) * 4, a = piece.data[s + 3];
    data[o] = piece.data[s]; data[o + 1] = piece.data[s + 1]; data[o + 2] = piece.data[s + 2]; data[o + 3] = a + data[o + 3] * (1 - a);
  }
  return { width: W, height: H, channels: 4, data };
}

/** Rotates a premultiplied piece about its centre with bilinear sampling, growing the canvas to fit. */
export function rotatePiece(piece: RasterV1, degrees: number): RasterV1 {
  if (!degrees) return piece;
  const r = (degrees * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), w = piece.width, h = piece.height;
  const W = Math.ceil(Math.abs(w * c) + Math.abs(h * s)) + 2, H = Math.ceil(Math.abs(w * s) + Math.abs(h * c)) + 2;
  const data = new Float32Array(W * H * 4), cx = w / 2, cy = h / 2, CX = W / 2, CY = H / 2, d = piece.data;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const dx = x + 0.5 - CX, dy = y + 0.5 - CY, u = c * dx + s * dy + cx - 0.5, v = -s * dx + c * dy + cy - 0.5;
    if (u <= -1 || v <= -1 || u >= w || v >= h) continue;
    const x0 = Math.floor(u), y0 = Math.floor(v), tx = u - x0, ty = v - y0, o = (y * W + x) * 4;
    for (let j = 0; j < 2; j += 1) for (let i = 0; i < 2; i += 1) {
      const xx = x0 + i, yy = y0 + j;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const wgt = (i ? tx : 1 - tx) * (j ? ty : 1 - ty), so = (yy * w + xx) * 4;
      data[o] += d[so] * wgt; data[o + 1] += d[so + 1] * wgt; data[o + 2] += d[so + 2] * wgt; data[o + 3] += d[so + 3] * wgt;
    }
  }
  return { width: W, height: H, channels: 4, data };
}

