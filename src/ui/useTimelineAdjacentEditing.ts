import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { EditProject, TimelineClip } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { planRollEdit, planSlideEdit, rollEditLimits, slideEditLimits, ROLL_LIMIT, SLIDE_LIMIT } from "../application/timelineAdjacentEdits";
import { translateUi as uiText, translateUiStatus } from "./i18n/interfacePreferences";
import { TIMELINE_DRAG_THRESHOLD_PX } from "./timelineInteraction";

interface Host {
  project: EditProject;
  scrollRef: RefObject<HTMLDivElement | null>;
  pixelsPerSecond: number;
  onCommand?: (command: EditorCommand, message?: string) => boolean | void;
  onSelect: (id: string) => void;
  onEditStart?: () => void;
  onRefused?: (message: string) => void;
  readout: (message?: string, limited?: boolean) => void;
  suppressClick: (id: string) => void;
  onDone: () => void;
}
interface Session {
  mode: "roll" | "slide";
  project: EditProject;
  clipId: string;
  clips: TimelineClip[];
  elements: Array<{ clip: TimelineClip; element: HTMLElement }>;
  pointerId: number;
  capture: HTMLElement;
  originX: number;
  currentX: number;
  scrollLeft: number;
  minimum: number;
  maximum: number;
  delta: number;
  requested: number;
  moved: boolean;
}
const CHANGED = "專案剛剛有變更，這次調整沒有套用；請再試一次。";

