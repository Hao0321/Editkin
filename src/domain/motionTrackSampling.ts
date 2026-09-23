import type { MotionTrack, MotionTrackPoint, NormalizedPoint, NormalizedRect } from "./types";

export interface MotionTrackPose {
  rect: NormalizedRect;
  confidence: number;
  status: MotionTrackPoint["status"];
  rotationDegrees: number;
  scale: number;
  quad?: [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];
}

function pose(point: MotionTrackPoint): MotionTrackPose {
  return {
    rect: { ...point.rect }, confidence: point.confidence, status: point.status,
    rotationDegrees: point.rotationDegrees ?? 0, scale: point.scale ?? 1,
    quad: point.quad?.map((corner) => ({ ...corner })) as MotionTrackPose["quad"],
  };
}

/**
 * Resolves one tracker observation without inventing a lock through an explicitly lost span.
 * A tracked sample is held only until the first lost observation; reacquisition starts at the
 * first subsequent non-lost observation. This contract is shared by preview and Engine Graph.
 */
export function motionTrackPoseAt(track: MotionTrack, localTime: number): MotionTrackPose | undefined {
  if (!Number.isFinite(localTime) || !track.points.length) return undefined;
  const nextIndex = track.points.findIndex((point) => point.time >= localTime);
  if (nextIndex < 0) {
    const last = track.points.at(-1)!;
    return last.status === "lost" ? undefined : pose(last);
  }
  const next = track.points[nextIndex];
  if (Math.abs(next.time - localTime) <= Number.EPSILON || nextIndex === 0) return next.status === "lost" ? undefined : pose(next);
  const previous = track.points[nextIndex - 1];
  if (previous.status === "lost") return undefined;
  if (next.status === "lost" || next.time <= previous.time) return { ...pose(previous), status: "held" };
  const ratio = Math.max(0, Math.min(1, (localTime - previous.time) / (next.time - previous.time)));
  const status: MotionTrackPoint["status"] = previous.status === "manual" && next.status === "manual"
    ? "manual"
    : previous.status === "held" || next.status === "held" ? "held" : "tracked";
  return {
    rect: {
      x: previous.rect.x + (next.rect.x - previous.rect.x) * ratio,
      y: previous.rect.y + (next.rect.y - previous.rect.y) * ratio,
      width: previous.rect.width + (next.rect.width - previous.rect.width) * ratio,
      height: previous.rect.height + (next.rect.height - previous.rect.height) * ratio,
    },
    confidence: previous.confidence + (next.confidence - previous.confidence) * ratio,
    status,
    rotationDegrees: (previous.rotationDegrees ?? 0) + ((next.rotationDegrees ?? 0) - (previous.rotationDegrees ?? 0)) * ratio,
    scale: (previous.scale ?? 1) + ((next.scale ?? 1) - (previous.scale ?? 1)) * ratio,
    quad: previous.quad && next.quad
      ? previous.quad.map((corner, index) => ({ x: corner.x + (next.quad![index].x - corner.x) * ratio, y: corner.y + (next.quad![index].y - corner.y) * ratio })) as MotionTrackPose["quad"]
      : previous.quad?.map((corner) => ({ ...corner })) as MotionTrackPose["quad"],
  };
}

export function trackRectAt(track: MotionTrack, localTime: number): NormalizedRect | undefined {
  return motionTrackPoseAt(track, localTime)?.rect;
}
