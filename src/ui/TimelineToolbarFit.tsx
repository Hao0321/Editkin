import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./timelineToolbarFit.css";

/**
 * Steps of the one-row timeline toolbar, from the roomiest:
 *  0 every action in the row;
 *  1–4 逐幀, 畫中畫, ＋ 軌道 and then 顯示全部 move into 更多工具, one at a time (the least used first);
 *  5 the 「時間軸 · N 個片段」 title steps aside too (the timeline keeps its spoken name);
 *  6 even that is too wide (a very narrow window at a large interface size): the row may wrap.
 * The two tools (選取, 剪刀), ＋ 文字, 調整片段／調整字幕, 吸附, 切開 and 刪除 always stay in the row with their words.
 */
export const TIMELINE_TOOLBAR_LAST_STEP = 6;
/** Actions that can move into 更多工具 (their row buttons carry data-overflow-step="1"–"4"). */
export const TIMELINE_TOOLBAR_MOVABLE = 4;

/** The next step after a measurement, or undefined when the row fits (or may already wrap). */
export function nextToolbarStep(step: number, overflow: boolean): number | undefined {
  return overflow && step < TIMELINE_TOOLBAR_LAST_STEP ? step + 1 : undefined;
}

type Box = { scrollWidth: number; clientWidth: number };
/**
 * Whether the row is wider than the toolbar gives it: the toolbar itself overflows, or one of its groups (the actions
 * may shrink) is narrower than its buttons, which then run into the toolbar's padding up to the window's edge.
 */
export function toolbarRowOverflows(toolbar: Box & { children: ArrayLike<Box> }): boolean {
  const over = (box: Box) => box.scrollWidth > box.clientWidth + 1;
  return over(toolbar) || Array.from(toolbar.children).some(over);
}

/** The row actions that are in 更多工具 at `step`, as the data-moved list ("1 2 3"). */
export function movedToolbarActions(step: number): string | undefined {
  const moved = Math.max(0, Math.min(step, TIMELINE_TOOLBAR_MOVABLE));
  return moved ? Array.from({ length: moved }, (_, index) => String(index + 1)).join(" ") : undefined;
}

/**
 * The timeline toolbar's own box. It measures before paint whenever its width or its words change (`fitKey`), steps
 * down until the row fits, and only switches attributes: the buttons stay the same elements, so they keep focus and
 * their handlers. The moved actions have their copies in 更多工具 (shown by timelineToolbarFit.css).
 */
export function TimelineToolbarFit({ fitKey, children }: { fitKey: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const widthRef = useRef(0);
  const settled = useRef("");
  const [width, setWidth] = useState(0);
  const [fit, setFit] = useState({ key: "", step: 0 });
  const key = `${width}|${fitKey}`;
  const step = fit.key === key ? fit.step : 0;

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (fit.key !== key) { setFit({ key, step: 0 }); return; }
    const state = `${key}|${fit.step}`;
    if (settled.current === state) return;
    const next = nextToolbarStep(fit.step, toolbarRowOverflows(node));
    if (next === undefined) settled.current = state; else setFit({ key, step: next });
  });

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = Math.round(node.clientWidth);
      if (next === widthRef.current) return;
      widthRef.current = next;
      closeTimelineMoreMenu(node);
      setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = ref.current;
    return node ? attachTimelineMoreMenu(node) : undefined;
  }, []);

  return <div className="timeline-toolbar" ref={ref} data-fit="" data-overflow={step} data-moved={movedToolbarActions(step)}>{children}</div>;
}

function closeTimelineMoreMenu(toolbar: HTMLElement) {
  const menu = toolbar.querySelector<HTMLDetailsElement>(".timeline-more");
  if (menu?.open) menu.open = false;
}

/**
 * Where 更多工具 opens: under the toolbar when it fits there; otherwise from the bottom of the window beside its button,
 * so it may cover other toolbar buttons but never its own button or anything above the toolbar (GPU 直出 draws the
 * picture up there in a native window). It closes on its button, a click elsewhere, Escape or a new window width.
 */
export function placeTimelineMoreMenu(toolbar: DOMRect, button: DOMRect, menuHeight: number, viewport: { width: number; height: number }) {
  const below = Math.round(viewport.height - toolbar.bottom - 18);
  if (menuHeight <= below) return { top: `${Math.round(toolbar.bottom + 6)}px`, bottom: "auto", right: "12px", maxHeight: `${below}px` };
  return { top: "auto", bottom: "12px", right: `${Math.max(12, Math.round(viewport.width - button.left + 8))}px`,
    maxHeight: `${Math.max(120, Math.round(viewport.height - toolbar.top - 18))}px` };
}

function attachTimelineMoreMenu(toolbar: HTMLElement): () => void {
  const menu = () => toolbar.querySelector<HTMLDetailsElement>(".timeline-more");
  const place = () => {
    const details = menu(), summary = details?.querySelector("summary"), popover = details?.querySelector<HTMLElement>(".timeline-more-popover");
    if (!details?.open || !summary || !popover) return;
    const spot = placeTimelineMoreMenu(toolbar.getBoundingClientRect(), summary.getBoundingClientRect(), popover.scrollHeight,
      { width: window.innerWidth, height: window.innerHeight });
    toolbar.style.setProperty("--timeline-more-top", spot.top);
    toolbar.style.setProperty("--timeline-more-bottom", spot.bottom);
    toolbar.style.setProperty("--timeline-more-right", spot.right);
    toolbar.style.setProperty("--timeline-more-max", spot.maxHeight);
  };
  const close = (focusButton: boolean) => {
    const details = menu();
    stopWatching();
    if (!details?.open) return;
    details.open = false;
    if (focusButton) details.querySelector<HTMLElement>("summary")?.focus();
  };
  const onScroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(toolbar)) place(); };
  const onPointer = (event: PointerEvent) => { if (!(event.target instanceof Node) || !menu()?.contains(event.target)) close(false); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !menu()?.open) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  let watching = false;
  const startWatching = () => {
    if (watching) return;
    watching = true;
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
  };
  function stopWatching() {
    if (!watching) return;
    watching = false;
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", place);
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
  }
  // The summary opens and closes the menu as usual (mouse, Enter, Space); the menu is placed before it is painted.
  const onClick = (event: MouseEvent) => {
    const summary = event.target instanceof Element ? event.target.closest("summary") : null;
    const details = menu();
    if (!summary || !details || summary.parentElement !== details) return;
    event.preventDefault();
    details.open = !details.open;
    if (details.open) { place(); startWatching(); } else stopWatching();
  };
  // Opened or closed any other way (a new window width closes it): keep the place and the listeners in step.
  const onToggle = (event: Event) => {
    const details = menu();
    if (event.target !== details || !details) return;
    if (details.open) { place(); startWatching(); } else stopWatching();
  };
  toolbar.addEventListener("click", onClick);
  toolbar.addEventListener("toggle", onToggle, true);
  return () => { toolbar.removeEventListener("click", onClick); toolbar.removeEventListener("toggle", onToggle, true); stopWatching(); };
}
