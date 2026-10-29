import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Mesh3dGeometryCache, mesh3dSceneTextFaceIdsV1, parseMesh3dFont } from "../../motion/mesh3dGeometry";
import { Mesh3dWorkerPoolV1 } from "../../motion/mesh3dParallel";
import type { Mesh3dTexture } from "../../motion/mesh3dRasterizer";
import { mesh3dSceneSchema, type Mesh3dScene } from "../../motion/mesh3dScene";
import { PRORES_422HQ, PRORES_4444, TO_YUV422, straightToYuva444 } from "../../motionLibrary/render/renderItem";
import { motionLibraryFontRoot } from "../../motionLibrary/svg/glyphs";
import { readMesh3dFaceV1 } from "../../render/mesh3dFontSource";
import type { StyleCompositeHooksV1, StyleCompositeLayersV1, StyleCompositePassLayerV1, StyleCompositePassV1, StyleSvgArtV1 } from "./compositeComponent";
import { createRaster, differenceMatte, downsampleEngine, mipChain, rasterFromPremultipliedBytes, toBytes, type MipChainV1, type RasterV1 } from "./raster";

/**
 * The template compositor (Node only): renders a composited template clip (compositeComponent.ts) frame by frame and
 * encodes it to ProRes exactly like the SVG path (ProRes 422 HQ opaque or ProRes 4444 straight alpha, BT.709 tv, tagged).
 *
 * - SVG art (pieces and textures) is rasterized once by the bundled FFmpeg's librsvg.
 * - Overlay layers (per-frame SVG type) are written as numbered documents and decoded by one librsvg stream per layer.
 * - Engine passes render on one Mesh3dWorkerPoolV1 per clip (closed in `finally`): frames are byte-identical for any
 *   thread count (mesh3dParallel), and everything after them is single-threaded deterministic TypeScript.
 * - Frames stream as raw 8-bit RGB (opaque) or premultiplied RGBA (alpha) into the encoder; nothing raw touches the disk.
 */

export interface StyleCompositeRunInputV1 {
  readonly hooks: StyleCompositeHooksV1;
  readonly params: Record<string, unknown>;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  /** Exact frame rate. */
  readonly rate: { readonly numerator: number; readonly denominator: number; readonly text: string };
  readonly output: "alpha" | "opaque";
  /** Slot pictures as data URIs, by image slot id. */
  readonly images: Readonly<Record<string, string>>;
  readonly ffmpegPath: string;
  /** A fresh, empty work folder (overlay documents and art sources are written here). */
  readonly workDir: string;
  /** Engine worker threads (default: mesh3dDefaultThreadsV1). The bytes do not depend on it. */
  readonly threads?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (phase: "generate" | "encode", completed: number, total: number) => void;
  /** Only these frame indices, in this order (previews and contact sheets); default every frame. */
  readonly only?: readonly number[];
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Runs FFmpeg and returns stdout bytes (exactly `expected` of them). */
function ffmpegBytes(ffmpeg: string, args: string[], expected: number, signal: AbortSignal | undefined, timeoutMs: number): Promise<Uint8Array> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let length = 0, stderr = "", failure: Error | undefined;
    const abort = () => { failure = new Error("STYLE_TEMPLATE_RENDER_CANCELLED"); child.kill(); };
    const timer = setTimeout(() => { failure = new Error("style template art rasterization timed out"); child.kill(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (bytes: Buffer) => { chunks.push(bytes); length += bytes.length; });
    child.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-4000); });
    child.on("error", error => { failure ??= error; });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`FFmpeg exit ${code}: ${stderr}`));
      if (length !== expected) return reject(new Error(`FFmpeg produced ${length} bytes, expected ${expected}`));
      resolve(new Uint8Array(Buffer.concat(chunks, length)));
    });
  });
}

const STRAIGHT = "setparams=alpha_mode=premultiplied,format=gbrap,unpremultiply=inplace=1,format=rgba";

