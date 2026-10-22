import { useRef, useState, type PointerEvent } from "react";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { translateUi as uiText } from "./i18n/interfacePreferences";
import { formatTime } from "../lib/format";

export function TimelineRulerMarkers({ markers, pixelsPerSecond, fps, duration, onSeek, onEditStart, onCommand }: {
  markers: EditProject["director"]["markers"]; pixelsPerSecond: number; fps: number; duration: number;
  onSeek: (time: number) => void; onEditStart?: () => void; onCommand?: (command: EditorCommand, message?: string) => unknown;
}) {
  const [selected, select] = useState<string>();
  const drag = useRef<{ id: string; pointerId: number; x: number; time: number; next: number; moved: boolean } | undefined>(undefined);
  const suppress = useRef(false);
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const session = drag.current; if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    session.next = Math.round(Math.max(0, Math.min(duration, session.time + (event.clientX - session.x) / pixelsPerSecond)) * fps) / fps;
    session.moved ||= Math.abs(event.clientX - session.x) >= 3;
    event.currentTarget.style.left = `${session.next * pixelsPerSecond}px`;
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const session = drag.current; if (!session || session.pointerId !== event.pointerId) return;
    if (!cancel) move(event); drag.current = undefined; suppress.current = session.moved;
    event.currentTarget.style.left = `${session.time * pixelsPerSecond}px`;
    if (!cancel && session.moved && session.next !== session.time) onCommand?.({ type: "update_director_marker", markerId: session.id, patch: { time: session.next } }, uiText("已移動標記，可復原。"));
  };
  return markers.map(marker => <button type="button" key={marker.id} className={`director-marker ${marker.kind}${selected === marker.id ? " selected" : ""}`}
    style={{ left: marker.time * pixelsPerSecond }} title={`${marker.title} · ${formatTime(marker.time)}`} data-testid={`timeline-marker-${marker.id}`} data-marker-time={marker.time}
    onPointerDown={event => {
      event.stopPropagation(); if (event.button !== 0) return; select(marker.id); event.currentTarget.focus({ preventScroll: true });
      if (!onCommand) return; onEditStart?.(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: marker.id, pointerId: event.pointerId, x: event.clientX, time: marker.time, next: marker.time, moved: false };
    }} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onClick={event => { event.stopPropagation(); select(marker.id); if (suppress.current) { suppress.current = false; return; } onSeek(marker.time); }}
    onDoubleClick={event => { event.stopPropagation(); if (!onCommand) return; const title = window.prompt(uiText("重新命名標記"), marker.title)?.trim(); if (title) onCommand({ type: "update_director_marker", markerId: marker.id, patch: { title } }, uiText("已重新命名標記，可復原。")); }}
    onKeyDown={event => { if (!onCommand || event.key !== "Delete" && event.key !== "Backspace") return; event.preventDefault(); event.stopPropagation(); onEditStart?.(); onCommand({ type: "delete_director_marker", markerId: marker.id }, uiText("已刪除標記，可復原。")); select(undefined); }}>◆</button>);
}
