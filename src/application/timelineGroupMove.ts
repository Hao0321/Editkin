import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import type { EditProject } from "../domain/types";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { isTemplateManagedClip } from "../domain/clipSourceEdits";
import { clipAttachments } from "./timelineMotionEdits";
import { planTimelineSelectionNudge, type TimelineSelectionEditPlan } from "./timelineSelectionEdits";
import type { TimelineSelection } from "./timelineSelection";
const frame = (project: EditProject, time: number) => Math.round(time * project.fps);
function finish(project: EditProject, commands: EditorCommand[], message: string): TimelineSelectionEditPlan {
  if (commands.some(command => "clipId" in command && isTemplateManagedClip(project, command.clipId))) throw new Error("有標題模板的整組片段只能在原軌道左右移動。");
  const command: EditorCommand = { type: "batch", commands }; applyCommand(project, command); return { command, message };
}

/** Group drag shares the exact caption/title ownership and one-batch command used by keyboard nudging. */
export function planTimelineGroupMove(project: EditProject, selection: TimelineSelection, frames: number, originTrackId: string, targetTrackId: string): TimelineSelectionEditPlan | undefined {
  if (originTrackId === targetTrackId) return planTimelineSelectionNudge(project, selection, frames);
  const origin = project.tracks.find(item => item.id === originTrackId), target = project.tracks.find(item => item.id === targetTrackId);
  if (!origin || !target || origin.kind !== target.kind || target.locked) throw new Error(TRACK_LOCKED_MESSAGE);
  const clips = project.tracks.flatMap(item => item.clips).filter(item => selection.clipIds.includes(item.id));
  const attachments = clips.map(clip => clipAttachments(project, clip.id));
  if (attachments.some(item => item.instances.length)) throw new Error("有標題模板的整組片段只能在原軌道左右移動。");
  const captions = project.captions.filter(item => selection.captionIds.includes(item.id) || attachments.some(a => a.captions.some(c => c.id === item.id)));
  if (captions.length && captionTrackLocked(project)) throw new Error(TRACK_LOCKED_MESSAGE);
  const kinds = project.tracks.filter(item => item.kind === origin.kind), offset = kinds.indexOf(target) - kinds.indexOf(origin);
  const earliest = Math.min(...clips.map(item => frame(project, item.timelineStart)), ...captions.map(item => frame(project, item.start)));
  const delta = Math.max(-earliest, frames), shift = (time: number) => (frame(project, time) + delta) / project.fps;
  const commands: EditorCommand[] = clips.map(clip => {
    const track = project.tracks.find(item => item.id === clip.trackId);
    if (!track || track.locked) throw new Error(TRACK_LOCKED_MESSAGE);
    const destination = track.kind === origin.kind ? kinds[kinds.indexOf(track) + offset] : track;
    if (!destination || destination.locked) throw new Error("這裡沒有足夠的可用軌道放下整組片段。");
    return { type: "move_clip_to_track", clipId: clip.id, trackId: destination.id, timelineStart: shift(clip.timelineStart) };
  });
  commands.push(...captions.map(item => ({ type: "update_caption" as const, captionId: item.id, patch: { start: shift(item.start) } })));
  const graphics = [...new Map(attachments.flatMap(item => item.graphics).map(item => [item.id, item])).values()];
  commands.push(...graphics.map(item => ({ type: "update_motion_graphic" as const, graphicId: item.id, patch: { timelineStart: shift(item.timelineStart) } })));
  return finish(project, commands, "已一起移動選取的片段與字幕；一次復原即可還原。");
}
