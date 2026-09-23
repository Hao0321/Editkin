export function playbackFrameIndex(time: number, fps: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Math.max(0, Math.floor(Math.max(0, time) * safeFps));
}
