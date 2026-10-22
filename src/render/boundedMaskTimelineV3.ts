/** FFmpeg's expression parser has a recursion limit. V3's exact per-frame paths need logarithmic selection depth. */
export function boundedMaskTimelineExpressionV3(times: readonly number[], valueAt: (index: number) => string,
  formatNumber: (value: number) => string): string {
  if (!times.length || times.length > 1800 || times.some((time, i) => !Number.isFinite(time) || time < 0 || (i > 0 && time <= times[i-1]))) {
    throw new Error("固定影像窗需要有效的逐格片段與獨立窗口版面。");
  }
  function choose(first: number, last: number): string {
    if (first === last) return valueAt(first);
    const middle = Math.floor((first + last) / 2), boundary = (times[middle] + times[middle+1]) / 2;
    return `if(lt(T\\,${formatNumber(boundary)})\\,${choose(first,middle)}\\,${choose(middle+1,last)})`;
  }
  return choose(0,times.length-1);
}
