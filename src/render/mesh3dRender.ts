import { trackAudioAudible } from "../domain/trackState";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EditProject } from "../domain/types";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { Mesh3dGeometryCache, mesh3dObjectDrawCountV1, mesh3dSceneTextFaceIdsV1, parseMesh3dFont } from "../motion/mesh3dGeometry";
import { mesh3dSceneExtendedV1 } from "../motion/mesh3dShading";
import { mesh3dPerPixelObjectsV1, mesh3dShadingExecutorV1 } from "./mesh3dShadingExecutorV1";
import { mesh3dGeometryPeakV1, type Mesh3dObject, type Mesh3dScene } from "../motion/mesh3dScene";
import { mesh3dTubeSetCountV1 } from "../motion/mesh3dTubeSet";
import { MESH3D_MAX_OBJECTS, MESH3D_MAX_SCENE_TRIANGLES, MESH3D_MAX_TEXTURES, type Mesh3dFrame, type Mesh3dTexture } from "../motion/mesh3dRasterizer";
import { renderMesh3dProjectFrameV1 } from "../motion/mesh3dProjectFrameV1";
import { Mesh3dWorkerPoolV1, mesh3dDefaultThreadsV1 } from "../motion/mesh3dParallel";
import { mesh3dOverlayClipIdsV1 } from "../motion/mesh3dOverlayV1";
import { mesh3dRasterSizeV1 } from "./mesh3dRasterSizeV1";
import { validateMesh3dProject } from "../domain/mesh3dValidation";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { mediaUtilityInputOptions } from "../application/mediaUtilityInputPolicy";
import { probeMedia, resolveMediaPath } from "./mediaProcess";
import { assertProofStillRouteV1 } from "./proofStillRouteV1";
import type { RenderOptions } from "./ffmpegTypes";
import { readMesh3dFaceV1, readMesh3dFont } from "./mesh3dFontSource";
import { assertRenderActive } from "./renderLifetime";
import { renderProgressTimeReporter, reportRenderStage } from "./renderProgress";

import type { Mesh3dRenderReceipt } from "./mesh3dReceipt";
export type { Mesh3dRenderReceipt } from "./mesh3dReceipt";
export async function meshSourceSha256(path: string): Promise<string> {
  const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest("hex");
}
function ownedPipe(ffmpeg: string, args: string[], timeout: number) {
  const child = spawn(ffmpeg,args,{ windowsHide:true, stdio:["pipe","pipe","pipe"] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr = `${stderr}${bytes}`.slice(-5000); });
  const timer = setTimeout(() => child.kill(), timeout);
  // Attach handlers immediately: an early decoder/encoder failure must not be unhandled.
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`3D FFmpeg exit ${code}: ${stderr}`)); });
  }); completion.catch(() => undefined);
  child.stdin.on("error", () => undefined);
  return { child, completion };
}
async function* rawFrames(child: ChildProcessWithoutNullStreams, bytes: number): AsyncGenerator<Uint8Array> {
  let chunks: Buffer[] = [], length = 0;
  for await (const input of child.stdout) {
    chunks.push(input as Buffer); length += input.length;
    while (length >= bytes) {
      const frame = Buffer.allocUnsafe(bytes); let copied = 0;
      while (copied < bytes) {
        const head = chunks[0], count = Math.min(bytes-copied,head.length); head.copy(frame,copied,0,count); copied += count;
        if (count === head.length) chunks.shift(); else chunks[0] = head.subarray(count);
      }
      // A plain Uint8Array view (no copy): the worker pool shares textures by typed-array constructor, and Buffer is not one.
      length -= bytes; yield new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    }
  }
  if (length) throw new Error("3D 解碼留下不完整的 RGBA 影格");
}
/** A failed encoder may close without a drain event; detach every listener on either terminal outcome. */
function waitForEncoderDrain(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = child.stdin;
    const clean = () => { stream.off("drain", drained); stream.off("close", closed); stream.off("error", failed); };
    const drained = () => { clean(); resolve(); };
    const closed = () => failed(new Error("3D 編碼器在寫入影格前已關閉"));
    const failed = (error: Error) => { clean(); reject(error); };
    stream.once("drain", drained); stream.once("close", closed); stream.once("error", failed);
    if (stream.destroyed) closed(); else if (!stream.writableNeedDrain) drained();
  });
}

