import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { EditProject } from "../domain/types";
import { MOTION_LIBRARY_CATALOG } from "../motionLibrary/catalog";
import type { MotionLibraryItem } from "../motionLibrary/types";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { MotionLibraryIcon } from "./MotionLibraryIcons";
import { MotionLibraryThumb } from "./MotionLibraryThumb";
import { MOTION_LIBRARY_TABS_V1, motionLibraryBadgeV1, motionLibraryCategoriesV1, motionLibraryMatchCountsV1, motionLibraryThumbnailSizeV1,
  searchMotionLibraryV1 } from "./motionLibraryCatalogViewV1";
import type { MotionLibraryControllerV1 } from "./motionLibraryControllerV1";
import { findCutV1 } from "./motionLibraryCutsV1";
import { readMotionLibraryDropGeometryV1, resolveMotionLibraryDropV1, type MotionLibraryDropTargetV1 } from "./motionLibraryDropV1";
import { planMotionLibraryClipPlacementV1 } from "./motionLibraryPlanV1";
import { sharedMotionLibraryThumbnailServiceV1, type MotionLibraryThumbnailServiceV1 } from "./motionLibraryThumbnailServiceV1";
import type { MotionLibraryJobV1, MotionLibraryUiStoreV1 } from "./motionLibraryUiStoreV1";
import { TIMELINE_DRAG_THRESHOLD_PX } from "./timelineInteraction";
import "./motionLibrary.css";

/**
 * 動態素材庫 (PHASE3_INTEGRATION_DESIGN §4): 文字動畫 / 轉場 / 背景, category chips, search over zh / ja / en names and tags,
 * live cards drawn by each item's own generator (a still; the animation on hover or keyboard focus).
 * Add: drag onto a track (text, background) or onto a cut (transitions); double-click, Enter or 「加入」 adds at the
 * playhead on the selected track (transitions: the focused cut, else the cut nearest the playhead). The editor's keys
 * keep working after a card or button is clicked: the grid takes no arrow keys and is not a listbox.
 */

export interface MotionLibraryPanelProps {
  readonly store: MotionLibraryUiStoreV1;
  readonly controller: MotionLibraryControllerV1;
  /** Defaults to the window's shared thumbnail service (one worker, one font set). */
  readonly service?: MotionLibraryThumbnailServiceV1;
  readonly project: EditProject;
  /** False in a browser: everything browses and previews; adding says it needs the desktop app. */
  readonly canRender: boolean;
}

const TOTAL = MOTION_LIBRARY_CATALOG.length;
const TAB_ICON = { text: "text", transition: "transition", background: "background" } as const;