/** One SVG document → RGBA bytes (librsvg). premultiplied: librsvg's own output; straight: unpremultiplied (engine textures). */
async function rasterizeArt(input: StyleCompositeRunInputV1, art: StyleSvgArtV1, alpha: "premultiplied" | "straight"): Promise<Uint8Array> {
  if (!Number.isInteger(art.width) || !Number.isInteger(art.height) || art.width < 2 || art.height < 2 || art.width * art.height > 4096 * 4096) {
    throw new Error(`style template art must be 2…4096 px (${art.width}×${art.height})`);
  }
  const file = join(input.workDir, `art-${sha(art.svg).slice(0, 24)}.svg`);
  await writeFile(file, art.svg);
  return ffmpegBytes(input.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, ...(alpha === "straight" ? ["-vf", STRAIGHT] : []),
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], art.width * art.height * 4, input.signal, input.timeoutMs ?? 120_000);
}

/** A raw-frame reader over a child's stdout. */
async function* rawFrames(child: ChildProcessWithoutNullStreams, bytes: number): AsyncGenerator<Uint8Array> {
  let chunks: Buffer[] = [], length = 0;
  for await (const input of child.stdout) {
    chunks.push(input as Buffer); length += (input as Buffer).length;
    while (length >= bytes) {
      const frame = Buffer.allocUnsafe(bytes);
      let copied = 0;
      while (copied < bytes) {
        const head = chunks[0], count = Math.min(bytes - copied, head.length);
        head.copy(frame, copied, 0, count); copied += count;
        if (count === head.length) chunks.shift(); else chunks[0] = head.subarray(count);
      }
      length -= bytes;
      yield new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    }
  }
  chunks = [];
  if (length) throw new Error("style template overlay stream ended inside a frame");
}

interface Owned { child: ChildProcessWithoutNullStreams; completion: Promise<void> }
function owned(ffmpeg: string, args: string[], timeoutMs: number, signal?: AbortSignal): Owned {
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-4000); });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", abort); code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}: ${stderr}`)); });
  });
  completion.catch(() => undefined);
  child.stdin.on("error", () => undefined);
  return { child, completion };
}

function writeFrame(child: ChildProcessWithoutNullStreams, bytes: Uint8Array): Promise<void> {
  if (child.stdin.write(bytes)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stream = child.stdin;
    const clean = () => { stream.off("drain", drained); stream.off("close", closed); stream.off("error", failed); };
    const drained = () => { clean(); resolve(); };
    const closed = () => failed(new Error("the encoder closed before taking every frame"));
    const failed = (error: Error) => { clean(); reject(error); };
    stream.once("drain", drained); stream.once("close", closed); stream.once("error", failed);
  });
}

/** Scene variant over a flat background (difference matte): no radial field, grid, bloom or vignette (they are not linear in the background). */
function overBackground(scene: Mesh3dScene, color: string): Mesh3dScene {
  const post = scene.post ? { ...scene.post } : undefined;
  if (post) { delete post.bloom; delete post.vignette; }
  return { ...scene, background: { color, gridColor: color, spacing: scene.background.spacing, grid: false }, ...(post ? { post } : {}) };
}

