import type { EditorCommand } from "../domain/commands";
import type { CaptionCue, TimelineClip } from "../domain/types";
import { alignTime } from "../domain/editGraph";

export type TimelineTrimEdge = "start" | "end";

export function buildClipTrimCommand(clip: TimelineClip, edge: TimelineTrimEdge, seconds: number): EditorCommand {
  const trim: EditorCommand = edge === "start"
    ? { type: "trim_clip_start", clipId: clip.id, seconds }
    : { type: "trim_clip_end", clipId: clip.id, seconds };
  return edge === "start"
    ? { type: "batch", commands: [trim, { type: "move_clip", clipId: clip.id, timelineStart: clip.timelineStart + seconds }] }
    : trim;
}

export function buildCaptionTrimCommand(caption: CaptionCue, edge: TimelineTrimEdge, seconds: number, fps?: number): EditorCommand {
  const align = (time: number) => fps ? alignTime(time, fps) : time;
  return {
    type: "update_caption",
    captionId: caption.id,
    patch: {
      start: align(edge === "start" ? caption.start + seconds : caption.start),
      duration: align(caption.duration - seconds),
    },
  };
}