/** RAF-only transient geometry; a real command is planned and dispatched once, on release. */
export function useTimelineAdjacentEditing(host: Host) {
  const latest = useRef(host); latest.current = host;
  const session = useRef<Session | undefined>(undefined);
  const raf = useRef<number | undefined>(undefined);
  const clear = () => {
    if (raf.current !== undefined) cancelAnimationFrame(raf.current); raf.current = undefined;
    const current = session.current; session.current = undefined;
    if (!current) return;
    const h = latest.current;
    for (const { clip, element } of current.elements) {
      const now = h.project.tracks.flatMap(track => track.clips).find(item => item.id === clip.id);
      element.classList.remove("is-rolling", "is-sliding");
      if (now) {
        element.style.left = `${now.timelineStart * h.pixelsPerSecond}px`;
        element.style.width = `${Math.max(12, now.duration * h.pixelsPerSecond)}px`;
        element.dataset.timelineStart = String(now.timelineStart); element.dataset.duration = String(now.duration);
      }
    }
    try { if (current.capture.hasPointerCapture(current.pointerId)) current.capture.releasePointerCapture(current.pointerId); } catch { /* detached capture */ }
    h.readout(); h.onDone();
    return current;
  };
  useEffect(() => () => { clear(); }, [host.project.id]);
  const begin = (event: ReactPointerEvent<HTMLElement>, mode: Session["mode"], clipId: string, clips: TimelineClip[], minimum: number, maximum: number) => {
    const h = latest.current, node = h.scrollRef.current;
    if (!node || !h.onCommand) return false;
    event.preventDefault(); event.stopPropagation(); h.onEditStart?.(); h.onSelect(clipId);
    const elements = [...node.querySelectorAll<HTMLElement>(".timeline-clip[data-testid]")]
      .flatMap(element => { const clip = clips.find(item => `timeline-clip-${item.id}` === element.dataset.testid); return clip ? [{ clip, element }] : []; });
    const button = event.currentTarget.closest<HTMLElement>(".timeline-clip"); button?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    session.current = { mode, project: h.project, clipId, clips, elements, pointerId: event.pointerId, capture: event.currentTarget,
      originX: event.clientX, currentX: event.clientX, scrollLeft: node.scrollLeft, minimum, maximum, delta: 0, requested: 0, moved: false };
    return true;
  };
  const refuse = (event: ReactPointerEvent<HTMLElement>, clipId: string, error: unknown) => {
    event.preventDefault(); event.stopPropagation(); latest.current.suppressClick(clipId);
    latest.current.onRefused?.(error instanceof Error ? error.message : ADJACENT_FAILED); return true;
  };
  const beginRoll = (event: ReactPointerEvent<HTMLElement>, clipId: string, edge: "start" | "end") => {
    const h = latest.current;
    if (!event.ctrlKey || !h.onCommand || event.button !== 0) return false;
    const element = event.currentTarget.closest<HTMLElement>(".timeline-clip"), rect = element?.getBoundingClientRect();
    if (!rect || Math.abs(event.clientX - (edge === "start" ? rect.left : rect.right)) > 4) return false;
    const track = h.project.tracks.find(track => track.clips.some(clip => clip.id === clipId));
    const ordered = [...(track?.clips ?? [])].sort((a,b) => a.timelineStart-b.timelineStart), index = ordered.findIndex(clip => clip.id === clipId);
    const left = edge === "start" ? ordered[index-1] : ordered[index], right = edge === "start" ? ordered[index] : ordered[index+1];
    if (!left || !right || Math.round((left.timelineStart+left.duration)*h.project.fps) !== Math.round(right.timelineStart*h.project.fps)) return false;
    try { const limits = rollEditLimits(h.project,left.id,right.id); return begin(event,"roll",clipId,[left,right],limits.minimum,limits.maximum); }
    catch (error) { return refuse(event,clipId,error); }
  };
  const beginSlide = (event: ReactPointerEvent<HTMLElement>, clipId: string) => {
    if (!event.altKey || !latest.current.onCommand || event.button !== 0) return false;
    try { const limits = slideEditLimits(latest.current.project,clipId);
      return begin(event,"slide",clipId,[limits.previous,limits.clip,limits.next],limits.minimum,limits.maximum); }
    catch (error) { return refuse(event,clipId,error); }
  };
  const flush = () => {
    raf.current = undefined; const s = session.current, h = latest.current;
    if (!s || h.project !== s.project) return;
    const pixels = s.currentX-s.originX+(h.scrollRef.current?.scrollLeft ?? 0)-s.scrollLeft;
    s.moved ||= Math.abs(pixels) >= TIMELINE_DRAG_THRESHOLD_PX;
    if (!s.moved) return;
    s.requested = Math.round(pixels/h.pixelsPerSecond*s.project.fps);
    const limited = s.requested < s.minimum || s.requested > s.maximum;
    s.delta = s.mode === "roll" ? Math.max(s.minimum,Math.min(s.maximum,s.requested)) : limited ? 0 : s.requested;
    const delta = s.delta/s.project.fps;
    s.elements.forEach(({clip,element}) => {
      const index = s.clips.indexOf(clip);
      const start = clip.timelineStart+(index === 0 ? 0 : delta), duration = clip.duration+(index === 0 ? delta : s.mode === "slide" && index === 1 ? 0 : -delta);
      element.style.left = `${start*h.pixelsPerSecond}px`; element.style.width = `${Math.max(12,duration*h.pixelsPerSecond)}px`;
      element.dataset.timelineStart = String(start); element.dataset.duration = String(duration);
      element.classList.add(s.mode === "roll" ? "is-rolling" : "is-sliding");
    });
    h.readout(limited ? translateUiStatus(s.mode === "roll" ? ROLL_LIMIT : SLIDE_LIMIT)
      : uiText(s.mode === "roll" ? "剪接點移動 {seconds} 秒" : "片段滑動 {seconds} 秒", { seconds: delta.toFixed(2) }),limited);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const s = session.current; if (!s || s.pointerId !== event.pointerId) return false;
    event.preventDefault(); event.stopPropagation(); s.currentX=event.clientX;
    if (raf.current === undefined) raf.current=requestAnimationFrame(flush); return true;
  };
  const finish = (event: ReactPointerEvent<HTMLElement>, cancel=false) => {
    const s = session.current; if (!s || s.pointerId !== event.pointerId) return false;
    event.preventDefault(); event.stopPropagation(); s.currentX=event.clientX;
    if (raf.current !== undefined) cancelAnimationFrame(raf.current); flush(); clear();
    const h=latest.current; if (s.moved) h.suppressClick(s.clipId);
    if (cancel || !s.moved || !s.requested) return true;
    if (h.project !== s.project) { h.onRefused?.(CHANGED); return true; }
    try {
      const plan = s.mode === "roll" ? planRollEdit(h.project,s.clips[0].id,s.clips[1].id,s.requested) : planSlideEdit(h.project,s.clipId,s.requested);
      if (plan) { h.onCommand?.(plan.command,plan.message); if (plan.limited) h.onRefused?.(ROLL_LIMIT); }
    } catch (error) { h.onRefused?.(error instanceof Error ? error.message : ADJACENT_FAILED); }
    return true;
  };
  const cancel = () => { const s=clear(); if (s?.moved) latest.current.suppressClick(s.clipId); return !!s; };
  return { beginRoll,beginSlide,move,finish,cancel,active:()=>!!session.current };
}
const ADJACENT_FAILED = "這次調整沒有套用，片段保持原位。";
