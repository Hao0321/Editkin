/** Restrict a generated cut to scene intervals already recorded by the Kit. */
export function timedEvidenceFrameCount(
  segment: { start: number; end: number; evidenceFrameIds?: unknown },
  frameTimes: ReadonlyMap<string, number>,
): number {
  const ids = segment.evidenceFrameIds;
  if (!Array.isArray(ids) || ids.length === 0 || !Number.isFinite(segment.start)
    || !Number.isFinite(segment.end) || segment.end <= segment.start) return 0;
  return ids.every(id => typeof id === "string" && frameTimes.has(id)
    && frameTimes.get(id)! >= segment.start - 1e-6 && frameTimes.get(id)! < segment.end - 1e-6)
    ? ids.length : 0;
}

export function evidenceBoundKeepRanges(
  requested: unknown,
  segments: readonly { start: number; end: number; summary: string; evidenceFrameCount?: number }[],
  duration: number,
  fps: number,
): { keepRanges: { start: number; end: number }[]; selectedSummaries: string[]; frames: number } {
  if (!Array.isArray(requested) || requested.length < 2 || requested.length > 8)
    throw Error("Smart Cut needs 2–8 reviewed keep ranges");
  if (!Number.isFinite(duration) || !Number.isFinite(fps) || fps <= 0)
    throw Error("The clip timebase is unavailable");
  const tolerance = 1e-6;
  let previousEnd = -1;
  let previousSegmentIndex = -1;
  let hasInteriorGap = false;
  let frames = 0;
  const keepRanges: { start: number; end: number }[] = [];
  const selectedSummaries: string[] = [];
  for (const value of requested) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Smart Cut range is invalid");
    const { start, end } = value as { start?: unknown; end?: unknown };
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || end > duration + tolerance
      || Math.abs(Math.round(start * fps) / fps - start) > tolerance
      || Math.abs(Math.round(end * fps) / fps - end) > tolerance)
      throw Error("Smart Cut ranges must be positive, frame-aligned and within the clip");
    if (previousEnd >= 0) {
      if (start < previousEnd - tolerance) throw Error("Smart Cut ranges must be ordered and non-overlapping");
      hasInteriorGap ||= start - previousEnd >= 1 / fps - tolerance;
    }
    const index = segments.findIndex((segment, candidate) => candidate > previousSegmentIndex
      && Math.abs(segment.start - start) <= tolerance && Math.abs(segment.end - end) <= tolerance
      && segment.summary.trim().length > 0 && (segment.evidenceFrameCount ?? 0) > 0);
    if (index < 0) throw Error("Smart Cut range does not match a distinct evidenced semantic segment");
    previousEnd = end;
    previousSegmentIndex = index;
    frames += Math.round((end - start) * fps);
    keepRanges.push({ start, end });
    selectedSummaries.push(segments[index].summary);
  }
  if (!hasInteriorGap) throw Error("Smart Cut must remove at least one interior frame");
  if (frames < 24 || frames > 3600) throw Error("Edited duration must be 24–3600 frames");
  return { keepRanges, selectedSummaries, frames };
}
