import type { TimelineMarkRange } from "../application/timelineNavigation";

export function TimelineRangeOverlay({ range, pixelsPerSecond, ruler = false }: { range?: TimelineMarkRange; pixelsPerSecond: number; ruler?: boolean }) {
  const from = range?.in, to = range?.out;
  return <>
    {from !== undefined && to !== undefined && to > from && <div className={`timeline-mark-range ${ruler ? "on-ruler" : "on-track"}`} style={{ left: from * pixelsPerSecond, width: (to - from) * pixelsPerSecond }} aria-hidden="true" data-testid={ruler ? "timeline-range-ruler" : undefined} />}
    {[from, to].map((value, index) => value === undefined ? null : <div key={index} className="timeline-range-edge" style={{ left: value * pixelsPerSecond }} aria-hidden="true" data-testid={ruler ? index === 0 ? "timeline-range-in" : "timeline-range-out" : undefined} />)}
  </>;
}
