/** A snapshot of interval ends. Leaves retain the existing sorted-index positions. */
export interface TimelineIntervalEndTree {
  leafCount: number;
  maximumEnds: number[];
}

export function buildTimelineIntervalEndTree(intervals: readonly { end: number }[]): TimelineIntervalEndTree {
  if (!intervals.length) return { leafCount: 0, maximumEnds: [] };
  let leafCount = 1;
  while (leafCount < intervals.length) leafCount *= 2;
  const maximumEnds = new Array<number>(leafCount * 2).fill(Number.NEGATIVE_INFINITY);
  for (let position = 0; position < intervals.length; position += 1) {
    maximumEnds[leafCount + position] = intervals[position].end;
  }
  for (let node = leafCount - 1; node > 0; node -= 1) {
    maximumEnds[node] = Math.max(maximumEnds[node * 2], maximumEnds[node * 2 + 1]);
  }
  return { leafCount, maximumEnds };
}

/** Visit in original stable index order, pruning subtrees which cannot overlap. */
export function visitTimelineIntervalEnds(
  tree: TimelineIntervalEndTree,
  first: number,
  last: number,
  visibleStart: number,
  visit: (position: number) => void,
): void {
  if (!tree.leafCount || first >= last) return;
  const walk = (node: number, start: number, end: number): void => {
    if (end <= first || start >= last || tree.maximumEnds[node] <= visibleStart) return;
    if (end - start === 1) {
      visit(start);
      return;
    }
    const middle = (start + end) / 2;
    walk(node * 2, start, middle);
    walk(node * 2 + 1, middle, end);
  };
  walk(1, 0, tree.leafCount);
}

