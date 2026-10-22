import type { EditProject } from "../domain/types";
import { linkedClipIds } from "../domain/clipLinks";
import type { TimelineProps } from "./timelineContract";

/** Menu availability lives outside the timeline component; linked peers answer to every track lock. */
export function clipLinkMenuActions(project: EditProject, clipId: string, selectedIds: readonly string[],
  actions: Pick<TimelineProps, "onFreezeFrame" | "onDetachAudio" | "onLinkClips" | "clipMediaBusy">) {
  const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId));
  const clip = track?.clips.find(item => item.id === clipId), asset = project.assets.find(item => item.id === clip?.assetId);
  const video = track?.kind === "video" && asset?.kind === "video";
  const group = linkedClipIds(project, clipId);
  return {
    disabled: Boolean(actions.clipMediaBusy) || project.tracks.some(item => item.locked && item.clips.some(member => group.includes(member.id))),
    onFreezeFrame: video ? actions.onFreezeFrame : undefined,
    onDetachAudio: video ? actions.onDetachAudio : undefined,
    onLink: actions.onLinkClips && selectedIds.length >= 2 ? () => actions.onLinkClips!([...selectedIds]) : undefined,
    onUnlink: actions.onLinkClips && group.length > 1 ? () => actions.onLinkClips!([clipId], true) : undefined,
  };
}
