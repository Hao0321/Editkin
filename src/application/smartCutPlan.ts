import type { NativeSmartCutPlan, SmartCutRequest } from "../render/nativeCore";

export interface SmartCutOptions {
  thresholdDb: number;
  minSilence: number;
  padding: number;
  minKeep: number;
}

export interface SmartCutResult extends NativeSmartCutPlan {
  silenceCount: number;
  thresholdDb: number;
  analyzedSeconds: number;
  cacheHit: boolean;
}

export const DEFAULT_SMART_CUT_OPTIONS: SmartCutOptions = {
  thresholdDb: -35,
  minSilence: 0.35,
  padding: 0.08,
  minKeep: 0.25,
};

function frame(value: number, fps: number): number {
  return Math.round(value * fps);
}

function validateRequest(request: SmartCutRequest): void {
  if (!Number.isFinite(request.fps) || request.fps <= 0 || request.fps > 240) throw new Error("Smart Cut fps 不合法");
  if (!Number.isFinite(request.duration) || request.duration <= 0) throw new Error("Smart Cut 片段時長不合法");
  for (const value of [request.options.padding, request.options.minSilence, request.options.minKeep]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Smart Cut 參數不合法");
  }
}

export function planSmartCutReference(request: SmartCutRequest): NativeSmartCutPlan {
  validateRequest(request);
  const sourceFrames = frame(request.duration, request.fps);
  const paddingFrames = frame(request.options.padding, request.fps);
  const minSilenceFrames = Math.max(1, frame(request.options.minSilence, request.fps));
  const minKeepFrames = Math.max(1, frame(request.options.minKeep, request.fps));
  const removals = request.silences.map((silence) => {
    if (![silence.start, silence.end].every((value) => Number.isFinite(value) && value >= 0) || silence.end < silence.start) {
      throw new Error("Smart Cut silence range 不合法");
    }
    const rawStart = Math.max(0, Math.min(sourceFrames, frame(silence.start, request.fps)));
    const rawEnd = Math.max(0, Math.min(sourceFrames, frame(silence.end, request.fps)));
    if (rawEnd - rawStart < minSilenceFrames) return undefined;
    const startFrame = Math.min(sourceFrames, rawStart + paddingFrames);
    const endFrame = Math.max(0, rawEnd - paddingFrames);
    return endFrame > startFrame ? { startFrame, endFrame } : undefined;
  }).filter((range): range is { startFrame: number; endFrame: number } => Boolean(range))
    .sort((left, right) => left.startFrame - right.startFrame);
  const merged: Array<{ startFrame: number; endFrame: number }> = [];
  for (const range of removals) {
    const previous = merged.at(-1);
    if (previous && range.startFrame - previous.endFrame < minKeepFrames) previous.endFrame = Math.max(previous.endFrame, range.endFrame);
    else merged.push({ ...range });
  }
  if (merged[0] && merged[0].startFrame < minKeepFrames) merged[0].startFrame = 0;
  if (merged.at(-1) && sourceFrames - merged.at(-1)!.endFrame < minKeepFrames) merged.at(-1)!.endFrame = sourceFrames;
  const ranges: Array<{ startFrame: number; endFrame: number }> = [];
  let cursor = 0;
  for (const removal of merged) {
    if (removal.startFrame > cursor) ranges.push({ startFrame: cursor, endFrame: removal.startFrame });
    cursor = Math.max(cursor, removal.endFrame);
  }
  if (cursor < sourceFrames) ranges.push({ startFrame: cursor, endFrame: sourceFrames });
  if (!ranges.length) throw new Error("Smart Cut 會移除整個片段，已停止");
  const keptFrames = ranges.reduce((sum, range) => sum + range.endFrame - range.startFrame, 0);
  return { engine: "editkin-typescript-safe-fallback-0.1", fps: request.fps, sourceFrames, ranges, removedFrames: sourceFrames - keptFrames, cutCount: merged.length };
}
