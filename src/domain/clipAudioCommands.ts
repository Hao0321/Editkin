import type { EditProject } from "./types";
import type { ClipAudioEnvelope } from "./clipAudioEnvelope";
import { assertClipAudioEnvelope } from "./clipAudioEnvelope";
import { EditGraphError } from "./editGraphError";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { isTemplateManagedClip } from "./clipSourceEdits";
export const AUDIO_TEMPLATE_REFUSAL="這段是標題模板管理的片段，尚未能安全調整聲音；原專案保持不變。";
export function applyClipAudioEnvelope(project:EditProject,command:{clipId:string;envelope?:ClipAudioEnvelope}):void {
  const track=project.tracks.find(t=>t.clips.some(c=>c.id===command.clipId)),clip=track?.clips.find(c=>c.id===command.clipId);
  if(!track||!clip)throw new EditGraphError("找不到這個片段，請重新選取。");
  if(track.locked)throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  const asset=project.assets.find(a=>a.id===clip.assetId);
  if(!asset||asset.kind==="image"||clip.layer?.role==="controller"||asset.compositionId)throw new EditGraphError("請選取有聲音的一般影片或聲音片段。");
  if(isTemplateManagedClip(project,clip.id))throw new EditGraphError(AUDIO_TEMPLATE_REFUSAL);
  assertClipAudioEnvelope(command.envelope);
  if(command.envelope)clip.audioEnvelope=structuredClone(command.envelope);else delete clip.audioEnvelope;
}
