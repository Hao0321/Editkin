import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { MediaAsset, TimelineClip, TimelineTrack } from "../domain/types";
import type { TimelineProps } from "./timelineContract";
import { ClipContextMenu, type ClipMenuTarget } from "./ClipContextMenu";
import { clipLinkMenuActions } from "./clipLinkMenuActions";

type Host = Pick<TimelineProps, "project" | "selectedClipIds" | "selectedClipId" | "onFreezeFrame" | "onDetachAudio" | "onLinkClips" | "clipMediaBusy" | "onSelect"> & {
  setMotionSelection: (id: string | undefined) => void;
};

/** The r57 context-menu state and callback; renderMenu stays at the old late JSX call site. */
export function useTimelineClipMenuControls({ project, selectedClipIds, selectedClipId, onFreezeFrame, onDetachAudio, onLinkClips, clipMediaBusy, onSelect, setMotionSelection }: Host) {
  const [clipMenu, setClipMenu] = useState<ClipMenuTarget>();
  useEffect(() => setClipMenu(undefined), [project.id]);
  const onContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, clip: TimelineClip, track: TimelineTrack, asset: MediaAsset | undefined) => { if (!onLinkClips && ((!onFreezeFrame && !onDetachAudio) || track.kind !== "video" || asset?.kind !== "video")) return; event.preventDefault(); event.stopPropagation(); setMotionSelection(undefined); if (!(selectedClipIds ?? [selectedClipId]).includes(clip.id)) onSelect(clip.id); setClipMenu({ clipId: clip.id, x: event.clientX, y: event.clientY }); };
  const renderMenu = () => (clipMenu && (onFreezeFrame || onDetachAudio || onLinkClips) && <ClipContextMenu target={clipMenu}
      {...clipLinkMenuActions(project, clipMenu.clipId, selectedClipIds ?? (selectedClipId ? [selectedClipId] : []), { onFreezeFrame, onDetachAudio, onLinkClips, clipMediaBusy })}
      onClose={() => setClipMenu(undefined)} />);
  return { onContextMenu, renderMenu };
}
