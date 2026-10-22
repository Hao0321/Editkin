import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { TimelineSelection } from "../application/timelineSelection";
import { planCloseGap } from "../application/timelineCanvasEdits";
import { planTimelineGroupMove } from "../application/timelineGroupMove";
import { marqueeBox, marqueeSelection, playheadPageScroll, type CanvasBox } from "./timelineCanvasGeometry";
import { trackMenuPosition } from "./trackMenuPosition";
import { translateUi as uiText } from "./i18n/interfacePreferences";
import { createTimelineGroupSelectionBounds } from "./timelineGroupSelectionBounds";

interface Host {
  project: EditProject; scrollRef: RefObject<HTMLDivElement | null>; pixelsPerSecond: number; playing: boolean; playhead: number;
  selection: TimelineSelection; onSelectionChange?: (value: TimelineSelection) => void; otherBusy: () => boolean;
  onEditStart?: () => void; onCommand?: (command: EditorCommand, message?: string) => unknown; onRefused?: (message: string) => void;
}
interface PointerSession {
  id: number; element: HTMLElement; x: number; y: number; scrollLeft: number; scrollTop: number; moved: boolean; project: EditProject;
}
interface GroupSession extends PointerSession {
  selection: TimelineSelection; originTrackId: string; trackId: string; frames: number; elements: HTMLElement[]; anchorStart: number;
  bounds: ReturnType<typeof createTimelineGroupSelectionBounds>;
}