/** Longest side of a decoded material texture (video/image on a mesh). Overlay sprites keep their own 1920 cap. */
export const MESH3D_MATERIAL_TEXTURE_MAX_PIXELS = 2048;
/** Floor and ceiling of the default mesh render budget, and its time per 1080p frame on a worker pool / the calling thread. */
const MESH3D_TIMEOUT_FLOOR_MS = 120_000, MESH3D_TIMEOUT_CEILING_MS = 6 * 60 * 60_000, MESH3D_TIMEOUT_POOL_FRAME_MS = 2_000, MESH3D_TIMEOUT_SERIAL_FRAME_MS = 4_000;
/**
 * Default budget when the caller gives none: proportional to the frames rendered, never below 2 minutes, never above
 * 6 hours. A 2 s S7-like export at 1080x1920 (60 frames: extruded and band text, tori, shadows, AO, DOF, bloom,
 * fisheye) measured 0.50 s a frame on 12 workers, 1.19 s on 3 and 3.14 s on the calling thread (without shadows and
 * AO: 0.36 / 0.73 / 1.74 s), so a pool job (2+ workers) allows 2 s a 1080p frame and a calling-thread job keeps 4 s.
 * A render inside an export receives the export's remaining lifetime instead.
 */
export function mesh3dRenderTimeoutMsV1(frameCount: number, width: number, height: number, workers = mesh3dDefaultThreadsV1()): number {
  const frames = Number.isFinite(frameCount) && frameCount > 0 ? frameCount : 0;
  const scale = Number.isFinite(width * height) && width * height > 0 ? Math.max(.25, width * height / (1920 * 1080)) : 1;
  const perFrame = workers >= 2 ? MESH3D_TIMEOUT_POOL_FRAME_MS : MESH3D_TIMEOUT_SERIAL_FRAME_MS;
  return Math.min(MESH3D_TIMEOUT_CEILING_MS, Math.max(MESH3D_TIMEOUT_FLOOR_MS, Math.ceil(MESH3D_TIMEOUT_FLOOR_MS + frames * perFrame * scale)));
}
/**
 * Receipt fields that describe which shading executor ran: unchanged strings for scenes without extension or polish fields.
 * Polish: a scene with light.shadow gets the soft-shadowmap contract, `post` lists AO in application order, and
 * `lightingFeatures` names GGX roughness and an area / sphere key light when the scene uses them.
 */
export function mesh3dShadingReceiptV1(scene: Mesh3dScene): Pick<Mesh3dRenderReceipt, "executor" | "lightingContract" | "post" | "lightingFeatures"> {
  const extendedScene = mesh3dSceneExtendedV1(scene), objects = scene.segments.flatMap(segment => segment.objects);
  const perPixelObjects = mesh3dPerPixelObjectsV1(scene);
  const post = scene.post ? (["motionBlur", "ao", "dof", "bloom", "fisheye", "vignette"] as const).filter(key => scene.post![key] !== undefined) : undefined;
  const lightingFeatures: NonNullable<Mesh3dRenderReceipt["lightingFeatures"]> = [
    ...(objects.some(object => object.material.roughness !== undefined) ? ["ggx-roughness" as const] : []),
    ...((scene.light.size ?? 0) > 0 ? ["area-key" as const] : []),
    ...(scene.light.distance !== undefined ? ["sphere-key" as const] : [])];
  return {
    executor: mesh3dShadingExecutorV1(scene),
    lightingContract: extendedScene ? (scene.light.shadow ? "per-pixel-key-fill-hemisphere-specular/soft-shadowmap/v1" : "per-pixel-key-fill-hemisphere-specular/no-shadowmap/v1")
      : perPixelObjects ? "vertex-plus-per-pixel-materials/no-shadowmap/v1" : "vertex-directional-plus-ambient/no-shadowmap/v1",
    ...(post ? { post: [...post] } : {}),
    ...(lightingFeatures.length ? { lightingFeatures } : {}),
  };
}

