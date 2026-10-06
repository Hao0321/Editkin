import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EditProject } from "../domain/types";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { Mesh3dGeometryCache, parseMesh3dFont } from "../motion/mesh3dGeometry";
import { renderMesh3dFrame, type Mesh3dTexture } from "../motion/mesh3dRasterizer";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { mediaUtilityInputOptions } from "../application/mediaUtilityInputPolicy";
import { probeMedia, resolveMediaPath } from "./mediaProcess";
import type { RenderOptions } from "./ffmpegTypes";
import { readMesh3dFont } from "./mesh3dFontSource";

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
    child.once("error", reject); child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`3D FFmpeg exit ${code}: ${stderr}`)); });
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
      length -= bytes; yield frame;
    }
  }
  if (length) throw new Error("3D 解碼留下不完整的 RGBA 影格");
}

/** Source pixels stream through owned pipes; no disk raw-frame tree or remote source I/O. */
export async function renderMesh3dVideo(project: EditProject, output: string, options: RenderOptions): Promise<Mesh3dRenderReceipt> {
  const scene = project.scene3d!;
  if (options.deliveryProfile && options.deliveryProfile !== "standard_mp4") throw new Error("網格 3D 尚未驗證透明／HDR交付");
  const ffmpeg = options.ffmpegPath ?? "ffmpeg", timeout = options.timeoutMs ?? 180000;
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
  const cache = new Mesh3dGeometryCache(fonts), totalDuration = scene.segments.at(-1)!.timelineStart + scene.segments.at(-1)!.duration;
  const count = Math.round(totalDuration*project.fps), sources: Mesh3dRenderReceipt["sources"] = [];
  await mkdir(dirname(output),{recursive:true});
  // A 1.5x raster is reduced with Lanczos to keep glyph/mesh edges clean at delivery size.
  const width = Math.ceil(project.width*1.5), height = Math.ceil(project.height*1.5);
  const encoder = ownedPipe(ffmpeg,["-y","-hide_banner","-loglevel","error","-f","rawvideo","-pix_fmt","rgba","-s",`${width}x${height}`,"-r",String(project.fps),"-i","pipe:0","-an","-vf",`scale=${project.width}:${project.height}:flags=lanczos,format=yuv420p`,"-c:v","libx264","-preset","veryfast","-crf","16","-frames:v",String(count),"-color_primaries","bt709","-color_trc","bt709","-colorspace","bt709","-movflags","+faststart",output],timeout);
  encoder.child.stdout.resume();
  const started = performance.now(); let peak = process.memoryUsage().rss, maxTriangles = 0, maxFrameMilliseconds = 0, rendered = 0;
  try {
    for (const segment of scene.segments) {
      const bindings = [...new Set(segment.objects.flatMap(o => o.material.clipId ? [o.material.clipId] : []))];
      const decoders: ReturnType<typeof ownedPipe>[] = [], records: { id: string; width: number; height: number; frames: AsyncGenerator<Uint8Array>; staticFrame?: Uint8Array }[] = [];
      const fingerprints: { path: string; bytes: number; mtimeMs: number; sha256: string }[] = [];
      try {
        for (const id of bindings) {
          const clip = project.tracks.flatMap(t => t.clips).find(c => c.id === id)!, asset = project.assets.find(a => a.id === clip.assetId)!, path = resolveMediaPath(asset.uri,options.assetBase);
          // Project media is an untrusted local file: self-contained formats over file:// only (no HLS/concat/image2 side files).
          const inputOptions = mediaUtilityInputOptions(path);
          const before = await stat(path), sourceSha256 = await meshSourceSha256(path), probe = await probeMedia(path,options.ffprobePath,inputOptions);
          if (!probe.hasVideo || !probe.width || !probe.height || ["smpte2084","arib-std-b67"].includes(probe.colorTransfer ?? "")) throw new Error("3D 材質來源非已驗證的 SDR 圖像");
          const scale = Math.min(1,640/Math.max(probe.width,probe.height)), tw = Math.max(2,Math.round(probe.width*scale)), th = Math.max(2,Math.round(probe.height*scale));
          const sourceStart = clip.sourceStart+segment.timelineStart-clip.timelineStart;
          sources.push({clipId:id,sourceSha256,sourceStart,duration:segment.duration,decodedWidth:tw,decodedHeight:th});
          fingerprints.push({path,bytes:before.size,mtimeMs:before.mtimeMs,sha256:sourceSha256});
          const args = ["-hide_banner","-loglevel","error","-ss",String(asset.kind === "image" ? 0 : sourceStart),...inputOptions,"-i",path,"-an","-vf",`fps=${project.fps},scale=${tw}:${th}:flags=lanczos,format=rgba`,"-frames:v",String(asset.kind === "image" ? 1 : Math.round(segment.duration*project.fps)),"-f","rawvideo","pipe:1"];
          const decoder = ownedPipe(ffmpeg,args,timeout); decoder.child.stdin.end(); decoders.push(decoder);
          records.push({id,width:tw,height:th,frames:rawFrames(decoder.child,tw*th*4)});
        }
        for (let localFrame = 0; localFrame < Math.round(segment.duration*project.fps); localFrame++) {
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
          const begin = performance.now(), frame = renderMesh3dFrame(scene,segment.timelineStart+localFrame/project.fps,width,height,cache,textures);
          maxFrameMilliseconds = Math.max(maxFrameMilliseconds,performance.now()-begin); maxTriangles = Math.max(maxTriangles,frame.triangleCount); peak = Math.max(peak,process.memoryUsage().rss);
          if (!encoder.child.stdin.write(frame.rgba)) await once(encoder.child.stdin,"drain");
          rendered++;
          if (performance.now()-started > timeout) throw new Error("網格 3D 渲染超時");
        }
        for (const record of records) if (!record.staticFrame && !(await record.frames.next()).done) throw new Error("3D 解碼影格數超出範圍");
        await Promise.all(decoders.map(d => d.completion));
        for (const f of fingerprints) { const after = await stat(f.path); if (after.size!==f.bytes || after.mtimeMs!==f.mtimeMs || await meshSourceSha256(f.path)!==f.sha256) throw new Error("3D 材質於輸出時被修改"); }
      } finally { for (const decoder of decoders) if (decoder.child.exitCode === null) decoder.child.kill(); }
    }
    encoder.child.stdin.end(); await encoder.completion;
    if (rendered !== count) throw new Error("3D 輸出影格數不一致");
    return {schema:"editkin.mesh-3d-render/v1",executor:"shared-cpu-triangle-zbuffer/v1",frameCount:rendered,width:project.width,height:project.height,maxTriangles,durationSeconds:totalDuration,renderMilliseconds:performance.now()-started,peakResidentBytes:peak,maxFrameMilliseconds,geometryFonts,sources,colorContract:"opaque-rec709-sdr/v1",lightingContract:"vertex-directional-plus-ambient/no-shadowmap/v1"};
  } finally { if (encoder.child.exitCode === null) encoder.child.kill(); }
}

