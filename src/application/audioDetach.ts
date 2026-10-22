import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, TimelineClip } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, DEFAULT_CLIP_LAYER } from "../domain/types";
import { isTemplateManagedClip } from "../domain/clipSourceEdits";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { expandLinkedClipIds, unusedLinkGroupId } from "../domain/clipLinks";

export const AUDIO_DETACH_DONE = "已把聲音分離到聲音軌，原影片已靜音；一次復原即可完整還原。";
export function planAudioDetach(project: EditProject, clipId: string, ids: { clipId: string; trackId: string }) {
  const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId)), clip = track?.clips.find(item => item.id === clipId);
  if (!track || !clip) throw new Error("找不到這個片段，請重新選取。");
  if (track.locked) throw new Error(TRACK_LOCKED_MESSAGE);
  const asset = project.assets.find(item => item.id === clip.assetId);
  if (track.kind !== "video" || !asset || asset.kind !== "video" || asset.compositionId || asset.imageSequence) throw new Error("請選取一般影片片段來分離聲音。");
  if (isTemplateManagedClip(project, clipId)) throw new Error("這段是標題模板管理的片段，還不能安全分離聲音；原專案保持不變。");
  const from = Math.round(clip.timelineStart * project.fps), to = from + Math.round(clip.duration * project.fps);
  const available = project.tracks.filter(item => item.kind === "audio" && !item.locked && item.muted === track.muted && Boolean(item.solo) === Boolean(track.solo) && item.clips.every(other => {
    const start = Math.round(other.timelineStart * project.fps), end = start + Math.round(other.duration * project.fps);
    return end <= from || start >= to;
  }));
  const destination = available.find(item => item.id === "audio-main") ?? available[0];
  const trackId = destination?.id ?? ids.trackId, commands: EditorCommand[] = [];
  if (!destination) commands.push({ type: "add_track", track: { id: trackId, name: "分離的聲音", kind: "audio", locked: false, muted: track.muted, ...(track.solo === undefined ? {} : { solo: track.solo }), clips: [] } });
  // Use the original media's audio stream directly. Rights/provenance stay on that same source asset.
  const sound: TimelineClip = { ...structuredClone(clip), id: ids.clipId, trackId, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR },
    keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, masks: undefined, creative: undefined, layout: undefined, transform3d: undefined,
    floatingFrame: undefined, expressions: {}, chromaKey: undefined, gradeV2: undefined };
  commands.push({ type: "set_clip_volume", clipId, volume: 0 }, { type: "add_clip", clip: sound },
    { type: "set_clip_links", clipIds: [...expandLinkedClipIds(project, [clipId]), sound.id], groupId: unusedLinkGroupId(project, sound.id) });
  const command: EditorCommand = { type: "batch", commands }; applyCommand(project, command);
  return { command, message: AUDIO_DETACH_DONE, audioClipId: sound.id, audioTrackId: trackId };
}
