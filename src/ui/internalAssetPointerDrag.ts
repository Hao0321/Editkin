import type { PointerEvent as ReactPointerEvent } from "react";
import { alignTimelineTime, TIMELINE_DRAG_THRESHOLD_PX } from "./timelineInteraction";
import { TIMELINE_LABEL_WIDTH } from "./timelineContract";

export const INTERNAL_ASSET_POINTER_DRAG_EVENT = "editkin:asset-pointer-drag";
export interface InternalAssetPointerDragDetail {
  readonly phase: "start" | "move" | "drop" | "cancel";
  readonly assetId: string;
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly altKey: boolean;
  readonly moved: boolean;
  readonly sourceElement: HTMLElement;
  readonly scopeElement: HTMLElement;
  readonly sessionId: number;
}
export interface TimelineImportPlacement {
  readonly trackId: string;
  readonly trackKind: "video" | "audio";
  readonly timelineStart: number;
}
export interface WorkspaceDropPoint { readonly clientX: number; readonly clientY: number; }
const emitted = new WeakSet<object>();
const active = new WeakMap<Document, () => void>();
let nextSessionId = 0;
export function isInternalAssetPointerDragDetail(value: unknown): value is InternalAssetPointerDragDetail {
  return !!value && typeof value === "object" && emitted.has(value);
}

/** One captured source per document. Every listener belongs to the active drag
 * and is removed before release/cancel; Windows native file drop stays enabled. */
export function startInternalAssetPointerDrag(event: ReactPointerEvent<HTMLElement>, options: {
  assetId: string; onStart?: (assetId: string) => void; onEnd?: () => void;
}): (() => void) | undefined {
  const source = event.currentTarget, document = source.ownerDocument;
  const scope = source.closest<HTMLElement>(".app-shell");
  const target = event.target as Element | null;
  if (event.button !== 0 || !Number.isInteger(event.pointerId) || !source.isConnected || !scope
    || !options.assetId.trim() || options.assetId !== options.assetId.trim() || options.assetId.length > 256
    || ![event.clientX, event.clientY].every(Number.isFinite)
    || target?.closest?.("button,input,select,textarea,a,[contenteditable='true']")) return undefined;
  active.get(document)?.();
  const window = document.defaultView;
  const sessionId = ++nextSessionId, origin = { x: event.clientX, y: event.clientY };
  // Match capture explicitly across EventTarget implementations. The ended
  // fence also rejects callbacks already delivered or reentered during cleanup.
  const captureOptions = { capture: true } as const;
  let point = { clientX: event.clientX, clientY: event.clientY, altKey: event.altKey }, moved = false, ended = false;
  const publish = (phase: InternalAssetPointerDragDetail["phase"]) => {
    if (ended && phase !== "drop" && phase !== "cancel") return;
    const detail = Object.freeze({ phase, assetId: options.assetId, pointerId: event.pointerId, ...point,
      moved, sourceElement: source, scopeElement: scope, sessionId });
    emitted.add(detail);
    scope.dispatchEvent(new CustomEvent<InternalAssetPointerDragDetail>(INTERNAL_ASSET_POINTER_DRAG_EVENT, { bubbles: true, detail }));
  };
  const finish = (phase: "drop" | "cancel") => {
    if (ended) return; ended = true;
    document.removeEventListener("pointermove", move, captureOptions);
    document.removeEventListener("pointerup", up, captureOptions);
    document.removeEventListener("pointercancel", cancelPointer, captureOptions);
    document.removeEventListener("keydown", key, captureOptions);
    source.removeEventListener("lostpointercapture", lost);
    window?.removeEventListener("blur", cancel);
    if (active.get(document) === cancel) active.delete(document);
    try { if (source.hasPointerCapture(event.pointerId)) source.releasePointerCapture(event.pointerId); } catch { /* The source may already have detached. */ }
    try { publish(phase); } finally { options.onEnd?.(); }
  };
  const cancel = () => finish("cancel");
  const update = (value: PointerEvent) => {
    if (ended) return false;
    if (![value.clientX, value.clientY].every(Number.isFinite)) { cancel(); return false; }
    point = { clientX: value.clientX, clientY: value.clientY, altKey: value.altKey };
    moved ||= Math.hypot(point.clientX - origin.x, point.clientY - origin.y) >= TIMELINE_DRAG_THRESHOLD_PX;
    return true;
  };
  const move = (value: PointerEvent) => {
    if (ended || value.pointerId !== event.pointerId) return;
    if (!source.isConnected || !scope.contains(source)) return cancel();
    value.preventDefault(); if (update(value)) publish("move");
  };
  const up = (value: PointerEvent) => {
    if (ended || value.pointerId !== event.pointerId) return;
    value.preventDefault();
    if (!source.isConnected || !scope.contains(source)) return cancel();
    if (update(value)) finish("drop");
  };
  const cancelPointer = (value: PointerEvent) => { if (!ended && value.pointerId === event.pointerId) cancel(); };
  const lost = (value: PointerEvent) => { if (!ended && value.pointerId === event.pointerId) cancel(); };
  const key = (value: KeyboardEvent) => { if (!ended && value.key === "Escape") { value.preventDefault(); cancel(); } };
  try { source.setPointerCapture(event.pointerId); } catch { return undefined; }
  event.preventDefault(); event.stopPropagation();
  document.addEventListener("pointermove", move, captureOptions);
  document.addEventListener("pointerup", up, captureOptions);
  document.addEventListener("pointercancel", cancelPointer, captureOptions);
  document.addEventListener("keydown", key, captureOptions);
  source.addEventListener("lostpointercapture", lost);
  window?.addEventListener("blur", cancel);
  active.set(document, cancel);
  try { options.onStart?.(options.assetId); publish("start"); } catch (error) { cancel(); throw error; }
  return cancel;
}

