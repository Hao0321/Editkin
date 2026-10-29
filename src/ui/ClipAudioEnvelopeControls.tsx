import { useEffect, useRef, useState } from "react";
import type { TimelineClip } from "../domain/types";
import { clipVolumePointDbAt, visibleClipFadeSeconds, withClipAudioFades, withClipVolumePoint, withoutClipVolumePoint, type ClipAudioEnvelope } from "../domain/clipAudioEnvelope";
import { translateUi as t, useI18n } from "./i18n/interfacePreferences";
import { usePlayheadSelection, usePlayheadStoreContext } from "./playheadStore";
import "./clipAudioEnvelope.css";

interface Props {
  clip: TimelineClip;
  playhead: number;
  fps: number;
  music?: boolean;
  disabled?: boolean;
  onChange(envelope?: ClipAudioEnvelope): boolean | void;
}
function VolumePointField({ db, disabled, onCommit }: {db:number;disabled:boolean;onCommit(value:number):void}) {
  const [draft, setDraft] = useState(String(db)), dirty = useRef(false);
  useEffect(() => { setDraft(String(Number(db.toFixed(1)))); dirty.current = false; }, [db]);
  const commit = () => { if (!dirty.current || disabled) return; dirty.current = false; const value = Number(draft);
    if (draft.trim() && Number.isFinite(value) && value >= -30 && value <= 6) onCommit(value); else setDraft(String(db)); };
  return <input type="number" min={-30} max={6} step={.1} value={draft} disabled={disabled} aria-label={t("音量點（dB）")}
    onChange={e => { dirty.current = true; setDraft(e.target.value); }} onBlur={commit}
    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { dirty.current = false; setDraft(String(db)); } }} />;
}
export function ClipAudioEnvelopeControls({ clip, playhead, fps, music = false, disabled = false, onChange }: Props) {
  useI18n();
  const visible = visibleClipFadeSeconds(clip, music);
  const [draft, setDraft] = useState({ in: String(visible.in), out: String(visible.out) }), [error, setError] = useState("");
  const dirty = useRef({ in: false, out: false });
  useEffect(() => { setDraft({ in: String(Number(visible.in.toFixed(3))), out: String(Number(visible.out.toFixed(3))) });
    dirty.current = { in: false, out: false }; setError(""); }, [clip.id, clip.audioEnvelope, clip.duration, visible.in, visible.out]);
  const send = (make: () => ClipAudioEnvelope | undefined) => {
    if (disabled) return;
    try { const envelope = make(); if (onChange(envelope) !== false) setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const commitFade = (edge: "in" | "out") => {
    if (!dirty.current[edge] || disabled) return;
    dirty.current[edge] = false;
    const value = Number(draft[edge]);
    if (!draft[edge].trim() || !Number.isFinite(value) || value < 0 || value > 5) { setError("請輸入 0–5 秒的淡化長度。"); return; }
    send(() => withClipAudioFades(clip, edge === "in" ? value : visible.in, edge === "out" ? value : visible.out));
  };
  // PF1: the live playhead (re-rendering only when it enters or leaves the clip); a new point uses the playhead at the click.
  const store = usePlayheadStoreContext();
  const localAt = (time: number) => Math.round((time - clip.timelineStart) * fps) / fps;
  const insideClip = usePlayheadSelection(store, { time: playhead, seekRevision: 0 }, state => { const local = localAt(state.time); return local >= 0 && local < clip.duration; });
  const canAdd = insideClip && !disabled;
  return <section className="clip-audio-envelope-controls" data-testid="clip-audio-envelope-controls" aria-label={t("聲音淡化與音量點")}>
    <div className="clip-audio-fade-fields">{(["in", "out"] as const).map(edge => <label key={edge}><span>{t(edge === "in" ? "淡入" : "淡出")}</span>
      <input type="number" min={0} max={5} step={.1} disabled={disabled} value={draft[edge]} data-testid={`clip-audio-fade-${edge}`} aria-label={t(edge === "in" ? "淡入（秒）" : "淡出（秒）")}
        onChange={e => { dirty.current[edge] = true; setDraft(current => ({ ...current, [edge]: e.target.value })); }} onBlur={() => commitFade(edge)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commitFade(edge); } if (e.key === "Escape") { dirty.current[edge] = false; setDraft(current => ({ ...current, [edge]: String(visible[edge]) })); } }} /><small>{t("秒")}</small></label>)}</div>
    <button type="button" className="mini-action" data-testid="add-clip-volume-point" disabled={!canAdd}
      onClick={() => { const local = localAt(store ? store.rendered().time : playhead); send(() => withClipVolumePoint(clip, { id: crypto.randomUUID(), time: local, db: Math.max(-30, Math.min(6, clipVolumePointDbAt(clip, local))) })); }}>{t("在播放頭加音量點")}</button>
    <small>{t("音量點相對片段音量；拖曳時間軸上的點可調整，雙擊可刪除。")}</small>
    {clip.audioEnvelope?.volume?.points.map((point, index) => <div className="clip-audio-point-field" key={point.id} data-point-id={point.id}>
      <span>{t("音量點 {number}", { number: index + 1 })} · {Number((point.time - clip.audioEnvelope!.volume!.offset).toFixed(3))} {t("秒")}</span>
      <VolumePointField db={point.db} disabled={disabled} onCommit={db => send(() => withClipVolumePoint(clip, { ...point, time: point.time - clip.audioEnvelope!.volume!.offset, db }))} />
      <button type="button" className="mini-action" disabled={disabled} aria-label={t("刪除音量點 {number}", {number:index + 1})} onClick={() => send(() => withoutClipVolumePoint(clip, point.id))}>×</button>
    </div>)}
    {error && <small role="alert">{t(error)}</small>}
  </section>;
}