/** Triangles an object draws at most in a frame: tube_set counted exactly at its largest growth, before any mesh is built. */
function peakTriangles(object: Mesh3dObject, cache: Mesh3dGeometryCache): number {
  const geometry = mesh3dGeometryPeakV1(object.geometry);
  return geometry.kind === "tube_set" ? mesh3dTubeSetCountV1(geometry).triangles : cache.get(geometry).indices.length / 3;
}
/** Receipt field naming tube_set geometry (2026-10-29): objects, polylines, and the most triangles the tube sets of one segment draw in a frame; nothing without them. */
export function mesh3dGeometryReceiptV1(scene: Mesh3dScene): Pick<Mesh3dRenderReceipt, "tubeSets"> {
  const tubes = scene.segments.map(segment => segment.objects.flatMap(object => object.geometry.kind === "tube_set" ? [object.geometry] : []));
  if (!tubes.some(list => list.length)) return {};
  return { tubeSets: { objects: tubes.reduce((n, list) => n + list.length, 0), polylines: tubes.flat().reduce((n, tube) => n + tube.polylines.length, 0),
    tips: tubes.flat().reduce((n, tube) => n + (tube.tips?.length ?? 0), 0),
    maxTriangles: Math.max(...tubes.map(list => list.reduce((n, tube) => n + mesh3dTubeSetCountV1(mesh3dGeometryPeakV1(tube) as typeof tube).triangles, 0))) } };
}

/** CPU execution of one renderMesh3dVideo job. The output bytes do not depend on it. */
export interface Mesh3dRenderEngineOptionsV1 {
  /** Worker threads of the job pool (default mesh3dDefaultThreadsV1()); below 2 the job renders on the calling thread. */
  threads?: number;
  /** Diagnostics and tests: each frame in order, just before it is written to the encoder (read only; do not keep it). */
  onFrame?: (frameIndex: number, rgba: Uint8ClampedArray) => void;
}

