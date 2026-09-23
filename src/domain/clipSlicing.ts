import { EditGraphError } from "./editGraph";
import { motionTrackPoseAt } from "./motionTrackSampling";
import type { ClipMask, EditProject, MaskKeyframe, MotionTrack, MotionTrackPoint, TimelineClip } from "./types";

export interface ClipVisualSlice {
  clipId: string;
  /** Original clip-local seconds, not source-media or timeline seconds. */
  start: number;
  end: number;
}

/** Total observations evaluated by one command, before allocating any sliced state. */
export const MAX_CLIP_SLICE_SAMPLES = 100_000;
const EPSILON = 1e-8;

function allocateId(preferred: string, reserved: Set<string>): string {
  let candidate = preferred;
  let suffix = 2;
  while (reserved.has(candidate)) candidate = `${preferred}-${suffix++}`;
  reserved.add(candidate);
  return candidate;
}

function nextIndex(samples: readonly { time: number }[], time: number): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nearest<T extends { time: number }>(samples: readonly T[], time: number): T {
  const low = nextIndex(samples, time);
  if (low === 0) return samples[0];
  if (low === samples.length) return samples[low - 1];
  // Match the existing nearest consumer's earlier-observation tie rule.
  return Math.abs(samples[low].time - time) < Math.abs(samples[low - 1].time - time) ? samples[low] : samples[low - 1];
}

/**
 * Preserve observations at every executable project frame. Keeping both ends
 * of each equal-value run compresses holds without shifting a frame decision.
 * This is project-frame parity, not a claim of subframe interpolation parity.
 */
function sampleFrames<T extends { frame: number; time: number }>(
  range: ClipVisualSlice, fps: number, sample: (sourceTime: number) => T, compressHolds = true,
): T[] {
  const result: T[] = [];
  let previous: T | undefined;
  let signature: string | undefined;
  const append = (point: T) => { if (result.at(-1)?.frame !== point.frame) result.push(point); };
  const lastFrame = Math.floor((range.end - range.start) * fps + EPSILON);
  for (let frame = 0; frame <= lastFrame; frame++) {
    const time = frame / fps;
    const observed = sample(Math.min(range.end, range.start + time));
    const point = { ...structuredClone(observed), frame, time };
    if (!compressHolds) { result.push(point); continue; }
    const { frame: _frame, time: _time, ...state } = observed;
    const nextSignature = JSON.stringify(state);
    if (signature !== nextSignature) {
      if (previous) append(previous);
      append(point);
      signature = nextSignature;
    }
    previous = point;
  }
  if (previous) append(previous);
  return result;
}

function sliceTrack(track: MotionTrack, range: ClipVisualSlice, fps: number, maskConsumer: boolean, id: string): MotionTrack {
  const points = track.points.length === 0 ? [] : sampleFrames(range, fps, (time): MotionTrackPoint => {
    const observation = nearest(track.points, time);
    if (maskConsumer) return observation;
    const index = nextIndex(track.points, time);
    // Reuse the real linear/lost-hold contract without its full-array search
    // for each frame of a long tracking sequence.
    const neighbours = track.points.slice(Math.max(0, index - 1), Math.min(track.points.length, index + 1));
    const pose = motionTrackPoseAt({ ...track, points: neighbours }, time);
    return pose
      ? { ...observation, ...pose }
      : { ...observation, status: "lost", confidence: 0 };
  }, false);
  const { points: _originalPoints, ...metadata } = track;
  return {
    ...structuredClone(metadata), id, clipId: range.clipId, analysisFps: fps, points,
    initialRect: { ...(points[0]?.rect ?? track.initialRect) },
    lostRatio: points.length ? points.filter((point) => point.status === "lost").length / points.length : 0,
  };
}

