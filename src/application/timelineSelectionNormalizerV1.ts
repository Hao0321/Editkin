import type { EditProject } from "../domain/types";
import type { TimelineSelection } from "./timelineSelection";
import { createTimelineSelectionIndex } from "./timelineSelectionIndex";

type PrimaryResolver = (clips: string[], captions: string[], clipId?: string, captionId?: string) => TimelineSelection;

/** One immutable published graph only. Raw mutable callers must create a fresh binding on every call. */
export function createSnapshotTimelineSelectionNormalizerV1(
  project: Pick<EditProject, "tracks" | "captions">,
  primary: PrimaryResolver,
): (selection: TimelineSelection) => TimelineSelection {
  let index: ReturnType<typeof createTimelineSelectionIndex> | undefined;
  let captionsById: Set<string> | undefined;
  const clipIndex = () => index ??= createTimelineSelectionIndex(project);
  return selection => {
    const clips = selection.clipIds.length ? clipIndex().expand(selection.clipIds) : [];
    const captions = selection.captionIds.length
      ? [...new Set(selection.captionIds)].filter(id => (captionsById ??= new Set(project.captions.map(caption => caption.id))).has(id))
      : [];
    const result = primary(clips, captions,
      selection.primaryClipId && clips.includes(selection.primaryClipId) ? selection.primaryClipId : undefined,
      selection.primaryCaptionId && captions.includes(selection.primaryCaptionId) ? selection.primaryCaptionId : undefined);
    const linked = clips.length ? clips.filter(id => clipIndex().linked(id)) : [];
    return linked.length ? { ...result, linkedClipIds: linked } : result;
  };
}
