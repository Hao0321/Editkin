import type { McpServer } from "@modelcontextprotocol/server";
import { resolve } from "node:path";
import { z } from "zod";
import { applyCommand } from "../domain/commands";
import { alignTime, findAsset, findClip, summarizeProject } from "../domain/editGraph";
import type { MediaAsset } from "../domain/types";
import { makeId } from "../lib/format";
import { planClipRetime, resolveRetimeWindow } from "../application/clipRetime";
import { planFreezeFrame } from "../application/freezeFrame";
import { inheritClipMediaSource } from "../application/clipMediaSource";
import { generateClipMediaDerivative } from "../application/clipMediaDerivatives";
import { creativeAssetIdFromUri, resolveCreativeLibraryAsset } from "../application/creativeLibrary";
import { readProject, resolveWorkspaceMediaPath, workspaceRoot, writeProject } from "./storage";
import { creativePackRoot, errorResult, personalMusicRoot, personalVisualRoot, textResult } from "./toolRuntime";

async function sourcePath(asset: MediaAsset): Promise<string> {
  const creative = creativeAssetIdFromUri(asset.uri);
  return creative ? (await resolveCreativeLibraryAsset(creativePackRoot(),creative,personalMusicRoot(),personalVisualRoot())).absolutePath : resolveWorkspaceMediaPath(asset.uri);
}
function runtime(signal?: AbortSignal) {
  return { cacheRoot:resolve(workspaceRoot(),'.editkin-media-cache'),signal,
    ffmpegPath:process.env.HAO_FFMPEG_PATH??resolve(import.meta.dirname,'../../vendor/ffmpeg/win32-x64/ffmpeg.exe'),
    ffprobePath:process.env.HAO_FFPROBE_PATH??resolve(import.meta.dirname,'../../vendor/ffmpeg/win32-x64/ffprobe.exe') };
}
const base = {projectPath:z.string().min(1),clipId:z.string().min(1).max(160),expectedRevision:z.number().int().nonnegative()};

export function registerClipRetimeTools(server: McpServer): void {
  server.registerTool("freeze_frame",{
    description:'在選取影片的播放頭插入2秒定格並波紋推後，以一個原子命令寫回。expectedRevision必填；專案變更或無法安全跟隨的標題模板會拒絕。',
    inputSchema:z.strictObject({...base,playhead:z.number().finite().nonnegative()}),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async ({projectPath,clipId,expectedRevision,playhead},context) => {
    try {
      const project=await readProject(projectPath);
      if(project.revision!==expectedRevision) throw new Error('專案版本已變更，請重新讀取後再定格。');
      const clip=findClip(project,clipId), source=findAsset(project,clip.assetId), path=await sourcePath(source);
      if(source.kind!=='video') throw new Error('定格只支援影片片段。');
      const at=alignTime(playhead,project.fps), ids={still:makeId('clip-freeze'),right:makeId('clip')};
      const placeholder:MediaAsset={id:makeId('asset-freeze'),kind:'image',name:'定格 2 秒',uri:resolve(runtime().cacheRoot,'pending.png'),duration:2,width:source.width,height:source.height};
      planFreezeFrame(project,clipId,at,placeholder,ids);
      const generated=await generateClipMediaDerivative({operation:'freeze',sourcePath:path,sourceAssetId:source.id,
        sourceStart:clip.sourceStart+at-clip.timelineStart,sourceDuration:clip.duration,fps:project.fps,sourceSha256:source.derivatives?.sourceSha256},runtime(context.mcpReq.signal));
      const plan=planFreezeFrame(project,clipId,at,inheritClipMediaSource(generated.asset,source),ids);
      const updated=await writeProject(projectPath,applyCommand(project,plan.command),expectedRevision);
      return textResult({status:'GREEN',duration:2,clipId:plan.stillClipId,derivativeSha256:generated.sha256,summary:summarizeProject(updated),message:plan.message});
    } catch(error) { return errorResult(error); }
  });
  server.registerTool("clip_retime",{
    description:'產生0.25–4倍速／倒放的片段衍生素材，聲音維持音高，預覽與輸出共用來源。速度為絕對倍速；倒放最多60秒。expectedRevision必填，一次原子套用；模板無法安全跟隨時拒絕。',
    inputSchema:z.strictObject({...base,rate:z.number().finite().min(0.25).max(4),reverse:z.boolean().default(false)}),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async ({projectPath,clipId,expectedRevision,rate,reverse},context) => {
    try {
      const project=await readProject(projectPath);
      if(project.revision!==expectedRevision) throw new Error('專案版本已變更，請重新讀取後再改速度。');
      const clip=findClip(project,clipId), request=resolveRetimeWindow(project,clipId,rate,reverse);
      const placeholder:MediaAsset={...request.asset,id:makeId('asset-retime'),uri:resolve(runtime().cacheRoot,'pending.mp4'),duration:request.duration};
      planClipRetime(project,clipId,clip.assetId,placeholder,request.duration);
      const generated=await generateClipMediaDerivative({operation:'retime',sourcePath:await sourcePath(request.asset),sourceAssetId:request.asset.id,
        sourceStart:request.sourceStart,sourceDuration:request.sourceDuration,fps:request.fps,rate,reverse,sourceSha256:request.asset.derivatives?.sourceSha256},runtime(context.mcpReq.signal));
      const plan=planClipRetime(project,clipId,clip.assetId,inheritClipMediaSource(generated.asset,request.asset),generated.duration);
      const updated=await writeProject(projectPath,applyCommand(project,plan.command),expectedRevision);
      return textResult({status:'GREEN',rate,reverse,duration:generated.duration,derivativeSha256:generated.sha256,summary:summarizeProject(updated),message:plan.message});
    } catch(error) { return errorResult(error); }
  });
}
