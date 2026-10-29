import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { runConversionProcess } from "../../application/mediaConversion";
import type { StyleImageSlotValueV1, StyleJobClipV1 } from "../../domain/styleJobFieldsV1";
import {
  STYLE_TEMPLATE_CLIP_CACHE_DIRECTORY_V1, STYLE_TEMPLATE_CLIP_CACHE_SCHEMA_V1, STYLE_TEMPLATE_CLIP_ENCODE_PROFILE_V1, STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1,
  assertStyleJobSlotAssetsV1, styleJobAssetFileNameV1,
} from "../../domain/styleJobV1";
import { motionLibraryFrameRateV1 } from "../../domain/motionLibraryV1";
import type { EditProject, MediaAsset } from "../../domain/types";
import { PRORES_422HQ, PRORES_4444, TO_YUV422, resolveMotionLibraryTools, straightToYuva444 } from "../../motionLibrary/render/renderItem";
import { motionLibraryEncodePool } from "../../motionLibrary/render/workerPool";
import { styleJobKey, type StyleRenderJobV1 } from "../jobs";
import { renderStyleJob } from "../render/renderStyleJob";
import { compileStyleTemplateClipV1, resolveSlotTemplateForClipV1, slotImageFraming, StyleTemplateClipRefusalV1 } from "./compileClip";
import { encodeStyleCompositeClipV1 } from "./compositeRender";
import { validateStyleSlotValuesV1 } from "./slotSchema";
import { slotImageDataUri, type SlotImageParams } from "./svgImage";

/**
 * Renders an editable template clip (Node only) along the Motion Library engine path: SVG frames → bundled FFmpeg
 * (librsvg) → ProRes, verified with ffprobe, published into the project media cache with a manifest written last.
 *
 * 1. Slots are checked against the template's declarations and every picture slot's project asset is resolved.
 * 2. Each picture becomes a normalized derivative: one decoded frame (an image file, or a video frame at its source
 *    time), cropped, scaled to the size the component needs at its strongest punch-in (never upscaled), PNG when the
 *    source has alpha else a q2 4:4:4 JPEG, content-addressed by sha256 (`<cache>/styletpl-img/<sha256>.<ext>`).
 * 3. The compiled job (compileClip.ts) names everything that changes output bytes; its key is the cache key, so the same
 *    slots are a cache hit and any change (text, colour, picture, fit, focal point, length) renders a new file.
 * 4. Frames are generated in this thread into a work folder on the cache's volume; the component's underlay (S1's
 *    designed backdrop) is a still rendered once and laid under the frames inside the same FFmpeg graph.
 * 5. A composited component (S4 and S7 on the mesh3d engine, the S5 collage) goes through the template compositor
 *    instead (compositeRender.ts): art rasterized once, engine passes on one Mesh3dWorkerPoolV1 per render (byte-identical
 *    for any thread count, `mesh3dThreads`), per-frame SVG type, composited in TypeScript and piped to the same encoder
 *    settings. Same key, cache, verification and manifest.
 *
 * Output: `<cacheRoot>/styletpl-clip/<templateId>/<key>.mov` (+ `<key>.json`): ProRes 422 HQ for opaque clips, ProRes 4444
 * straight alpha for alpha clips; BT.709 limited range, tagged. The preview plays this file and export reads it, so the
 * timeline preview equals the export by construction.
 */

export const STYLE_SLOT_IMAGE_DIRECTORY_V1 = "styletpl-img" as const;
export const STYLE_TEMPLATE_WORK_DIRECTORY_V1 = ".styletpl-work" as const;
const SLOT_IMAGE_SCHEMA = "editkin.style-slot-image/v1" as const;

export interface StyleTemplateRenderProgressV1 {
  readonly phase: "images" | "cache" | "generate" | "encode" | "verify" | "done";
  readonly completed: number;
  readonly total: number;
  /** 0..1 over the whole render. */
  readonly fraction: number;
}

