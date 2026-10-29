import { findAsset, findClip } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, MediaAsset } from "../domain/types";

export const RETIME_DONE = "已更新片段速度與倒放；復原一次即可完整還原。";
export const RETIME_SOURCE_MISSING = "原素材已不在專案中，無法再次調整速度；原專案保持不變。";

/** Presets are absolute speeds. A trimmed previous derivative maps back to its retained original source window. */
export function resolveRetimeWindow(project: EditProject, clipId: string, rate: number, reverse: boolean) {
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new Error("速度必須介於 0.25 倍到 4 倍。" );
  const clip = findClip(project, clipId), current = findAsset(project, clip.assetId), previous = current.clipRetime;
  const asset = previous ? project.assets.find(item => item.id === previous.sourceAssetId) : current;
  if (!asset) throw new Error(RETIME_SOURCE_MISSING);
  if (asset.kind === "image" || asset.compositionId || asset.imageSequence) throw new Error("速度調整只支援一般影片或聲音素材。" );
  // Ceil-to-frame output padding repeats the final frame; it never extends the retained original window.
  const localStart = previous ? Math.min(previous.sourceDuration, clip.sourceStart * previous.rate) : clip.sourceStart;
  const localEnd = previous ? Math.min(previous.sourceDuration, (clip.sourceStart + clip.duration) * previous.rate) : clip.sourceStart + clip.duration;
  const sourceDuration = localEnd - localStart;
  const sourceStart = !previous ? localStart : previous.sourceStart + (previous.reverse ? previous.sourceDuration - localEnd : localStart);
  if (sourceDuration <= 1e-9 || sourceStart < -1e-6 || sourceStart + sourceDuration > asset.duration + 1 / project.fps) throw new Error("原素材的可用範圍不足，無法調整速度。" );
  return { asset, sourceStart: Math.max(0, sourceStart), sourceDuration, rate, reverse, fps: project.fps,
    duration: Math.max(1 / project.fps, Math.ceil(sourceDuration * project.fps / rate - 1e-7) / project.fps) };
}

export function planClipRetime(project: EditProject, clipId: string, expectedAssetId: string, asset: MediaAsset, duration: number) {
  const command: EditorCommand = { type: "batch", commands: [
    { type: "import_asset", asset }, { type: "retime_clip", clipId, expectedAssetId, assetId: asset.id, sourceStart: 0, duration },
  ] };
  applyCommand(project, command);
  return { command, message: RETIME_DONE };
}
