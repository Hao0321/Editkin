import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { EditProject, TimelineTrack } from "../domain/types";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { MotionLibraryIcon } from "./MotionLibraryIcons";
import type { MotionLibraryControllerV1 } from "./motionLibraryControllerV1";
import { defaultTransitionFramesV1, listTrackCutsV1, matteTransitionFrameLimitsV1, resizeTransitionWindowV1, sameCutV1,
  type MotionLibraryCutPointV1, type MotionLibraryTransitionWindowV1 } from "./motionLibraryCutsV1";
import type { MotionLibraryUiStoreV1 } from "./motionLibraryUiStoreV1";
import "./motionLibraryTimeline.css";

/**
 * Cut points on one video track (roadmap 2.4, PHASE3_INTEGRATION_DESIGN §4), drawn inside the timeline lane:
 * - hovering a cut shows an 18 px transition button; clicking it opens the panel's 轉場 tab focused on that cut;
 * - right-click (button or diamond): 溶接 0.5 s / 黑場 0.5 s / 動態轉場… / 移除;
 * - an applied transition is a 10 px diamond on the cut over its window; dragging the window's edges changes its length
 *   (one Undo; a motion transition re-renders at the new length first); click selects it, Delete removes it.
 * The overlay takes pointer events only on its own controls, so clips, trims and the playhead behave as before.
 */

export interface TimelineCutPointsProps {
  readonly project: EditProject;
  readonly track: TimelineTrack;
  readonly pixelsPerSecond: number;
  readonly controller: MotionLibraryControllerV1;
  readonly store: MotionLibraryUiStoreV1;
}

const HOVER_PX = 14;
const keyOf = (cut: Pick<MotionLibraryCutPointV1, "fromClipId" | "toClipId">) => `${cut.fromClipId}\u0000${cut.toClipId}`;
let itemNames: Map<string, string> | undefined;
let itemNamesLoading: Promise<Map<string, string>> | undefined;
function loadItemNames(): Promise<Map<string, string>> {
  itemNamesLoading ??= import("../motionLibrary/catalog").then(module => (itemNames = new Map(module.MOTION_LIBRARY_CATALOG.map(item => [item.id, item.names.zh]))));
  return itemNamesLoading;
}

interface MenuState { readonly cut: MotionLibraryCutPointV1; readonly x: number; readonly y: number }
interface ResizeState { readonly transitionId: string; readonly window: MotionLibraryTransitionWindowV1 }