/** Source pixels stream through owned pipes; no disk raw-frame tree or remote source I/O. */
export async function renderMesh3dVideo(project: EditProject, output: string, options: RenderOptions, engine: Mesh3dRenderEngineOptionsV1 = {}): Promise<Mesh3dRenderReceipt> {
  assertProofStillRouteV1(project, "mesh3d");
  if (!project.scene3d?.enabled) throw new Error("MESH_ENABLED_SCENE_REQUIRED");
  validateMesh3dProject(project);
  const scene = project.scene3d!;
  if (options.deliveryProfile && options.deliveryProfile !== "standard_mp4") throw new Error("網格 3D 尚未驗證透明／HDR交付");
  const totalDuration = scene.segments.at(-1)!.timelineStart + scene.segments.at(-1)!.duration;
  const count = Math.round(totalDuration*project.fps), sources: Mesh3dRenderReceipt["sources"] = [];
  const workers = engine.threads ?? mesh3dDefaultThreadsV1();
  const ffmpeg = options.ffmpegPath ?? "ffmpeg", timeout = options.timeoutMs ?? mesh3dRenderTimeoutMsV1(count, project.width, project.height, workers);
  const fonts = new Map(), geometryFonts: Mesh3dRenderReceipt["geometryFonts"] = [];
  const weights = new Set(scene.segments.flatMap(s => s.objects.flatMap(o => o.geometry.kind === "text" ? [o.geometry.fontWeight] : [])));
  for (const weight of weights) {
    if (!options.fontRoot) throw new Error("3D 實體字需指定已安裝的開放字型目錄");
    const file = resolveBundledFontFace("Noto Sans TC",weight)?.fontFile;
    if (!file) throw new Error("3D 實體字缺少已封裝的實際字型檔");
    const bytes = await readMesh3dFont(options.fontRoot,weight);
    geometryFonts.push({ weight, file, sha256:createHash("sha256").update(bytes).digest("hex") });
    fonts.set(weight,parseMesh3dFont(new Uint8Array(bytes).buffer));
  }
  // text_extrude / band_text: bundled faces by compiled catalog ID, SHA-verified before any geometry is built.
  const faces = new Map<string, ReturnType<typeof parseMesh3dFont>>(), textFaces: NonNullable<Mesh3dRenderReceipt["textFaces"]> = [];
  for (const faceId of mesh3dSceneTextFaceIdsV1(scene)) {
    if (!options.fontRoot) throw new Error("3D 擠出文字／文字帶需指定已安裝的開放字型目錄");
    const face = await readMesh3dFaceV1(options.fontRoot, faceId);
    textFaces.push({ faceId: face.faceId, file: face.file, sha256: face.sha256 });
    faces.set(faceId, parseMesh3dFont(new Uint8Array(face.bytes).buffer));
  }
  const cache = new Mesh3dGeometryCache(fonts, faces);
  // The engine per-frame budgets, for every segment before any decoder or encoder starts (the frame planner would refuse the
  // same frame mid-export): objects, decoded textures (material and overlay clips) and triangles of the built geometry.
  for (const segment of scene.segments) {
    const textureCount = new Set([...segment.objects.flatMap(o => o.material.clipId ? [o.material.clipId] : []), ...mesh3dOverlayClipIdsV1(scene.overlaysV1, segment.id)]).size;
    const triangles = segment.objects.reduce((sum, o) => sum + peakTriangles(o, cache), 0);
    // Draws: one per object, plus one per tip colour role of a tube_set.
    const draws = mesh3dObjectDrawCountV1(segment.objects);
    if (draws > MESH3D_MAX_OBJECTS || textureCount > MESH3D_MAX_TEXTURES || triangles > MESH3D_MAX_SCENE_TRIANGLES)
      throw new Error(`3D 場景「${segment.name}」超出單格預算：物件 ${draws}/${MESH3D_MAX_OBJECTS}、材質 ${textureCount}/${MESH3D_MAX_TEXTURES}、三角形 ${triangles}/${MESH3D_MAX_SCENE_TRIANGLES}`);
  }
  await mkdir(dirname(output),{recursive:true});
  // Progress: the stage's output length is the scene; each encoded frame advances it (no invented percentage).
  reportRenderStage("scene3d", totalDuration);
  const progress = renderProgressTimeReporter();
  // A 1.5x raster is reduced with Lanczos to keep glyph/mesh edges clean at delivery size.
  const { width, height } = mesh3dRasterSizeV1(project.width, project.height);
  const encoder = ownedPipe(ffmpeg,["-y","-hide_banner","-loglevel","error","-f","rawvideo","-pix_fmt","rgba","-s",`${width}x${height}`,"-r",String(project.fps),"-i","pipe:0","-an","-vf",`scale=${project.width}:${project.height}:flags=lanczos,format=yuv420p`,"-c:v","libx264","-preset","veryfast","-crf","16","-frames:v",String(count),"-color_primaries","bt709","-color_trc","bt709","-colorspace","bt709","-movflags","+faststart",output],timeout);
  encoder.child.stdout.resume();
  const started = performance.now(); let peak = process.memoryUsage().rss, maxTriangles = 0, maxFrameMilliseconds = 0, rendered = 0;
  // One worker pool per job: the shared kernel on row bands, byte-identical to the calling thread at any thread count.
  // If the pool cannot start or a worker fails, the job continues on the calling thread with the same kernel and bytes;
  // a frame error (e.g. an undecoded texture) recurs there with its own message.
  let pool: Mesh3dWorkerPoolV1 | undefined, poolFrames = 0, fallback: string | undefined;
  const stopPool = async (reason: unknown) => {
    fallback ??= reason instanceof Error ? reason.message : String(reason);
    const stopped = pool; pool = undefined; await stopped?.close().catch(() => undefined);
  };
  const renderFrame = async (clock: { timelineFrame: number; fps: number }, textures: Map<string, Mesh3dTexture>, legacySeconds: number): Promise<Mesh3dFrame> => {
    if (pool) {
      try { const frame = await pool.renderProjectFrame(scene, clock, width, height, cache, textures, legacySeconds); poolFrames++; return frame; }
      catch (error) { await stopPool(error); }
    }
    return renderMesh3dProjectFrameV1(scene, clock, width, height, cache, textures, legacySeconds);
  };
  try {
    if (workers >= 2) { try { pool = new Mesh3dWorkerPoolV1({ threads: workers }); } catch (error) { await stopPool(error); } }
    for (const segment of scene.segments) {
      const overlayIds = mesh3dOverlayClipIdsV1(scene.overlaysV1, segment.id);
      const bindings = [...new Set([...segment.objects.flatMap(o => o.material.clipId ? [o.material.clipId] : []), ...overlayIds])];
      const decoders: ReturnType<typeof ownedPipe>[] = [], records: { id: string; width: number; height: number; frames: AsyncGenerator<Uint8Array>; staticFrame?: Uint8Array }[] = [];
      const fingerprints: { path: string; bytes: number; mtimeMs: number; sha256: string }[] = [];
      try {
        for (const id of bindings) {
          const clip = project.tracks.flatMap(t => t.clips).find(c => c.id === id)!, asset = project.assets.find(a => a.id === clip.assetId)!, path = resolveMediaPath(asset.uri,options.assetBase);
          // Project media is an untrusted local file: self-contained formats over file:// only (no HLS/concat/image2 side files).
          const inputOptions = mediaUtilityInputOptions(path);
          const before = await stat(path), sourceSha256 = await meshSourceSha256(path), probe = await probeMedia(path,options.ffprobePath,inputOptions);
          if (!probe.hasVideo || !probe.width || !probe.height || ["smpte2084","arib-std-b67"].includes(probe.colorTransfer ?? "")) throw new Error("3D 材質來源非已驗證的 SDR 圖像");
          const maximum = overlayIds.includes(id) ? 1920 : MESH3D_MATERIAL_TEXTURE_MAX_PIXELS;
          const scale = Math.min(1,maximum/Math.max(probe.width,probe.height)), tw = Math.max(2,Math.round(probe.width*scale)), th = Math.max(2,Math.round(probe.height*scale));
          const sourceStart = clip.sourceStart+segment.timelineStart-clip.timelineStart;
          sources.push({clipId:id,sourceSha256,sourceStart,duration:segment.duration,decodedWidth:tw,decodedHeight:th});
          fingerprints.push({path,bytes:before.size,mtimeMs:before.mtimeMs,sha256:sourceSha256});
          const filter = `${asset.kind === "image" ? "" : `fps=${project.fps},`}scale=${tw}:${th}:flags=lanczos,format=rgba`;
          const args = ["-hide_banner","-loglevel","error","-ss",String(asset.kind === "image" ? 0 : sourceStart),...inputOptions,"-i",path,"-an","-vf",filter,"-frames:v",String(asset.kind === "image" ? 1 : Math.round(segment.duration*project.fps)),"-f","rawvideo","pipe:1"];
          const decoder = ownedPipe(ffmpeg,args,timeout); decoder.child.stdin.end(); decoders.push(decoder);
          // Listen from the start: Node discards an unread child stdout once the child exits, so a small texture that decodes
          // and exits before its first frame is read would arrive empty. Paused until rawFrames reads (backpressure unchanged).
          decoder.child.stdout.on("readable", () => undefined);
          records.push({id,width:tw,height:th,frames:rawFrames(decoder.child,tw*th*4)});
        }
        for (let localFrame = 0; localFrame < Math.round(segment.duration*project.fps); localFrame++) {
          assertRenderActive();
          const textures = new Map<string,Mesh3dTexture>();
          for (const record of records) {
            if (!record.staticFrame) {
              const next = await record.frames.next();
              if (next.done) throw new Error(`3D 材質提前結束：${record.id}／${localFrame}`);
              const asset = project.assets.find(a => a.id === project.tracks.flatMap(t => t.clips).find(c => c.id === record.id)!.assetId)!;
              if (asset.kind === "image") record.staticFrame = next.value;
              textures.set(record.id,{width:record.width,height:record.height,rgba:next.value});
            } else textures.set(record.id,{width:record.width,height:record.height,rgba:record.staticFrame});
          }
          const begin = performance.now(), frame = await renderFrame(
            { timelineFrame: Math.round(segment.timelineStart * project.fps) + localFrame, fps: project.fps },
            textures,segment.timelineStart+localFrame/project.fps);
          maxFrameMilliseconds = Math.max(maxFrameMilliseconds,performance.now()-begin); maxTriangles = Math.max(maxTriangles,frame.triangleCount); peak = Math.max(peak,process.memoryUsage().rss);
          engine.onFrame?.(rendered, frame.rgba);
          if (!encoder.child.stdin.write(frame.rgba)) await waitForEncoderDrain(encoder.child);
          rendered++;
          progress?.(rendered/project.fps);
          if (performance.now()-started > timeout) throw new Error(`網格 3D 渲染逾時（已完成 ${rendered}/${count} 格，上限 ${Math.round(timeout/1000)} 秒）`);
        }
        for (const record of records) if (!record.staticFrame && !(await record.frames.next()).done) throw new Error("3D 解碼影格數超出範圍");
        await Promise.all(decoders.map(d => d.completion));
        for (const f of fingerprints) { const after = await stat(f.path); if (after.size!==f.bytes || after.mtimeMs!==f.mtimeMs || await meshSourceSha256(f.path)!==f.sha256) throw new Error("3D 材質於輸出時被修改"); }
      } finally {
        for (const decoder of decoders) {
          if (decoder.child.exitCode === null) decoder.child.kill();
          decoder.child.stdout.destroy(); decoder.child.stdin.destroy();
        }
        await Promise.allSettled(decoders.map(d => d.completion));
      }
    }
    encoder.child.stdin.end(); await encoder.completion;
    if (rendered !== count) throw new Error("3D 輸出影格數不一致");
    const shading = mesh3dShadingReceiptV1(scene);
    return {schema:"editkin.mesh-3d-render/v1",executor:shading.executor,frameCount:rendered,width:project.width,height:project.height,maxTriangles,durationSeconds:totalDuration,renderMilliseconds:performance.now()-started,peakResidentBytes:peak,maxFrameMilliseconds,geometryFonts,
      ...(textFaces.length ? { textFaces } : {}),sources,colorContract:"opaque-rec709-sdr/v1",lightingContract:shading.lightingContract,...(shading.post ? { post: shading.post } : {}),
      ...(shading.lightingFeatures ? { lightingFeatures: shading.lightingFeatures } : {}),parallel:{ workers: workers >= 2 ? workers : 0, poolFrames, ...(fallback ? { fallback } : {}) },
      ...mesh3dGeometryReceiptV1(scene),
      ...(scene.overlaysV1 ? { overlaysV1: { bindingsSha256: createHash("sha256").update(JSON.stringify(scene.overlaysV1)).digest("hex"), compositor: "shared-project-frame/v1" as const, depth: "float64" as const } } : {}) };
  } finally {
    const closing = pool; pool = undefined; await closing?.close().catch(() => undefined);
    if (encoder.child.exitCode === null) encoder.child.kill();
    encoder.child.stdin.destroy(); encoder.child.stdout.destroy();
    await Promise.allSettled([encoder.completion]);
  }
}

