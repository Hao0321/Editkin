import type { EditorCommand } from "../domain/commands";
import { alignTime } from "../domain/editGraph";
import type { EditProject, TimelineClip } from "../domain/types";
import { makeId } from "../lib/format";

export function buildSceneSplitCommand(
  project: EditProject,
  clip: TimelineClip,
  cuts: Array<{ time: number }>,
  idFactory: () => string = () => makeId("clip-scene"),
): { command: EditorCommand; splitCount: number } {
  const clipEnd = clip.timelineStart + clip.duration;
  const times = [...new Set(cuts.map((cut) => alignTime(clip.timelineStart + cut.time, project.fps)))]
    .filter((time) => time > clip.timelineStart && time < clipEnd)
    .sort((left, right) => left - right);
  if (!times.length) throw new Error("沒有找到可分割的場景切點");
  const commands: EditorCommand[] = [];
  let currentClipId = clip.id;
  for (const at of times) {
    const newClipId = idFactory();
    commands.push({ type: "split_clip", clipId: currentClipId, at, newClipId });
    currentClipId = newClipId;
  }
  return { command: { type: "batch", commands }, splitCount: commands.length };
}