export function TimelineCutPointsV1({ project, track, pixelsPerSecond, controller, store }: TimelineCutPointsProps) {
  useI18n();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const cuts = useMemo(() => listTrackCutsV1(project, track.id), [project, track.id]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<string>();
  const [menu, setMenu] = useState<MenuState>();
  const [resize, setResize] = useState<ResizeState>();
  const [names, setNames] = useState(itemNames);
  const fps = project.fps;
  const editable = !track.locked;

  useEffect(() => {
    if (!names && cuts.some(cut => cut.transition?.motionLibrary)) void loadItemNames().then(setNames);
  }, [cuts, names]);

  // Hover detection on the lane itself: the overlay never blocks clips; only its buttons take the pointer.
  useEffect(() => {
    const lane = rootRef.current?.parentElement;
    if (!lane || !editable) return;
    const move = (event: PointerEvent) => {
      if (event.buttons !== 0 || (event.target instanceof Element && event.target.closest(".ml-cut-window"))) { setHovered(undefined); return; }
      const left = lane.getBoundingClientRect().left;
      const near = cuts.filter(cut => cut.eligible && !cut.transition)
        .map(cut => ({ cut, distance: Math.abs(left + cut.time * pixelsPerSecond - event.clientX) }))
        .filter(entry => entry.distance <= HOVER_PX).sort((a, b) => a.distance - b.distance)[0];
      setHovered(near ? keyOf(near.cut) : undefined);
    };
    const leave = () => setHovered(undefined);
    lane.addEventListener("pointermove", move);
    lane.addEventListener("pointerleave", leave);
    return () => { lane.removeEventListener("pointermove", move); lane.removeEventListener("pointerleave", leave); };
  }, [cuts, pixelsPerSecond, editable]);

  const openPanel = (cut: MotionLibraryCutPointV1) => store.openPanel({ tab: "transition", focusCut: { trackId: cut.trackId, fromClipId: cut.fromClipId, toClipId: cut.toClipId } });
  const openMenu = (event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, cut: MotionLibraryCutPointV1) => {
    event.preventDefault(); event.stopPropagation();
    if (!editable) return;
    setMenu({ cut, x: event.clientX, y: event.clientY });
  };

  const beginResize = (event: ReactPointerEvent<HTMLElement>, cut: MotionLibraryCutPointV1, edge: "before" | "after") => {
    const transition = cut.transition;
    if (!transition || !editable || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget, pointerId = event.pointerId, startX = event.clientX;
    const limits = transition.kernel === "matte" ? matteTransitionFrameLimitsV1(fps) : { min: 2, max: Math.round(10 * fps) };
    const current = { before: transition.beforeFrames, after: transition.afterFrames };
    let latest: MotionLibraryTransitionWindowV1 = current;
    try { handle.setPointerCapture(pointerId); } catch { /* still works without capture */ }
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const frames = ((moveEvent.clientX - startX) / pixelsPerSecond) * fps * (edge === "before" ? -1 : 1);
      latest = resizeTransitionWindowV1(cut, current, edge, frames, limits);
      setResize({ transitionId: transition.id, window: latest });
    };
    const finish = (commit: boolean) => (endEvent: PointerEvent | KeyboardEvent) => {
      if ("pointerId" in endEvent && endEvent.pointerId !== pointerId) return;
      if (!("pointerId" in endEvent) && endEvent.key !== "Escape") return;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* detached */ }
      setResize(undefined);
      if (!("pointerId" in endEvent)) endEvent.preventDefault();
      if (commit && (latest.before !== current.before || latest.after !== current.after)) void controller.resizeTransition(transition.id, latest);
    };
    const up = finish(true), cancel = finish(false), escape = finish(false);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  };

  const at = (frame: number) => (frame / fps) * pixelsPerSecond;
  // The lane seeks on click; a click that ends a drag on our own controls must not move the playhead.
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return <div className="ml-cuts" ref={rootRef} data-testid={`timeline-cut-points-${track.id}`}>
    {cuts.map(cut => {
      const key = keyOf(cut), transition = cut.transition;
      const job = state.jobs.find(entry => entry.target.kind === "cut" && sameCutV1(entry.target.cut, cut));
      if (transition) {
        const window = resize?.transitionId === transition.id ? resize.window : { before: transition.beforeFrames, after: transition.afterFrames };
        const selected = state.selectedTransitionId === transition.id;
        const name = transition.motionLibrary ? names?.get(transition.motionLibrary.itemId) ?? transition.motionLibrary.itemId : uiText(transition.kernel === "dip" ? "黑場" : "溶接");
        const seconds = ((window.before + window.after) / fps).toFixed(2);
        return <div key={key} className="ml-cut-window" data-kernel={transition.kernel} data-selected={selected || undefined} data-resizing={resize?.transitionId === transition.id || undefined}
          style={{ left: at(cut.cutFrame - window.before), width: Math.max(10, at(window.before + window.after)) }}
          onContextMenu={event => openMenu(event, cut)} data-testid={`timeline-transition-${transition.id}`}>
          {editable && <span className="ml-cut-edge is-before" onPointerDown={event => beginResize(event, cut, "before")} onClick={stop} onDoubleClick={stop} onContextMenu={event => openMenu(event, cut)} title={uiText("拖曳改變轉場長度（前半）")} />}
          <button type="button" className="ml-cut-diamond" style={{ left: at(window.before) }} aria-pressed={selected}
            aria-label={uiText("轉場：{value0}，{value1} 秒", { value0: name, value1: seconds })}
            title={uiText("{value0} · {value1} 秒｜點一下選取（Delete 移除）；雙擊換轉場；右鍵選單；拖左右邊緣改長度", { value0: name, value1: seconds })}
            onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); controller.selectTransition(transition.id); }}
            onDoubleClick={event => { event.stopPropagation(); openPanel(cut); }} onContextMenu={event => openMenu(event, cut)} data-testid={`timeline-transition-diamond-${transition.id}`} />
          {editable && <span className="ml-cut-edge is-after" onPointerDown={event => beginResize(event, cut, "after")} onClick={stop} onDoubleClick={stop} onContextMenu={event => openMenu(event, cut)} title={uiText("拖曳改變轉場長度（後半）")} />}
          {resize?.transitionId === transition.id && <span className="ml-cut-readout">{seconds}s</span>}
          {job && <span className="ml-cut-job" style={{ left: at(window.before) }} title={uiText("正在產生轉場… {value0}%", { value0: Math.round(job.fraction * 100) })} />}
        </div>;
      }
      if (job) return <span key={key} className="ml-cut-job is-alone" style={{ left: at(cut.cutFrame) }} title={uiText("正在產生轉場… {value0}%", { value0: Math.round(job.fraction * 100) })} />;
      if (hovered !== key || !editable || !cut.eligible) return null;
      return <button key={key} type="button" className="ml-cut-add" style={{ left: at(cut.cutFrame) }} data-testid={`timeline-cut-add-${cut.fromClipId}`}
        aria-label={uiText("在這個剪接點加入轉場")} title={uiText("加入轉場：點一下選轉場；右鍵快速選單；Ctrl+T 套用上次的轉場")}
        onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); openPanel(cut); }} onContextMenu={event => openMenu(event, cut)}>
        <MotionLibraryIcon name="transition" size={12} /></button>;
    })}
    {menu && createPortal(<CutMenu menu={menu} fps={fps} controller={controller} onOpenPanel={() => openPanel(menu.cut)} onClose={() => setMenu(undefined)} />, document.body)}
  </div>;
}

