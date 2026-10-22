import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { UiCardCompileResultV1, UiCardFrame, UiCardLayer } from "./compile";
import type { RoiBox, RoiHeat } from "./roi";

/**
 * Node side of the S1 v2 UI card (review renderer and analyzer; the product binds the same layers as clips):
 * - analyzeScreen: frame-difference heat and the content box of a screen recording (bundled FFmpeg, grey 192 × 108);
 * - renderCardLayer: draws every card and callout (source window → rounded card, chrome stills posed with it,
 *   motion blur on fast moves by sub-frame accumulation) into one straight-alpha ProRes 4444 layer.
 */

const GRID = { width: 192, height: 108, cols: 48, rows: 27 };

function readProcess(ffmpeg: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-2000)}`))));
  });
}

export async function analyzeScreen(ffmpeg: string, file: string, start: number, duration: number, source: { width: number; height: number }): Promise<RoiHeat> {
  const rate = 10;
  const raw = await readProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(start), "-t", String(duration), "-i", file,
    "-vf", `fps=${rate},scale=${GRID.width}:${GRID.height}:flags=area,format=gray`, "-f", "rawvideo", "-"]);
  const size = GRID.width * GRID.height, count = Math.floor(raw.length / size);
  const frames: Uint8Array[] = Array.from({ length: count }, (_, i) => raw.subarray(i * size, (i + 1) * size));
  // Content: columns / rows where at least 15% of the pixels ever rise above near-black.
  const max = new Uint8Array(size);
  for (const frame of frames) for (let p = 0; p < size; p += 1) if (frame[p] > max[p]) max[p] = frame[p];
  const colHit = (x: number) => { let n = 0; for (let y = 0; y < GRID.height; y += 1) if (max[y * GRID.width + x] > 24) n += 1; return n / GRID.height >= 0.15; };
  const rowHit = (y: number) => { let n = 0; for (let x = 0; x < GRID.width; x += 1) if (max[y * GRID.width + x] > 24) n += 1; return n / GRID.width >= 0.15; };
  let x0 = 0, x1 = GRID.width - 1, y0 = 0, y1 = GRID.height - 1;
  while (x0 < x1 && !colHit(x0)) x0 += 1;
  while (x1 > x0 && !colHit(x1)) x1 -= 1;
  while (y0 < y1 && !rowHit(y0)) y0 += 1;
  while (y1 > y0 && !rowHit(y1)) y1 -= 1;
  const sx = source.width / GRID.width, sy = source.height / GRID.height;
  const content: RoiBox = { x0: x0 * sx, y0: y0 * sy, x1: (x1 + 1) * sx, y1: (y1 + 1) * sy };
  // Heat: thresholded frame differences summed into a 48 × 27 grid, decayed over ~0.3 s.
  const cell = GRID.width / GRID.cols;
  // Detail: where the screen carries information (edge energy of the middle frame), so a quiet shot frames the UI, not empty canvas.
  const detail = new Float32Array(GRID.cols * GRID.rows);
  const mid = frames[Math.floor(count / 2)];
  if (mid) for (let y = 1; y < GRID.height; y += 1) for (let x = 1; x < GRID.width; x += 1) {
    const p = y * GRID.width + x;
    detail[Math.floor(y / cell) * GRID.cols + Math.floor(x / cell)] += Math.abs(mid[p] - mid[p - 1]) + Math.abs(mid[p] - mid[p - GRID.width]);
  }
  const heat: Float32Array[] = [];
  let previous = new Float32Array(GRID.cols * GRID.rows);
  for (let i = 0; i < count; i += 1) {
    const current = new Float32Array(GRID.cols * GRID.rows);
    if (i > 0) {
      const a = frames[i - 1], b = frames[i];
      for (let y = 0; y < GRID.height; y += 1) for (let x = 0; x < GRID.width; x += 1) {
        const d = Math.abs(b[y * GRID.width + x] - a[y * GRID.width + x]);
        if (d > 6) current[Math.floor(y / cell) * GRID.cols + Math.floor(x / cell)] += Math.min(60, d);
      }
    }
    for (let k = 0; k < current.length; k += 1) current[k] += previous[k] * 0.7;
    heat.push(current);
    previous = current;
  }
  return { rate, source, content, cols: GRID.cols, rows: GRID.rows, frames: heat, detail };
}

// ---------------------------------------------------------------------------
// Card layer
// ---------------------------------------------------------------------------

interface Rgba { readonly width: number; readonly height: number; readonly data: Uint8Array }

export async function decodePng(ffmpeg: string, file: string): Promise<Rgba> {
  const probe = await readProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  return { width: 0, height: 0, data: new Uint8Array(probe.buffer, probe.byteOffset, probe.byteLength) };
}

/** Pulls decoded RGB frames of one source span, one at a time. */
class FrameStream {
  private readonly child;
  private chunks: Buffer[] = [];
  private queued = 0;
  private ended = false;
  private waiters: Array<() => void> = [];
  readonly frameBytes: number;
  last: Uint8Array | undefined;
  constructor(ffmpeg: string, file: string, start: number, duration: number, readonly width: number, readonly height: number, fps: number) {
    this.frameBytes = width * height * 3;
    this.child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", start.toFixed(4), "-t", (duration + 0.5).toFixed(4), "-i", file,
      "-vf", `fps=${fps},scale=${width}:${height}:in_color_matrix=bt709:in_range=tv:out_range=pc:flags=lanczos,format=rgb24`, "-f", "rawvideo", "-"], { windowsHide: true });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk); this.queued += chunk.length;
      if (this.queued > this.frameBytes * 4) this.child.stdout.pause();
      this.wake();
    });
    this.child.stdout.on("end", () => { this.ended = true; this.wake(); });
    this.child.on("error", () => { this.ended = true; this.wake(); });
  }
  private wake() { const waiters = this.waiters; this.waiters = []; waiters.forEach(fn => fn()); }
  async next(): Promise<Uint8Array> {
    while (this.queued < this.frameBytes && !this.ended) {
      this.child.stdout.resume();
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    if (this.queued >= this.frameBytes) {
      // Copy one frame out of the queued chunks (each byte copied once).
      const frame = new Uint8Array(this.frameBytes);
      let filled = 0;
      while (filled < this.frameBytes) {
        const head = this.chunks[0], take = Math.min(head.length, this.frameBytes - filled);
        frame.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(take);
      }
      this.queued -= this.frameBytes;
      if (this.queued < this.frameBytes * 2) this.child.stdout.resume();
      this.last = frame;
    }
    if (!this.last) throw new Error("source produced no frames");
    return this.last;
  }
  close() { this.child.kill(); }
}

export interface CardLayerSource { readonly file: string; readonly width: number; readonly height: number }

/** Linear blend of two states (for motion-blur sub-frames). */
function mix(a: UiCardFrame, b: UiCardFrame, u: number): UiCardFrame {
  const l = (p: number, q: number) => p + (q - p) * u;
  return { cx: l(a.cx, b.cx), cy: l(a.cy, b.cy), w: l(a.w, b.w), h: l(a.h, b.h), dx: l(a.dx, b.dx), dy: l(a.dy, b.dy), scale: l(a.scale, b.scale), opacity: l(a.opacity, b.opacity) };
}

/** How far (px) the card's corners and content move between two states. */
function displacement(layer: UiCardLayer, a: UiCardFrame, b: UiCardFrame): number {
  const r = layer.rect, corners = [[r.x, r.y], [r.x + r.w, r.y + r.h], [r.x + r.w, r.y], [r.x, r.y + r.h]];
  const rcx = r.x + r.w / 2, rcy = r.y + r.h / 2;
  let worst = 0;
  for (const [x, y] of corners) {
    const pa = { x: rcx + (x - rcx) * a.scale + a.dx, y: rcy + (y - rcy) * a.scale + a.dy };
    const pb = { x: rcx + (x - rcx) * b.scale + b.dx, y: rcy + (y - rcy) * b.scale + b.dy };
    worst = Math.max(worst, Math.hypot(pa.x - pb.x, pa.y - pb.y));
    // Content under that corner: source point a shows, where b shows it.
    const sx = a.cx + (x - rcx) * (a.w / r.w), sy = a.cy + (y - rcy) * (a.h / r.h);
    const qx = rcx + (sx - b.cx) * (r.w / b.w), qy = rcy + (sy - b.cy) * (r.h / b.h);
    worst = Math.max(worst, Math.hypot(qx - x, qy - y));
  }
  return worst;
}

export interface CardLayerOptions {
  readonly ffmpeg: string;
  readonly output: string;
  readonly sources: ReadonlyMap<string, CardLayerSource>;
  /** Rendered chrome stills by job id (canvas-sized straight RGBA PNGs). */
  readonly chrome: ReadonlyMap<string, string>;
  readonly encodeArgs: readonly string[];
  readonly onProgress?: (frame: number, total: number, spentMs?: Record<string, number>) => void;
}

export async function renderCardLayer(compile: UiCardCompileResultV1, options: CardLayerOptions): Promise<string> {
  const { width: W, height: H, fps, frames: total } = compile.frame;
  const encoder = spawn(options.ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-framerate", String(fps), "-i", "-",
    "-filter_complex", "[0:v]format=gbrap,split=2[c][a];[c]scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv444p10le[y];[a]alphaextract,format=gray10le[al];[y][al]alphamerge,format=yuva444p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[v]",
    "-map", "[v]", ...options.encodeArgs, "-f", "mov", options.output], { windowsHide: true });
  let encoderError = "";
  encoder.stderr.on("data", chunk => { encoderError += chunk.toString(); });
  const encoderDone = new Promise<void>((resolve, reject) => encoder.on("close", code => (code === 0 ? resolve() : reject(new Error(`encoder ${code}: ${encoderError.slice(-2000)}`)))));
  let writeError: Error | undefined;
  encoder.stdin.on("error", error => { writeError = error; });
  const write = (data: Uint8Array) => new Promise<void>((resolve, reject) => {
    if (writeError) { reject(writeError); return; }
    if (encoder.stdin.write(data)) resolve(); else encoder.stdin.once("drain", resolve);
  });

  const acc = new Float32Array(W * H * 4);
  const out = new Uint8Array(W * H * 4);
  let dirty: { x0: number; y0: number; x1: number; y1: number } | undefined;
  const streams = new Map<string, FrameStream>();
  const chromeCache = new Map<string, Uint8Array>();
  const chromeOf = async (id: string) => {
    let data = chromeCache.get(id);
    if (!data) {
      const file = options.chrome.get(id);
      if (!file) throw new Error(`missing chrome still ${id}`);
      data = (await decodePng(options.ffmpeg, file)).data;
      chromeCache.set(id, data);
    }
    return data;
  };
  const layers = [...compile.layers].sort((a, b) => (a.kind === b.kind ? a.startFrame - b.startFrame : a.kind === "card" ? -1 : 1));

  const spent = { decode: 0, draw: 0, convert: 0, write: 0 };
  let mark = performance.now();
  const lap = (key: keyof typeof spent) => { const now = performance.now(); spent[key] += now - mark; mark = now; };
  for (let f = 0; f < total; f += 1) {
    mark = performance.now();
    // Clear last frame's dirty area.
    if (dirty) for (let y = dirty.y0; y < dirty.y1; y += 1) { acc.fill(0, (y * W + dirty.x0) * 4, (y * W + dirty.x1) * 4); out.fill(0, (y * W + dirty.x0) * 4, (y * W + dirty.x1) * 4); }
    dirty = undefined;
    let wroteOut = false;
    const active = layers.filter(layer => { const i = f - layer.startFrame; return i >= 0 && i < layer.frames.length && layer.frames[i].opacity > 0.002; });
    for (const layer of layers) {
      const i = f - layer.startFrame;
      if (i < 0 || i >= layer.frames.length) {
        if (i >= layer.frames.length && streams.has(layer.id)) { streams.get(layer.id)!.close(); streams.delete(layer.id); chromeCache.delete(layer.under); chromeCache.delete(layer.over); restCaches.delete(layer.id); }
        continue;
      }
      let stream = streams.get(layer.id);
      if (!stream) {
        const source = options.sources.get(layer.shotId);
        if (!source) throw new Error(`no source for ${layer.shotId}`);
        stream = new FrameStream(options.ffmpeg, source.file, layer.sourceStart, layer.frames.length / fps, source.width, source.height, fps);
        streams.set(layer.id, stream);
      }
      lap("draw");
      const rgb = await stream.next();
      lap("decode");
      const state = layer.frames[i];
      if (state.opacity <= 0.002) continue;
      const prev = layer.frames[Math.max(0, i - 1)], next = layer.frames[Math.min(layer.frames.length - 1, i + 1)];
      const move = Math.max(displacement(layer, prev, state), displacement(layer, state, next));
      // Motion blur on fast moves: a 180° shutter, sampled so no sub-step jumps more than ~2 px (slow follow stays sharp).
      const subs = move > 3 ? Math.min(5, Math.ceil(move / 2)) : 1;
      const samples: UiCardFrame[] = subs === 1 ? [state] : Array.from({ length: subs }, (_, k) => {
        const u = -0.25 + 0.5 * ((k + 0.5) / subs);
        return u < 0 ? mix(state, prev, -u) : mix(state, next, u);
      });
      const under = await chromeOf(layer.under), over = await chromeOf(layer.over);
      const atRest = samples.length === 1 && state.dx === 0 && state.dy === 0 && state.scale === 1;
      const single = atRest && active.length === 1 && state.opacity >= 0.999;
      if (single) wroteOut = true;
      const box = single ? drawSingleRest(out, W, layer, state, rgb, stream.width, stream.height, restCache(layer, W, H, under, over))
        : atRest ? drawRest(acc, W, layer, state, rgb, stream.width, stream.height, restCache(layer, W, H, under, over))
          : drawLayer(acc, W, H, layer, samples, rgb, stream.width, stream.height, under, over);
      if (box) dirty = dirty ? { x0: Math.min(dirty.x0, box.x0), y0: Math.min(dirty.y0, box.y0), x1: Math.max(dirty.x1, box.x1), y1: Math.max(dirty.y1, box.y1) } : box;
    }
    lap("draw");
    if (dirty && !wroteOut) {
      for (let y = dirty.y0; y < dirty.y1; y += 1) {
        for (let x = dirty.x0; x < dirty.x1; x += 1) {
          const p = (y * W + x) * 4, a = acc[p + 3];
          if (a <= 0.0005) continue;
          out[p] = Math.min(255, Math.round(acc[p] / a)); out[p + 1] = Math.min(255, Math.round(acc[p + 1] / a)); out[p + 2] = Math.min(255, Math.round(acc[p + 2] / a));
          out[p + 3] = Math.min(255, Math.round(a * 255));
        }
      }
    }
    lap("convert");
    // The pipe keeps a reference until flushed: hand it a copy, the next frame reuses `out`.
    await write(Buffer.from(out));
    lap("write");
    if (f % 300 === 0) options.onProgress?.(f, total, Object.fromEntries(Object.entries(spent).map(([key, value]) => [key, Math.round(value)])));
  }
  for (const stream of streams.values()) stream.close();
  encoder.stdin.end();
  await encoderDone;
  await stat(options.output);
  return options.output;
}

let layerScratch = new Float32Array(0);

/** A layer at rest (no offset, scale 1): its chrome and edge coverage never change, so they are prepared once. */
interface RestCache { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number;
  /** Premultiplied chrome-under RGBA per bbox pixel, the content coverage, and the premultiplied rim over it. */
  readonly under: Float32Array; readonly cover: Float32Array; readonly rim: Float32Array;
  /** Straight RGBA of the chrome alone (what shows where the content does not), for the single-card fast path. */
  readonly ring: Uint8Array;
  /** The content's bounding rows/columns (cover > 0). */
  readonly inner: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } }
const restCaches = new Map<string, RestCache>();

function restCache(layer: UiCardLayer, W: number, H: number, under: Uint8Array, over: Uint8Array): RestCache {
  const cached = restCaches.get(layer.id);
  if (cached) return cached;
  const r = layer.rect, rcx = r.x + r.w / 2, rcy = r.y + r.h / 2, radius = layer.radius, reach = 225;
  const x0 = Math.max(0, Math.floor(r.x - reach)), y0 = Math.max(0, Math.floor(r.y - reach)), x1 = Math.min(W, Math.ceil(r.x + r.w + reach)), y1 = Math.min(H, Math.ceil(r.y + r.h + reach));
  const bw = x1 - x0, n = bw * (y1 - y0);
  const u = new Float32Array(n * 4), cover = new Float32Array(n), rim = new Float32Array(n * 4);
  const innerW = r.w / 2 - radius, innerH = r.h / 2 - radius;
  for (let y = y0; y < y1; y += 1) {
    const qy = Math.abs(y + 0.5 - rcy) - innerH;
    for (let x = x0; x < x1; x += 1) {
      const qx = Math.abs(x + 0.5 - rcx) - innerW;
      const distance = qx <= 0 || qy <= 0 ? Math.max(qx, qy) - radius : Math.sqrt(qx * qx + qy * qy) - radius;
      const i = (y - y0) * bw + (x - x0), p = (y * W + x) * 4;
      cover[i] = distance <= -0.5 ? 1 : distance >= 0.5 ? 0 : 0.5 - distance;
      const ua = under[p + 3] / 255;
      if (ua > 0) { u[i * 4] = under[p] * ua; u[i * 4 + 1] = under[p + 1] * ua; u[i * 4 + 2] = under[p + 2] * ua; u[i * 4 + 3] = ua; }
      const oa = over[p + 3] / 255;
      if (oa > 0) { rim[i * 4] = over[p] * oa; rim[i * 4 + 1] = over[p + 1] * oa; rim[i * 4 + 2] = over[p + 2] * oa; rim[i * 4 + 3] = oa; }
    }
  }
  const ring = new Uint8Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    const i4 = i * 4, ra = rim[i4 + 3], keep = 1 - ra;
    const pr = rim[i4] + u[i4] * keep, pg = rim[i4 + 1] + u[i4 + 1] * keep, pb = rim[i4 + 2] + u[i4 + 2] * keep, pa = ra + u[i4 + 3] * keep;
    if (pa > 0.0005) { ring[i4] = Math.min(255, Math.round(pr / pa)); ring[i4 + 1] = Math.min(255, Math.round(pg / pa)); ring[i4 + 2] = Math.min(255, Math.round(pb / pa)); ring[i4 + 3] = Math.min(255, Math.round(pa * 255)); }
  }
  const inner = { x0: Math.max(x0, Math.floor(r.x) - 1), y0: Math.max(y0, Math.floor(r.y) - 1), x1: Math.min(x1, Math.ceil(r.x + r.w) + 1), y1: Math.min(y1, Math.ceil(r.y + r.h) + 1) };
  const made = { x0, y0, x1, y1, under: u, cover, rim, ring, inner };
  restCaches.set(layer.id, made);
  return made;
}

/** The most common frame: one opaque card at rest and nothing else. Writes straight RGBA directly; returns the touched box. */
function drawSingleRest(out: Uint8Array, W: number, layer: UiCardLayer, state: UiCardFrame, rgb: Uint8Array, sw: number, sh: number, cache: RestCache):
  { x0: number; y0: number; x1: number; y1: number } {
  const r = layer.rect, rcx = r.x + r.w / 2, rcy = r.y + r.h / 2;
  const { x0, y0, x1, y1 } = cache, bw = x1 - x0;
  for (let y = y0; y < y1; y += 1) out.set(cache.ring.subarray((y - y0) * bw * 4, (y - y0 + 1) * bw * 4), (y * W + x0) * 4);
  const k = state.w / r.w, maxSx = sw - 1.001, maxSy = sh - 1.001;
  const { inner } = cache;
  for (let y = inner.y0; y < inner.y1; y += 1) {
    const sy = Math.max(0, Math.min(maxSy, state.cy + (y + 0.5 - rcy) * k - 0.5));
    const yi = sy | 0, fy = sy - yi, row = (y - y0) * bw - x0;
    const sxBase = state.cx + (0.5 - rcx) * k - 0.5;
    for (let x = inner.x0; x < inner.x1; x += 1) {
      const i = row + x, cover = cache.cover[i];
      if (cover <= 0) continue;
      const sx = Math.max(0, Math.min(maxSx, sxBase + x * k));
      const xi = sx | 0, fx = sx - xi;
      const p00 = (yi * sw + xi) * 3, p01 = p00 + sw * 3;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      let pr = rgb[p00] * w00 + rgb[p00 + 3] * w10 + rgb[p01] * w01 + rgb[p01 + 3] * w11;
      let pg = rgb[p00 + 1] * w00 + rgb[p00 + 4] * w10 + rgb[p01 + 1] * w01 + rgb[p01 + 4] * w11;
      let pb = rgb[p00 + 2] * w00 + rgb[p00 + 5] * w10 + rgb[p01 + 2] * w01 + rgb[p01 + 5] * w11;
      let pa = 1;
      const i4 = i * 4;
      if (cover < 1) {
        const keep = 1 - cover;
        pr = pr * cover + cache.under[i4] * keep; pg = pg * cover + cache.under[i4 + 1] * keep; pb = pb * cover + cache.under[i4 + 2] * keep; pa = cover + cache.under[i4 + 3] * keep;
      }
      const ra = cache.rim[i4 + 3];
      if (ra > 0) { const keep = 1 - ra; pr = cache.rim[i4] + pr * keep; pg = cache.rim[i4 + 1] + pg * keep; pb = cache.rim[i4 + 2] + pb * keep; pa = ra + pa * keep; }
      const p = (y * W + x) * 4;
      if (pa >= 0.9995) { out[p] = pr + 0.5; out[p + 1] = pg + 0.5; out[p + 2] = pb + 0.5; out[p + 3] = 255; }
      else { out[p] = Math.min(255, pr / pa + 0.5); out[p + 1] = Math.min(255, pg / pa + 0.5); out[p + 2] = Math.min(255, pb / pa + 0.5); out[p + 3] = pa * 255 + 0.5; }
    }
  }
  return { x0, y0, x1, y1 };
}

/** The common case: the card at rest, only its content (and opacity) changes. */
function drawRest(acc: Float32Array, W: number, layer: UiCardLayer, state: UiCardFrame, rgb: Uint8Array, sw: number, sh: number, cache: RestCache):
  { x0: number; y0: number; x1: number; y1: number } {
  const r = layer.rect, rcx = r.x + r.w / 2, rcy = r.y + r.h / 2;
  const { x0, y0, x1, y1 } = cache, bw = x1 - x0;
  const k = state.w / r.w, opacity = state.opacity;
  const maxSx = sw - 1.001, maxSy = sh - 1.001;
  for (let y = y0; y < y1; y += 1) {
    const sy = Math.max(0, Math.min(maxSy, state.cy + (y + 0.5 - rcy) * k - 0.5));
    const yi = sy | 0, fy = sy - yi;
    for (let x = x0; x < x1; x += 1) {
      const i = (y - y0) * bw + (x - x0), i4 = i * 4;
      const cover = cache.cover[i];
      let pr = 0, pg = 0, pb = 0, pa = 0;
      if (cover < 1) { pa = cache.under[i4 + 3]; if (pa > 0) { pr = cache.under[i4]; pg = cache.under[i4 + 1]; pb = cache.under[i4 + 2]; } }
      if (cover > 0) {
        const sx = Math.max(0, Math.min(maxSx, state.cx + (x + 0.5 - rcx) * k - 0.5));
        const xi = sx | 0, fx = sx - xi;
        const p00 = (yi * sw + xi) * 3, p01 = p00 + sw * 3;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const cr = rgb[p00] * w00 + rgb[p00 + 3] * w10 + rgb[p01] * w01 + rgb[p01 + 3] * w11;
        const cg = rgb[p00 + 1] * w00 + rgb[p00 + 4] * w10 + rgb[p01 + 1] * w01 + rgb[p01 + 4] * w11;
        const cb = rgb[p00 + 2] * w00 + rgb[p00 + 5] * w10 + rgb[p01 + 2] * w01 + rgb[p01 + 5] * w11;
        const keep = 1 - cover;
        pr = cr * cover + pr * keep; pg = cg * cover + pg * keep; pb = cb * cover + pb * keep; pa = cover + pa * keep;
      }
      const ra = cache.rim[i4 + 3];
      if (ra > 0) { const keep = 1 - ra; pr = cache.rim[i4] + pr * keep; pg = cache.rim[i4 + 1] + pg * keep; pb = cache.rim[i4 + 2] + pb * keep; pa = ra + pa * keep; }
      if (pa <= 0) continue;
      const p = (y * W + x) * 4, a = pa * opacity, keep = 1 - a;
      acc[p] = pr * opacity + acc[p] * keep; acc[p + 1] = pg * opacity + acc[p + 1] * keep; acc[p + 2] = pb * opacity + acc[p + 2] * keep; acc[p + 3] = a + acc[p + 3] * keep;
    }
  }
  return { x0, y0, x1, y1 };
}

/** Composite one layer (chrome under, content, chrome over), averaged over motion-blur samples, into the premultiplied accumulator. */
function drawLayer(acc: Float32Array, W: number, H: number, layer: UiCardLayer, samples: readonly UiCardFrame[], rgb: Uint8Array, sw: number, sh: number,
  under: Uint8Array, over: Uint8Array): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const r = layer.rect, rcx = r.x + r.w / 2, rcy = r.y + r.h / 2, radius = layer.radius;
  // Bounding box over all samples (with the shadow's reach: 3σ of the widest layer + its offset).
  const reach = 225;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const s of samples) {
    const hw = (r.w / 2) * s.scale, hh = (r.h / 2) * s.scale;
    bx0 = Math.min(bx0, rcx + s.dx - hw - reach); bx1 = Math.max(bx1, rcx + s.dx + hw + reach);
    by0 = Math.min(by0, rcy + s.dy - hh - reach); by1 = Math.max(by1, rcy + s.dy + hh + reach);
  }
  const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0)), x1 = Math.min(W, Math.ceil(bx1)), y1 = Math.min(H, Math.ceil(by1));
  if (x1 <= x0 || y1 <= y0) return undefined;
  const bw = x1 - x0, size = bw * (y1 - y0) * 4;
  if (layerScratch.length < size) layerScratch = new Float32Array(size);
  const buf = layerScratch;
  buf.fill(0, 0, size);
  const inv = 1 / samples.length;
  const halfW = r.w / 2, halfH = r.h / 2, innerW = halfW - radius, innerH = halfH - radius;
  const maxSx = sw - 1.001, maxSy = sh - 1.001;
  for (const s of samples) {
    const k = s.w / r.w, invScale = 1 / s.scale, opacity = s.opacity * inv;
    // At rest (whole-pixel offset, scale 1) the chrome stills are read directly, not resampled.
    const direct = s.scale === 1 && Number.isInteger(s.dx) && Number.isInteger(s.dy);
    for (let y = y0; y < y1; y += 1) {
      const uy = rcy + (y + 0.5 - rcy - s.dy) * invScale;
      const qy = Math.abs(uy - rcy) - innerH;
      const row = (y - y0) * bw;
      for (let x = x0; x < x1; x += 1) {
        const ux = rcx + (x + 0.5 - rcx - s.dx) * invScale;
        const qx = Math.abs(ux - rcx) - innerW;
        const distance = qx <= 0 || qy <= 0 ? Math.max(qx, qy) - radius : Math.sqrt(qx * qx + qy * qy) - radius;
        const cover = distance <= -0.5 ? 1 : distance >= 0.5 ? 0 : 0.5 - distance;
        let pr = 0, pg = 0, pb = 0, pa = 0;
        if (cover < 1) {
          // Chrome under (the shadows), where the content does not fully cover.
          let ar = 0, ag = 0, ab = 0, aa = 0;
          if (direct) {
            const px = x - s.dx, py = y - s.dy;
            if (px >= 0 && py >= 0 && px < W && py < H) { const p = (py * W + px) * 4; aa = under[p + 3] / 255; if (aa > 0) { ar = under[p]; ag = under[p + 1]; ab = under[p + 2]; } }
          } else { const c = sampleRgba(under, W, H, ux - 0.5, uy - 0.5); ar = c[0]; ag = c[1]; ab = c[2]; aa = c[3]; }
          if (aa > 0) { pa = aa; pr = ar * aa; pg = ag * aa; pb = ab * aa; }
        }
        if (cover > 0) {
          // Content: bilinear from the source window.
          const sx = Math.max(0, Math.min(maxSx, s.cx + (ux - rcx) * k - 0.5)), sy = Math.max(0, Math.min(maxSy, s.cy + (uy - rcy) * k - 0.5));
          const xi = sx | 0, yi = sy | 0, fx = sx - xi, fy = sy - yi;
          const p00 = (yi * sw + xi) * 3, p01 = p00 + sw * 3;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          const cr = rgb[p00] * w00 + rgb[p00 + 3] * w10 + rgb[p01] * w01 + rgb[p01 + 3] * w11;
          const cg = rgb[p00 + 1] * w00 + rgb[p00 + 4] * w10 + rgb[p01 + 1] * w01 + rgb[p01 + 4] * w11;
          const cb = rgb[p00 + 2] * w00 + rgb[p00 + 5] * w10 + rgb[p01 + 2] * w01 + rgb[p01 + 5] * w11;
          const keep = 1 - cover;
          pr = cr * cover + pr * keep; pg = cg * cover + pg * keep; pb = cb * cover + pb * keep; pa = cover + pa * keep;
        }
        if (distance > -6 && distance < 1.5) {
          // Chrome over (the rim light): a thin band just inside the edge.
          const c = direct ? readRgba(over, W, H, x - s.dx, y - s.dy) : sampleRgba(over, W, H, ux - 0.5, uy - 0.5);
          if (c[3] > 0) { const a = c[3], keep = 1 - a; pr = c[0] * a + pr * keep; pg = c[1] * a + pg * keep; pb = c[2] * a + pb * keep; pa = a + pa * keep; }
        }
        if (pa <= 0) continue;
        const q = (row + (x - x0)) * 4;
        buf[q] += pr * opacity; buf[q + 1] += pg * opacity; buf[q + 2] += pb * opacity; buf[q + 3] += pa * opacity;
      }
    }
  }
  // Layer over the accumulator (premultiplied "over").
  for (let y = y0; y < y1; y += 1) {
    const row = (y - y0) * bw;
    for (let x = x0; x < x1; x += 1) {
      const q = (row + (x - x0)) * 4, a = buf[q + 3];
      if (a <= 0) continue;
      const p = (y * W + x) * 4, keep = 1 - a;
      acc[p] = buf[q] + acc[p] * keep; acc[p + 1] = buf[q + 1] + acc[p + 1] * keep; acc[p + 2] = buf[q + 2] + acc[p + 2] * keep; acc[p + 3] = a + acc[p + 3] * keep;
    }
  }
  return { x0, y0, x1, y1 };
}

const tmp4: [number, number, number, number] = [0, 0, 0, 0];
const tmp3: [number, number, number] = [0, 0, 0];

/** Bilinear straight RGBA (alpha 0..1) from a canvas-sized buffer; zero outside. */
function sampleRgba(data: Uint8Array, w: number, h: number, x: number, y: number): [number, number, number, number] {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  tmp4[0] = tmp4[1] = tmp4[2] = tmp4[3] = 0;
  let wsum = 0, r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 2; j += 1) for (let i = 0; i < 2; i += 1) {
    const px = xi + i, py = yi + j;
    const wgt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
    if (px < 0 || py < 0 || px >= w || py >= h || wgt === 0) { wsum += wgt; continue; }
    const p = (py * w + px) * 4, al = data[p + 3] / 255;
    r += data[p] * al * wgt; g += data[p + 1] * al * wgt; b += data[p + 2] * al * wgt; a += al * wgt; wsum += wgt;
  }
  if (a > 1e-6) { tmp4[0] = r / a; tmp4[1] = g / a; tmp4[2] = b / a; tmp4[3] = a / Math.max(1e-6, wsum); }
  return tmp4;
}

function sampleRgb(data: Uint8Array, w: number, h: number, x: number, y: number): [number, number, number] {
  const cx = Math.max(0, Math.min(w - 1.001, x)), cy = Math.max(0, Math.min(h - 1.001, y));
  const xi = Math.floor(cx), yi = Math.floor(cy), fx = cx - xi, fy = cy - yi;
  const p00 = (yi * w + xi) * 3, p10 = p00 + 3, p01 = p00 + w * 3, p11 = p01 + 3;
  for (let c = 0; c < 3; c += 1) {
    tmp3[c] = (data[p00 + c] * (1 - fx) + data[p10 + c] * fx) * (1 - fy) + (data[p01 + c] * (1 - fx) + data[p11 + c] * fx) * fy;
  }
  return tmp3;
}

/** Signed distance (px; negative inside) from (x, y) to a w × h rounded rect of radius r. */
function roundedDistance(x: number, y: number, w: number, h: number, r: number): number {
  const qx = Math.abs(x - w / 2) - (w / 2 - r), qy = Math.abs(y - h / 2) - (h / 2 - r);
  if (qx <= 0 || qy <= 0) return Math.max(qx, qy) - r;
  return Math.sqrt(qx * qx + qy * qy) - r;
}

/** Straight RGBA (alpha 0..1) at an integer pixel; zero outside. */
function readRgba(data: Uint8Array, w: number, h: number, x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= w || y >= h) { tmp4[3] = 0; return tmp4; }
  const p = (y * w + x) * 4;
  tmp4[0] = data[p]; tmp4[1] = data[p + 1]; tmp4[2] = data[p + 2]; tmp4[3] = data[p + 3] / 255;
  return tmp4;
}
