import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MediaAsset } from "../domain/types";
import { makeId } from "../lib/format";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { inspectMedia } from "./inspectMedia";
import { mediaFileSha256, runConversionProcess } from "./mediaConversion";

export const clipMediaDerivativeSchema = z.strictObject({
  operation: z.enum(["freeze", "retime"]), sourcePath: z.string().min(1), sourceAssetId: z.string().min(1),
  sourceStart: z.number().finite().nonnegative(), sourceDuration: z.number().finite().positive(),
  fps: z.number().finite().min(1).max(240), rate: z.number().finite().min(0.25).max(4).default(1), reverse: z.boolean().default(false),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});
export type ClipMediaDerivativeRequest = z.input<typeof clipMediaDerivativeSchema>;
export interface ClipMediaDerivativeRuntime { cacheRoot: string; ffmpegPath: string; ffprobePath: string; signal?: AbortSignal; timeoutMs?: number }

export function atempoFilters(rate: number): string[] {
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new Error("速度必須介於 0.25 倍到 4 倍。" );
  const parts: number[] = [];
  while (rate < 0.5 - 1e-9) { parts.push(0.5); rate /= 0.5; }
  while (rate > 2 + 1e-9) { parts.push(2); rate /= 2; }
  parts.push(rate);
  return parts.map(part => `atempo=${part}`);
}

/** A published derivative is the actual source asset, shared by every preview and export renderer. */
export async function generateClipMediaDerivative(input: ClipMediaDerivativeRequest, runtime: ClipMediaDerivativeRuntime) {
  const request = clipMediaDerivativeSchema.parse(input);
  if (request.reverse && request.sourceDuration > 60) throw new Error("倒放一次最多處理 60 秒，請先把片段切短。" );
  assertLocalMediaPath(request.sourcePath); assertLocalMediaPath(runtime.cacheRoot);
  if (!isAbsolute(request.sourcePath) || !isAbsolute(runtime.cacheRoot)) throw new Error("媒體衍生處理需要本機絕對路徑。" );
  runtime.signal?.throwIfAborted();
  const source = await realpath(request.sourcePath); assertLocalMediaPath(source);
  const probe = await inspectMedia(source, runtime.ffprobePath);
  const sourceSha256 = await mediaFileSha256(source, {signal:runtime.signal});
  if (request.sourceSha256 && request.sourceSha256.toLowerCase() !== sourceSha256) throw new Error("原素材已變更，這次衍生處理沒有套用到專案。" );
  if (!probe.hasVideo && !probe.hasAudio || request.operation === 'freeze' && !probe.hasVideo) throw new Error("這個素材沒有可處理的畫面或聲音。" );
  if (request.sourceStart >= probe.duration || request.operation === 'retime' && request.sourceStart+request.sourceDuration > probe.duration+1/request.fps) throw new Error("原素材的可用範圍不足，無法調整速度。" );
  if (['smpte2084','arib-std-b67'].includes(probe.colorTransfer ?? '') || /^(?:yuva|gbrap|rgba|bgra|argb|abgr)/.test(probe.pixelFormat ?? '') && request.operation === 'retime') throw new Error("這個素材需要保留 HDR 或透明色彩，這次速度調整暫不支援；原專案保持不變。" );
  const duration = request.operation === 'freeze' ? 2 : Math.max(1/request.fps, Math.ceil(request.sourceDuration*request.fps/request.rate-1e-7)/request.fps);
  const directory = join(runtime.cacheRoot, 'clip-edits', randomUUID()); await mkdir(directory, {recursive:true});
  const path = join(directory, request.operation === 'freeze' ? 'frame.png' : probe.hasVideo ? 'retimed.mp4' : 'retimed.wav');
  const args = ['-hide_banner','-loglevel','error','-nostdin','-n','-threads','2','-ss',String(request.sourceStart)];
  if (request.operation === 'retime') args.push('-t',String(request.sourceDuration));
  args.push('-i',source);
  if (request.operation === 'freeze') args.push('-map','0:v:0','-frames:v','1','-c:v','png');
  else {
    if (probe.hasVideo) args.push('-map','0:v:0','-vf',`${request.reverse?'reverse,':''}setpts=(PTS-STARTPTS)/${request.rate},tpad=stop_mode=clone:stop_duration=${1/request.fps}`,
      '-r',String(request.fps),'-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-threads','2');
    if (probe.hasAudio) args.push('-map','0:a:0','-af',[request.reverse?'areverse':'',...atempoFilters(request.rate),`apad=whole_dur=${duration}`,`atrim=duration=${duration}`].filter(Boolean).join(','),
      '-c:a',probe.hasVideo?'aac':'pcm_s16le',...(probe.hasVideo?['-b:a','192k']:[]));
    args.push('-t',String(duration),...(probe.hasVideo?['-movflags','+faststart']:[]));
  }
  args.push(path);
  await runConversionProcess(runtime.ffmpegPath,args,runtime.signal,runtime.timeoutMs??180_000);
  const outputProbe = await inspectMedia(path,runtime.ffprobePath);
  if ((await stat(path)).size <= 0 || probe.hasVideo && !outputProbe.hasVideo || request.operation === 'retime' && probe.hasAudio && !outputProbe.hasAudio
    || request.operation === 'retime' && Math.abs(outputProbe.duration-duration)>Math.max(0.08,1.5/request.fps)) throw new Error("衍生素材未通過時長或串流檢查。" );
  await runConversionProcess(runtime.ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-i',path,'-f','null','-'],runtime.signal,runtime.timeoutMs??180_000);
  const sha256 = await mediaFileSha256(path,{signal:runtime.signal});
  if (await mediaFileSha256(source,{signal:runtime.signal}) !== sourceSha256) throw new Error("處理期間原素材有變更，沒有套用到專案。" );
  const asset: MediaAsset = { id:makeId('asset'),name:request.operation==='freeze'?'定格 2 秒':`${request.rate}×${request.reverse?' 倒放':''}`,
    kind:request.operation==='freeze'?'image':probe.hasVideo?'video':'audio',uri:path,duration:request.operation==='freeze'?2:Math.max(duration,outputProbe.duration),
    width:outputProbe.width,height:outputProbe.height,displayAspectRatio:outputProbe.displayAspectRatio,
    derivatives:{sourceSha256:sha256,generatedAt:new Date().toISOString()},
    ...(request.operation==='retime'?{clipRetime:{schema:'editkin.clip-retime/v1' as const,sourceAssetId:request.sourceAssetId,sourceStart:request.sourceStart,sourceDuration:request.sourceDuration,rate:request.rate,reverse:request.reverse}}:{}),
  };
  const receipt = { schema:'editkin.clip-media-derivative/v1',request,sourceSha256,sha256,path,duration,probe:outputProbe,args,asset };
  await writeFile(join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return {asset,duration,sha256,sourceSha256,receiptPath:join(directory,'receipt.json')};
}
