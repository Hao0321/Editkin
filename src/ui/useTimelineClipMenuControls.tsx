import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { MediaAsset, TimelineClip, TimelineTrack } from "../domain/types";
import type { TimelineProps } from "./timelineContract";
import { ClipContextMenu, clipMenuHasActions, type ClipMenuTarget } from "./ClipContextMenu";
import { clipLinkMenuActions } from "./clipLinkMenuActions";

type Host = Pick<TimelineProps, "project" | "selectedClipIds" | "selectedClipId" | "onFreezeFrame" | "onDetachAudio" | "onLinkClips" | "clipMediaBusy" | "onSelect"> & {
  setMotionSelection: (id: string | undefined) => void;
};

/**
 * The r57 context-menu state and callback; renderMenu stays at the old late JSX call site. A right-click picks the clip as
 * before, but a clip with nothing to offer (an unlinked sound or picture clip on its own, for example) opens no menu: an
 * empty menu would own the keyboard until dismissed, and every editing key would seem dead.
 */
export function useTimelineClipMenuControls({ project, selectedClipIds, selectedClipId, onFreezeFrame, onDetachAudio, onLinkClips, clipMediaBusy, onSelect, setMotionSelection }: Host) {
  const [clipMenu, setClipMenu] = useState<ClipMenuTarget>();
  useEffect(() => setClipMenu(undefined), [project.id]);
  const actionsFor = (clipId: string, selectedIds: readonly string[]) => clipLinkMenuActions(project, clipId, selectedIds, { onFreezeFrame, onDetachAudio, onLinkClips, clipMediaBusy });
  const onContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, clip: TimelineClip, track: TimelineTrack, asset: MediaAsset | undefined) => {
    if (!onLinkClips && ((!onFreezeFrame && !onDetachAudio) || track.kind !== "video" || asset?.kind !== "video")) return;
    event.preventDefault(); event.stopPropagation(); setMotionSelection(undefined);
    const selected = selectedClipIds ?? (selectedClipId ? [selectedClipId] : []), picked = selected.includes(clip.id);
    if (!picked) onSelect(clip.id);
    // The menu offers what fits the selection the right-click leaves: the clip alone when it was not picked yet.
    if (!clipMenuHasActions(actionsFor(clip.id, picked ? selected : [clip.id]))) { setClipMenu(undefined); return; }
    setClipMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
  };
  const renderMenu = () => {
    if (!clipMenu || !(onFreezeFrame || onDetachAudio || onLinkClips)) return undefined;
    const actions = actionsFor(clipMenu.clipId, selectedClipIds ?? (selectedClipId ? [selectedClipId] : []));
    return clipMenuHasActions(actions) ? <ClipContextMenu target={clipMenu} {...actions} onClose={() => setClipMenu(undefined)} /> : undefined;
  };
  return { onContextMenu, renderMenu };
}
