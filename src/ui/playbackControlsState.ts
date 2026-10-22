export const PREVIEW_PLAYBACK_RATES = [0.5, 1, 2, 4, 8, -0.5, -1, -2, -4, -8] as const;

export function isPreviewPlaybackRate(value: number): boolean {
  return PREVIEW_PLAYBACK_RATES.some(rate => rate === value);
}

export function nextShuttleRate(rate: number, playing: boolean, direction: -1 | 1): number {
  if (!playing || Math.sign(rate) !== direction) return direction;
  return direction * ([1, 2, 4, 8].find(speed => speed > Math.abs(rate)) ?? 8);
}

/** Reverse starts on the last actual frame, where a video layer still exists. */
export function playbackResumeTime(time: number, duration: number, fps: number, rate: number): number {
  if (duration <= 0 || fps <= 0 || !Number.isFinite(duration) || !Number.isFinite(fps)) return 0;
  if (rate < 0 && (time <= 0 || time >= duration)) return Math.max(0, (Math.ceil(duration * fps - 1e-7) - 1) / fps);
  if (rate > 0 && time >= duration) return 0;
  return Math.max(0, Math.min(duration, time));
}

export function stepPreviewFrame(time: number, duration: number, fps: number, direction: -1 | 1): number {
  if (fps <= 0 || !Number.isFinite(fps)) return 0;
  return Math.max(0, Math.min(duration, (Math.round(time * fps) + direction) / fps));
}