/** Rejoin ordinary captions, standalone Motion and the existing voice/music mixer. */
export function materializeMesh3dProject(project: EditProject, path: string, duration: number): EditProject {
  const output = structuredClone(project); delete output.scene3d;
  const id = "mesh-3d-rendered-scene", trackId = "mesh-3d-rendered-track";
  if (output.assets.some(a=>a.id===id) || output.tracks.some(t=>t.id===trackId)) throw new Error("3D 物化 ID 已存在，拒絕覆蓋");
  output.assets.push({id,name:"3D 場景像素",kind:"video",uri:path,duration,width:project.width,height:project.height,color:{interpretation:"rec709"}});
  const audio = project.tracks.filter(t=>t.kind==="audio"&&trackAudioAudible(project,t));
  const voice = project.tracks.filter(t=>t.kind==="video"&&trackAudioAudible(project,t)).flatMap(t=>t.clips.filter(c=>c.volume>0&&c.layer?.enabled!==false).map(c=>({id:`mesh-audio-${c.id}`,name:project.assets.find(a=>a.id===c.assetId)!.name,kind:"audio" as const,locked:false,muted:false,...(t.solo===undefined?{}:{solo:t.solo}),clips:[{...structuredClone(c),id:`mesh-audio-${c.id}`,trackId:`mesh-audio-${c.id}`,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],creative:undefined,layer:{...DEFAULT_CLIP_LAYER},masks:undefined,floatingFrame:undefined,expressions:{}}]})));
  output.tracks=[{id:trackId,name:"3D 場景",kind:"video",locked:false,muted:false,clips:[{id,assetId:id,trackId,timelineStart:0,sourceStart:0,duration,volume:0,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],layer:{...DEFAULT_CLIP_LAYER}}]},...audio,...voice];
  return output;
}