export function useTimelineCanvasEditing(host: Host) {
  const latest = useRef(host); latest.current = host;
  const marquee = useRef<(PointerSession & { initial?: TimelineSelection; before: TimelineSelection }) | undefined>(undefined);
  const group = useRef<GroupSession | undefined>(undefined);
  const suppress = useRef<string | undefined>(undefined);
  const userUntil = useRef(0);
  const userScrolling = useRef(false);
  const [rectangle, setRectangle] = useState<CanvasBox>();
  const [gap, setGap] = useState<{ x: number; y: number; trackId: string; time: number }>();
  const busy = () => !!marquee.current || !!group.current;
  const cleanGroup = () => { for (const element of group.current?.elements ?? []) { element.style.removeProperty("transform"); element.classList.remove("is-dragging"); } group.current?.bounds.clear(); };
  useEffect(() => {
    const node = host.scrollRef.current; if (!node) return;
    const wheel = () => { userUntil.current = performance.now() + 800; };
    const down = (event: Event) => { if (event.target === node) { userScrolling.current = true; userUntil.current = performance.now() + 800; } };
    const up = () => { if (userScrolling.current) { userScrolling.current = false; userUntil.current = performance.now() + 800; } };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !busy()) return; event.preventDefault(); event.stopPropagation();
      if (marquee.current) latest.current.onSelectionChange?.(marquee.current.before);
      suppress.current = group.current ? "item" : "lane";
      cleanGroup(); group.current = undefined; marquee.current = undefined; setRectangle(undefined);
    };
    node.addEventListener("wheel", wheel, { passive: true }); node.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up); document.addEventListener("keydown", escape, true);
    return () => { node.removeEventListener("wheel", wheel); node.removeEventListener("pointerdown", down); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); document.removeEventListener("keydown", escape, true); cleanGroup(); };
  }, []);
  useEffect(() => {
    const node = host.scrollRef.current; if (!node) return;
    const page = playheadPageScroll({ playing: host.playing, busy: busy() || userScrolling.current || host.otherBusy(), now: performance.now(), userUntil: userUntil.current,
      left: node.scrollLeft, width: Math.max(0, node.clientWidth - 188), playheadX: host.playhead * host.pixelsPerSecond });
    if (page !== undefined) node.scrollLeft = page;
  }, [host.playhead, host.playing, host.pixelsPerSecond]);
  useEffect(() => { cleanGroup(); group.current = undefined; marquee.current = undefined; setRectangle(undefined); setGap(undefined); }, [host.project.id]);

  const beginMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!latest.current.onSelectionChange || event.button !== 0 || !event.currentTarget.matches(".track-lane[data-track-id]")) return false;
    if ((event.target as HTMLElement).closest(".timeline-clip")) return false;
    event.preventDefault(); event.stopPropagation(); latest.current.onEditStart?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    const node = latest.current.scrollRef.current;
    marquee.current = { id: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, scrollLeft: node?.scrollLeft ?? 0,
      scrollTop: node?.scrollTop ?? 0, moved: false, project: latest.current.project,
      before: structuredClone(latest.current.selection), initial: event.shiftKey || event.ctrlKey || event.metaKey ? latest.current.selection : undefined };
    return true;
  };
  const moveMarquee = (event: ReactPointerEvent<HTMLElement>) => {
    const session = marquee.current, current = latest.current, node = current.scrollRef.current;
    if (!session || session.id !== event.pointerId || !node) return false;
    event.preventDefault(); event.stopPropagation(); session.moved ||= Math.hypot(event.clientX - session.x, event.clientY - session.y) >= 3;
    if (!session.moved) return true;
    const nodeBox = node.getBoundingClientRect();
    const originX = session.x - nodeBox.left + session.scrollLeft, originY = session.y - nodeBox.top + session.scrollTop;
    const box = marqueeBox(originX, originY, event.clientX - nodeBox.left + node.scrollLeft, event.clientY - nodeBox.top + node.scrollTop);
    setRectangle(box);
    const items = [...node.querySelectorAll<HTMLElement>(".timeline-clip[data-testid]")].map(element => {
      const rect = element.getBoundingClientRect(), caption = element.dataset.testid?.startsWith("timeline-caption-");
      return { kind: caption ? "caption" as const : "clip" as const, id: element.dataset.testid!.slice(caption ? "timeline-caption-".length : "timeline-clip-".length),
        box: { left: rect.left - nodeBox.left + node.scrollLeft, right: rect.right - nodeBox.left + node.scrollLeft,
          top: rect.top - nodeBox.top + node.scrollTop, bottom: rect.bottom - nodeBox.top + node.scrollTop } };
    });
    current.onSelectionChange?.(marqueeSelection(box, items, session.initial)); return true;
  };
  const finishMarquee = (event: ReactPointerEvent<HTMLElement>, cancel = false) => {
    const session = marquee.current; if (!session || session.id !== event.pointerId) return false;
    if (!cancel) moveMarquee(event); marquee.current = undefined; setRectangle(undefined);
    if (cancel) latest.current.onSelectionChange?.(session.before);
    if (session.moved) suppress.current = "lane";
    else if (!cancel) latest.current.onSelectionChange?.({ clipIds: [], captionIds: [] });
    return true;
  };

  const beginGroup = (event: ReactPointerEvent<HTMLButtonElement>, item: { kind: "clip" | "caption"; id: string; trackId: string; start: number }) => {
    const current = latest.current, ids = item.kind === "clip" ? current.selection.clipIds : current.selection.captionIds;
    if (!current.onCommand || !current.onSelectionChange || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
      || !ids.includes(item.id) || current.selection.clipIds.length + current.selection.captionIds.length < 2) return false;
    event.preventDefault(); event.stopPropagation(); current.onEditStart?.(); event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const elements = [...(current.scrollRef.current?.querySelectorAll<HTMLElement>(".timeline-clip.selected") ?? [])];
    group.current = { id: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, scrollLeft: current.scrollRef.current?.scrollLeft ?? 0,
      scrollTop: current.scrollRef.current?.scrollTop ?? 0, project: current.project, moved: false, selection: structuredClone(current.selection),
      originTrackId: item.trackId, trackId: item.trackId, frames: 0, elements, anchorStart: item.start, bounds: createTimelineGroupSelectionBounds() };
    return true;
  };
  const moveGroup = (event: ReactPointerEvent<HTMLElement>) => {
    const session = group.current, current = latest.current, node = current.scrollRef.current;
    if (!session || session.id !== event.pointerId || !node) return false;
    event.preventDefault(); event.stopPropagation();
    const deltaX = event.clientX - session.x + node.scrollLeft - session.scrollLeft;
    session.moved ||= Math.hypot(event.clientX - session.x, event.clientY - session.y) >= 3;
    session.frames = Math.round(deltaX / current.pixelsPerSecond * current.project.fps);
    const minimumStart = session.bounds.minimumStart(current.project, session.selection);
    if (minimumStart !== undefined) session.frames = Math.max(-Math.round(minimumStart * current.project.fps), session.frames);
    const lanes = [...node.querySelectorAll<HTMLElement>(".track-lane[data-track-id]")];
    const destination = lanes.find(lane => { const r = lane.getBoundingClientRect(); return event.clientY >= r.top && event.clientY < r.bottom; });
    const origin = lanes.find(lane => lane.dataset.trackId === session.originTrackId);
    session.trackId = destination?.dataset.trackKind === origin?.dataset.trackKind ? destination?.dataset.trackId ?? session.originTrackId : session.originTrackId;
    const y = destination && origin && session.trackId !== session.originTrackId ? destination.getBoundingClientRect().top - origin.getBoundingClientRect().top : 0;
    for (const element of session.elements) { element.style.transform = `translate3d(${session.frames / current.project.fps * current.pixelsPerSecond}px,${element.classList.contains("caption") ? 0 : y}px,0)`; element.classList.toggle("is-dragging", session.moved); }
    return true;
  };
  const finishGroup = (event: ReactPointerEvent<HTMLElement>, cancel = false) => {
    const session = group.current; if (!session || session.id !== event.pointerId) return false;
    if (!cancel) moveGroup(event); cleanGroup(); group.current = undefined;
    if (!session.moved) return true; suppress.current = "item";
    if (cancel) return true;
    const current = latest.current;
    try {
      if (current.project !== session.project) throw new Error("專案剛剛有變更，這次移動沒有套用；請再試一次。");
      const plan = planTimelineGroupMove(current.project, session.selection, session.frames, session.originTrackId, session.trackId);
      if (plan) current.onCommand?.(plan.command, plan.message);
    } catch (error) { current.onRefused?.(error instanceof Error ? error.message : String(error)); }
    return true;
  };
  const consumeClick = (kind: "item" | "lane") => { if (suppress.current !== kind) return false; suppress.current = undefined; return true; };
  const contextGap = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".timeline-clip") || !latest.current.onCommand) return;
    const trackId = event.currentTarget.dataset.trackId, time = (event.clientX - event.currentTarget.getBoundingClientRect().left) / latest.current.pixelsPerSecond;
    if (!trackId) return; event.preventDefault(); event.stopPropagation();
    try { planCloseGap(latest.current.project, trackId, time); setGap({ x: event.clientX, y: event.clientY, trackId, time }); }
    catch (error) { latest.current.onRefused?.(error instanceof Error ? error.message : String(error)); }
  };
  const applyGap = () => {
    if (!gap) return; setGap(undefined); latest.current.onEditStart?.();
    try { const plan = planCloseGap(latest.current.project, gap.trackId, gap.time); latest.current.onCommand?.(plan.command, plan.message); }
    catch (error) { latest.current.onRefused?.(error instanceof Error ? error.message : String(error)); }
  };
  return { busy, beginMarquee, moveMarquee, finishMarquee, beginGroup, moveGroup, finishGroup, consumeClick, contextGap,
    overlays: <>{rectangle && <div className="timeline-marquee" style={{ left: rectangle.left, top: rectangle.top, width: rectangle.right - rectangle.left, height: rectangle.bottom - rectangle.top }} data-testid="timeline-marquee" />}
      {gap && <GapMenu x={gap.x} y={gap.y} onClose={() => setGap(undefined)} onApply={applyGap} />}</> };
}

function GapMenu({ x, y, onClose, onApply }: { x: number; y: number; onClose: () => void; onApply: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector("button")?.focus();
    const dismiss = (event: Event) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", dismiss, true); document.addEventListener("scroll", dismiss, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("scroll", dismiss, true); document.removeEventListener("keydown", key, true); };
  }, [onClose]);
  return createPortal(<div ref={menu} className="track-options-menu" role="menu" style={trackMenuPosition({ left: x, top: y, bottom: y }, window.innerWidth, window.innerHeight)} data-testid="timeline-gap-menu">
    <button type="button" role="menuitem" onClick={onApply} data-testid="timeline-close-gap">{uiText("刪除空隙")}</button></div>, document.body);
}
