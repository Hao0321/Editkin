import type { MediaAsset, TimelineClip } from "../domain/types";

export interface ClipWaveformWindow {
  /** Source seconds of the media this clip plays. */
  sourceStart: number;
  sourceEnd: number;
  /** Where the whole-file waveform image sits inside the clip, in percent of the clip's width. */
  leftPercent: number;
  widthPercent: number;
}

/**
 * A clip shows only its own part of the sound. The waveform derivative is one image of the whole file
 * (mediaDerivatives: ffmpeg showwavespic across the asset's full length, left edge = 0 s, right edge = the end), so
 * the clip draws it as wide as the whole file at the clip's own scale and shifted left by the clip's in-point: the
 * visible part is exactly sourceStart … sourceStart + duration. A trimmed, split or slipped clip therefore shows the
 * right sound. Undefined when the asset has no usable length.
 */
export function clipWaveformWindow(clip: Pick<TimelineClip, "sourceStart" | "duration">, asset: Pick<MediaAsset, "duration">): ClipWaveformWindow | undefined {
  const total = asset.duration;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(clip.duration) || clip.duration <= 0 || !Number.isFinite(clip.sourceStart)) return undefined;
  const sourceStart = Math.max(0, Math.min(total, clip.sourceStart));
  return { sourceStart, sourceEnd: Math.min(total, sourceStart + clip.duration),
    leftPercent: -sourceStart / clip.duration * 100, widthPercent: total / clip.duration * 100 };
}
