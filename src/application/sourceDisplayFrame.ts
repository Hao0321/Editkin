/** Parse the same decode's showinfo, never infer a frame timestamp from -ss. */
export function sourceDisplayFrame(stderr: string, origin: number, sourceStart: number, duration: number, requestedTime: number, maximumDimension: number) {
  const tb = stderr.match(/config in time_base:\s*(\d+)\/(\d+)/);
  const frame = stderr.match(/n:\s*0\s+pts:\s*(-?\d+)\s+pts_time:[^\s]+[\s\S]*?\bs:(\d+)x(\d+)/);
  if (!tb || !frame) throw Error("decoded-pts-unverified");
  const numerator = Number(tb[1]), denominator = Number(tb[2]), pts = Number(frame[1]), width = Number(frame[2]), height = Number(frame[3]);
  if (![numerator, denominator, width, height].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(pts)
    || width > maximumDimension || height > maximumDimension) throw Error("truncated-or-invalid-rgb-surface");
  const sourceTime = pts * numerator / denominator - origin, relativeTime = sourceTime - sourceStart;
  if (![origin, sourceTime, relativeTime].every(Number.isFinite) || sourceTime < sourceStart + requestedTime - 1e-7 || relativeTime < 0 || relativeTime >= duration) throw Error("decoded-frame-outside-request-window");
  return { pts, timeBase: { numerator, denominator }, sourceTime, relativeTime, width, height };
}
