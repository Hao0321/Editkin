import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { TimelineClip } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { clipVolumePointDbAt, visibleClipFadeSeconds, withClipAudioFades, withClipVolumePoint, withoutClipVolumePoint, type ClipAudioEnvelope } from "../domain/clipAudioEnvelope";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { translateUi as t } from "./i18n/interfacePreferences";
import "./clipAudioEnvelope.css";

interface Props {
  clip: TimelineClip;
  pixelsPerSecond: number;
  music?: boolean;
  locked: boolean;
  onCommand(command: EditorCommand, message?: string): boolean | void;
  onEditStart?(): void;
  onRefused?(message: string): void;
}
interface Gesture { pointer: number; element: HTMLElement; clip: TimelineClip; startX: number; startY: number; height: number;
  kind: "in" | "out" | "point"; pointId?: string; inSeconds: number; outSeconds: number; db: number; moved: boolean; }
export function TimelineAudioEnvelope({ clip, pixelsPerSecond, music = false, locked, onCommand, onEditStart, onRefused }: Props) {
  const [draft, setDraft] = useState<ClipAudioEnvelope>(), gesture = useRef<Gesture | undefined>(undefined), last = useRef({x:0,y:0});
  const frame = useRef<number | undefined>(undefined), current = useRef(clip); current.current = clip;
  const cancel = () => {
    const active = gesture.current; gesture.current = undefined;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; setDraft(undefined);
    if (active?.element.hasPointerCapture?.(active.pointer)) active.element.releasePointerCapture(active.pointer);
  };
  useEffect(() => {
    if (gesture.current && gesture.current.clip !== clip) cancel();
  }, [clip]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("keydown", escape, true); const active = gesture.current; gesture.current = undefined;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      if (active?.element.hasPointerCapture?.(active.pointer)) active.element.releasePointerCapture(active.pointer); };
  }, []);
  const edited = draft ? { ...clip, audioEnvelope: draft } : clip, fades = visibleClipFadeSeconds(edited, music);
  const width = Math.max(12, clip.duration * pixelsPerSecond), volume = edited.audioEnvelope?.volume;
  const commit = (envelope: ClipAudioEnvelope | undefined) => {
    if (locked) { onRefused?.(TRACK_LOCKED_MESSAGE); return; }
    onCommand({ type: "set_clip_audio_envelope", clipId: clip.id, envelope }, "已更新聲音淡化與音量點，可一次復原。");
  };
  const begin = (event: ReactPointerEvent<HTMLElement>, kind: Gesture["kind"], pointId?: string) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    if (locked) { onRefused?.(TRACK_LOCKED_MESSAGE); return; }
    const button = event.currentTarget.closest(".timeline-clip")! as HTMLElement;
    const original = visibleClipFadeSeconds(clip, music), point = clip.audioEnvelope?.volume?.points.find(p => p.id === pointId);
    gesture.current = {pointer:event.pointerId,element:event.currentTarget,clip,startX:event.clientX,startY:event.clientY,height:button.getBoundingClientRect().height,
      kind,pointId,inSeconds:original.in,outSeconds:original.out,db:point?.db ?? 0,moved:false};
    last.current = {x:event.clientX,y:event.clientY}; onEditStart?.(); event.currentTarget.setPointerCapture(event.pointerId);
  };
  const build = (active: Gesture) => {
    if (active.kind === "point") {
      const point = active.clip.audioEnvelope!.volume!.points.find(p => p.id === active.pointId)!;
      const db = Math.max(-30, Math.min(6, active.db - (last.current.y - active.startY) / (active.height * .5) * 36));
      return withClipVolumePoint(active.clip, {...point,time:point.time-active.clip.audioEnvelope!.volume!.offset,db:Math.round(db*10)/10});
    }
    const delta = (last.current.x - active.startX) / pixelsPerSecond * (active.kind === "in" ? 1 : -1);
    const other = active.kind === "in" ? active.outSeconds : active.inSeconds;
    const value = Math.max(0, Math.min(5, active.clip.duration - other, (active.kind === "in" ? active.inSeconds : active.outSeconds) + delta));
    const exact = Math.min(value, Math.round(value*1000)/1000);
    return withClipAudioFades(active.clip, active.kind === "in" ? exact : active.inSeconds,
      active.kind === "out" ? exact : active.outSeconds);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const active = gesture.current; if (!active || event.pointerId !== active.pointer) return;
    event.preventDefault(); event.stopPropagation(); last.current = {x:event.clientX,y:event.clientY};
    active.moved ||= Math.abs(event.clientX-active.startX) + Math.abs(event.clientY-active.startY) >= 2;
    if (frame.current === undefined) frame.current = requestAnimationFrame(() => { frame.current = undefined; if (gesture.current === active) setDraft(build(active)); });
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const active = gesture.current; if (!active || event.pointerId !== active.pointer) return;
    event.preventDefault(); event.stopPropagation(); last.current = {x:event.clientX,y:event.clientY};
    let result: ClipAudioEnvelope | undefined;
    try { if (active.moved && current.current === active.clip) result = build(active); }
    catch (error) { onRefused?.(error instanceof Error ? error.message : String(error)); }
    cancel(); if (result) commit(result);
  };
  const handlers = {onPointerMove:move,onPointerUp:end,onPointerCancel:cancel,onLostPointerCapture:cancel,onClick:(e:ReactMouseEvent)=>e.stopPropagation()};
  const points = volume?.points.filter(p => p.time-volume.offset >= 0 && p.time-volume.offset <= clip.duration) ?? [];
  const curveTimes = [...new Set([0, clip.duration, ...points.map(p=>p.time-volume!.offset)])].sort((a,b)=>a-b);
  return <span className="timeline-audio-envelope" data-testid={`timeline-audio-envelope-${clip.id}`}>
    <svg className="timeline-audio-fades" viewBox={`0 0 ${width} 56`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`M 0 56 L ${fades.in*pixelsPerSecond} 0 M ${width-fades.out*pixelsPerSecond} 0 L ${width} 56`} />
    </svg>
    <svg className="timeline-audio-volume-line" viewBox={`0 0 ${width} 36`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={curveTimes.map(time=>`${time*pixelsPerSecond},${6-clipVolumePointDbAt(edited,time)}`).join(" ")} />
    </svg>
    {(["in", "out"] as const).map(edge => <span key={edge} className="timeline-audio-fade-handle" data-testid={`timeline-audio-fade-${edge}-${clip.id}`}
      title={t(edge === "in" ? "淡入（秒）" : "淡出（秒）")} aria-hidden="true"
      style={{left:Math.max(4,Math.min(width-4,edge === "in" ? fades.in*pixelsPerSecond : width-fades.out*pixelsPerSecond))-4}}
      onPointerDown={e=>begin(e,edge)} {...handlers} />)}
    {points.map(point => <span key={point.id} className="timeline-audio-volume-point" data-testid={`timeline-audio-volume-point-${point.id}`} data-db={point.db}
      style={{left:Math.max(4,Math.min(width-4,(point.time-volume!.offset)*pixelsPerSecond))-4,top:`${40+(6-point.db)/36*50}%`}}
      title={t("音量點（dB）") + ` ${Number(point.db.toFixed(1))}`} aria-hidden="true" onPointerDown={e=>begin(e,"point",point.id)}
      onDoubleClick={e=>{e.preventDefault();e.stopPropagation();commit(withoutClipVolumePoint(clip,point.id));}} {...handlers} />)}
    {draft && <span className="timeline-audio-envelope-readout">{gesture.current?.kind === "point"
      ? `${Number(draft.volume!.points.find(p=>p.id===gesture.current?.pointId)!.db.toFixed(1))} dB`
      : t("淡化 {seconds} 秒",{seconds:Number((gesture.current?.kind === "in" ? fades.in : fades.out).toFixed(3))})}</span>}
  </span>;
}