const containsPoint = (rect: DOMRect, point: WorkspaceDropPoint) => point.clientX >= rect.left && point.clientX < rect.right
  && point.clientY >= rect.top && point.clientY < rect.bottom;

/** Capture before import awaits. A blocked timeline hit never becomes append.
 * Coordinates and frame scale come from the actual owned timeline viewport. */
export function resolveTimelineImportPlacement(point: WorkspaceDropPoint, document: Document): TimelineImportPlacement | undefined {
  if (![point.clientX, point.clientY].every(Number.isFinite)) throw new Error("拖放座標無效，未加入素材。");
  const shell = [...document.querySelectorAll<HTMLElement>(".timeline-shell")].find(node => containsPoint(node.getBoundingClientRect(), point));
  if (!shell) return undefined;
  const viewport = shell.querySelector<HTMLElement>(".timeline-scroll[data-timeline-viewport='true']");
  if (!viewport) throw new Error("時間軸尚未就緒，請稍後重新拖放。");
  const rect = viewport.getBoundingClientRect(), pixelsPerSecond = Number(viewport.dataset.timelinePixelsPerSecond), fps = Number(viewport.dataset.timelineFps);
  const left = rect.left + viewport.clientLeft, top = rect.top + viewport.clientTop;
  if (![left, top, viewport.clientWidth, viewport.clientHeight].every(Number.isFinite) || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) throw new Error("時間軸可見區域尚未就緒，未加入素材。");
  if (point.clientX < left + TIMELINE_LABEL_WIDTH || point.clientX >= left + viewport.clientWidth
    || point.clientY < top || point.clientY >= top + viewport.clientHeight) throw new Error("請放到時間軸右側軌道內容區，不能放在名稱、工具列或捲軸。");
  const ruler = viewport.querySelector<HTMLElement>(".ruler-row")?.getBoundingClientRect();
  if (ruler && point.clientY < ruler.bottom) throw new Error("請放到未鎖定的畫面或聲音軌道，不能放在刻度或字幕軌。");
  if (!(pixelsPerSecond > 0) || !Number.isFinite(pixelsPerSecond) || !(fps > 0) || !Number.isFinite(fps)
    || !Number.isFinite(viewport.scrollLeft)) throw new Error("時間軸影格比例尚未就緒，未加入素材。");
  const lane = [...viewport.querySelectorAll<HTMLElement>(".track-lane[data-track-id]")].find(node => containsPoint(node.getBoundingClientRect(), point));
  if (!lane || !lane.dataset.trackId || !["video", "audio"].includes(lane.dataset.trackKind ?? "") || lane.dataset.trackLocked !== "false") {
    throw new Error("請放到未鎖定的畫面或聲音軌道，不能放在刻度或字幕軌。");
  }
  const time = (point.clientX - left - TIMELINE_LABEL_WIDTH + viewport.scrollLeft) / pixelsPerSecond;
  return Object.freeze({ trackId: lane.dataset.trackId, trackKind: lane.dataset.trackKind as "video" | "audio", timelineStart: alignTimelineTime(time, fps) });
}
