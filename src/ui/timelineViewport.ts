import { buildTimelineIntervalEndTree, visitTimelineIntervalEnds, type TimelineIntervalEndTree } from "./timelineIntervalEndTree";

export interface TimelineInterval {
  start: number;
  end: number;
}

export interface TimelineIntervalIndex<T> {
  items: T[];
  intervals: TimelineInterval[];
  starts: number[];
  prefixMaxEnd: number[];
  positions: Map<T, number>;
  /** Derived immutable snapshot; optional so legacy/manual indexes remain queryable. */
  endTree?: TimelineIntervalEndTree;
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function buildTimelineIntervalIndex<T>(source: T[], interval: (item: T) => TimelineInterval): TimelineIntervalIndex<T> {
  const pairs = source.map((item) => ({ item, interval: interval(item) }))
    .sort((left, right) => left.interval.start - right.interval.start || left.interval.end - right.interval.end);
  const prefixMaxEnd: number[] = [];
  let maximum = Number.NEGATIVE_INFINITY;
  let hasNestedEnd = false;
  for (const pair of pairs) {
    if (pair.interval.end < maximum) hasNestedEnd = true;
    maximum = Math.max(maximum, pair.interval.end);
    prefixMaxEnd.push(maximum);
  }
  const items = pairs.map((pair) => pair.item);
  const intervals = pairs.map((pair) => pair.interval);
  const index: TimelineIntervalIndex<T> = { items, intervals, starts: pairs.map((pair) => pair.interval.start), prefixMaxEnd, positions: new Map(items.map((item, position) => [item, position])) };
  // With monotonic ends the original prefix bounds already visit only overlaps.
  if (hasNestedEnd) index.endTree = buildTimelineIntervalEndTree(intervals);
  return index;
}

export function queryTimelineIntervalIndex<T>(index: TimelineIntervalIndex<T>, visibleStart: number, visibleEnd: number): T[] {
  if (!index.items.length || visibleEnd <= visibleStart) return [];
  const first = lowerBound(index.prefixMaxEnd, visibleStart + Number.EPSILON);
  const last = lowerBound(index.starts, visibleEnd);
  if (first >= last) return [];
  const output: T[] = [];
  if (index.endTree) {
    visitTimelineIntervalEnds(index.endTree, first, last, visibleStart, position => {
      if (index.intervals[position].end > visibleStart) output.push(index.items[position]);
    });
  } else {
    // Older callers can still supply the original public index shape.
    for (let cursor = first; cursor < last; cursor += 1) {
      if (index.intervals[cursor].end > visibleStart) output.push(index.items[cursor]);
    }
  }
  return output;
}

export function timelineRulerStep(pixelsPerSecond: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return candidates.find((seconds) => seconds * pixelsPerSecond >= 72) ?? candidates.at(-1)!;
}
/** Preserve the captured DOM node AND its sibling order as it leaves the viewport. */
export function retainTimelineSelection<T extends { id: string }>(visible: T[], selected: T | undefined, index: TimelineIntervalIndex<T>): T[] {
  if (!selected || visible.some(item => item.id === selected.id)) return visible;
  const position = index.positions.get(selected);
  if (position === undefined) return visible;
  let low = 0, high = visible.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index.positions.get(visible[middle])! < position) low = middle + 1;
    else high = middle;
  }
  // Appending an earlier item makes React move the captured element in the DOM,
  // which causes WebView2 to lose pointer capture mid-drag. Keep index order.
  return [...visible.slice(0, low), selected, ...visible.slice(low)];
}

