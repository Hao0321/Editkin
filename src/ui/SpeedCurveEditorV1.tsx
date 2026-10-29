import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { ClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import { speedCurveForClipV1 } from "../application/speedCurveEditCommandsV1";
import { createSpeedCurveInteractionV1, speedCurveInteractionErrorKindV1, type SpeedCurveDragTargetV1 } from "../application/speedCurveInteractionV1";
import { createSpeedCurvePresetV1, SPEED_CURVE_PRESETS_V1, type SpeedCurvePresetIdV1 } from "../application/speedCurvePresetsV1";
import { speedCurveAnchorsV1, speedCurvePointWindowV1, insertSpeedCurvePointV1, deleteSpeedCurvePointV1, moveSpeedCurvePointV1, nudgeSpeedCurvePointV1 } from "../application/speedCurveEditorModelV1";
import "./speedCurveEditorV1.css";

/** Labels are required from the host. Proposed five-language pack67 is handed to H15, not a
 * second translation store or an edit to its generated catalogues. No default runtime capability. */
export interface SpeedCurveEditorLabelsV1 {
  title: string; graph: string; add: string; remove: string; previous: string; next: string; reverse: string; mute: string; follow: string;
  time: string; speed: string; reset: string; unavailable: string; pending: string; failed: string; unsupported: string; stale: string;
  locked: string; sourceShort: string; temporal: string; endpoint: string; followUnavailable: string; invalid: string; outside: string;
  help: string; presetAudio: string; candidate: string; preset: Record<SpeedCurvePresetIdV1, string>;
  point(index: number, time: string, speed: string): string;
}
export interface SpeedCurveEditorPropsV1 {
  project: EditProject; clipId: string; playhead: number; labels: SpeedCurveEditorLabelsV1; locale?: string;
  sourceClockHostReady?: boolean; sourceHasAudio?: boolean; followAudioSupported?: boolean;
  previewState?: "idle" | "pending" | "ready" | "failed"; disabled?: boolean;
  onCommand?(command: EditorCommand, expectedRevision: number): void | Promise<void>; onError?(error: unknown): void;
}
const BOX = { width: 640, height: 230, left: 26, top: 14, innerWidth: 588, innerHeight: 184 };
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
function errorLabel(error: unknown, l: SpeedCurveEditorLabelsV1) {
  return l[speedCurveInteractionErrorKindV1(error)];
}
export function SpeedCurveEditorV1(props: SpeedCurveEditorPropsV1) {
  const latest = useRef(props); latest.current = props;
  const alive = useRef(true), svg = useRef<SVGSVGElement>(null), capture = useRef<{ id: number; target: SpeedCurveDragTargetV1; maxSpeed: number; base: ClipTimeRemapV1 } | undefined>(undefined);
  const [draft, setDraft] = useState<ClipTimeRemapV1>(), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const [selected, setSelected] = useState(0), [offset, setOffset] = useState(0), [timeText, setTimeText] = useState(""), [speedText, setSpeedText] = useState("");
  const fieldCancelled = useRef(false);
  const interaction = useRef<ReturnType<typeof createSpeedCurveInteractionV1>>(undefined);
  if (!interaction.current) interaction.current = createSpeedCurveInteractionV1({
    read: () => { const p = latest.current; return { project: p.project, clipId: p.clipId, hostReady: p.sourceClockHostReady && !!p.onCommand,
      disabled: p.disabled, busy: p.previewState === "pending", sourceHasAudio: p.sourceHasAudio, followAudioSupported: p.followAudioSupported }; },
    dispatch: (command, revision) => { const p = latest.current; if (!p.onCommand) throw Error("SPEED_CURVE_UI_UNAVAILABLE"); return p.onCommand(command, revision); },
    onDraft: value => { if (alive.current) setDraft(value); }, onBusy: value => { if (alive.current) setBusy(value); },
    onError: e => { if (alive.current) setError(e); latest.current.onError?.(e); },
  });
  const driver = interaction.current, clip = props.project.tracks.flatMap(t => t.clips).find(c => c.id === props.clipId), asset = props.project.assets.find(a => a.id === clip?.assetId);
  const locked = !!props.project.tracks.find(t => t.id === clip?.trackId)?.locked;
  let saved: ClipTimeRemapV1 | undefined;
  try { if (clip && asset && !asset.clipRetime) saved = speedCurveForClipV1(props.project, clip.id); } catch { /* visible unsupported state below */ }
  const curve = clip && asset ? draft ?? saved : undefined, points = curve ? speedCurveAnchorsV1(curve) : [], selection = clamp(selected, 0, Math.max(0, points.length - 1));
  const point = points[selection], visible = curve ? speedCurvePointWindowV1(curve, offset) : { points: [], offset: 0, total: 0 };
  const canEdit = !!clip && asset?.kind === "video" && !!saved && !locked && !props.disabled && !busy && props.previewState !== "pending" && !!props.sourceClockHostReady && !!props.onCommand;
  const maxSpeed = Math.min(64, Math.max(4, Math.ceil(Math.max(...(curve?.segments.flatMap(s => [s.from.speed, s.control1.speed, s.control2.speed, s.to.speed]) ?? [4])))));
  const number = new Intl.NumberFormat(props.locale ?? "zh-TW", { maximumSignificantDigits: 6 });
  const xy = (p: { time: number; speed: number }) => ({ x: BOX.left + p.time * BOX.innerWidth, y: BOX.top + (1 - p.speed / maxSpeed) * BOX.innerHeight });
  const release = () => { const c = capture.current; capture.current = undefined; if (c && svg.current?.hasPointerCapture(c.id)) svg.current.releasePointerCapture(c.id); };
  const cancel = () => { release(); driver.cancel(); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; release(); driver.cancel(); }; }, []);
  useEffect(() => { cancel(); setError(undefined); }, [props.project.revision, props.project.id, props.clipId, props.sourceClockHostReady, props.disabled, props.previewState === "pending"]);
  useEffect(() => { setTimeText(point && clip ? String(point.time * clip.duration) : ""); setSpeedText(point ? String(point.speed) : ""); },
    [props.project.revision, props.clipId, selection, point?.time, point?.speed, clip?.duration]);
  const change = (edit: (c: ClipTimeRemapV1) => ClipTimeRemapV1) => { setError(undefined); return driver.change(edit); };
  const add = () => change(c => {
    const p = latest.current, target = p.project.tracks.flatMap(t => t.clips).find(c => c.id === p.clipId)!;
    const time = (p.playhead - target.timelineStart) / target.duration;
    if (time < 0 || time > 1) throw Error("SPEED_CURVE_UI_PLAYHEAD_OUTSIDE");
    const result = insertSpeedCurvePointV1(c, time); setSelected(result.pointIndex); setOffset(Math.max(0, result.pointIndex - 7)); return result.curve;
  });
  const start = (target: SpeedCurveDragTargetV1, e: PointerEvent<SVGCircleElement>) => {
    if (!canEdit || e.button !== 0 || !curve || !svg.current) return;
    e.preventDefault(); e.stopPropagation(); setError(undefined); if (!driver.begin(target)) return;
    try { svg.current.setPointerCapture(e.pointerId); capture.current = { id: e.pointerId, target, maxSpeed, base: curve }; }
    catch (error) { driver.cancel(); setError(error); return; }
    e.currentTarget.focus(); if (target.kind === "anchor") setSelected(target.index);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const c = capture.current; if (!c || c.id !== e.pointerId || !svg.current || !clip) return;
    const rect = svg.current.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    let time = clamp(((e.clientX - rect.left) / rect.width * BOX.width - BOX.left) / BOX.innerWidth, 0, 1);
    const speed = clamp((1 - ((e.clientY - rect.top) / rect.height * BOX.height - BOX.top) / BOX.innerHeight) * c.maxSpeed, 0, c.maxSpeed);
    if (c.target.kind === "anchor") {
      const a = speedCurveAnchorsV1(c.base), i = c.target.index;
      if (i === 0 || i === a.length - 1) time = a[i].time;
      else { const gap = a[i + 1].time - a[i - 1].time, epsilon = Math.min(1 / props.project.fps / clip.duration, gap / 4); time = clamp(time, a[i - 1].time + epsilon, a[i + 1].time - epsilon); }
    }
    if (!driver.move({ time, speed })) release();
  };
  const key = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
    if (!canEdit || e.altKey || e.ctrlKey || e.metaKey || (e.target as Element).closest("input,textarea,select,button")) return;
    if (e.key === "Enter") { e.preventDefault(); add(); }
    else if (e.key === "Delete") { e.preventDefault(); change(c => deleteSpeedCurvePointV1(c, selection)); }
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault(); change(c => nudgeSpeedCurvePointV1(c, selection, e.key as "ArrowLeft", clip!.duration, props.project.fps, e.shiftKey));
    }
  };
  const numeric = (kind: "time" | "speed") => {
    if (fieldCancelled.current) { fieldCancelled.current = false; return; }
    const raw = kind === "time" ? timeText : speedText;
    if (!raw.trim() || !Number.isFinite(Number(raw))) { setError(Error("SPEED_CURVE_POINT_INVALID")); setTimeText(point && clip ? String(point.time * clip.duration) : ""); setSpeedText(point ? String(point.speed) : ""); return; }
    const value = Number(raw); if (point && Math.abs(value - (kind === "time" ? point.time * clip!.duration : point.speed)) < 1e-6) return;
    void change(c => { const p = speedCurveAnchorsV1(c)[selection]; return moveSpeedCurvePointV1(c, selection, { time: kind === "time" ? value / clip!.duration : p.time, speed: kind === "speed" ? value : p.speed }); }).then(ok => {
      if (!ok && alive.current) { setTimeText(point && clip ? String(point.time * clip.duration) : ""); setSpeedText(point ? String(point.speed) : ""); }
    });
  };
  const inputKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Escape") { fieldCancelled.current = true; setTimeText(point && clip ? String(point.time * clip.duration) : ""); setSpeedText(point ? String(point.speed) : ""); e.currentTarget.blur(); e.stopPropagation(); } else if (e.key === "Enter") { e.currentTarget.blur(); e.stopPropagation(); } };
  const l = props.labels, sourceFollow = props.sourceHasAudio === false || props.followAudioSupported;
  const status = error ? errorLabel(error, l) : locked ? l.locked : props.previewState === "pending" ? l.pending : props.previewState === "failed" ? l.failed : !props.sourceClockHostReady ? l.unavailable : !saved && !asset?.clipRetime ? l.unsupported : "";
  let path = ""; if (curve) for (const [i, s] of curve.segments.entries()) { const a = xy(s.from), b = xy(s.control1), c = xy(s.control2), d = xy(s.to); path += `${i ? "" : `M${a.x},${a.y}`} C${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`; }
  const controls = curve ? [selection > 0 ? { index: selection - 1, handle: "control2" as const } : undefined, selection < curve.segments.length ? { index: selection, handle: "control1" as const } : undefined].filter(c => !!c) : [];
  return <section className="speed-curve-editor-v1" data-testid="speed-curve-editor" data-busy={busy} tabIndex={0} aria-label={l.title} onKeyDown={key}
    onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && driver.isDragging()) cancel(); }}>
    <div className="speed-curve-heading"><strong>{l.title}</strong><span>{l.candidate}</span></div>
    {status && <p role="status" aria-live="polite" data-testid="speed-curve-status">{status}</p>}
    {asset?.clipRetime ? <button type="button" disabled={locked || busy || props.disabled || !props.onCommand} onClick={() => { void driver.resetB4(); }} data-testid="speed-curve-reset-b4">{l.reset}</button> : <>
      <div className="speed-curve-presets">{SPEED_CURVE_PRESETS_V1.map(p => <button key={p.id} type="button" disabled={!canEdit} data-testid={`speed-curve-preset-${p.id}`} onClick={() => { setSelected(0); setOffset(0); change(() => createSpeedCurvePresetV1(p.id)); }}>{l.preset[p.id]}</button>)}</div>
      <p className="speed-curve-help">{l.presetAudio}</p>
      {curve && <p className="speed-curve-help" data-testid="speed-curve-range">{l.speed} {number.format(0)}–{number.format(maxSpeed)}×</p>}
      {curve && <svg ref={svg} viewBox={`0 0 ${BOX.width} ${BOX.height}`} preserveAspectRatio="none" role="group" aria-label={l.graph} data-testid="speed-curve-graph"
        onPointerMove={move} onPointerUp={e => { if (capture.current?.id === e.pointerId) { release(); void driver.commit(); } }} onPointerCancel={cancel}
        onLostPointerCapture={e => { if (capture.current?.id === e.pointerId) cancel(); }}>
        {[0, .25, .5, .75, 1].map(t => <path key={t} className="speed-curve-grid" d={`M${BOX.left + t * BOX.innerWidth},${BOX.top}v${BOX.innerHeight} M${BOX.left},${BOX.top + t * BOX.innerHeight}h${BOX.innerWidth}`} />)}
        <path d={path} className="speed-curve-line" />
        {controls.map(c => { const p = xy(curve.segments[c.index][c.handle]); return <circle key={`${c.index}-${c.handle}`} cx={p.x} cy={p.y} r={4} className="speed-curve-handle" data-testid={`speed-curve-handle-${c.index}-${c.handle}`} aria-label={l.graph} role="button" tabIndex={canEdit ? 0 : -1} onPointerDown={e => start({ kind: "handle", ...c }, e)} />; })}
        {visible.points.map(p => { const q = xy(p); return <circle key={p.index} cx={q.x} cy={q.y} r={selection === p.index ? 7 : 5} className="speed-curve-point" data-selected={selection === p.index} role="button" tabIndex={canEdit ? 0 : -1}
          aria-disabled={!canEdit} aria-label={l.point(p.index + 1, number.format(p.time * clip!.duration), number.format(p.speed))} data-testid={`speed-curve-point-${p.index}`} onFocus={() => setSelected(p.index)} onPointerDown={e => start({ kind: "anchor", index: p.index }, e)} />; })}
      </svg>}
      {curve && <div className="speed-curve-axis-labels" aria-hidden="true"><span>{number.format(0)}</span><span>{number.format(clip?.duration ?? 0)}</span></div>}
      <div className="speed-curve-point-list"><button type="button" disabled={visible.offset === 0} onClick={() => setOffset(Math.max(0, visible.offset - 8))} data-testid="speed-curve-previous">{l.previous}</button>
        {visible.points.map(p => <button key={p.index} type="button" aria-pressed={selection === p.index} aria-label={l.point(p.index + 1, number.format(p.time * clip!.duration), number.format(p.speed))} onClick={() => setSelected(p.index)} data-testid={`speed-curve-select-${p.index}`}>{number.format(p.index + 1)}</button>)}
        <button type="button" disabled={visible.offset + 8 >= visible.total} onClick={() => setOffset(visible.offset + 8)} data-testid="speed-curve-next">{l.next}</button></div>
      <div className="speed-curve-fields"><label>{l.time}<input type="number" min={0} max={clip?.duration} step={1 / props.project.fps} value={timeText} disabled={!canEdit || !point || selection === 0 || selection === points.length - 1} onChange={e => setTimeText(e.currentTarget.value)} onBlur={() => numeric("time")} onKeyDown={inputKey} data-testid="speed-curve-time" /></label>
        <label>{l.speed}<input type="number" min={0} max={64} step={.1} value={speedText} disabled={!canEdit || !point} onChange={e => setSpeedText(e.currentTarget.value)} onBlur={() => numeric("speed")} onKeyDown={inputKey} data-testid="speed-curve-speed" /></label></div>
      <div className="speed-curve-actions"><button type="button" disabled={!canEdit} onClick={add} data-testid="speed-curve-add">{l.add}</button><button type="button" disabled={!canEdit || selection === 0 || selection === points.length - 1} onClick={() => change(c => deleteSpeedCurvePointV1(c, selection))} data-testid="speed-curve-remove">{l.remove}</button>
        <button type="button" aria-pressed={curve?.direction === "reverse"} disabled={!canEdit} onClick={() => change(c => ({ ...c, direction: c.direction === "reverse" ? "forward" : "reverse" }))} data-testid="speed-curve-reverse">{l.reverse}</button></div>
      <div className="speed-curve-actions" role="group" aria-label={l.follow}><button type="button" disabled={!canEdit} aria-pressed={curve?.audioMode === "mute"} onClick={() => change(c => ({ ...c, audioMode: "mute" }))} data-testid="speed-curve-mute">{l.mute}</button>
        <button type="button" disabled={!canEdit || !sourceFollow} aria-pressed={curve?.audioMode === "follow_speed"} onClick={() => change(c => ({ ...c, audioMode: "follow_speed" }))} data-testid="speed-curve-follow">{l.follow}</button></div>
      {!sourceFollow && <p className="speed-curve-help">{l.followUnavailable}</p>}<p className="speed-curve-help">{l.help}</p>
    </>}
  </section>;
}
