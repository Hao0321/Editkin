import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runConversionProcess } from "../../application/mediaConversion";
import { getMotionLibraryItem } from "../catalog";
import { generateMotionFrame, generateTransitionFrame, itemFrameTime, motionFrameCount, motionFrameRate, type MotionFrameRate, type RationalRate } from "../frames";
import { canonicalJson, resolveMotionLibraryParams } from "../params";
import { emptySvg } from "../svg/document";
import { motionLibraryFontDigests } from "../svg/glyphs";
import {
  MOTION_LIBRARY_ENGINE_VERSION,
  MotionLibraryNotImplementedError,
  assertMotionFrameSize,
  resolveMotionItemRevision,
  type BackgroundMotionParams,
  type MotionFrameSize,
  type MotionLibraryItem,
  type MotionLibraryKind,
  type MotionLibraryParams,
  type TextMotionParams,
  type TransitionMotionParams,
} from "../types";
import { motionLibraryEncodePool } from "./workerPool";

/**
 * Render a motion library item to cached clips (Node only).
 *
 * 1. Resolve params, compute the cache key and return a verified cache hit.
 * 2. Generate every SVG frame in this thread into a temp folder (TEMP/TMP or
 *    tempRoot). Generation errors, including MotionLibraryGlyphError for a
 *    character the face cannot draw, happen before FFmpeg starts. Text and
 *    background frames sample t = i / fps; transitions sample the endpoint
 *    clock t = D · i / (N − 1) (first frame pure A, last frame pure B).
 * 3. One bundled-FFmpeg process rasterizes (librsvg) and encodes:
 *    - text            → <key>.mov          ProRes 4444, yuva444p10le, straight alpha
 *    - transition      → <key>.matte.mov    ProRes 4444 whose ALPHA is the matte (RGB white)
 *                        <key>.overlay.mov  ProRes 4444 RGBA overlay (only if the item draws one)
 *    - background      → <key>.mov          ProRes 422 HQ, yuv422p10le, opaque
 *                        <key>.preview.mp4  optional H.264 High 4:2:0 ≈25 Mb/s
 *    All outputs are BT.709, limited range, tagged. librsvg delivers
 *    premultiplied RGBA labelled as straight; the graph declares it
 *    premultiplied and unpremultiplies before the 4444 encode, so soft edges
 *    keep their colour instead of darkening.
 * 4. Packet counts are verified with ffprobe, outputs are renamed into
 *    <cacheRoot>/motionlib/<itemId>/ and the manifest <key>.json is written
 *    last; a cache entry exists only when its manifest does.
 *
 * Why the matte lives in alpha: ProRes is always limited-range Y'CbCr, so a
 * grey matte stored in luma comes back as 64–940 and needs a range
 * convention on every consumer. ProRes 4444 alpha is stored full range (up to
 * 16 bit) and decodes unambiguously as 0..max; the consumer kernel reads
 * alpha (e.g. FFmpeg alphaextract) as mix(A, B, matte).
 *
 * Cancellation: an AbortSignal stops generation between frames and kills the
 * FFmpeg child; temp frames and partial outputs are always removed.
 */

/** v2: the key and manifest carry the item's art revision (itemRevision). */
export const MOTION_LIBRARY_CACHE_SCHEMA = "editkin.motion-library-cache/v2" as const;
/** Bump when encoder settings change (it is part of the cache key). */
export const MOTION_LIBRARY_ENCODE_PROFILE = "prores_ks/4444-yuva444p10le|422hq-yuv422p10le|h264-high-25M/bt709-tv/unpremultiplied/v1" as const;

export type MotionLibraryOutputRole = "clip" | "matte" | "overlay" | "preview";

export interface MotionLibraryOutputFile {
  readonly path: string;
  readonly bytes: number;
  readonly codec: "prores" | "h264";
  readonly profile: "4444" | "422 HQ" | "high";
  readonly pixFmt: string;
  readonly alpha: boolean;
}

export interface MotionLibraryRenderProgress {
  readonly phase: "cache" | "generate" | "encode" | "verify" | "done";
  readonly completed: number;
  readonly total: number;
  /** Overall progress 0..1. */
  readonly fraction: number;
}

