export function playbackFrameIndex(time: number, fps: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Math.max(0, Math.floor(Math.max(0, time) * safeFps));
}

export function previewPlaybackRate(value = 1): number {
  if (![0.5, 1, 2, 4, 8, -0.5, -1, -2, -4, -8].includes(value)) throw new Error("預覽播放速度無效");
  return value;
}

export interface CompatiblePlaybackClockOptions {
  origin: number;
  duration: number;
  fps: number;
  playbackRate?: number;
  now: () => number;
  requestFrame: (callback: (now: number) => void) => number;
  cancelFrame: (handle: number) => void;
  isCurrent: () => boolean;
  onTime: (time: number) => void;
  onEnded: () => void;
}

/** A fresh clock per explicit seek/rate change; cancellation also invalidates delivered callbacks. */
export function startCompatiblePlaybackClock(options: CompatiblePlaybackClockOptions): () => void {
  const rate = previewPlaybackRate(options.playbackRate);
  if (![options.origin, options.duration, options.fps].every(Number.isFinite)
    || options.duration < 0 || options.fps <= 0) throw new Error("預覽播放時間範圍無效");
  const origin = Math.max(0, Math.min(options.duration, options.origin)), startedAt = options.now();
  if (!Number.isFinite(startedAt)) throw new Error("預覽播放時鐘無效");
  let active = true, handle: number | undefined, lastFrame = playbackFrameIndex(origin, options.fps);
  const cancel = () => { active = false; if (handle !== undefined) options.cancelFrame(handle); handle = undefined; };
  const tick = (now: number) => {
    handle = undefined;
    if (!active) return;
    if (!options.isCurrent()) { cancel(); return; }
    if (!Number.isFinite(now)) { cancel(); return; }
    const next = Math.max(0, Math.min(options.duration, origin + Math.max(0, now - startedAt) * rate / 1000));
    const ended = rate < 0 ? next <= 0 : next >= options.duration;
    const frame = playbackFrameIndex(next, options.fps);
    if (frame !== lastFrame || ended) { lastFrame = frame; options.onTime(next); }
    if (!active || !options.isCurrent()) return;
    if (ended) { active = false; options.onEnded(); }
    else handle = options.requestFrame(tick);
  };
  handle = options.requestFrame(tick);
  return cancel;
}
