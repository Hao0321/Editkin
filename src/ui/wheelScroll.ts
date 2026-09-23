import { useEffect, type RefObject } from "react";
import { libraryWheelDeltaPixels } from "./creativeLibraryPreview";

export type ScrollAxis = "horizontal" | "vertical";
type Viewport = Pick<HTMLElement, "scrollLeft" | "scrollTop" | "scrollWidth" | "scrollHeight" | "clientWidth" | "clientHeight">;
type ScrollEvent = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "preventDefault" | "stopPropagation">;

/** Own only a scroll that can move. At either boundary the outer panel may scroll. */
export function scrollViewportByWheel(node: Viewport, event: ScrollEvent, axis: ScrollAxis): boolean {
  if (event.ctrlKey || event.metaKey) return false;
  const horizontal = axis === "horizontal";
  const raw = horizontal && Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!horizontal && Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
  const extent = horizontal ? node.clientWidth : node.clientHeight;
  const delta = libraryWheelDeltaPixels(raw, event.deltaMode, extent);
  const maximum = Math.max(0, horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight);
  const previous = horizontal ? node.scrollLeft : node.scrollTop;
  if (![delta, maximum, previous].every(Number.isFinite)) return false;
  const next = Math.max(0, Math.min(maximum, previous + delta));
  if (!delta || next === previous) return false;
  if (horizontal) node.scrollLeft = next; else node.scrollTop = next;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

/** React's delegated wheel listener can be passive in Chromium/WebView2. */
export function useNativeWheelScroll(ref: RefObject<HTMLElement | null>, axis: ScrollAxis, bindingKey?: string) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => { scrollViewportByWheel(node, event, axis); };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [ref, axis, bindingKey]);
}