/** The ordered frames of a composited clip as encoder-ready bytes (RGB24, or premultiplied RGBA for alpha clips). */
export async function* styleCompositeFramesV1(input: StyleCompositeRunInputV1): AsyncGenerator<Uint8Array> {
  const { hooks, params, width: W, height: H, frameCount, rate } = input;
  const timeoutMs = input.timeoutMs ?? 600_000;
  const channels = input.output === "alpha" ? 4 : 3;
  await mkdir(input.workDir, { recursive: true });

  // 1. Art rasterized once: pieces (premultiplied, mipmapped) and engine textures (straight RGBA).
  const rasters: Record<string, RasterV1> = {};
  for (const [name, art] of Object.entries(hooks.pieces?.(params, input.images) ?? {})) {
    input.signal?.throwIfAborted();
    rasters[name] = rasterFromPremultipliedBytes(art.width, art.height, await rasterizeArt(input, art, "premultiplied"));
  }
  const pieces: Record<string, MipChainV1> = {};
  for (const [name, raster] of Object.entries(hooks.refine ? hooks.refine(params, rasters) : rasters)) pieces[name] = mipChain(raster);
  const textures = new Map<string, Mesh3dTexture>();
  for (const [id, art] of Object.entries(hooks.textures?.(params, input.images) ?? {})) {
    input.signal?.throwIfAborted();
    textures.set(id, { width: art.width, height: art.height, rgba: await rasterizeArt(input, art, "straight") });
  }

  // 2. Overlay documents for every frame, then one librsvg decode stream per layer.
  const time = (index: number) => (index * rate.denominator) / rate.numerator;
  const indices = input.only ?? Array.from({ length: frameCount }, (_, index) => index);
  if (!indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= frameCount)) throw new Error("frame indices are outside the clip");
  const layerNames = Object.keys(hooks.frame(params, 0, 0).overlays).sort();
  for (const name of layerNames) if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(name)) throw new Error(`overlay layer ${name} is not a simple name`);
  for (const [position, index] of indices.entries()) {
    input.signal?.throwIfAborted();
    const overlays = hooks.frame(params, time(index), index).overlays;
    const names = Object.keys(overlays).sort();
    if (names.join() !== layerNames.join()) throw new Error(`frame ${index} names overlay layers ${names.join(",")}, not ${layerNames.join(",")}`);
    for (const name of names) await writeFile(join(input.workDir, `ov-${name}-${String(position).padStart(5, "0")}.svg`), overlays[name]);
  }
  const decoders = layerNames.map(name => {
    const decoder = owned(input.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-framerate", rate.text, "-start_number", "0",
      "-i", join(input.workDir, `ov-${name}-%05d.svg`), "-frames:v", String(indices.length), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], timeoutMs, input.signal);
    decoder.child.stdin.end();
    return { name, decoder, frames: rawFrames(decoder.child, W * H * 4) };
  });

  // 3. Engine: one pool per clip, faces loaded as scenes name them (SHA-pinned bundled faces).
  const faces = new Map<string, ReturnType<typeof parseMesh3dFont>>();
  const cache = new Mesh3dGeometryCache(new Map(), faces);
  let pool: Mesh3dWorkerPoolV1 | undefined;
  const ensureFaces = async (scene: Mesh3dScene) => {
    for (const faceId of mesh3dSceneTextFaceIdsV1(scene)) {
      if (faces.has(faceId)) continue;
      const face = await readMesh3dFaceV1(motionLibraryFontRoot(), faceId);
      faces.set(faceId, parseMesh3dFont(new Uint8Array(face.bytes).buffer));
    }
  };
  const renderPass = async (pass: StyleCompositePassV1): Promise<StyleCompositePassLayerV1> => {
    const ss = pass.ss ?? 2, resolution = pass.resolution ?? 1;
    const w = Math.max(2, Math.round(W * resolution)), h = Math.max(2, Math.round(H * resolution));
    if (!Number.isInteger(ss) || ss < 1 || ss > 4 || w * ss * h * ss > 3840 * 2160) throw new Error(`pass ${pass.id}: ${w}×${h} at ${ss}× exceeds the engine raster budget`);
    const scene = mesh3dSceneSchema.parse(pass.scene) as Mesh3dScene;
    await ensureFaces(scene);
    pool ??= new Mesh3dWorkerPoolV1(input.threads !== undefined ? { threads: input.threads } : {});
    const rw = w * ss, rh = h * ss;
    // Only the textures this scene's materials name (the engine budgets textures per frame).
    const used = new Set(scene.segments.flatMap(segment => segment.objects.flatMap(object => object.material.clipId ? [object.material.clipId] : [])));
    const passTextures = new Map([...textures].filter(([id]) => used.has(id)));
    for (const id of used) if (!textures.has(id)) throw new Error(`pass ${pass.id} names texture ${id}, which the component did not make`);
    const splits = (depth: Float32Array) => {
      const out: Record<string, Float32Array> = {};
      for (const [name, threshold] of Object.entries(pass.splits ?? {})) {
        const plane = new Float32Array(w * h), inv = 1 / (ss * ss);
        for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
          let count = 0;
          for (let dy = 0; dy < ss; dy += 1) for (let dx = 0; dx < ss; dx += 1) if (depth[(y * ss + dy) * rw + x * ss + dx] < threshold) count += 1;
          plane[y * w + x] = count * inv;
        }
        out[name] = plane;
      }
      return out;
    };
    if (pass.matte === "difference") {
      const black = await pool.render(overBackground(scene, "#000000"), pass.time, rw, rh, cache, passTextures);
      const white = await pool.render(overBackground(scene, "#FFFFFF"), pass.time, rw, rh, cache, passTextures);
      const matte = differenceMatte(black.rgba, white.rgba, w, h, ss);
      const nearest = downsampleEngine(black.rgba, black.depth, w, h, ss, "depth").depth;
      return { width: w, height: h, color: matte.color, alpha: matte.alpha, depth: nearest, splits: splits(black.depth) };
    }
    const frame = await pool.render(scene, pass.time, rw, rh, cache, passTextures);
    const layer = downsampleEngine(frame.rgba, frame.depth, w, h, ss, pass.matte === "opaque" ? "opaque" : "depth");
    return { width: w, height: h, color: layer.color, alpha: layer.alpha, depth: layer.depth, splits: splits(frame.depth) };
  };

  try {
    for (const [position, index] of indices.entries()) {
      input.signal?.throwIfAborted();
      const t = time(index), frame = hooks.frame(params, t, index);
      const passes: Record<string, StyleCompositePassLayerV1> = {};
      for (const pass of frame.passes) {
        if (passes[pass.id]) throw new Error(`frame ${index} renders pass ${pass.id} twice`);
        passes[pass.id] = await renderPass(pass);
      }
      const overlays: Record<string, RasterV1> = {};
      for (const { name, frames } of decoders) {
        const next = await frames.next();
        if (next.done) throw new Error(`overlay ${name} ended at frame ${index}`);
        overlays[name] = rasterFromPremultipliedBytes(W, H, next.value);
      }
      const out = createRaster(W, H, channels);
      const layers: StyleCompositeLayersV1 = { passes, overlays, pieces };
      hooks.composite(params, t, index, layers, out);
      const bytes = new Uint8Array(W * H * channels);
      toBytes(out, bytes);
      input.onProgress?.("generate", position + 1, indices.length);
      yield bytes;
    }
    for (const { decoder } of decoders) await decoder.completion;
  } finally {
    for (const { decoder } of decoders) if (decoder.child.exitCode === null) decoder.child.kill();
    await pool?.close().catch(() => undefined);
  }
}

