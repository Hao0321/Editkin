import { randomUUID } from "node:crypto";
import { lstat, open, link, unlink, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { canonicalJson } from "../shared/canonicalJson";
import { runProcess, FFMPEG_PROGRESS_ARGS } from "./mediaProcess";
import { withRenderLifetime, renderLifetimeSignal, renderLifetimeAbort, assertRenderActive } from "./renderLifetime";
import { createRenderVolumeWatchV1 } from "./renderVolumeWatchV1";
import type { DiskSpaceProbe } from "./renderDiskSpace";
import { assertTimeRemapLocalPathV1, timeRemapFingerprintV1, timeRemapSha256V1, timeRemapToolIdentityV1 } from "./timeRemapCacheIdentityV1";
import { decodeRgbaOutputWitnessV1 } from "./rgbaOutputWitnessV1";
import { assertTimeRemapBrowserSourceV1, timeRemapBrowserSurfaceIdentityV1, TIME_REMAP_BROWSER_SURFACE_POLICY_V1,
  TIME_REMAP_BROWSER_SURFACE_SESSION_BYTES_V1, type TimeRemapBrowserSourceV1 } from "./timeRemapBrowserSurfaceContractV1";

export interface TimeRemapBrowserSurfaceRuntimeV1 {
  policy: typeof TIME_REMAP_BROWSER_SURFACE_POLICY_V1; ffmpegPath: string; ffprobePath: string;
  expectedFfmpegSha256: string; expectedFfprobeSha256: string; outputRoot: string; helperTemporaryRoot: string;
  maximumStoredBytes?: number; timeoutMs?: number; volumeProbe?: DiskSpaceProbe;
  /** Durable host journal registration. Every created partial/published path is reported. */
  onOwnedPath(path: string, kind: "file"): Promise<void>;
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function timingWitness(ffprobe: string, path: string, source: TimeRemapBrowserSourceV1, timeout: number) {
  const data = JSON.parse((await runProcess(ffprobe,["-v","error","-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp_time","-of","json",path],timeout,{completeStdoutMaxChars:262144})).stdout);
  if (!Array.isArray(data.frames) || data.frames.length!==source.frames) throw Error("CLOCK_BROWSER_SURFACE_FRAME_COUNT_CHANGED");
  let maximumTimestampError=0;
  for(let n=0;n<data.frames.length;n++) {
    const time=Number(data.frames[n].best_effort_timestamp_time),error=Math.abs(time-n*source.rate.denominator/source.rate.numerator);
    if(!Number.isFinite(time)||error>.000511)throw Error("CLOCK_BROWSER_SURFACE_FRAME_CLOCK_CHANGED");maximumTimestampError=Math.max(maximumTimestampError,error);
  }
  return {frames:data.frames.length,maximumTimestampError,containerTimestampToleranceSeconds:.000511};
}
/** A short display carrier, not an export transcode. At most two live files/64MiB per session,
 * one producer, same source/output/TEMP volume, no movie-sized pixel staging or implicit audio drop.
 * The host closes all media consumers before release; no auto eviction of a playing source. */
export async function createTimeRemapBrowserSurfaceSessionV1(requestedRuntime: TimeRemapBrowserSurfaceRuntimeV1) {
  const runtime = Object.freeze({ ...requestedRuntime });
  const quota = runtime.maximumStoredBytes ?? TIME_REMAP_BROWSER_SURFACE_SESSION_BYTES_V1;
  if (runtime.policy !== TIME_REMAP_BROWSER_SURFACE_POLICY_V1 || typeof runtime.onOwnedPath !== "function"
    || !Number.isSafeInteger(quota) || quota < 1024**2 || quota > TIME_REMAP_BROWSER_SURFACE_SESSION_BYTES_V1) throw Error("CLOCK_BROWSER_SURFACE_POLICY_OR_QUOTA_INVALID");
  const roots = [runtime.outputRoot, runtime.helperTemporaryRoot, process.env.TEMP, process.env.TMP];
  for (const p of roots) { if (!p) throw Error("CLOCK_BROWSER_SURFACE_TEMP_REQUIRED"); await assertTimeRemapLocalPathV1(p); if (!(await lstat(p)).isDirectory()) throw Error("CLOCK_BROWSER_SURFACE_DIRECTORY_REQUIRED"); }
  const root = resolve(runtime.outputRoot), rootIdentity = await lstat(root, { bigint: true }), tempIdentity = await lstat(runtime.helperTemporaryRoot, { bigint: true });
  if ((await realpath(root)).toLowerCase() !== root.toLowerCase() || roots.some(p => !p) || rootIdentity.dev !== tempIdentity.dev
    || (await lstat(process.env.TEMP!, { bigint: true })).dev !== rootIdentity.dev || (await lstat(process.env.TMP!, { bigint: true })).dev !== rootIdentity.dev) throw Error("CLOCK_BROWSER_SURFACE_SAME_VOLUME_REQUIRED");
  const tools = await Promise.all([timeRemapToolIdentityV1(runtime.ffmpegPath), timeRemapToolIdentityV1(runtime.ffprobePath)]);
  if (tools[0].sha256 !== runtime.expectedFfmpegSha256 || tools[1].sha256 !== runtime.expectedFfprobeSha256) throw Error("CLOCK_BROWSER_SURFACE_TOOL_CHANGED");
  let closed = false, busy = false;
  const live = new Map<string, { bytes: number; verify(): Promise<void>; dispose(): Promise<void> }>();
  async function stableRoot() {
    const s = await lstat(root, { bigint: true }); await assertTimeRemapLocalPathV1(root);
    if (s.dev !== rootIdentity.dev || s.ino !== rootIdentity.ino) throw Error("CLOCK_BROWSER_SURFACE_ROOT_CHANGED");
  }
  async function stableRootAndTools() {
    await stableRoot();
    if(process.env.TEMP!==roots[2]||process.env.TMP!==roots[3])throw Error("CLOCK_BROWSER_SURFACE_TEMP_CHANGED");
    for (let i=0;i<tools.length;i++) if ((await timeRemapToolIdentityV1(tools[i].path)).sha256 !== tools[i].sha256) throw Error("CLOCK_BROWSER_SURFACE_TOOL_CHANGED");
    for (const p of roots) { await assertTimeRemapLocalPathV1(p!); if ((await lstat(p!, { bigint: true })).dev !== rootIdentity.dev) throw Error("CLOCK_BROWSER_SURFACE_TEMP_CHANGED"); }
  }
  return {
    async prepare(source: TimeRemapBrowserSourceV1, options: { signal?: AbortSignal } = {}) {
      assertTimeRemapBrowserSourceV1(source);
      if (closed || busy) throw Error("CLOCK_BROWSER_SURFACE_SESSION_NOT_IDLE");
      if (live.size >= 2) throw Error("CLOCK_BROWSER_SURFACE_CONSUMERS_MUST_RELEASE");
      busy = true;
      try { return await withRenderLifetime({ signal: options.signal, timeoutMs: runtime.timeoutMs ?? 30_000, workSeconds: source.frames*source.rate.denominator/source.rate.numerator }, async () => {
        await stableRootAndTools(); for(const active of live.values())await active.verify(); await assertTimeRemapLocalPathV1(source.sourcePath);
        const identity = await timeRemapFingerprintV1(source.sourcePath);
        if (identity.dev !== String(rootIdentity.dev) || extname(source.sourcePath).toLowerCase() !== ".mkv") throw Error("CLOCK_BROWSER_SURFACE_CANONICAL_FFV1_VOLUME_REQUIRED");
        const key = timeRemapBrowserSurfaceIdentityV1(source, tools[0].sha256), id = randomUUID(), output = join(root, `clock-${key.slice(0,16)}-${id}.webm`), partial = join(root, `.${basename(output)}.part.webm`);
        const cap = quota - [...live.values()].reduce((n, x) => n + x.bytes, 0);
        if (cap < 1024**2) throw Error("CLOCK_BROWSER_SURFACE_QUOTA_FULL");
        let file: FileHandle | undefined, fileIdentity: { dev: bigint; ino: bigint } | undefined, published = false, returned = false;
        let monitor: ReturnType<typeof createRenderVolumeWatchV1> | undefined;
        const sourceHandle = await open(source.sourcePath, "r");
        const stableSource = async () => { if (canonicalJson(await timeRemapFingerprintV1(source.sourcePath)) !== canonicalJson(identity)
          || (await sourceHandle.stat({bigint:true})).ino !== BigInt(identity.ino)) throw Error("CLOCK_BROWSER_SURFACE_SOURCE_CHANGED"); };
        const removeOwned = async (path: string) => {
          const s = await lstat(path, {bigint:true}).catch(e=>{if(missing(e))return undefined;throw e;}); if (!s) return;
          await stableRoot(); if (s.isSymbolicLink() || s.dev !== fileIdentity?.dev || s.ino !== fileIdentity?.ino) throw Error("CLOCK_BROWSER_SURFACE_OUTPUT_OWNER_CHANGED"); await unlink(path);
        };
        try {
          await stableSource(); if (await timeRemapSha256V1(source.sourcePath, renderLifetimeSignal()) !== source.sourceSha256) throw Error("CLOCK_BROWSER_SURFACE_SOURCE_SHA_CHANGED");
          await stableRootAndTools(); const probe = JSON.parse((await runProcess(runtime.ffprobePath,["-v","error","-show_streams","-show_format","-of","json",source.sourcePath],30_000,{completeStdoutMaxChars:65536})).stdout);
          const streams = probe.streams as Record<string,any>[], video = streams?.filter(s=>s.codec_type==="video");
          if (!video || video.length!==1 || streams.some(s=>s.codec_type!=="video") || video[0].codec_name!=="ffv1" || !["bgra","bgr0","rgba","gbrp"].includes(video[0].pix_fmt)
            || video[0].width!==source.width || video[0].height!==source.height || video[0].side_data_list?.length
            || (video[0].sample_aspect_ratio!==undefined && !["1:1","1/1","N/A"].includes(video[0].sample_aspect_ratio)) || Number(video[0].start_time??0)!==0
            || !Number.isFinite(Number(probe.format.duration)) || Math.abs(Number(probe.format.duration)-source.frames*source.rate.denominator/source.rate.numerator)>.002)
            throw Error("CLOCK_BROWSER_SURFACE_OPAQUE_SHORT_FFV1_SOURCE_REQUIRED");
          const color = {primaries:video[0].color_primaries??"unspecified",transfer:video[0].color_transfer??"unspecified"};
          for (const value of Object.values(color)) if (!["bt709","unknown","unspecified"].includes(value)) throw Error("CLOCK_BROWSER_SURFACE_SDR_ONLY");
          if (video[0].color_range!==undefined && !["pc","unknown","unspecified"].includes(video[0].color_range)) throw Error("CLOCK_BROWSER_SURFACE_RGB_RANGE_UNRESOLVED");
          const witness = {executable:runtime.ffmpegPath,width:source.width,height:source.height,expectedFrames:source.frames,timeoutMs:runtime.timeoutMs??30_000};
          await stableRootAndTools(); const original = await decodeRgbaOutputWitnessV1({...witness,source:source.sourcePath});
          if (original.sha256!==source.pixelSha256) throw Error("CLOCK_BROWSER_SURFACE_SOURCE_PIXELS_CHANGED");
          await stableRootAndTools(); const originalTiming=await timingWitness(runtime.ffprobePath,source.sourcePath,source,runtime.timeoutMs??30_000);
          file = await open(partial,"wx+"); const si=await file.stat({bigint:true}); fileIdentity={dev:si.dev,ino:si.ino}; await runtime.onOwnedPath(partial,"file");
          monitor=createRenderVolumeWatchV1({workRoot:root,stagingLimitBytes:cap,requirements:[{path:root,reserveBytes:1024**3,initialBytes:cap},{path:process.env.SystemRoot??root,reserveBytes:2*1024**3,initialBytes:0}],
            sampleWork:async()=>Number((await file!.stat()).size),probe:runtime.volumeProbe,onFailure:renderLifetimeAbort()!}); await monitor.check();monitor.start();
          await stableRootAndTools(); await runProcess(runtime.ffmpegPath,["-hide_banner","-v","error","-nostdin","-y","-noautorotate","-i",source.sourcePath,"-map","0:v:0","-an","-sn","-dn","-threads","1",
            "-c:v","libvpx-vp9","-lossless","1","-deadline","realtime","-cpu-used","8","-row-mt","0","-pix_fmt","gbrp","-vf","setsar=1","-fps_mode","passthrough","-color_range","pc","-colorspace","rgb",
            "-color_primaries",color.primaries==="unknown"?"unspecified":color.primaries,"-color_trc",color.transfer==="unknown"?"unspecified":color.transfer,"-fs",String(cap),...FFMPEG_PROGRESS_ARGS,partial],runtime.timeoutMs??30_000,undefined,{ffmpegProgress:true,paths:[partial]});
          await stableSource(); await monitor.check(); await stableRootAndTools(); const decoded=await decodeRgbaOutputWitnessV1({...witness,source:partial});
          if (decoded.sha256!==source.pixelSha256) throw Error("CLOCK_BROWSER_SURFACE_PIXELS_DIFFERENT_OR_ALPHA_UNSUPPORTED");
          await stableRootAndTools(); const outputTiming=await timingWitness(runtime.ffprobePath,partial,source,runtime.timeoutMs??30_000);
          await stableRootAndTools(); const encodedProbe=JSON.parse((await runProcess(runtime.ffprobePath,["-v","error","-show_streams","-of","json",partial],30_000,{completeStdoutMaxChars:65536})).stdout);
          const encodedVideo=encodedProbe.streams?.[0];
          if(encodedProbe.streams?.length!==1||encodedVideo.codec_name!=="vp9"||encodedVideo.pix_fmt!=="gbrp"||encodedVideo.color_space!=="gbr"||encodedVideo.color_range!=="pc")throw Error("CLOCK_BROWSER_SURFACE_RGB_CODEC_METADATA_CHANGED");
          const outputColor={primaries:encodedVideo.color_primaries??"unspecified",transfer:encodedVideo.color_transfer??"unspecified"};
          const bytes=Number((await file.stat()).size); if(bytes<1 || bytes>cap)throw Error("CLOCK_BROWSER_SURFACE_OUTPUT_CAP_EXCEEDED");
          const outputSha256=await timeRemapSha256V1(partial,renderLifetimeSignal());await stableSource();await stableRootAndTools();
          if(await timeRemapSha256V1(source.sourcePath,renderLifetimeSignal())!==source.sourceSha256)throw Error("CLOCK_BROWSER_SURFACE_SOURCE_SHA_CHANGED");
          const finalIdentity=await lstat(partial,{bigint:true});if(finalIdentity.isSymbolicLink()||finalIdentity.dev!==fileIdentity.dev||finalIdentity.ino!==fileIdentity.ino)throw Error("CLOCK_BROWSER_SURFACE_OUTPUT_OWNER_CHANGED");
          assertRenderActive(); await link(partial,output);published=true;await runtime.onOwnedPath(output,"file");assertRenderActive();
          const publication=await lstat(output,{bigint:true});if(publication.isSymbolicLink()||publication.dev!==fileIdentity.dev||publication.ino!==fileIdentity.ino||Number(publication.size)!==bytes||await timeRemapSha256V1(output)!==outputSha256)throw Error("CLOCK_BROWSER_SURFACE_PUBLICATION_CHANGED");
          // Removing our own temporary hard link changes inode ctime on Windows.
          // Capture the live-file fingerprint only after that owned transition ends.
          await monitor.stop(); monitor=undefined; await file.close(); file=undefined; await removeOwned(partial);
          const outputFingerprint=canonicalJson(await timeRemapFingerprintV1(output));
          const dispose = async () => { const existing=live.get(output);if(!existing)return; if(await timeRemapSha256V1(output)!==outputSha256)throw Error("CLOCK_BROWSER_SURFACE_OUTPUT_CHANGED_RETAINED"); await removeOwned(output);live.delete(output); };
          const receipt=Object.freeze({schema:"editkin.time-remap-browser-surface/v1" as const,policy:runtime.policy,key,sourceSha256:source.sourceSha256,clockIdentity:source.clockIdentity,
            firstGlobalFrame:source.firstGlobalFrame,frames:source.frames,rate:source.rate,width:source.width,height:source.height,bytes,outputSha256,pixelSha256:decoded.sha256,
            codec:"vp9_lossless_gbrp" as const,color:{source:color,output:outputColor,metadataDropped:canonicalJson(color)!==canonicalJson(outputColor),
              interpretationUnresolved:outputColor.primaries!=="bt709"||outputColor.transfer!=="bt709"},sourceDecoder:original.producer,outputDecoder:decoded.producer,
            originalTiming,outputTiming,sourceSampleAspectRatio:video[0].sample_aspect_ratio??"unspecified",surfaceSampleAspectRatio:"1:1",
            rawMoviePixelFileBytes:0,ordinaryEditorPreviewReady:false as const,nativeWebView2Ready:false as const,colourCertified:false as const,audio:"absent_or_explicitly_muted" as const});
          live.set(output,{bytes,dispose,verify:async()=>{if(canonicalJson(await timeRemapFingerprintV1(output))!==outputFingerprint)throw Error("CLOCK_BROWSER_SURFACE_LIVE_OUTPUT_CHANGED");}});returned=true;return {outputPath:output,receipt,release:dispose};
        } finally { await monitor?.stop();await file?.close();await sourceHandle.close();if(fileIdentity){await removeOwned(partial);if(published&&!returned)await removeOwned(output);} }
      }); } finally {busy=false;}
    },
    async close() { if(busy)throw Error("CLOCK_BROWSER_SURFACE_SESSION_BUSY"); if(live.size)throw Error("CLOCK_BROWSER_SURFACE_CONSUMERS_MUST_RELEASE");closed=true; },
    get receipt(){return {liveSurfaces:live.size,liveBytes:[...live.values()].reduce((n,x)=>n+x.bytes,0),maximumStoredBytes:quota,busy,closed};},
  };
}
