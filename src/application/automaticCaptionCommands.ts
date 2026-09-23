import type { EditorCommand } from "../domain/commands";
import { alignTime } from "../domain/editGraph";
import type { EditProject, TimelineClip } from "../domain/types";
import { makeId } from "../lib/format";

export function buildAutomaticCaptionCommand(
  project: EditProject,
  clip: TimelineClip,
  result: { cues: Array<{ start: number; end: number; text: string; translation?: { text: string; language: string } }> },
  idFactory: () => string = () => makeId("caption-auto"),
): { command: EditorCommand; added: number; replaced: number } {
  const start = clip.timelineStart;
  const end = clip.timelineStart + clip.duration;
  const lastFrameEnd = Math.floor(end * project.fps + 1e-7) / project.fps;
  const commands: EditorCommand[] = project.captions
    .filter((caption) => caption.start < end && caption.start + caption.duration > start)
    .map((caption) => ({ type: "delete_caption" as const, captionId: caption.id }));
  const replaced = commands.length;
  let added = 0;
  for (const cue of result.cues) {
    const cueStart = alignTime(Math.max(start, start + cue.start), project.fps);
    const cueEnd = Math.min(lastFrameEnd, alignTime(Math.min(end, start + cue.end), project.fps));
    if (!cue.text.trim() || cueEnd <= cueStart) continue;
    commands.push({
      type: "add_caption",
      caption: {
        id: idFactory(), text: cue.text.trim(), start: cueStart, duration: cueEnd - cueStart,
        translation: cue.translation?.text.trim() ? { text: cue.translation.text.trim(), language: cue.translation.language } : undefined,
      },
    });
    added += 1;
  }
  if (!added) throw new Error("沒有可加入 Timeline 的字幕");
  return { command: { type: "batch", commands }, added, replaced };
}