export interface MotionLibraryRenderOptions {
  readonly item: MotionLibraryItem | string;
  /** Partial params merged over the item's defaults (see resolveMotionLibraryParams). */
  readonly params?: unknown;
  /** Even width and height, 16..7680. */
  readonly size: MotionFrameSize;
  /** Default 30. Numbers become rationals (29.97002997… → 30000/1001). */
  readonly fps?: number | RationalRate;
  /** Absolute; clips go to <cacheRoot>/motionlib/<itemId>/<cacheKey>.* */
  readonly cacheRoot: string;
  /** Backgrounds: also write an H.264 preview. */
  readonly preview?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MotionLibraryRenderProgress) => void;
  /** Where temp frame folders go (default os.tmpdir(), i.e. TEMP/TMP). */
  readonly tempRoot?: string;
  /** Default: Editkin's resolver (HAO_FFMPEG_PATH, EDITKIN_FFMPEG_PATH, else the vendored build). */
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  /** Per FFmpeg/ffprobe process (default 10 minutes). */
  readonly timeoutMs?: number;
  /** Keep the generated SVG frames (debugging); their folder is returned as framesDir. */
  readonly keepFrames?: boolean;
}

export interface MotionLibraryRenderResult {
  readonly schema: typeof MOTION_LIBRARY_CACHE_SCHEMA;
  readonly itemId: string;
  /** The item's art revision the clip was rendered (and keyed) with. */
  readonly itemRevision: number;
  readonly kind: MotionLibraryKind;
  readonly engineVersion: typeof MOTION_LIBRARY_ENGINE_VERSION;
  readonly cacheKey: string;
  readonly cacheHit: boolean;
  readonly params: MotionLibraryParams;
  readonly width: number;
  readonly height: number;
  readonly fps: string;
  readonly frameCount: number;
  /** frameCount / fps. */
  readonly durationSeconds: number;
  readonly outputs: Readonly<Partial<Record<MotionLibraryOutputRole, MotionLibraryOutputFile>>>;
  readonly manifestPath: string;
  readonly framesDir?: string;
  readonly timings: { readonly generateMs: number; readonly generateMsPerFrame: number; readonly encodeMs: number; readonly verifyMs: number; readonly totalMs: number };
}

interface ManifestOutput { file: string; bytes: number; codec: MotionLibraryOutputFile["codec"]; profile: MotionLibraryOutputFile["profile"]; pixFmt: string; alpha: boolean }
interface CacheManifest {
  schema: typeof MOTION_LIBRARY_CACHE_SCHEMA;
  cacheKey: string;
  itemId: string;
  itemRevision: number;
  kind: MotionLibraryKind;
  engineVersion: string;
  encodeProfile: string;
  params: MotionLibraryParams;
  width: number;
  height: number;
  fps: string;
  frameCount: number;
  durationSeconds: number;
  outputs: Partial<Record<MotionLibraryOutputRole, ManifestOutput>>;
}

// ---------------------------------------------------------------------------
// FFmpeg resolution and process helpers
// ---------------------------------------------------------------------------

let editkinTools: Promise<{ ffmpeg: string; ffprobe: string }> | undefined;

