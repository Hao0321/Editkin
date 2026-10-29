import { useRef, useState } from "react";
import { findAsset, findClip, alignTime } from "../domain/editGraph";
import type { EditorCommand } from "../domain/commandTypes";
import type { MediaAsset } from "../domain/types";
import { makeId } from "../lib/format";
import { planClipRetime, resolveRetimeWindow } from "../application/clipRetime";
import { planFreezeFrame } from "../application/freezeFrame";
import { inheritClipMediaSource } from "../application/clipMediaSource";
import { acceptProjectTask } from "../application/projectTask";
import type { ProjectSession } from "../application/projectSession";
import type { HaoDesktopApi } from "./types";

interface Options {
  api?: HaoDesktopApi; projectSession: ProjectSession; getPlayhead: () => number;
  onCommand: (command: EditorCommand,message: string) => boolean | void;
  onStatus: (message: string) => void; onPause: () => void;
  onRuntimeUrls: (urls: Record<string,string>) => void;
}
export const CLIP_MEDIA_DESKTOP_REQUIRED = "這個操作需要桌面版的本機媒體引擎。";
export function useClipMediaEdits(options: Options) {
  const [busy,setBusy] = useState(false), pending = useRef(false);
  const run = async (clipId: string, operation: 'freeze'|'retime', rate=1, reverse=false): Promise<boolean> => {
    if(pending.current) return false;
    if(!options.api?.generateClipMediaDerivative) {options.onStatus(CLIP_MEDIA_DESKTOP_REQUIRED);return false;}
    const project=options.projectSession.getSnapshot().history.present, task=options.projectSession.beginTask(project);
    const current=()=>acceptProjectTask(task,options.onStatus,operation==='freeze'?'定格':'速度調整');
    if(!current()) return false;
    try {
      const clip=findClip(project,clipId), original=findAsset(project,clip.assetId), at=alignTime(options.getPlayhead(),project.fps);
      const ids={still:makeId('clip-freeze'),right:makeId('clip')};
      const source=operation==='retime'?resolveRetimeWindow(project,clipId,rate,reverse):undefined;
      const placeholder:MediaAsset={...(source?.asset??original),id:makeId('asset'),kind:operation==='freeze'?'image':(source?.asset??original).kind,
        duration:operation==='freeze'?2:source!.duration};
      if(operation==='freeze') planFreezeFrame(project,clipId,at,placeholder,ids);
      else planClipRetime(project,clipId,clip.assetId,placeholder,source!.duration);
      pending.current=true;setBusy(true);options.onPause();
      options.onStatus(operation==='freeze'?'正在產生定格素材…':'正在產生速度與倒放素材…');
      const generated=await options.api.generateClipMediaDerivative({operation,sourcePath:(source?.asset??original).uri,sourceAssetId:(source?.asset??original).id,
        sourceStart:operation==='freeze'?clip.sourceStart+at-clip.timelineStart:source!.sourceStart,
        sourceDuration:source?.sourceDuration??clip.duration,fps:project.fps,rate,reverse,sourceSha256:(source?.asset??original).derivatives?.sourceSha256});
      if(!current()) return false;
      const asset=inheritClipMediaSource(generated.asset,source?.asset??original);
      const plan=operation==='freeze'?planFreezeFrame(project,clipId,at,asset,ids):planClipRetime(project,clipId,clip.assetId,asset,generated.duration);
      if(options.onCommand(plan.command,plan.message)===false) return false;
      options.onRuntimeUrls({[asset.id]:generated.previewUrl});
      return true;
    } catch(error) { if(current()) options.onStatus(error instanceof Error?error.message:'無法處理片段素材。');return false; }
    finally {pending.current=false;setBusy(false);}
  };
  return {busy,freeze:(clipId:string)=>run(clipId,'freeze'),retime:(clipId:string,rate:number,reverse:boolean)=>run(clipId,'retime',rate,reverse)};
}