function sliceMask(mask: ClipMask, range: ClipVisualSlice, fps: number, id: string, trackIds: Map<string, string>): ClipMask {
  const result = structuredClone(mask);
  result.id = id;
  if (mask.trackId) result.trackId = trackIds.get(mask.trackId);
  if (mask.keyframes.length) {
    const keyframes = mask.keyframes;
    if (keyframes.some((keyframe, index) => index > 0 && keyframe.time <= keyframes[index - 1].time)) {
      throw new EditGraphError(`遮罩 ${mask.id} 的關鍵幀時間未遞增；請先整理動畫關鍵幀再切片，原遮罩已保留。`);
    }
    result.keyframes = sampleFrames<MaskKeyframe>(range, fps, (time) => nearest(keyframes, time));
  }
  if (mask.frozenRange) {
    const offset = Math.round(range.start * fps);
    const lastFrame = Math.round((range.end - range.start) * fps);
    const clamp = (frame: number) => Math.max(0, Math.min(lastFrame, frame - offset));
    // An empty intersection keeps a zero-width invalidation anchor, never a
    // claim that a newly sliced pixel sequence was generated or verified.
    result.frozenRange = { fromFrame: clamp(mask.frozenRange.fromFrame), toFrame: clamp(mask.frozenRange.toFrame) };
  }
  if (mask.rotoCorrections) {
    const rate = mask.matteSequence?.analysisFps ?? Math.min(12, fps);
    const frameCount = Math.max(1, Math.ceil((range.end - range.start) * rate - EPSILON));
    result.rotoCorrections = mask.rotoCorrections.flatMap((stroke) => {
      const time = stroke.frame / rate;
      if (time < range.start - EPSILON || time >= range.end - EPSILON) return [];
      // Quantize to the nearest remaining analysis frame; never produce the
      // exclusive frameCount endpoint rejected by the native brush importer.
      const frame = Math.max(0, Math.min(frameCount - 1, Math.round((time - range.start) * rate)));
      return [{ ...structuredClone(stroke), frame }];
    });
  }
  if (result.matteSequence) {
    result.matteSequence.stale = true;
    result.matteSequence.staleReason = "clip-time-range-changed";
  }
  return result;
}

/**
 * Shared split/trim/Smart Cut ownership boundary. Masks and motion tracks are
 * cloned together; callers retain their existing transform/transition logic.
 * No writes occur until the complete visual plan has been built successfully.
 */
export function sliceClipVisuals(project: EditProject, original: TimelineClip, ranges: readonly ClipVisualSlice[]): Array<ClipMask[] | undefined> {
  const unchanged = ranges.length === 1 && ranges[0].clipId === original.id
    && Math.abs(ranges[0].start) < EPSILON && Math.abs(ranges[0].end - original.duration) < EPSILON;
  if (unchanged) return [structuredClone(original.masks)];
  const tracks = project.motionTracks.filter((track) => track.clipId === original.id);
  const trackIds = new Set(tracks.map((track) => track.id));
  if (project.motionGraphics.some((graphic) => graphic.trackId && trackIds.has(graphic.trackId))) {
    throw new EditGraphError("這個片段有綁定追蹤的動態文字／圖卡；目前無法安全轉移切片動畫時鐘。請先完成剪輯再追蹤，或解除圖卡追蹤綁定後重新追蹤。");
  }
  if (tracks.length && project.fps > 120) {
    throw new EditGraphError("超過 120 FPS 的追蹤片段目前無法安全切片；請先完成剪輯再追蹤，或在 120 FPS 以下的專案重新分析。");
  }
  const animatedMasks = (original.masks ?? []).filter((mask) => mask.keyframes.length > 0).length;
  const observationCount = ranges.reduce((sum, range) => sum + Math.floor((range.end - range.start) * project.fps + EPSILON) + 1, 0)
    * (tracks.length + animatedMasks);
  if (!Number.isSafeInteger(observationCount) || observationCount > MAX_CLIP_SLICE_SAMPLES) {
    throw new EditGraphError(`追蹤／遮罩切片超過 ${MAX_CLIP_SLICE_SAMPLES.toLocaleString("en-US")} 個取樣的安全上限；請先剪輯較短的片段，再重新追蹤或製作遮罩動畫。`);
  }
  const reservedMasks = new Set(project.tracks.flatMap((track) => track.clips).flatMap((clip) => (clip.masks ?? []).map((mask) => mask.id)));
  const reservedTracks = new Set(project.motionTracks.map((track) => track.id));
  const maskTrackIds = new Set((original.masks ?? []).flatMap((mask) => mask.trackId ? [mask.trackId] : []));
  const newTracks: MotionTrack[] = [];
  const masks = ranges.map((range) => {
    const mappedTracks = new Map<string, string>();
    for (const track of tracks) {
      const id = range.clipId === original.id ? track.id : allocateId(`${track.id}-${range.clipId}`, reservedTracks);
      mappedTracks.set(track.id, id);
      newTracks.push(sliceTrack(track, range, project.fps, maskTrackIds.has(track.id), id));
    }
    return original.masks?.map((mask) => {
      if (mask.trackId && !mappedTracks.has(mask.trackId)) throw new EditGraphError(`遮罩 ${mask.id} 的追蹤參照不存在，無法安全切片`);
      const id = range.clipId === original.id ? mask.id : allocateId(`${mask.id}-${range.clipId}`, reservedMasks);
      return sliceMask(mask, range, project.fps, id, mappedTracks);
    });
  });
  project.motionTracks = project.motionTracks.filter((track) => track.clipId !== original.id).concat(newTracks);
  return masks;
}