function percent(fraction: number) { return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`; }

function ProgressRing({ fraction }: { fraction: number }) {
  const radius = 15, length = 2 * Math.PI * radius;
  return <svg className="ml-ring" viewBox="0 0 36 36" aria-hidden="true">
    <circle cx="18" cy="18" r={radius} className="ml-ring-track" />
    <circle cx="18" cy="18" r={radius} className="ml-ring-value" strokeDasharray={`${length * Math.max(0.03, fraction)} ${length}`} />
  </svg>;
}

interface CardProps {
  readonly item: MotionLibraryItem;
  readonly service: MotionLibraryThumbnailServiceV1;
  readonly size: { width: number; height: number };
  readonly visible: boolean;
  readonly selected: boolean;
  readonly job?: MotionLibraryJobV1;
  readonly onSelect: (itemId: string) => void;
  readonly onAdd: (itemId: string) => void;
  readonly onDragStart: (event: ReactPointerEvent<HTMLButtonElement>, item: MotionLibraryItem) => void;
  readonly registerNode: (itemId: string, node: HTMLElement | null) => void;
}

const MotionLibraryCard = memo(function MotionLibraryCard({ item, service, size, visible, selected, job, onSelect, onAdd, onDragStart, registerNode }: CardProps) {
  const [animating, setAnimating] = useState(false);
  // Right after a render finishes, the cancel pill does not turn straight back into 加入: a late click must not add a copy.
  const [settling, setSettling] = useState(false);
  const hadJob = useRef(false);
  useEffect(() => {
    if (job) { hadJob.current = true; return; }
    if (!hadJob.current) return;
    hadJob.current = false; setSettling(true);
    const timer = setTimeout(() => setSettling(false), 1200);
    return () => clearTimeout(timer);
  }, [job]);
  const cardRef = useCallback((node: HTMLDivElement | null) => registerNode(item.id, node), [item.id, registerNode]);
  const badge = motionLibraryBadgeV1(item);
  const addLabel = item.kind === "transition" ? uiText("套用") : uiText("加入");
  const addHelp = item.kind === "transition" ? uiText("套用到剪接點（Enter）：聚焦的剪接點，否則離播放頭最近的剪接點；也可以直接拖到剪接點上")
    : uiText("加入到播放頭（Enter 或雙擊）；也可以拖到時間軸上指定的位置");
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    onSelect(item.id);
    onAdd(item.id);
  };
  return <div role="listitem" className="ml-card" ref={cardRef} data-item-id={item.id} data-kind={item.kind}
    data-selected={selected || undefined} data-busy={job ? "true" : undefined} data-testid={`motion-library-card-${item.id}`}>
    <button type="button" className="ml-card-face" aria-label={`${item.names.zh}（${item.names.en}）`} aria-pressed={selected}
      title={`${item.names.zh} · ${item.names.en} · ${item.names.ja}\n${addHelp}`}
      onPointerEnter={() => setAnimating(true)} onPointerLeave={() => setAnimating(false)} onFocus={() => setAnimating(true)} onBlur={() => setAnimating(false)}
      onClick={() => onSelect(item.id)} onDoubleClick={() => onAdd(item.id)} onKeyDown={onKeyDown} onPointerDown={event => onDragStart(event, item)}>
      <MotionLibraryThumb service={service} item={item} size={size} purpose="card" visible={visible} animating={animating && visible} />
      {badge && <span className="ml-badge">{uiText(badge)}</span>}
      {job && <span className="ml-card-progress" role="status" aria-label={uiText("正在產生 {value0}", { value0: percent(job.fraction) })}>
        <ProgressRing fraction={job.fraction} /><b>{percent(job.fraction)}</b></span>}
    </button>
    <div className="ml-card-meta">
      <strong title={item.names.zh}>{item.names.zh}</strong>
      <small title={item.names.en}>{item.names.en}</small>
    </div>
    {settling ? <span className="ml-card-action is-done" role="status"><MotionLibraryIcon name="check" size={13} />{uiText("完成")}</span> : job
      ? <button type="button" className="ml-card-action is-cancel" onClick={job.cancel} title={uiText("取消產生；時間軸不會改變")}><MotionLibraryIcon name="close" size={13} />{uiText("取消")}</button>
      : <button type="button" className="ml-card-action" onClick={() => { onSelect(item.id); onAdd(item.id); }} title={addHelp} aria-keyshortcuts="Enter">
        <MotionLibraryIcon name="plus" size={13} />{addLabel}</button>}
  </div>;
});

interface DragState { item: MotionLibraryItem; x: number; y: number; target?: MotionLibraryDropTargetV1; previewUrl?: string; durationFrames: number; newLayer?: boolean }

export default function MotionLibraryPanel({ store, controller, service: serviceProp, project, canRender }: MotionLibraryPanelProps) {
  useI18n();
  const service = serviceProp ?? sharedMotionLibraryThumbnailServiceV1();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const tab = state.tab, category = state.category[tab];
  const items = useMemo(() => searchMotionLibraryV1({ kind: tab, category, query: state.query }), [tab, category, state.query]);
  const counts = useMemo(() => state.query.trim() ? motionLibraryMatchCountsV1(state.query) : undefined, [state.query]);
  const size = useMemo(() => motionLibraryThumbnailSizeV1(project), [project.width, project.height]);
  const portrait = size.height > size.width;
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const nodes = useRef(new Map<string, HTMLElement>());
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  const gridRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const markChipsEnd = useCallback(() => {
    const node = chipsRef.current;
    if (node) node.toggleAttribute("data-scrolled-end", node.scrollLeft + node.clientWidth >= node.scrollWidth - 2);
  }, []);
  // A mouse wheel over the category row scrolls it sideways (the row has no visible scrollbar).
  useEffect(() => {
    const node = chipsRef.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || node.scrollWidth <= node.clientWidth) return;
      event.preventDefault();
      node.scrollLeft += event.deltaY;
    };
    node.addEventListener("wheel", wheel, { passive: false });
    markChipsEnd();
    return () => node.removeEventListener("wheel", wheel);
  }, [markChipsEnd, tab]);
  const projectRef = useRef(project);
  projectRef.current = project;

  // Only cards on screen (plus a margin) ask for their still; the set is committed once per animation frame.
  useEffect(() => {
    const root = gridRef.current;
    if (!root || typeof IntersectionObserver === "undefined") { setVisible(new Set(MOTION_LIBRARY_CATALOG.map(item => item.id))); return; }
    let pending = new Map<string, boolean>(), frame = 0;
    const commit = () => {
      frame = 0;
      const changes = pending; pending = new Map();
      setVisible(current => { const next = new Set(current); for (const [id, shown] of changes) shown ? next.add(id) : next.delete(id); return next; });
    };
    const instance = new IntersectionObserver(entries => {
      for (const entry of entries) { const id = (entry.target as HTMLElement).dataset.itemId; if (id) pending.set(id, entry.isIntersecting); }
      if (!frame) frame = requestAnimationFrame(commit);
    }, { root, rootMargin: "160px 0px" });
    observer.current = instance;
    for (const node of nodes.current.values()) instance.observe(node);
    return () => { instance.disconnect(); observer.current = undefined; if (frame) cancelAnimationFrame(frame); };
  }, []);
  const registerNode = useCallback((itemId: string, node: HTMLElement | null) => {
    const previous = nodes.current.get(itemId);
    if (previous && previous !== node) observer.current?.unobserve(previous);
    if (node) { nodes.current.set(itemId, node); observer.current?.observe(node); } else if (previous) nodes.current.delete(itemId);
  }, []);
  useEffect(() => { if (gridRef.current) gridRef.current.scrollTop = 0; }, [tab, category, state.query]);
  // Typing a search that has no match on this tab shows the tab with the most matches (the counts stay on every tab).
  useEffect(() => {
    if (!counts || counts[tab] > 0) return;
    const best = MOTION_LIBRARY_TABS_V1.reduce((winner, entry) => counts[entry.kind] > counts[winner.kind] ? entry : winner);
    if (counts[best.kind] > 0) store.setTab(best.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts]);

  const jobsByItem = useMemo(() => new Map(state.jobs.filter(job => job.target.kind === "card").map(job => [job.itemId ?? "", job])), [state.jobs]);
  const select = useCallback((itemId: string) => store.selectItem(itemId), [store]);
  const add = useCallback((itemId: string) => { void controller.addItem(itemId); }, [controller]);

  // Pointer drag from a card: a floating card follows the pointer; the timeline shows where it lands.
  const [drag, setDrag] = useState<DragState>();
  const dragRef = useRef<DragState | undefined>(undefined);
  const suppressClick = useRef(false);
  const startDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>, item: MotionLibraryItem) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const source = event.currentTarget, pointerId = event.pointerId, origin = { x: event.clientX, y: event.clientY };
    const documentNode = source.ownerDocument;
    let started = false, geometry = readMotionLibraryDropGeometryV1(documentNode);
    const durationFrames = Math.max(1, Math.round(item.defaultDurationSeconds * projectRef.current.fps));
    const previewUrl = source.querySelector("img")?.getAttribute("src") ?? undefined;
    const update = (x: number, y: number) => {
      const target = resolveMotionLibraryDropV1({ clientX: x, clientY: y }, geometry, item.kind, projectRef.current);
      let newLayer = false;
      if (target?.kind === "track" && item.kind !== "transition") {
        try { newLayer = planMotionLibraryClipPlacementV1(projectRef.current, { trackId: target.trackId, startFrame: target.startFrame, durationFrames, kind: item.kind, strictTrack: true }, prefix => `${prefix}-preview`).trackId !== target.trackId; }
        catch { newLayer = false; }
      }
      const next = { item, x, y, target, previewUrl, durationFrames, newLayer };
      dragRef.current = next; setDrag(next);
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!started) {
        if (Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < TIMELINE_DRAG_THRESHOLD_PX + 2) return;
        started = true; geometry = readMotionLibraryDropGeometryV1(documentNode);
        try { source.setPointerCapture(pointerId); } catch { /* The card may have re-rendered. */ }
      }
      moveEvent.preventDefault();
      update(moveEvent.clientX, moveEvent.clientY);
    };
    const end = (commit: boolean) => (endEvent: PointerEvent | KeyboardEvent) => {
      if ("pointerId" in endEvent && endEvent.pointerId !== pointerId) return;
      if (!("pointerId" in endEvent) && endEvent.key !== "Escape") return;
      documentNode.removeEventListener("pointermove", move, true);
      documentNode.removeEventListener("pointerup", up, true);
      documentNode.removeEventListener("pointercancel", cancel, true);
      documentNode.removeEventListener("keydown", escape, true);
      try { if (source.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId); } catch { /* detached */ }
      const finished = dragRef.current;
      dragRef.current = undefined; setDrag(undefined);
      if (!started) return;
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      if (!("pointerId" in endEvent)) endEvent.preventDefault();
      if (!commit) return;
      const target = finished?.target;
      store.selectItem(item.id);
      if (!target) controller.notify(item.kind === "transition" ? "把轉場拖到時間軸上兩段影片相接的剪接點。" : "把動態素材拖到時間軸的畫面軌道上。");
      else if (target.kind === "track") void controller.addItem(item.id, { trackId: target.trackId, startFrame: target.startFrame, strictTrack: true });
      else if (target.kind === "cut") void controller.applyTransition({ kind: "matte", itemId: item.id }, target.cut);
      else controller.notify(target.reason);
    };
    const up = end(true), cancel = end(false), escape = end(false);
    documentNode.addEventListener("pointermove", move, true);
    documentNode.addEventListener("pointerup", up, true);
    documentNode.addEventListener("pointercancel", cancel, true);
    documentNode.addEventListener("keydown", escape, true);
  }, [controller, store]);
  const selectFromClick = useCallback((itemId: string) => { if (!suppressClick.current) select(itemId); }, [select]);

  const selected = state.selectedItemId ? items.find(item => item.id === state.selectedItemId) ?? MOTION_LIBRARY_CATALOG.find(item => item.id === state.selectedItemId) : undefined;
  const focusCut = tab === "transition" && state.focusCut && findCutV1(project, state.focusCut) ? state.focusCut : undefined;
  const focusCutPoint = focusCut ? findCutV1(project, focusCut) : undefined;
  const jobs = state.jobs;
  const tabHint = MOTION_LIBRARY_TABS_V1.find(entry => entry.kind === tab)!.hint;

  return <div className="ml-panel" data-testid="motion-library-panel" data-tab={tab} data-portrait={portrait || undefined}>
    <header className="ml-head">
      <label className="ml-search" title={uiText("動態素材庫")}>
        <MotionLibraryIcon name="search" size={15} />
        <input type="search" value={state.query} onChange={event => store.setQuery(event.target.value)} data-testid="motion-library-search"
          placeholder={uiText("搜尋 {value0} 種動態素材（名稱、標籤）", { value0: TOTAL })} aria-label={uiText("搜尋動態素材")}
          onKeyDown={event => { if (event.key === "Escape" && state.query) { event.preventDefault(); event.stopPropagation(); store.setQuery(""); } }} />
        {state.query && <button type="button" className="ml-search-clear" onClick={() => store.setQuery("")} aria-label={uiText("清除搜尋")} title={uiText("清除搜尋（Esc）")}>
          <MotionLibraryIcon name="close" size={13} /></button>}
      </label>
    </header>
    <div className="ml-tabs" role="tablist" aria-label={uiText("動態素材類型")} data-counting={counts ? "true" : undefined}>
      {MOTION_LIBRARY_TABS_V1.map(entry => <button key={entry.kind} type="button" role="tab" aria-selected={entry.kind === tab} data-testid={`motion-library-tab-${entry.kind}`}
        onClick={() => store.setTab(entry.kind)} title={uiText(entry.hint)}>
        <MotionLibraryIcon name={TAB_ICON[entry.kind]} size={15} /><span>{uiText(entry.label)}</span>
        {counts && <small className="ml-tab-count">{counts[entry.kind]}</small>}
      </button>)}
    </div>
    <div className="ml-chips" role="group" aria-label={uiText("分類")} ref={chipsRef} onScroll={markChipsEnd}>
      <button type="button" aria-pressed={!category} onClick={() => store.setCategory(tab, undefined)}>{uiText("全部")}</button>
      {motionLibraryCategoriesV1(tab).map(entry => <button key={entry.id} type="button" aria-pressed={category === entry.id} title={`${entry.names.en} · ${entry.names.ja}`}
        onClick={() => store.setCategory(tab, category === entry.id ? undefined : entry.id)}>{uiText(entry.names.zh)}</button>)}
    </div>
    {tab === "transition" && <div className="ml-basic-row">
      {focusCutPoint ? <div className="ml-focus-cut" data-testid="motion-library-focus-cut" title={uiText("套用到 {value0} 的剪接點", { value0: formatCutTime(focusCutPoint.time) })}>
        <MotionLibraryIcon name="target" size={14} />
        <span>{uiText("套用到 {value0} 的剪接點", { value0: formatCutTime(focusCutPoint.time) })}</span>
        <button type="button" onClick={() => store.setFocusCut(undefined)} aria-label={uiText("改回套用到離播放頭最近的剪接點")} title={uiText("改回套用到離播放頭最近的剪接點")}>
          <MotionLibraryIcon name="close" size={12} /></button>
      </div> : <small className="ml-basic-note" title={uiText("套用到離播放頭最近的剪接點；Ctrl+T 套用上次的轉場")}><span>{uiText("套用到最近的剪接點")}</span><kbd>Ctrl+T</kbd></small>}
      <div className="ml-basic-actions">
        <button type="button" onClick={() => void basicApply("dissolve")} title={uiText("溶接 0.5 秒（不需要算圖）")}><MotionLibraryIcon name="dissolve" size={14} />{uiText("溶接")}</button>
        <button type="button" onClick={() => void basicApply("dip")} title={uiText("黑場 0.5 秒（不需要算圖）")}><MotionLibraryIcon name="dip" size={14} />{uiText("黑場")}</button>
      </div>
    </div>}
    {!canRender && <p className="ml-note" role="note" title={uiText("瀏覽器預覽：160 種效果都能瀏覽與預覽；加入時間軸需要 Editkin 桌面版的本機渲染。溶接與黑場可直接套用。")}>
      <MotionLibraryIcon name="motion" size={13} /><span>{uiText("瀏覽器只能預覽；加入時間軸要用桌面版")}</span></p>}
    <div className="ml-grid" role="list" ref={gridRef} data-testid="motion-library-grid" data-wheel-scroll="vertical" aria-label={uiText("{value0}：{value1} 項", { value0: uiText(MOTION_LIBRARY_TABS_V1.find(entry => entry.kind === tab)!.label), value1: items.length })}
      onClickCapture={event => { if (suppressClick.current) { event.stopPropagation(); event.preventDefault(); } }}>
      {items.map(item => <MotionLibraryCard key={item.id} item={item} service={service} size={size} visible={visible.has(item.id)}
        selected={state.selectedItemId === item.id} job={jobsByItem.get(item.id)} onSelect={selectFromClick} onAdd={add} onDragStart={startDrag} registerNode={registerNode} />)}
      {!items.length && <div className="ml-empty" data-testid="motion-library-empty"><strong>{uiText("沒有符合的動態素材")}</strong>
        <span>{counts && (counts.text + counts.transition + counts.background) > 0 ? uiText("其他分頁有結果，換個分頁看看。") : uiText("換個關鍵字，或清除分類與搜尋。")}</span></div>}
    </div>
    <footer className="ml-foot">
      {jobs.length > 0 && <ul className="ml-jobs" aria-label={uiText("正在產生")}>{jobs.map(job => <li key={job.id}>
        <ProgressRing fraction={job.fraction} /><span>{uiText("正在產生「{value0}」", { value0: job.label })}<small>{percent(job.fraction)}</small></span>
        <button type="button" onClick={job.cancel} title={uiText("取消產生；時間軸不會改變")}><MotionLibraryIcon name="close" size={12} />{uiText("取消")}</button>
      </li>)}</ul>}
      {selected ? <div className="ml-selected" data-testid="motion-library-selected">
        <span><strong>{selected.names.zh}</strong><small>{selected.id} · {selected.names.en}</small></span>
        <button type="button" className="primary-tool-action" onClick={() => add(selected.id)} aria-keyshortcuts="Enter"
          title={selected.kind === "transition" ? uiText("套用到剪接點（Enter）") : uiText("加入到播放頭（Enter）")}>
          <MotionLibraryIcon name="plus" size={14} />{selected.kind === "transition" ? uiText("套用") : uiText("加入")}<kbd aria-hidden="true">Enter</kbd></button>
      </div> : <small className="ml-hint">{uiText(tabHint)}</small>}
    </footer>
    {drag && createPortal(<DragLayer drag={drag} fps={project.fps} />, document.body)}
  </div>;

  async function basicApply(kind: "dissolve" | "dip") {
    const focus = state.focusCut && findCutV1(projectRef.current, state.focusCut) ? state.focusCut : undefined;
    if (focus) await controller.applyTransition({ kind }, focus);
    else await controller.applyTransitionNearPlayhead({ kind });
  }
}

function formatCutTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60), rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

/** The floating card and the landing marker on the timeline while a card is dragged. */
function DragLayer({ drag, fps }: { drag: DragState; fps: number }) {
  const target = drag.target;
  const valid = target && target.kind !== "invalid";
  let marker: ReactNode = null;
  if (target?.kind === "track") {
    const geometry = readMotionLibraryDropGeometryV1(document);
    const pps = geometry?.pixelsPerSecond ?? 0;
    const left = target.lane.left + (target.startFrame / fps) * pps, width = Math.max(10, (drag.durationFrames / fps) * pps);
    const clip = geometry?.area;
    const shownLeft = Math.max(left, clip?.left ?? left), shownRight = Math.min(left + width, clip?.right ?? left + width);
    if (shownRight > shownLeft) marker = <div className="ml-drop-clip" style={{ left: shownLeft, top: target.lane.top + 5, width: shownRight - shownLeft, height: target.lane.bottom - target.lane.top - 10 }}>
      <span>{drag.item.names.zh}</span></div>;
  } else if (target?.kind === "cut") {
    marker = <div className="ml-drop-cut" style={{ left: target.x, top: target.lane.top - 4, height: target.lane.bottom - target.lane.top + 8 }}><i /></div>;
  }
  return <div className="ml-drag-layer" aria-hidden="true">
    {marker}
    <div className="ml-drag-card" data-valid={valid ? "true" : target ? "false" : undefined} style={{ transform: `translate3d(${drag.x + 14}px, ${drag.y + 12}px, 0)` }}>
      {drag.previewUrl ? <img src={drag.previewUrl} alt="" /> : <span className="ml-thumb-shimmer" />}
      <strong>{drag.item.names.zh}</strong>
      <small>{target?.kind === "invalid" ? uiText(target.reason) : target?.kind === "cut" ? uiText("放開：加到這個剪接點") : target?.kind === "track" ? uiText(drag.newLayer ? "放開：這段有片段，會放到上方的空圖層" : "放開：加到這裡")
        : drag.item.kind === "transition" ? uiText("拖到兩段影片相接的剪接點") : uiText("拖到時間軸的畫面軌道")}</small>
    </div>
  </div>;
}