/** Editkin's own resolver (templateShortQaTools), loaded lazily: it pulls a large module graph. */
export function resolveMotionLibraryTools(): Promise<{ ffmpeg: string; ffprobe: string }> {
  editkinTools ??= import("../../application/templateShortQa").then(module => module.templateShortQaTools(process.env));
  return editkinTools;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function runTool(executable: string, args: string[], signal: AbortSignal | undefined, timeoutMs: number,
  onTime?: (seconds: number) => void): Promise<string> {
  try {
    return await runConversionProcess(executable, args, signal, timeoutMs, onTime);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw new Error(`Motion library ${executable.toLowerCase().includes("ffprobe") ? "ffprobe" : "FFmpeg"} failed: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Filter graphs
// ---------------------------------------------------------------------------

const COLOR_TAGS = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
/** librsvg (cairo) frames are premultiplied but untagged: declare, then unpremultiply. */
const STRAIGHT_RGBA = "setparams=alpha_mode=premultiplied,format=gbrap,unpremultiply=inplace=1";
const TO_YUV444_10 = "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv444p10le";
/**
 * Alpha at full scale. swscale carries 8-bit alpha into 10 bits by a shift (255 → 1020, so "opaque" and "all B"
 * would decode as 99.7%); routed through its own plane, gray8 → gray10le expands to full scale (255 → 1023, which a
 * 12-bit decoder reports as 4095). Labels are prefixed with `tag` so several of these can share one graph.
 */
export function straightToYuva444(input: string, output: string, tag: string): string {
  return `${input}${STRAIGHT_RGBA},split=2[${tag}c][${tag}a];[${tag}c]${TO_YUV444_10}[${tag}y];[${tag}a]alphaextract,format=gray10le[${tag}al];`
    + `[${tag}y][${tag}al]alphamerge,format=yuva444p10le,${COLOR_TAGS}${output}`;
}
export const TO_YUV422 = `format=gbrp,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv422p10le,${COLOR_TAGS}`;
const TO_YUV420 = `format=gbrp,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p,${COLOR_TAGS}`;
/** Matte luminance (R of an opaque black/white frame) becomes full-scale alpha over white RGB. */
function matteToYuva444(input: string, output: string, tag: string): string {
  return `${input}format=gbrap,split=2[${tag}c][${tag}s];[${tag}s]extractplanes=r,format=gray10le[${tag}a];`
    + `[${tag}c]lutrgb=r=255:g=255:b=255,${TO_YUV444_10}[${tag}w];[${tag}w][${tag}a]alphamerge,format=yuva444p10le,${COLOR_TAGS}${output}`;
}

export const COLOR_FLAGS = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
export const PRORES_4444 = ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-vendor", "apl0", ...COLOR_FLAGS];
export const PRORES_422HQ = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-vendor", "apl0", ...COLOR_FLAGS];
const H264_PREVIEW = ["-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-b:v", "25M", "-maxrate", "30M", "-bufsize", "50M",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart", ...COLOR_FLAGS];

const OUTPUT_FORMATS: Record<MotionLibraryOutputRole, Omit<ManifestOutput, "file" | "bytes">> = {
  clip: { codec: "prores", profile: "4444", pixFmt: "yuva444p10le", alpha: true },
  matte: { codec: "prores", profile: "4444", pixFmt: "yuva444p10le", alpha: true },
  overlay: { codec: "prores", profile: "4444", pixFmt: "yuva444p10le", alpha: true },
  preview: { codec: "h264", profile: "high", pixFmt: "yuv420p", alpha: false },
};
const BACKGROUND_CLIP: Omit<ManifestOutput, "file" | "bytes"> = { codec: "prores", profile: "422 HQ", pixFmt: "yuv422p10le", alpha: false };

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const fileNames = (key: string): Record<MotionLibraryOutputRole | "manifest", string> => ({
  clip: `${key}.mov`, matte: `${key}.matte.mov`, overlay: `${key}.overlay.mov`, preview: `${key}.preview.mp4`, manifest: `${key}.json`,
});

/**
 * sha256 over the canonical description of everything that changes output bytes:
 * cache schema, engine version, encode profile, item id and art revision, kind,
 * resolved params, size, fps, preview flag and the font digests. Item source code
 * is not part of it: an item whose output changes must bump its revision.
 */
export function motionLibraryCacheKey(input: { itemId: string; itemRevision: number; kind: MotionLibraryKind; params: MotionLibraryParams;
  size: MotionFrameSize; fps: MotionFrameRate; preview: boolean }): string {
  const material = canonicalJson({
    schema: MOTION_LIBRARY_CACHE_SCHEMA, engineVersion: MOTION_LIBRARY_ENGINE_VERSION, encodeProfile: MOTION_LIBRARY_ENCODE_PROFILE,
    itemId: input.itemId, itemRevision: resolveMotionItemRevision(input.itemRevision), kind: input.kind, params: input.params,
    width: input.size.width, height: input.size.height, fps: input.fps.text, preview: input.kind === "background" && input.preview,
    fonts: motionLibraryFontDigests(),
  });
  return createHash("sha256").update(material).digest("hex");
}

async function readCacheHit(directory: string, key: string, itemRevision: number): Promise<CacheManifest | undefined> {
  let manifest: CacheManifest;
  try { manifest = JSON.parse(await readFile(join(directory, fileNames(key).manifest), "utf8")) as CacheManifest; } catch { return undefined; }
  if (manifest?.schema !== MOTION_LIBRARY_CACHE_SCHEMA || manifest.cacheKey !== key || manifest.engineVersion !== MOTION_LIBRARY_ENGINE_VERSION
    || manifest.itemRevision !== itemRevision
    || manifest.encodeProfile !== MOTION_LIBRARY_ENCODE_PROFILE || !manifest.outputs || typeof manifest.outputs !== "object") return undefined;
  for (const output of Object.values(manifest.outputs)) {
    if (!output || typeof output.file !== "string" || !/^[a-f0-9]{64}\.[a-z0-9.]+$/.test(output.file)) return undefined;
    try { if ((await stat(join(directory, output.file))).size !== output.bytes) return undefined; } catch { return undefined; }
  }
  return manifest;
}

async function publish(partial: string, final: string): Promise<void> {
  try {
    await rename(partial, final);
  } catch (error) {
    // Another render of the same key may hold the final file open; its bytes are the same.
    const code = (error as NodeJS.ErrnoException).code;
    const existing = await stat(final).catch(() => undefined);
    await rm(partial, { force: true });
    if (!existing || !["EPERM", "EBUSY", "EACCES", "EEXIST"].includes(code ?? "")) throw error;
  }
}

function toResult(manifest: CacheManifest, directory: string, cacheHit: boolean, timings: MotionLibraryRenderResult["timings"],
  framesDir?: string): MotionLibraryRenderResult {
  const outputs: Partial<Record<MotionLibraryOutputRole, MotionLibraryOutputFile>> = {};
  for (const [role, output] of Object.entries(manifest.outputs) as Array<[MotionLibraryOutputRole, ManifestOutput]>) {
    outputs[role] = Object.freeze({ path: join(directory, output.file), bytes: output.bytes, codec: output.codec, profile: output.profile,
      pixFmt: output.pixFmt, alpha: output.alpha });
  }
  return Object.freeze({
    schema: MOTION_LIBRARY_CACHE_SCHEMA, itemId: manifest.itemId, itemRevision: manifest.itemRevision, kind: manifest.kind, engineVersion: MOTION_LIBRARY_ENGINE_VERSION,
    cacheKey: manifest.cacheKey, cacheHit, params: manifest.params, width: manifest.width, height: manifest.height, fps: manifest.fps,
    frameCount: manifest.frameCount, durationSeconds: manifest.durationSeconds, outputs: Object.freeze(outputs),
    manifestPath: join(directory, fileNames(manifest.cacheKey).manifest), ...(framesDir ? { framesDir } : {}), timings: Object.freeze(timings),
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function frameName(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(5, "0")}.svg`;
}

export async function renderMotionLibraryItem(options: MotionLibraryRenderOptions): Promise<MotionLibraryRenderResult> {
  const started = performance.now();
  const signal = options.signal;
  signal?.throwIfAborted();
  const item = typeof options.item === "string" ? getMotionLibraryItem(options.item) : options.item;
  if (!item.implemented) throw new MotionLibraryNotImplementedError(item.id);
  const size = { width: options.size?.width, height: options.size?.height };
  assertMotionFrameSize(size);
  if (size.width % 2 !== 0 || size.height % 2 !== 0) throw new Error("Motion library clips need even width and height (4:2:2 / 4:2:0 outputs)");
  if (typeof options.cacheRoot !== "string" || !isAbsolute(options.cacheRoot)) throw new Error("Motion library cacheRoot must be an absolute path");
  const params = resolveMotionLibraryParams(item, options.params);
  const fps = motionFrameRate(options.fps ?? 30);
  const frameCount = motionFrameCount(params.durationSeconds, fps);
  const preview = item.kind === "background" && Boolean(options.preview);
  const timeoutMs = options.timeoutMs ?? 600_000;
  const progress = (phase: MotionLibraryRenderProgress["phase"], completed: number, total: number, fraction: number) => {
    try { options.onProgress?.(Object.freeze({ phase, completed, total, fraction: Math.max(0, Math.min(1, fraction)) })); } catch { /* observers cannot break a render */ }
  };

  const itemRevision = resolveMotionItemRevision(item.revision);
  const cacheKey = motionLibraryCacheKey({ itemId: item.id, itemRevision, kind: item.kind, params, size, fps, preview });
  const directory = join(resolve(options.cacheRoot), "motionlib", item.id);
  const names = fileNames(cacheKey);
  const hit = await readCacheHit(directory, cacheKey, itemRevision);
  if (hit) {
    progress("cache", 1, 1, 1);
    return toResult(hit, directory, true, { generateMs: 0, generateMsPerFrame: 0, encodeMs: 0, verifyMs: 0, totalMs: performance.now() - started });
  }

  // Preflight frame 0 before touching the filesystem: glyph and parameter errors surface first.
  const timeOf = (index: number) => itemFrameTime(item.kind, index, frameCount, fps, params.durationSeconds);
  const firstTime = timeOf(0);
  if (item.kind === "transition") generateTransitionFrame(item, params as TransitionMotionParams, firstTime, size);
  else if (item.kind === "text") generateMotionFrame(item, params as TextMotionParams, firstTime, size);
  else generateMotionFrame(item, params as BackgroundMotionParams, firstTime, size);

  const tempRoot = resolve(options.tempRoot ?? tmpdir());
  if (tempRoot.includes("%")) throw new Error("Motion library temp folder may not contain '%' (FFmpeg image sequence pattern)");
  await mkdir(tempRoot, { recursive: true });
  await mkdir(directory, { recursive: true });
  const framesDir = await mkdtemp(join(tempRoot, `editkin-motionlib-${item.id}-`));
  const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const partials: string[] = [];
  const partial = (role: MotionLibraryOutputRole) => {
    const path = join(directory, `${cacheKey}.${token}.${role}.partial.${role === "preview" ? "mp4" : "mov"}`);
    partials.push(path);
    return path;
  };
  let succeeded = false;
  try {
    // 1. Generate frames.
    const generateStarted = performance.now();
    let overlayCount = 0;
    const missingOverlay: number[] = [];
    progress("generate", 0, frameCount, 0);
    for (let index = 0; index < frameCount; index += 1) {
      signal?.throwIfAborted();
      const t = timeOf(index);
      if (item.kind === "transition") {
        const frame = generateTransitionFrame(item, params as TransitionMotionParams, t, size);
        await writeFile(join(framesDir, frameName("m", index)), frame.matte);
        if (frame.overlay !== undefined) { overlayCount += 1; await writeFile(join(framesDir, frameName("o", index)), frame.overlay); }
        else missingOverlay.push(index);
      } else {
        const svg = item.kind === "text" ? generateMotionFrame(item, params as TextMotionParams, t, size)
          : generateMotionFrame(item, params as BackgroundMotionParams, t, size);
        await writeFile(join(framesDir, frameName("f", index)), svg);
      }
      if (index % 8 === 7 || index === frameCount - 1) progress("generate", index + 1, frameCount, ((index + 1) / frameCount) * 0.25);
    }
    const hasOverlay = overlayCount > 0;
    if (hasOverlay && missingOverlay.length) {
      const blank = emptySvg(size);
      for (const index of missingOverlay) await writeFile(join(framesDir, frameName("o", index)), blank);
    }
    const generateMs = performance.now() - generateStarted;

    // 2. Encode (one FFmpeg process; process-wide encode slots).
    const tools = options.ffmpegPath && options.ffprobePath ? { ffmpeg: options.ffmpegPath, ffprobe: options.ffprobePath }
      : { ...(await resolveMotionLibraryTools()), ...(options.ffmpegPath ? { ffmpeg: options.ffmpegPath } : {}), ...(options.ffprobePath ? { ffprobe: options.ffprobePath } : {}) };
    const input = (prefix: string) => ["-framerate", fps.text, "-start_number", "0", "-i", join(framesDir, `${prefix}%05d.svg`)];
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"];
    const planned: Array<{ role: MotionLibraryOutputRole; path: string; format: Omit<ManifestOutput, "file" | "bytes"> }> = [];
    const frames = ["-frames:v", String(frameCount), "-an"];
    if (item.kind === "text") {
      const clip = partial("clip");
      args.push(...input("f"), "-filter_complex", straightToYuva444("[0:v]", "[v]", "t"), "-map", "[v]", ...frames, ...PRORES_4444, "-f", "mov", clip);
      planned.push({ role: "clip", path: clip, format: OUTPUT_FORMATS.clip });
    } else if (item.kind === "transition") {
      const matte = partial("matte");
      args.push(...input("m"));
      if (hasOverlay) args.push(...input("o"));
      const graph = [matteToYuva444("[0:v]", "[matte]", "m"), ...(hasOverlay ? [straightToYuva444("[1:v]", "[overlay]", "o")] : [])].join(";");
      args.push("-filter_complex", graph, "-map", "[matte]", ...frames, ...PRORES_4444, "-f", "mov", matte);
      planned.push({ role: "matte", path: matte, format: OUTPUT_FORMATS.matte });
      if (hasOverlay) {
        const overlay = partial("overlay");
        args.push("-map", "[overlay]", ...frames, ...PRORES_4444, "-f", "mov", overlay);
        planned.push({ role: "overlay", path: overlay, format: OUTPUT_FORMATS.overlay });
      }
    } else {
      const clip = partial("clip");
      args.push(...input("f"));
      const graph = preview ? `[0:v]split=2[a][b];[a]${TO_YUV422}[clip];[b]${TO_YUV420}[preview]` : `[0:v]${TO_YUV422}[clip]`;
      args.push("-filter_complex", graph, "-map", "[clip]", ...frames, ...PRORES_422HQ, "-f", "mov", clip);
      planned.push({ role: "clip", path: clip, format: BACKGROUND_CLIP });
      if (preview) {
        const previewPath = partial("preview");
        args.push("-map", "[preview]", ...frames, ...H264_PREVIEW, "-f", "mp4", previewPath);
        planned.push({ role: "preview", path: previewPath, format: OUTPUT_FORMATS.preview });
      }
    }
    const encodeStarted = performance.now();
    progress("encode", 0, frameCount, 0.25);
    await motionLibraryEncodePool().run(() => runTool(tools.ffmpeg, args, signal, timeoutMs, seconds => {
      const done = Math.min(frameCount, Math.round(seconds * fps.value));
      progress("encode", done, frameCount, 0.25 + (done / frameCount) * 0.7);
    }), signal);
    const encodeMs = performance.now() - encodeStarted;

    // 3. Verify packet counts, then publish.
    const verifyStarted = performance.now();
    progress("verify", 0, planned.length, 0.95);
    const outputs: CacheManifest["outputs"] = {};
    for (const output of planned) {
      signal?.throwIfAborted();
      const probe = JSON.parse(await runTool(tools.ffprobe, ["-v", "error", "-count_packets", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,pix_fmt,width,height,nb_read_packets", "-of", "json", output.path], signal, timeoutMs)) as
        { streams?: Array<{ codec_name?: string; width?: number; height?: number; nb_read_packets?: string }> };
      const stream = probe.streams?.[0];
      if (!stream || stream.codec_name !== output.format.codec || stream.width !== size.width || stream.height !== size.height
        || Number(stream.nb_read_packets) !== frameCount) {
        throw new Error(`Motion library ${output.role} output failed verification (${JSON.stringify(stream ?? null)}, expected ${frameCount} ${output.format.codec} packets)`);
      }
      const bytes = (await stat(output.path)).size;
      outputs[output.role] = { file: names[output.role], bytes, ...output.format };
    }
    for (const output of planned) await publish(output.path, join(directory, names[output.role]));
    const manifest: CacheManifest = {
      schema: MOTION_LIBRARY_CACHE_SCHEMA, cacheKey, itemId: item.id, itemRevision, kind: item.kind, engineVersion: MOTION_LIBRARY_ENGINE_VERSION,
      encodeProfile: MOTION_LIBRARY_ENCODE_PROFILE, params, width: size.width, height: size.height, fps: fps.text, frameCount,
      durationSeconds: (frameCount * fps.denominator) / fps.numerator, outputs,
    };
    const manifestPartial = join(directory, `${cacheKey}.${token}.manifest.partial.json`);
    partials.push(manifestPartial);
    await writeFile(manifestPartial, `${JSON.stringify(manifest, null, 2)}\n`);
    await publish(manifestPartial, join(directory, names.manifest));
    const verifyMs = performance.now() - verifyStarted;
    succeeded = true;
    progress("done", 1, 1, 1);
    return toResult(manifest, directory, false, {
      generateMs, generateMsPerFrame: generateMs / frameCount, encodeMs, verifyMs, totalMs: performance.now() - started,
    }, options.keepFrames ? framesDir : undefined);
  } finally {
    if (!options.keepFrames || !succeeded) await rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
    await Promise.all(partials.map(path => rm(path, { force: true }).catch(() => undefined)));
  }
}