function CutMenu({ menu, fps, controller, onOpenPanel, onClose }: { menu: MenuState; fps: number; controller: MotionLibraryControllerV1; onOpenPanel: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const away = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  const frames = defaultTransitionFramesV1(fps), cut = menu.cut;
  const run = (action: () => void) => () => { onClose(); action(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };
  const left = Math.min(menu.x, window.innerWidth - 220), top = Math.min(menu.y, window.innerHeight - 190);
  return <div ref={ref} className="ml-cut-menu" role="menu" aria-label={uiText("剪接點轉場")} style={{ left, top }} onKeyDown={onKeyDown} data-testid="timeline-cut-menu">
    <button type="button" role="menuitem" onClick={run(() => void controller.applyTransition({ kind: "dissolve" }, cut, { frames }))}>
      <MotionLibraryIcon name="dissolve" size={14} />{uiText("溶接")}<small>{(frames / fps).toFixed(1)} {uiText("秒")}</small></button>
    <button type="button" role="menuitem" onClick={run(() => void controller.applyTransition({ kind: "dip" }, cut, { frames }))}>
      <MotionLibraryIcon name="dip" size={14} />{uiText("黑場")}<small>{(frames / fps).toFixed(1)} {uiText("秒")}</small></button>
    <button type="button" role="menuitem" onClick={run(onOpenPanel)}><MotionLibraryIcon name="motion" size={14} />{uiText("動態轉場…")}<small>{uiText("40 種")}</small></button>
    <hr aria-hidden="true" />
    <button type="button" role="menuitem" disabled={!cut.transition} onClick={run(() => { if (cut.transition) controller.removeTransition(cut.transition.id); })}>
      <MotionLibraryIcon name="trash" size={14} />{uiText("移除")}<small>Delete</small></button>
  </div>;
}
