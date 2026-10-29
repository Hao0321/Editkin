import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runConversionProcess } from "../../application/mediaConversion";
import { PRORES_422HQ, PRORES_4444, TO_YUV422, resolveMotionLibraryTools, straightToYuva444 } from "../../motionLibrary/render/renderItem";
import { motionLibraryEncodePool } from "../../motionLibrary/render/workerPool";
import { styleJobFrame, type StyleRenderJobV1 } from "../jobs";
import { STYLE_ENGINE_VERSION } from "../types";

/**
 * Render one style job to a cached clip (Node only), the same way the motion
 * library renders its items: SVG frames → bundled FFmpeg (librsvg) → ProRes.
 *
 * - alpha  → <key>.mov ProRes 4444 yuva444p10le, straight alpha (librsvg's
 *            premultiplied output is declared and unpremultiplied first).
 * - opaque → <key>.mov ProRes 422 HQ (drawn on black; composited with screen).
 *
 * The filter graphs and ProRes settings are the motion library's own (renderItem.ts
 * exports them). Frames are written to a temp folder and
 * removed afterwards; the manifest is written last, so a cache entry exists only
 * when its manifest does.
 */

export const STYLE_RENDER_CACHE_SCHEMA = "editkin.style-template-cache/v1" as const;
export const STYLE_ENCODE_PROFILE = "prores_ks/4444-yuva444p10le|422hq-yuv422p10le/bt709-tv/unpremultiplied/v1" as const;

// The motion library's own encode graphs (exported for this use): identical colour tags, straight alpha at full scale.
const ALPHA_GRAPH = straightToYuva444("[0:v]", "[v]", "s");
const OPAQUE_GRAPH = `[0:v]${TO_YUV422}[v]`;

export interface StyleJobRenderOptions {
  readonly cacheRoot: string;
  readonly tempRoot?: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Run the encode through this scheduler (default: the motion library's shared encode pool). */
  readonly schedule?: <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}

export interface StyleJobRenderResult {
  readonly jobId: string;
  readonly key: string;
  readonly path: string;
  readonly cacheHit: boolean;
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly output: StyleRenderJobV1["output"];
  readonly timings: { readonly generateMs: number; readonly generateMsPerFrame: number; readonly encodeMs: number; readonly encodeMsPerFrame: number };
}

interface Manifest { schema: string; engine: string; encodeProfile: string; key: string; jobId: string; component: string; frameCount: number; fps: number;
  width: number; height: number; file: string; bytes: number; output: string }

export async function renderStyleJob(job: StyleRenderJobV1, options: StyleJobRenderOptions): Promise<StyleJobRenderResult> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (!isAbsolute(options.cacheRoot)) throw new Error("style job cacheRoot must be absolute");
  const { width, height } = job.params;
  if (width % 2 || height % 2) throw new Error("style job clips need even width and height");
  const directory = join(resolve(options.cacheRoot), "styletpl", job.component);
  const still = job.output === "still";
  const file = `${job.key}.${still ? "png" : "mov"}`, manifestFile = `${job.key}.json`;
  const result = (cacheHit: boolean, timings: StyleJobRenderResult["timings"]): StyleJobRenderResult => Object.freeze({
    jobId: job.id, key: job.key, path: join(directory, file), cacheHit, frameCount: job.frameCount, width, height,
    durationSeconds: job.frameCount / job.fps, output: job.output, timings,
  });
  try {
    const manifest = JSON.parse(await readFile(join(directory, manifestFile), "utf8")) as Manifest;
    if (manifest.schema === STYLE_RENDER_CACHE_SCHEMA && manifest.engine === STYLE_ENGINE_VERSION && manifest.key === job.key
      && manifest.encodeProfile === STYLE_ENCODE_PROFILE && (await stat(join(directory, file))).size === manifest.bytes) {
      return result(true, { generateMs: 0, generateMsPerFrame: 0, encodeMs: 0, encodeMsPerFrame: 0 });
    }
  } catch { /* not cached */ }

