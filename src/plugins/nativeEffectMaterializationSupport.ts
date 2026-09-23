import type { RenderPlan, RenderSegment } from "../render/planner";

export function videoSegments(plan: RenderPlan): Array<Extract<RenderSegment, { kind: "clip" }>> {
  return plan.videoLayers.flatMap((layer) => layer.segments.filter((segment): segment is Extract<RenderSegment, { kind: "clip" }> => segment.kind === "clip"));
}

export function replaceRenderSegmentRangeWithGap(
  layer: RenderPlan["videoLayers"][number],
  segment: Extract<RenderSegment, { kind: "clip" }>,
  rangeStart: number,
  rangeEnd: number,
): void {
  const index = layer.segments.indexOf(segment);
  if (index < 0) throw new Error(`無法封存 RenderPlan 片段：${segment.clip.id}`);
  const segmentEnd = segment.start + segment.duration;
  const overlapStart = Math.max(segment.start, rangeStart);
  const overlapEnd = Math.min(segmentEnd, rangeEnd);
  if (overlapEnd <= overlapStart + 1e-6) throw new Error(`RenderPlan 封存範圍沒有交集：${segment.clip.id}`);
  const replacement: RenderSegment[] = [];
  if (segment.start < overlapStart - 1e-6) {
    replacement.push({
      kind: "clip", start: segment.start, duration: overlapStart - segment.start, assetPath: segment.assetPath,
      clip: { ...structuredClone(segment.clip), duration: overlapStart - segment.start },
    });
  }
  replacement.push({ kind: "gap", start: overlapStart, duration: overlapEnd - overlapStart });
  if (segmentEnd > overlapEnd + 1e-6) {
    replacement.push({
      kind: "clip", start: overlapEnd, duration: segmentEnd - overlapEnd, assetPath: segment.assetPath,
      clip: {
        ...structuredClone(segment.clip), timelineStart: overlapEnd,
        sourceStart: segment.clip.sourceStart + overlapEnd - segment.start,
        duration: segmentEnd - overlapEnd,
      },
    });
  }
  layer.segments.splice(index, 1, ...replacement);
}

export function safeId(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "_");
}

export function rationalFps(fps: number): { numerator: number; denominator: number } {
  let best = { numerator: Math.round(fps), denominator: 1, error: Math.abs(Math.round(fps) - fps) };
  for (let denominator = 1; denominator <= 1001; denominator += 1) {
    const numerator = Math.round(fps * denominator);
    const error = Math.abs(numerator / denominator - fps);
    if (error < best.error) best = { numerator, denominator, error };
  }
  if (best.numerator <= 0 || best.error > 1e-6) throw new Error(`專案 fps 無法轉成穩定 rational：${fps}`);
  return best;
}