/** Renders a composited clip into `outputPath` (ProRes, the SVG path's profiles and colour tags). */
export async function encodeStyleCompositeClipV1(input: StyleCompositeRunInputV1 & { readonly outputPath: string }): Promise<{ generateMs: number; encodeMs: number }> {
  const timeoutMs = input.timeoutMs ?? 600_000, started = performance.now();
  const graph = input.output === "alpha" ? straightToYuva444("[0:v]", "[v]", "s") : `[0:v]${TO_YUV422}[v]`;
  const encoder = owned(input.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", input.output === "alpha" ? "rgba" : "rgb24",
    "-s", `${input.width}x${input.height}`, "-framerate", input.rate.text, "-i", "pipe:0", "-filter_complex", graph, "-map", "[v]", "-frames:v", String(input.frameCount), "-an",
    ...(input.output === "alpha" ? PRORES_4444 : PRORES_422HQ), "-f", "mov", input.outputPath], timeoutMs, input.signal);
  encoder.child.stdout.resume();
  let written = 0;
  try {
    for await (const bytes of styleCompositeFramesV1(input)) {
      await writeFrame(encoder.child, bytes);
      written += 1;
    }
    if (written !== input.frameCount) throw new Error(`composited ${written} of ${input.frameCount} frames`);
    const generated = performance.now();
    input.onProgress?.("encode", 0, 1);
    encoder.child.stdin.end();
    await encoder.completion;
    input.onProgress?.("encode", 1, 1);
    return { generateMs: generated - started, encodeMs: performance.now() - generated };
  } catch (error) {
    if (encoder.child.exitCode === null) encoder.child.kill();
    throw error;
  }
}