export interface StyleTemplateToolsV1 { readonly ffmpegPath?: string; readonly ffprobePath?: string }

export interface StyleTemplateClipRenderInputV1 extends StyleTemplateToolsV1 {
  readonly templateId: string;
  /** Raw slot values (validated here). */
  readonly slots: unknown;
  readonly project: Pick<EditProject, "width" | "height" | "fps" | "assets">;
  readonly durationSeconds?: number;
  /** Absolute; the project media cache (resolveMotionLibraryCacheRootV1). */
  readonly cacheRoot: string;
  /** Maps an asset uri to an absolute file path (default: the uri itself). */
  readonly resolveAssetPath?: (uri: string) => string | Promise<string>;
  readonly tempRoot?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: StyleTemplateRenderProgressV1) => void;
  readonly timeoutMs?: number;
  /** mesh3d engine worker threads (default mesh3dDefaultThreadsV1); the rendered bytes do not depend on it. */
  readonly mesh3dThreads?: number;
}

export interface StyleSlotImageDerivativeV1 extends Pick<SlotImageParams, "sha256" | "width" | "height" | "mime"> {
  readonly path: string;
  readonly bytes: number;
  readonly cacheHit: boolean;
}

export interface StyleTemplateClipRenderResultV1 {
  readonly field: StyleJobClipV1;
  readonly asset: MediaAsset;
  readonly path: string;
  readonly cacheHit: boolean;
  readonly frameCount: number;
  readonly durationSeconds: number;
  readonly images: Readonly<Record<string, StyleSlotImageDerivativeV1>>;
  /** The project assets the picture slots used (rights and provenance follow them). */
  readonly sourceAssets: readonly MediaAsset[];
  readonly timings: { readonly imagesMs: number; readonly generateMs: number; readonly encodeMs: number; readonly totalMs: number };
}

const sha256Bytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sha256Text = (text: string) => createHash("sha256").update(text).digest("hex");

async function tools(input: StyleTemplateToolsV1): Promise<{ ffmpeg: string; ffprobe: string }> {
  if (input.ffmpegPath && input.ffprobePath) return { ffmpeg: input.ffmpegPath, ffprobe: input.ffprobePath };
  const resolved = await resolveMotionLibraryTools();
  return { ffmpeg: input.ffmpegPath ?? resolved.ffmpeg, ffprobe: input.ffprobePath ?? resolved.ffprobe };
}

