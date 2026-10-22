import type { EditProject } from "../domain/types";
import { listTrackCutsV1, type MotionLibraryCutRefV1 } from "./motionLibraryCutsV1";
import { TIMELINE_LABEL_WIDTH } from "./timelineContract";

/**
 * Where a Motion Library card dropped on the timeline lands. Geometry comes from the live timeline viewport (the same
 * data attributes the asset drop reads); the decision is pure so it is tested without a DOM.
 * - text / background: the picture track under the pointer, at the frame under the pointer;
 * - transition: the cut under the pointer on that track (within CUT_SNAP_PX).
 */

export interface MotionLibraryRectV1 { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface MotionLibraryLaneGeometryV1 extends MotionLibraryRectV1 { readonly trackId: string; readonly kind: string; readonly locked: boolean }
export interface MotionLibraryDropGeometryV1 {
  /** The visible track area (the viewport minus the track names column). */
  readonly area: MotionLibraryRectV1;
  readonly lanes: readonly MotionLibraryLaneGeometryV1[];
  readonly pixelsPerSecond: number;
  readonly fps: number;
}

export type MotionLibraryDropTargetV1 =
  | { readonly kind: "track"; readonly trackId: string; readonly startFrame: number; readonly lane: MotionLibraryLaneGeometryV1 }
  | { readonly kind: "cut"; readonly cut: MotionLibraryCutRefV1; readonly x: number; readonly lane: MotionLibraryLaneGeometryV1 }
  | { readonly kind: "invalid"; readonly reason: string; readonly lane?: MotionLibraryLaneGeometryV1 };

export const MOTION_LIBRARY_CUT_SNAP_PX_V1 = 28;
const inside = (rect: MotionLibraryRectV1, x: number, y: number) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;

export function resolveMotionLibraryDropV1(point: { clientX: number; clientY: number }, geometry: MotionLibraryDropGeometryV1 | undefined,
  itemKind: "text" | "transition" | "background", project: EditProject): MotionLibraryDropTargetV1 | undefined {
  if (!geometry || !inside(geometry.area, point.clientX, point.clientY)) return undefined;
  const lane = geometry.lanes.find(candidate => inside(candidate, point.clientX, point.clientY));
  if (!lane) return { kind: "invalid", reason: itemKind === "transition" ? "把轉場拖到兩段影片相接的剪接點上。" : "把動態素材拖到畫面軌道上。" };
  if (lane.kind !== "video") return { kind: "invalid", reason: "動態素材只能放在畫面軌道（V）上。", lane };
  if (lane.locked) return { kind: "invalid", reason: "這條軌道已鎖定，先解鎖才能加入。", lane };
  const seconds = (point.clientX - lane.left) / geometry.pixelsPerSecond;
  if (itemKind !== "transition") return { kind: "track", trackId: lane.trackId, startFrame: Math.max(0, Math.round(seconds * geometry.fps)), lane };
  const cuts = listTrackCutsV1(project, lane.trackId).filter(cut => cut.eligible);
  const nearest = cuts.map(cut => ({ cut, x: lane.left + cut.time * geometry.pixelsPerSecond }))
    .sort((a, b) => Math.abs(a.x - point.clientX) - Math.abs(b.x - point.clientX))[0];
  if (!nearest || Math.abs(nearest.x - point.clientX) > MOTION_LIBRARY_CUT_SNAP_PX_V1) {
    return { kind: "invalid", reason: cuts.length ? "靠近兩段影片相接的剪接點再放開。" : "這條軌道還沒有剪接點；先用剪刀（B）切開影片。", lane };
  }
  return { kind: "cut", cut: { trackId: nearest.cut.trackId, fromClipId: nearest.cut.fromClipId, toClipId: nearest.cut.toClipId }, x: nearest.x, lane };
}

/** Reads the timeline viewport's geometry, or undefined while no timeline is shown. */
export function readMotionLibraryDropGeometryV1(document: Document): MotionLibraryDropGeometryV1 | undefined {
  const viewport = document.querySelector<HTMLElement>(".timeline-scroll[data-timeline-viewport='true']");
  if (!viewport) return undefined;
  const pixelsPerSecond = Number(viewport.dataset.timelinePixelsPerSecond), fps = Number(viewport.dataset.timelineFps);
  if (!(pixelsPerSecond > 0) || !(fps > 0)) return undefined;
  const box = viewport.getBoundingClientRect();
  const left = box.left + viewport.clientLeft, top = box.top + viewport.clientTop;
  const ruler = viewport.querySelector<HTMLElement>(".ruler-row")?.getBoundingClientRect();
  const area = { left: left + TIMELINE_LABEL_WIDTH, top: ruler ? Math.max(top, ruler.bottom) : top, right: left + viewport.clientWidth, bottom: top + viewport.clientHeight };
  const lanes = [...viewport.querySelectorAll<HTMLElement>(".track-lane[data-track-id]")].map(node => {
    const rect = node.getBoundingClientRect();
    return { trackId: node.dataset.trackId!, kind: node.dataset.trackKind ?? "", locked: node.dataset.trackLocked === "true",
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
  return { area, lanes, pixelsPerSecond, fps };
}