/** Rejoin ordinary captions, standalone Motion and the existing voice/music mixer. */
export function materializeMesh3dProject(project: EditProject, path: string, duration: number): EditProject {
  const output = structuredClone(project); delete output.scene3d;
  const id = "mesh-3d-rendered-scene", trackId = "mesh-3d-rendered-track";
  if (output.assets.some(a=>a.id===id) || output.tracks.some(t=>t.id===trackId)) throw new Error("3D 物化 ID 已存在，拒絕覆蓋");
  output.assets.push({id,name:"3D 場景像素",kind:"video",uri:path,duration,width:project.width,height:project.height,color:{interpretation:"rec709"}});
  const audio = project.tracks.filter(t=>t.kind==="audio");
  const voice = project.tracks.filter(t=>t.kind==="video"&&!t.muted).flatMap(t=>t.clips.filter(c=>c.volume>0&&c.layer?.enabled!==false).map(c=>({id:`mesh-audio-${c.id}`,name:project.assets.find(a=>a.id===c.assetId)!.name,kind:"audio" as const,locked:false,muted:false,clips:[{...structuredClone(c),id:`mesh-audio-${c.id}`,trackId:`mesh-audio-${c.id}`,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],creative:undefined,layer:{...DEFAULT_CLIP_LAYER},masks:undefined,floatingFrame:undefined,expressions:{}}]})));
  output.tracks=[{id:trackId,name:"3D 場景",kind:"video",locked:false,muted:false,clips:[{id,assetId:id,trackId,timelineStart:0,sourceStart:0,duration,volume:0,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],layer:{...DEFAULT_CLIP_LAYER}}]},...audio,...voice];
  return output;
}