async function publish(partial: string, final: string): Promise<void> {
  try { await rename(partial, final); } catch (error) {
    // Another render of the same key may hold the final file open; its bytes are the same.
    const existing = await stat(final).catch(() => undefined);
    await rm(partial, { force: true });
    if (!existing || !["EPERM", "EBUSY", "EACCES", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

// ---------------------------------------------------------------------------
// Picture derivatives
// ---------------------------------------------------------------------------

interface DerivativeManifest { schema: typeof SLOT_IMAGE_SCHEMA; request: string; sha256: string; file: string; bytes: number; width: number; height: number; mime: SlotImageParams["mime"] }

/**
 * One normalized picture for a slot value: decoded (an image file, or a video frame at its source time, auto-rotated),
 * cropped, scaled to fit the component's window at `maxPunch` (cover: the covering size; contain: the fitting size;
 * never upscaled), PNG with alpha or a q2 4:4:4 JPEG. Content-addressed; a request manifest keyed by the source file
 * (path, size, mtime) and the framing makes a repeat request a cache hit.
 */
export async function styleSlotImageDerivativeV1(input: StyleTemplateToolsV1 & {
  readonly sourcePath: string;
  readonly value: StyleImageSlotValueV1;
  readonly fit: SlotImageParams["fit"];
  readonly window: { readonly w: number; readonly h: number };
  readonly maxPunch: number;
  readonly cacheRoot: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<StyleSlotImageDerivativeV1> {
  const source = resolve(input.sourcePath);
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile()) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_IMAGE_UNREADABLE", `${source} is not a readable file`);
  const { ffmpeg, ffprobe } = await tools(input);
  const timeoutMs = input.timeoutMs ?? 120_000;
  const probe = JSON.parse(await runConversionProcess(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,width,height", "-of", "json", source],
    input.signal, timeoutMs).catch(() => { throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_IMAGE_UNREADABLE", `${parse(source).base} has no picture`); })) as { streams?: Array<{ pix_fmt?: string }> };
  const pixFmt = probe.streams?.[0]?.pix_fmt;
  if (!pixFmt) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_IMAGE_UNREADABLE", `${parse(source).base} has no picture`);
  const alpha = /^(?:yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/.test(pixFmt);
  const crop = input.value.crop;
  const P = Math.max(1, input.maxPunch);
  // Scale factor (expression over the cropped, auto-rotated frame): the covering/fitting size at the strongest punch, ≤ 1.
  const fitScale = `${input.fit === "cover" ? "max" : "min"}(${input.window.w.toFixed(3)}/iw\\,${input.window.h.toFixed(3)}/ih)`;
  const k = `min(1\\,${P.toFixed(4)}*${fitScale})`;
  const filters = [
    ...(crop ? [`crop=w=iw*${(crop[2] - crop[0]).toFixed(6)}:h=ih*${(crop[3] - crop[1]).toFixed(6)}:x=iw*${crop[0].toFixed(6)}:y=ih*${crop[1].toFixed(6)}:exact=1`] : []),
    `scale=w='max(2\\,2*trunc(iw*${k}/2))':h='max(2\\,2*trunc(ih*${k}/2))':flags=lanczos+accurate_rnd+full_chroma_int`,
    alpha ? "format=rgba" : "format=rgb24",
  ].join(",");
  const encoder = alpha ? ["-c:v", "png", "-pix_fmt", "rgba"] : ["-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p"];
  const request = sha256Text(JSON.stringify({ schema: SLOT_IMAGE_SCHEMA, source: source.toLowerCase(), bytes: info.size, mtimeMs: Math.round(info.mtimeMs),
    kind: input.value.source.kind, time: input.value.source.kind === "still" ? input.value.source.time : null, filters, encoder }));
  const directory = join(resolve(input.cacheRoot), STYLE_SLOT_IMAGE_DIRECTORY_V1);
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, `req-${request}.json`);
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DerivativeManifest;
    const path = join(directory, manifest.file);
    if (manifest.schema === SLOT_IMAGE_SCHEMA && manifest.request === request && (await stat(path)).size === manifest.bytes) {
      return { sha256: manifest.sha256, width: manifest.width, height: manifest.height, mime: manifest.mime, path, bytes: manifest.bytes, cacheHit: true };
    }
  } catch { /* not cached */ }
  const ext = alpha ? "png" : "jpg";
  const partial = join(directory, `${request}.${process.pid}-${randomBytes(6).toString("hex")}.partial.${ext}`);
  try {
    await runConversionProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      ...(input.value.source.kind === "still" ? ["-ss", input.value.source.time.toFixed(6)] : []), "-i", source, "-map", "0:v:0", "-frames:v", "1", "-an",
      "-vf", filters, ...encoder, "-f", "image2", partial], input.signal, timeoutMs)
      .catch(error => { if (input.signal?.aborted) throw error; throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_IMAGE_UNREADABLE", `${parse(source).base}: ${(error as Error).message.split("\n")[0]}`); });
    const bytes = await readFile(partial);
    if (!bytes.length) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_IMAGE_UNREADABLE", `${parse(source).base} produced no picture (a still past the end?)`);
    const dims = JSON.parse(await runConversionProcess(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", partial],
      input.signal, timeoutMs)) as { streams?: Array<{ width?: number; height?: number }> };
    const width = dims.streams?.[0]?.width, height = dims.streams?.[0]?.height;
    if (!width || !height) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_IMAGE_UNREADABLE", `${parse(source).base}: the derivative has no size`);
    const sha256 = sha256Bytes(bytes), file = `${sha256}.${ext}`;
    await publish(partial, join(directory, file));
    const manifest: DerivativeManifest = { schema: SLOT_IMAGE_SCHEMA, request, sha256, file, bytes: bytes.length, width, height, mime: alpha ? "image/png" : "image/jpeg" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { sha256, width, height, mime: manifest.mime, path: join(directory, file), bytes: bytes.length, cacheHit: false };
  } finally {
    await rm(partial, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Rights and the asset record
// ---------------------------------------------------------------------------

const isPrivate = (asset: MediaAsset) => asset.id.startsWith("private-visual:") || asset.license === "PRIVATE-OWNER-ONLY"
  || asset.distributionScope === "private-owner-only" || asset.rightsBasis === "private-owner-only";

/** A rendered clip is never freer than the pictures inside it (the existing media rules: private stays private). */
export function styleTemplateClipRightsV1(sources: readonly MediaAsset[]): Pick<MediaAsset, "license" | "redistributable" | "distributionScope" | "rightsBasis"> {
  if (!sources.length) return { license: "Editkin original", redistributable: true };
  if (sources.some(isPrivate)) return { license: "PRIVATE-OWNER-ONLY", redistributable: false, distributionScope: "private-owner-only", rightsBasis: "private-owner-only" };
  if (sources.some(asset => asset.redistributable === false)) return { license: "Editkin original template + project media (not redistributable)", redistributable: false };
  if (sources.every(asset => asset.redistributable === true)) return { license: "Editkin original template + redistributable project media", redistributable: true };
  return { license: "Editkin original template + project media (rights not recorded)" };
}

export function styleTemplateClipAssetV1(field: StyleJobClipV1, path: string, frame: { width: number; height: number; fps: number }, name: string,
  sources: readonly MediaAsset[]): MediaAsset {
  const rate = motionLibraryFrameRateV1(frame.fps);
  const pictures = Object.entries(field.slots.image).map(([slot, value]) => `${slot} ← ${value.source.assetId}${value.source.kind === "still" ? `@${value.source.time}s` : ""}`);
  return {
    id: `styletpl-${field.template.id}-${field.key.slice(0, 16)}`,
    name: `${name}（模板）`,
    kind: "video", uri: path,
    duration: (field.job.frameCount * rate.denominator) / rate.numerator,
    width: frame.width, height: frame.height,
    alphaMode: field.output === "alpha" ? "straight" : "opaque",
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
    provenance: `Editkin style template ${field.template.id} r${field.template.revision} (${field.component.id}/${field.component.renderer} r${field.component.revision}) key ${field.key}`
      + (pictures.length ? `; pictures: ${pictures.join(", ")}` : ""),
    ...styleTemplateClipRightsV1(sources),
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface ClipManifest {
  schema: typeof STYLE_TEMPLATE_CLIP_CACHE_SCHEMA_V1; engineVersion: string; encodeProfile: string; key: string; templateId: string; component: string;
  output: string; file: string; bytes: number; frameCount: number; fps: string; width: number; height: number; field: StyleJobClipV1;
}

const PHASE: Record<StyleTemplateRenderProgressV1["phase"], readonly [number, number]> = {
  images: [0, 0.08], cache: [0.08, 0.1], generate: [0.1, 0.55], encode: [0.55, 0.95], verify: [0.95, 0.99], done: [1, 1],
};

export async function renderStyleTemplateClipV1(input: StyleTemplateClipRenderInputV1): Promise<StyleTemplateClipRenderResultV1> {
  const started = performance.now();
  const signal = input.signal;
  signal?.throwIfAborted();
  if (!isAbsolute(input.cacheRoot)) throw new Error("style template cacheRoot must be absolute");
  const progress = (phase: StyleTemplateRenderProgressV1["phase"], completed: number, total: number) => {
    const [from, to] = PHASE[phase];
    try { input.onProgress?.(Object.freeze({ phase, completed, total, fraction: from + (to - from) * (total > 0 ? Math.min(1, completed / total) : 1) })); } catch { /* observers cannot break a render */ }
  };
  const frame = { width: input.project.width, height: input.project.height, fps: input.project.fps };
  if (frame.width % 2 || frame.height % 2) throw new Error("style template clips need even width and height");
  const { template, component } = resolveSlotTemplateForClipV1(input.templateId, frame);
  const slots = validateStyleSlotValuesV1(template, input.slots);
  assertStyleJobSlotAssetsV1(input.project.assets, slots);

  // 1. Pictures.
  const imagesStarted = performance.now();
  const images: Record<string, StyleSlotImageDerivativeV1> = {};
  const sourceAssets: MediaAsset[] = [];
  const entries = Object.entries(slots.image);
  progress("images", 0, entries.length);
  for (const [index, [slotId, value]] of entries.entries()) {
    signal?.throwIfAborted();
    const asset = input.project.assets.find(candidate => candidate.id === value.source.assetId)!;
    if (!sourceAssets.includes(asset)) sourceAssets.push(asset);
    const declaration = template.slots.image.find(slot => slot.id === slotId)!;
    const window = component.imageWindow(slotId, frame);
    if (!window) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_NOT_IMPLEMENTED", `${component.id} draws no picture for ${slotId}`);
    images[slotId] = await styleSlotImageDerivativeV1({ sourcePath: await (input.resolveAssetPath ?? (uri => uri))(asset.uri), value, fit: slotImageFraming(declaration, value).fit,
      window, maxPunch: component.maxImagePunch, cacheRoot: input.cacheRoot, ffmpegPath: input.ffmpegPath, ffprobePath: input.ffprobePath, signal, timeoutMs: input.timeoutMs });
    progress("images", index + 1, entries.length);
  }
  const imagesMs = performance.now() - imagesStarted;

  // 2. Compile; the key is the cache key.
  const compiled = compileStyleTemplateClipV1({ templateId: template.id, slots, frame, durationSeconds: input.durationSeconds,
    images: Object.fromEntries(Object.entries(images).map(([slotId, image]) => [slotId, { sha256: image.sha256, width: image.width, height: image.height, mime: image.mime }])) });
  const field = compiled.field;
  const directory = join(resolve(input.cacheRoot), STYLE_TEMPLATE_CLIP_CACHE_DIRECTORY_V1, template.id);
  const file = styleJobAssetFileNameV1(field.key), finalPath = join(directory, file), manifestPath = join(directory, `${field.key}.json`);
  const result = (cacheHit: boolean, generateMs: number, encodeMs: number): StyleTemplateClipRenderResultV1 => Object.freeze({
    field, asset: styleTemplateClipAssetV1(field, finalPath, frame, template.names.zh, sourceAssets), path: finalPath, cacheHit,
    frameCount: field.job.frameCount, durationSeconds: compiled.durationSeconds, images, sourceAssets,
    timings: { imagesMs, generateMs, encodeMs, totalMs: performance.now() - started },
  });
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ClipManifest;
    if (manifest.schema === STYLE_TEMPLATE_CLIP_CACHE_SCHEMA_V1 && manifest.key === field.key && manifest.engineVersion === STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1
      && manifest.encodeProfile === STYLE_TEMPLATE_CLIP_ENCODE_PROFILE_V1 && (await stat(finalPath)).size === manifest.bytes) {
      progress("cache", 1, 1); progress("done", 1, 1);
      return result(true, 0, 0);
    }
  } catch { /* not cached */ }
  if (!component.composite && (component.renderer !== "svg" || !component.svgFrame)) {
    throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_NOT_IMPLEMENTED", `${component.id} has no ${component.renderer} renderer here`);
  }
  const { ffmpeg, ffprobe } = await tools(input);
  const rate = motionLibraryFrameRateV1(frame.fps);

  /** Verify the partial file, publish it and write the manifest last (both paths). */
  const seal = async (partial: string, generateMs: number, encodeMs: number) => {
    const total = field.job.frameCount;
    progress("verify", 0, 1);
    const probe = JSON.parse(await runConversionProcess(ffprobe, ["-v", "error", "-count_packets", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,nb_read_packets", "-of", "json", partial], signal, 120_000)) as
      { streams?: Array<{ codec_name?: string; width?: number; height?: number; nb_read_packets?: string }> };
    const stream = probe.streams?.[0];
    if (!stream || stream.codec_name !== "prores" || stream.width !== frame.width || stream.height !== frame.height || Number(stream.nb_read_packets) !== total) {
      throw new Error(`style template clip ${template.id} failed verification (${JSON.stringify(stream ?? null)}, expected ${total} prores packets)`);
    }
    const bytes = (await stat(partial)).size;
    await publish(partial, finalPath);
    const manifest: ClipManifest = { schema: STYLE_TEMPLATE_CLIP_CACHE_SCHEMA_V1, engineVersion: STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1, encodeProfile: STYLE_TEMPLATE_CLIP_ENCODE_PROFILE_V1,
      key: field.key, templateId: template.id, component: component.id, output: field.output, file, bytes, frameCount: total, fps: rate.text,
      width: frame.width, height: frame.height, field };
    const manifestPartial = join(directory, `${field.key}.${process.pid}-${randomBytes(6).toString("hex")}.manifest.partial.json`);
    await writeFile(manifestPartial, `${JSON.stringify(manifest, null, 2)}\n`);
    await publish(manifestPartial, manifestPath);
    progress("verify", 1, 1); progress("done", 1, 1);
    return result(false, generateMs, encodeMs);
  };
  const tempRoot = resolve(input.tempRoot ?? join(input.cacheRoot, STYLE_TEMPLATE_WORK_DIRECTORY_V1));
  if (tempRoot.includes("%")) throw new Error("temp folder may not contain '%'");

  // Composited components (mesh3d passes, SVG art posed per frame): the template compositor streams frames into ProRes.
  if (component.composite) {
    const pictures: Record<string, string> = {};
    for (const [slotId, image] of Object.entries(images)) {
      pictures[slotId] = slotImageDataUri(image.mime, await readFile(image.path));
      if (sha256Bytes(Buffer.from(pictures[slotId].slice(pictures[slotId].indexOf(",") + 1), "base64")) !== image.sha256) throw new Error(`picture ${slotId} changed on disk`);
    }
    await mkdir(tempRoot, { recursive: true });
    await mkdir(directory, { recursive: true });
    const workDir = await mkdtemp(join(tempRoot, `editkin-styletpl-${template.id}-`));
    const partial = join(directory, `${field.key}.${process.pid}-${randomBytes(6).toString("hex")}.partial.mov`);
    try {
      const total = field.job.frameCount;
      progress("generate", 0, total);
      const timings = await encodeStyleCompositeClipV1({ hooks: component.composite, params: field.job.params, width: frame.width, height: frame.height,
        frameCount: total, rate, output: field.output, images: pictures, ffmpegPath: ffmpeg, workDir, threads: input.mesh3dThreads, signal,
        timeoutMs: input.timeoutMs ?? 1_800_000, outputPath: partial, onProgress: (phase, completed, count) => progress(phase, completed, count) });
      return await seal(partial, timings.generateMs, timings.encodeMs);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(partial, { force: true }).catch(() => undefined);
    }
  }
  if (!component.svgFrame) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_NOT_IMPLEMENTED", `${component.id} has no frame renderer`);
  const svgFrame = component.svgFrame;

  // 3. Underlay still (rendered once, cached by its own job key).
  const underlayParams = component.underlay?.(field.job.params);
  let underlayPath: string | undefined;
  if (underlayParams) {
    const job: StyleRenderJobV1 = { id: `${component.id}-underlay`, key: styleJobKey(underlayParams.component, underlayParams, 1, rate.numerator / rate.denominator),
      component: underlayParams.component, params: underlayParams, timelineStart: 0, startFrame: 0, frameCount: 1, fps: rate.numerator / rate.denominator,
      output: "still", blendMode: "normal", track: "backdrop", beatIndex: 0 };
    underlayPath = (await renderStyleJob(job, { cacheRoot: input.cacheRoot, tempRoot: input.tempRoot ?? join(input.cacheRoot, STYLE_TEMPLATE_WORK_DIRECTORY_V1),
      ffmpegPath: ffmpeg, ffprobePath: ffprobe, signal, timeoutMs: input.timeoutMs })).path;
  }

  // Static layers rendered once (the card shadow): stills placed inside every frame.
  const stills: Record<string, string> = {};
  for (const [name, still] of Object.entries(component.stills?.(field.job.params) ?? {})) {
    const job: StyleRenderJobV1 = { id: `${component.id}-${name}`, key: styleJobKey(still.component, still, 1, rate.numerator / rate.denominator), component: still.component,
      params: still, timelineStart: 0, startFrame: 0, frameCount: 1, fps: rate.numerator / rate.denominator, output: "still", blendMode: "normal", track: "cardUnder", beatIndex: 0 };
    const rendered = await renderStyleJob(job, { cacheRoot: input.cacheRoot, tempRoot: input.tempRoot ?? join(input.cacheRoot, STYLE_TEMPLATE_WORK_DIRECTORY_V1),
      ffmpegPath: ffmpeg, ffprobePath: ffprobe, signal, timeoutMs: input.timeoutMs });
    stills[name] = slotImageDataUri("image/png", await readFile(rendered.path));
  }

  // 4. Frames.
  const pictures: Record<string, string> = {};
  for (const [slotId, image] of Object.entries(images)) pictures[slotId] = slotImageDataUri(image.mime, await readFile(image.path));
  for (const [slotId, image] of Object.entries(images)) {
    if (sha256Bytes(Buffer.from(pictures[slotId].slice(pictures[slotId].indexOf(",") + 1), "base64")) !== image.sha256) throw new Error(`picture ${slotId} changed on disk`);
  }
  await mkdir(tempRoot, { recursive: true });
  await mkdir(directory, { recursive: true });
  const framesDir = await mkdtemp(join(tempRoot, `editkin-styletpl-${template.id}-`));
  const partial = join(directory, `${field.key}.${process.pid}-${randomBytes(6).toString("hex")}.partial.mov`);
  try {
    const generateStarted = performance.now();
    const total = field.job.frameCount;
    progress("generate", 0, total);
    for (let index = 0; index < total; index += 1) {
      signal?.throwIfAborted();
      const t = (index * rate.denominator) / rate.numerator;
      await writeFile(join(framesDir, `f${String(index).padStart(5, "0")}.svg`), svgFrame(field.job.params, t, { images: pictures, stills }));
      if (index % 8 === 7 || index === total - 1) progress("generate", index + 1, total);
    }
    const generateMs = performance.now() - generateStarted;
    const svgInput = ["-framerate", rate.text, "-start_number", "0", "-i", join(framesDir, "f%05d.svg")];
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"];
    if (underlayPath) {
      // The still under the frames: librsvg's premultiplied frames are declared, unpremultiplied and laid over it.
      args.push("-loop", "1", "-framerate", rate.text, "-i", underlayPath, ...svgInput, "-filter_complex",
        `[0:v]format=gbrap[bg];[1:v]setparams=alpha_mode=premultiplied,format=gbrap,unpremultiply=inplace=1[fg];[bg][fg]overlay=format=gbrp:shortest=1[m];`
        + (field.output === "alpha" ? straightToYuva444("[m]", "[v]", "u") : `[m]${TO_YUV422}[v]`));
    } else {
      args.push(...svgInput, "-filter_complex", field.output === "alpha" ? straightToYuva444("[0:v]", "[v]", "s") : `[0:v]${TO_YUV422}[v]`);
    }
    args.push("-map", "[v]", "-frames:v", String(total), "-an", ...(field.output === "alpha" ? PRORES_4444 : PRORES_422HQ), "-f", "mov", partial);
    const encodeStarted = performance.now();
    progress("encode", 0, total);
    await motionLibraryEncodePool().run(() => runConversionProcess(ffmpeg, args, signal, input.timeoutMs ?? 600_000, seconds => {
      progress("encode", Math.min(total, Math.round((seconds * rate.numerator) / rate.denominator)), total);
    }), signal);
    const encodeMs = performance.now() - encodeStarted;
    return await seal(partial, generateMs, encodeMs);
  } finally {
    await rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Commands and the pre-dispatch file check
// ---------------------------------------------------------------------------

// The add/update commands are browser-safe (the inspector builds them too).
export { styleTemplateAddClipCommandV1, styleTemplateUpdateClipCommandV1 } from "./clipCommands";

/**
 * Pre-dispatch file check: every template clip's asset exists as a regular file whose size matches the cache manifest
 * written beside it (`<key>.json`). The pure commands cannot see the disk; prepare and the render host run this.
 * Only files inside `<cacheRoot>/styletpl-clip/` are ever touched: a project is untrusted input, so UNC, relative and
 * out-of-cache asset paths are refused before any filesystem call (no SMB/NTLM probe of a crafted path).
 */
export async function assertStyleTemplateProjectFilesV1(project: EditProject, cacheRoot: string): Promise<number> {
  if (!isAbsolute(cacheRoot) || isUncPath(cacheRoot)) throw new Error("STYLE_JOB_CACHE_ROOT_INVALID: style template cacheRoot must be an absolute local path");
  const clipRoot = resolve(cacheRoot, "styletpl-clip");
  const ids = new Map<string, string>();
  for (const container of [project, ...project.compositions]) {
    for (const clip of container.tracks.flatMap(track => track.clips)) if (clip.styleJob) ids.set(clip.assetId, clip.styleJob.key);
  }
  for (const [assetId, key] of ids) {
    const asset = project.assets.find(candidate => candidate.id === assetId);
    if (!asset) throw new Error(`STYLE_JOB_ASSET_MISSING: ${assetId}`);
    const path = styleTemplateCachedClipPathV1(clipRoot, asset.uri, assetId);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size < 1) throw new Error(`STYLE_JOB_ASSET_MISSING: ${assetId} has no rendered file at ${path}`);
    let manifest: Partial<ClipManifest> | undefined;
    try { manifest = JSON.parse(await readFile(join(dirname(path), `${key}.json`), "utf8")); } catch { manifest = undefined; }
    if (!manifest || manifest.key !== key || manifest.file !== parse(path).base || manifest.bytes !== info.size) {
      throw new Error(`STYLE_JOB_ASSET_BINDING_MISMATCH: ${assetId} does not match its cache manifest`);
    }
  }
  return ids.size;
}

const isUncPath = (value: string) => value.startsWith("\\\\") || value.startsWith("//") || value.startsWith("\\/") || value.startsWith("/\\");

/** Lexical containment: the asset must be an absolute, non-UNC path strictly inside `<cacheRoot>/styletpl-clip/`. */
function styleTemplateCachedClipPathV1(clipRoot: string, uri: string, assetId: string): string {
  if (typeof uri !== "string" || !uri || isUncPath(uri) || !isAbsolute(uri)) throw new Error(`STYLE_JOB_ASSET_OUTSIDE_CACHE: ${assetId}`);
  const path = resolve(uri), rel = relative(clipRoot, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`STYLE_JOB_ASSET_OUTSIDE_CACHE: ${assetId}`);
  return path;
}
