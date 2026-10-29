import { useEffect, useRef, useState } from "react";
import type { TimelineTrack } from "../domain/types";
import { EasyIcon } from "./easy/easyIcons";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import "./layerControlsV1.css";

export interface TrackQuickTogglesProps {
  track: TimelineTrack;
  /** Picture tracks: picture off or on (sound as usual). */
  onToggleHidden?: (trackId: string) => void;
  /** Sound only: the picture keeps showing. */
  onToggleMute?: (trackId: string) => void;
  /** Hear only this track (and other solo tracks). */
  onToggleSolo?: (trackId: string) => void;
  onToggleLock?: (trackId: string) => void;
}

/**
 * The track header's quick switches, as in CapCut's track header: 隱藏畫面 (eye), 靜音 (speaker), 獨奏 (headphones) and
 * 鎖定 (lock), each an icon with a tooltip that says what it changes. Used by the timeline header and the 圖層 panel.
 * The switches send the existing track commands; locked tracks still allow them (trackLock.ts).
 */
export function TrackQuickTogglesV1({ track, onToggleHidden, onToggleMute, onToggleSolo, onToggleLock }: TrackQuickTogglesProps) {
  useI18n();
  const sound = track.kind !== "caption";
  return <div className="track-quick-toggles" role="group" aria-label={uiText("{value0} 軌道開關", { value0: track.name })} data-testid={`track-toggles-${track.id}`}>
    {track.kind === "video" && onToggleHidden && <button type="button" className={`track-toggle track-hide${track.hidden ? " active" : ""}`} data-testid={`track-hide-${track.id}`}
      onClick={() => onToggleHidden(track.id)} aria-label={uiText("{value0} 隱藏畫面", { value0: track.name })} aria-pressed={Boolean(track.hidden)}
      title={uiText(track.hidden ? "畫面已隱藏：按一下顯示畫面" : "隱藏畫面：只關畫面，聲音照常")}><EasyIcon name={track.hidden ? "eye-off" : "eye"} /></button>}
    {sound && onToggleMute && <button type="button" className={`track-mute ${track.muted ? "active" : ""}`} onClick={() => onToggleMute(track.id)} aria-label={uiText("{value0} 靜音", { value0: track.name })} aria-pressed={track.muted} title={uiText(track.kind === "video" ? "靜音：只關聲音，畫面照常" : "靜音")}><EasyIcon name={track.muted ? "volume-off" : "volume"} /></button>}
    {sound && onToggleSolo && <button type="button" className={`track-toggle track-solo${track.solo ? " active" : ""}`} data-testid={`track-solo-button-${track.id}`}
      onClick={() => onToggleSolo(track.id)} aria-label={uiText("{value0} 獨奏", { value0: track.name })} aria-pressed={Boolean(track.solo)}
      title={uiText(track.solo ? "獨奏中：只聽獨奏的軌道；按一下取消" : "獨奏：只聽這一軌（和其他獨奏軌）")}><EasyIcon name="headphones" /></button>}
    {onToggleLock && <button type="button" className={`track-toggle track-lock${track.locked ? " active" : ""}`} data-testid={`track-lock-${track.id}`}
      onClick={() => onToggleLock(track.id)} aria-label={uiText("{value0} 鎖定", { value0: track.name })} aria-pressed={track.locked}
      title={uiText(track.locked ? "已鎖定：按一下解鎖" : "鎖定：這一軌的片段不能移動或修改")}><EasyIcon name={track.locked ? "lock" : "unlock"} /></button>}
  </div>;
}

/** Inline rename (no browser prompt): Enter or leaving the field keeps the name, Esc cancels; an empty name is ignored. */
export function TrackNameEditorV1({ name, onCommit, onDone, label }: { name: string; onCommit: (name: string) => void; onDone: () => void; label: string }) {
  useI18n();
  const [draft, setDraft] = useState(name), input = useRef<HTMLInputElement>(null), finished = useRef(false);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const finish = (keep: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = draft.trim();
    if (keep && next && next !== name) onCommit(next.slice(0, 80));
    onDone();
  };
  return <input ref={input} className="track-name-editor" data-testid="track-name-editor" value={draft} maxLength={80} aria-label={label}
    onChange={event => setDraft(event.currentTarget.value)} onBlur={() => finish(true)} onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    }} />;
}
