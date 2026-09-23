import type { ClipMask, EditProject, MaskPathPoint, MaskShapeKind, MotionTrackPoint, TimelineClip } from "./types";
import { clipLocalProjectFrame, compileClipAlphaPlan, floorClipAlphaSampleIndex, pixelMatteOperation } from "./clipAlphaPlan";

const RECTANGLE: MaskPathPoint[] = [
  { id: "p1", x: 0.2, y: 0.18 }, { id: "p2", x: 0.8, y: 0.18 },
  { id: "p3", x: 0.8, y: 0.82 }, { id: "p4", x: 0.2, y: 0.82 },
];

const ELLIPSE: MaskPathPoint[] = [
  { id: "p1", x: 0.22, y: 0.2 }, { id: "p2", x: 0.78, y: 0.2 },
  { id: "p3", x: 0.78, y: 0.8 }, { id: "p4", x: 0.22, y: 0.8 },
];

export function createClipMask(id: string, kind: MaskShapeKind): ClipMask {
  const subject = kind === "subject";
  return {
    id, name: subject ? "主體追蹤遮罩" : kind === "ellipse" ? "橢圓遮罩" : kind === "polygon" ? "鋼筆遮罩" : "矩形遮罩",
    kind, mode: "add", enabled: true, inverted: false, opacity: 1, feather: subject ? 0.035 : 0.015,
    expansion: subject ? 0.012 : 0, path: structuredClone(kind === "ellipse" ? ELLIPSE : RECTANGLE), keyframes: [],
    refine: { edgeShift: 0, contrast: 0.5, chatterReduction: subject ? 0.65 : 0.25 },
  };
}

function pathFromTrackPoint(point: MotionTrackPoint): MaskPathPoint[] {
  if (point.quad?.length === 4) return point.quad.map((corner, index) => ({ id: `tracked-${index}`, x: corner.x, y: corner.y }));
  const { x, y, width, height } = point.rect;
  return [
    { id: "p1", x, y }, { id: "p2", x: x + width, y },
    { id: "p3", x: x + width, y: y + height }, { id: "p4", x, y: y + height },
  ];
}

export interface ResolvedMaskPath {
  points: MaskPathPoint[];
  status: "tracked" | "held" | "lost" | "manual";
}

export function resolveMaskPath(project: EditProject, clip: TimelineClip, mask: ClipMask, localTime: number): ResolvedMaskPath {
  if (mask.trackId) {
    const track = project.motionTracks.find((item) => item.id === mask.trackId && item.clipId === clip.id);
    if (!track || track.points.length === 0) return { points: mask.path, status: "lost" };
    const nearest = track.points.reduce((best, point) => Math.abs(point.time - localTime) < Math.abs(best.time - localTime) ? point : best, track.points[0]);
    return { points: nearest.status === "lost" ? mask.path : pathFromTrackPoint(nearest), status: nearest.status };
  }
  if (mask.keyframes.length > 0) {
    const nearest = mask.keyframes.reduce((best, keyframe) => Math.abs(keyframe.time - localTime) < Math.abs(best.time - localTime) ? keyframe : best, mask.keyframes[0]);
    return { points: nearest.points, status: nearest.status };
  }
  return { points: mask.path, status: "manual" };
}

function expandedPoints(points: MaskPathPoint[], expansion: number): MaskPathPoint[] {
  const cx = points.reduce((sum, point) => sum + point.x, 0) / Math.max(1, points.length);
  const cy = points.reduce((sum, point) => sum + point.y, 0) / Math.max(1, points.length);
  const scale = Math.max(0.05, 1 + expansion * 2);
  return points.map((point) => ({ ...point, x: Math.max(0, Math.min(1, cx + (point.x - cx) * scale)), y: Math.max(0, Math.min(1, cy + (point.y - cy) * scale)) }));
}

export function maskCssImage(project: EditProject, clip: TimelineClip, mask: ClipMask, localTime: number): string {
  if (!mask.enabled) return "linear-gradient(transparent,transparent)";
  if (mask.matteSequence || mask.frozenRange) {
    // Compatibility helper: pixel mattes obey the same fail-closed validation
    // and frame sampling as the active preview, never a stale image or ellipse.
    const plan = compileClipAlphaPlan(project, { ...clip, masks: [mask] });
    const pixel = pixelMatteOperation(plan)!;
    const frame = floorClipAlphaSampleIndex(plan, clipLocalProjectFrame(plan, localTime))!;
    return `url("${pixel.matte.previewUris[frame].replaceAll('"', "%22")}")`;
  }
  const resolved = resolveMaskPath(project, clip, mask, localTime);
  if (resolved.status === "lost") return "linear-gradient(transparent,transparent)";
  const points = expandedPoints(resolved.points, mask.expansion);
  const xs = points.map((point) => point.x * 1000);
  const ys = points.map((point) => point.y * 1000);
  const left = Math.min(...xs); const right = Math.max(...xs); const top = Math.min(...ys); const bottom = Math.max(...ys);
  const shape = mask.kind === "ellipse" || mask.kind === "subject"
    ? `<ellipse cx="${(left + right) / 2}" cy="${(top + bottom) / 2}" rx="${(right - left) / 2}" ry="${(bottom - top) / 2}"/>`
    : mask.kind === "rectangle"
      ? `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="${Math.min(50, (right - left) * .06)}"/>`
      : `<polygon points="${points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")}"/>`;
  const base = mask.inverted ? "white" : "black";
  const fill = mask.inverted ? "black" : "white";
  const blur = Math.max(0, mask.feather * 1000);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs><rect width="1000" height="1000" fill="${base}"/><g fill="${fill}" opacity="${mask.opacity}" filter="url(#f)">${shape}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
