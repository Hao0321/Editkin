import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { TimelineTrack } from "../domain/types";
import { trackMenuPosition } from "./trackMenuPosition";
import { activateTrackMenuItem } from "./trackMenuKeyboard";

interface Props {
  track: TimelineTrack;
  onRename: (id: string, name: string) => void;
  onToggleLock: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Portal escapes the timeline's scrolling clip and sticky-label stacking context. */
export function TrackOptions({ track, onRename, onToggleLock, onDelete }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof trackMenuPosition>>();
  const close = (restoreFocus = true) => {
    setPosition(undefined);
    if (restoreFocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false);
    };
    const moved = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [position]);
  const keyboard = (event: KeyboardEvent) => {
    const focused = document.activeElement as HTMLButtonElement | null;
    if (activateTrackMenuItem(event, focused?.tagName === "BUTTON" && menu.current?.contains(focused) ? focused : null)) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <div className="track-options">
    <button ref={trigger} type="button" className="track-options-trigger" aria-label={`${track.name} 軌道選項`}
      aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={() => {
        if (position) close();
        else setPosition(trackMenuPosition(trigger.current!.getBoundingClientRect(), window.innerWidth, window.innerHeight));
      }}>⋯</button>
    {position && createPortal(<div ref={menu} className="track-options-menu" role="menu" aria-label={`${track.name} 軌道操作`}
      data-testid="track-options-menu" data-drop-zone="blocked" style={position} onKeyDown={keyboard}>
      <button type="button" role="menuitem" onClick={() => {
        close(); const name = window.prompt("重新命名軌道", track.name)?.trim(); if (name) onRename(track.id, name);
      }}>重新命名</button>
      <button type="button" role="menuitem" onClick={() => { onToggleLock(track.id); close(); }}>{track.locked ? "解除鎖定" : "鎖定軌道"}</button>
      <button type="button" role="menuitem" className="danger-action"
        disabled={track.clips.length > 0 || track.kind === "caption" || track.id === "video-main" || track.id === "audio-main"}
        onClick={() => { onDelete(track.id); close(); }}>刪除空軌</button>
    </div>, document.body)}
  </div>;
}
