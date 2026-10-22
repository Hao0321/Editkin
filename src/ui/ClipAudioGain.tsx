import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useMemo, useRef, useState } from "react";
import { createParameterRangeGestureInputV1 } from "./parameterRangeGestureInputV1";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import { assertClipVolume, clipVolumeDb, clipVolumeFromDb, MAX_CLIP_GAIN_DB, MIN_AUDIBLE_GAIN_DB } from "../domain/audioGain";
import "./clipAudioGain.css";

export interface ClipAudioGainProps {
  clipId: string;
  volume: number;
  onVolumeChange(volume: number): boolean | void;
  onGestureStart?: () => ParameterGestureLeaseV1 | undefined;
  previewVolume?: number;
  editScope?: unknown;
  disabled?: boolean;
  compact?: boolean;
}
/** Same existing volume command; no new project fields or browser audio executor. */
export function ClipAudioGain({ clipId, volume, onVolumeChange, onGestureStart, previewVolume, editScope, disabled = false, compact = false }: ClipAudioGainProps) {
  useI18n();
  const validVolume = Number.isFinite(volume) && volume >= 0 && volume <= 2;
  const displayVolume = previewVolume ?? volume;
  const db = validVolume ? clipVolumeDb(displayVolume) : null;
  const currentDb = useRef(db), submitted = useRef(volume);
  currentDb.current = db;
  const gestureInput = useMemo(() => createParameterRangeGestureInputV1(), []);
  useEffect(() => () => gestureInput.cancel(), [gestureInput, clipId, editScope]);
  const rangeGesture = onGestureStart ? gestureInput.bind(clipId, () => { currentDb.current = db; return onGestureStart(); }) : undefined;
  const [draft, setDraft] = useState(String(volume * 100)), [error, setError] = useState("");
  const draftEdited = useRef(false);
  const lastAudible = useRef({ clipId, volume: volume > 0 && validVolume ? volume : 1 });
  const blocked = disabled || !validVolume;
  useEffect(() => {
    submitted.current = volume;
    setDraft(String(Number((volume * 100).toFixed(8)))); setError(""); draftEdited.current = false;
    if (lastAudible.current.clipId !== clipId) lastAudible.current = { clipId, volume: volume > 0 && validVolume ? volume : 1 };
    else if (validVolume && volume > 0) lastAudible.current.volume = volume;
  }, [clipId, volume, validVolume]);
  useEffect(() => { if (!draftEdited.current) setDraft(String(Number((displayVolume * 100).toFixed(8)))); }, [displayVolume]);
  const send = (value: number) => {
    if (blocked) return;
    gestureInput.cancel();
    assertClipVolume(value); setError(""); draftEdited.current = false;
    if (value !== submitted.current && onVolumeChange(value) !== false) submitted.current = value;
  };
  const commitPercentage = () => {
    if (blocked || !draftEdited.current) return;
    if (!draft.trim() || !/^\d+(?:\.\d*)?$/.test(draft) || !Number.isFinite(Number(draft)) || Number(draft) > 200) {
      setError("請輸入 0–200% 的音量"); return;
    }
    send(Number(draft) / 100);
  };
  return <section className={`clip-audio-gain${compact ? " compact" : ""}`} aria-label={uiText("片段音量")} data-clip-id={clipId}>
    <header><strong>{uiText("片段音量")}</strong><output aria-live="polite">{displayVolume === 0 ? uiText("靜音") : db === null ? uiText("無效音量") : `${db > 0 ? "+" : ""}${db.toFixed(2)} dB`}</output></header>
    <label className="clip-audio-gain-range">{uiText("增益")}<input aria-label={uiText("片段增益 dB")} type="range" min={MIN_AUDIBLE_GAIN_DB} max={MAX_CLIP_GAIN_DB} step="any"
        {...rangeGesture?.events}
        value={db === null ? MIN_AUDIBLE_GAIN_DB : Math.max(MIN_AUDIBLE_GAIN_DB, db)} disabled={blocked}
        onChange={event => {
          const value = clipVolumeFromDb(Number(event.target.value)); currentDb.current = Number(event.target.value);
          if (!rangeGesture?.change(event.currentTarget, value)) send(value);
        }}
        onKeyDown={event => {
          if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
          rangeGesture?.events.onKeyDown(event);
          if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? MIN_AUDIBLE_GAIN_DB : event.key === "End" ? MAX_CLIP_GAIN_DB
            : Math.max(MIN_AUDIBLE_GAIN_DB, Math.min(MAX_CLIP_GAIN_DB, (currentDb.current ?? MIN_AUDIBLE_GAIN_DB) + (["ArrowRight", "ArrowUp"].includes(event.key) ? 0.5 : -0.5)));
          currentDb.current = next;
          const value = clipVolumeFromDb(next);
          if (!rangeGesture?.change(event.currentTarget, value)) send(value);
        }} />
    </label>
    {!compact && <div className="clip-audio-gain-input"><label>{uiText("精確音量")}<input aria-label={uiText("精確音量百分比")} data-testid="clip-volume-input" type="text" inputMode="decimal" value={draft} disabled={blocked}
      aria-invalid={Boolean(error)} onChange={event => { draftEdited.current = true; setDraft(event.target.value); setError(""); }} onBlur={commitPercentage}
      onKeyDown={event => { if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return; if (event.key === "Enter") { event.preventDefault(); commitPercentage(); } else if (event.key === "Escape") { draftEdited.current = false; setDraft(String(Number((volume * 100).toFixed(8)))); setError(""); } }} /><span>%</span></label></div>}
    <div className="clip-audio-gain-actions"><button type="button" aria-pressed={volume === 0} disabled={blocked} onClick={() => send(volume === 0
      ? lastAudible.current.clipId === clipId ? lastAudible.current.volume : 1 : 0)}>{volume === 0 ? uiText("恢復音量") : uiText("靜音")}</button>
      <button type="button" disabled={blocked || displayVolume === 1} onClick={() => send(1)}>{uiText("還原 0 dB")}</button></div>
    {error && <p role="alert">{error}</p>}
    {!validVolume && <p role="alert">{uiText("片段音量不合法，請先檢查專案。")}</p>}
    {!compact && <small>{uiText("0 dB = 原始音量。增益會改變音量；多軌混音仍需檢查峰值。")}</small>}
  </section>;
}