  // Preflight frame 0 (glyph errors surface before any file is written).
  styleJobFrame(job, 0);
  const tempRoot = resolve(options.tempRoot ?? tmpdir());
  if (tempRoot.includes("%")) throw new Error("temp folder may not contain '%'");
  await mkdir(tempRoot, { recursive: true });
  await mkdir(directory, { recursive: true });
  const framesDir = await mkdtemp(join(tempRoot, `editkin-style-${job.component}-`));
  const partial = join(directory, `${job.key}.${process.pid}-${randomBytes(6).toString("hex")}.partial.${still ? "png" : "mov"}`);
  try {
    const generateStarted = performance.now();
    for (let index = 0; index < (still ? 1 : job.frameCount); index += 1) {
      signal?.throwIfAborted();
      await writeFile(join(framesDir, `f${String(index).padStart(5, "0")}.svg`), styleJobFrame(job, index));
    }
    const generateMs = performance.now() - generateStarted;
    const tools = options.ffmpegPath && options.ffprobePath ? { ffmpeg: options.ffmpegPath, ffprobe: options.ffprobePath } : await resolveMotionLibraryTools();
    const fpsText = Number.isInteger(job.fps) ? `${job.fps}/1` : `${Math.round(job.fps * 1001)}/1001`;
    // A still is one straight-alpha RGBA PNG (librsvg's premultiplied output unpremultiplied, as for the ProRes clips).
    const args = still
      ? ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", join(framesDir, "f00000.svg"), "-vf", "setparams=alpha_mode=premultiplied,format=gbrap,unpremultiply=inplace=1,format=rgba", "-frames:v", "1", "-f", "image2", "-c:v", "png", partial]
      : ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-framerate", fpsText, "-start_number", "0", "-i", join(framesDir, "f%05d.svg"),
        "-filter_complex", job.output === "alpha" ? ALPHA_GRAPH : OPAQUE_GRAPH, "-map", "[v]", "-frames:v", String(job.frameCount), "-an",
        ...(job.output === "alpha" ? PRORES_4444 : PRORES_422HQ), "-f", "mov", partial];
    const encodeStarted = performance.now();
    const schedule = options.schedule ?? ((task, s) => motionLibraryEncodePool().run(task, s));
    await schedule(() => runConversionProcess(tools.ffmpeg, args, signal, options.timeoutMs ?? 600_000), signal);
    const encodeMs = performance.now() - encodeStarted;
    const probe = JSON.parse(await runConversionProcess(tools.ffprobe, ["-v", "error", "-count_packets", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,nb_read_packets", "-of", "json", partial], signal, 120_000)) as { streams?: Array<{ codec_name?: string; width?: number; height?: number; nb_read_packets?: string }> };
    const stream = probe.streams?.[0];
    if (!stream || stream.codec_name !== (still ? "png" : "prores") || stream.width !== width || stream.height !== height || Number(stream.nb_read_packets) !== (still ? 1 : job.frameCount)) {
      throw new Error(`style job ${job.id} failed verification (${JSON.stringify(stream ?? null)})`);
    }
    const bytes = (await stat(partial)).size;
    await rename(partial, join(directory, file)).catch(async error => {
      if (!(await stat(join(directory, file)).catch(() => undefined))) throw error;
    });
    const manifest: Manifest = { schema: STYLE_RENDER_CACHE_SCHEMA, engine: STYLE_ENGINE_VERSION, encodeProfile: STYLE_ENCODE_PROFILE, key: job.key, jobId: job.id,
      component: job.component, frameCount: job.frameCount, fps: job.fps, width, height, file, bytes, output: job.output };
    await writeFile(join(directory, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
    return result(false, { generateMs, generateMsPerFrame: generateMs / job.frameCount, encodeMs, encodeMsPerFrame: encodeMs / job.frameCount });
  } finally {
    await rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
  }
}
