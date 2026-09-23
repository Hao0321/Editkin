import { useRef, useState } from "react";
import type { EditorCommand } from "../domain/commands";
import type { EditProject, TimelineClip } from "../domain/types";
import { makeId } from "../lib/format";
import type { HaoDesktopApi } from "./types";
import type { ProjectSession } from "../application/projectSession";
import { acceptProjectTask } from "../application/projectTask";

interface UseSmartCutOptions {
  api?: HaoDesktopApi;
  project: EditProject;
  projectSession: ProjectSession;
  selectedClip?: TimelineClip;
  onCommand: (command: EditorCommand, message: string) => void;
  onStatus: (message: string) => void;
}

export function useSmartCut({ api, project, projectSession, selectedClip, onCommand, onStatus }: UseSmartCutOptions) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = async () => {
    if (pending.current) return;
    const task = projectSession.beginTask(project);
    const current = () => acceptProjectTask(task, onStatus, "智慧去停頓");
    if (!current()) return;
    if (!api) return onStatus("智慧去停頓需要桌面版的本機 FFmpeg／Rust 引擎。");
    if (!selectedClip) return onStatus("請先選一段有人聲的影片或聲音片段。");
    const asset = project.assets.find((item) => item.id === selectedClip.assetId);
    if (!asset || asset.kind === "image") return onStatus("智慧去停頓只支援含聲音的影片或音訊。");
    pending.current = true;
    try {
      setBusy(true);
      onStatus("正在本機分析聲音停頓；素材不會上傳…");
      const result = await api.smartCutMedia({
        sourcePath: asset.uri, sourceStart: selectedClip.sourceStart, duration: selectedClip.duration,
        fps: project.fps, sourceSha256: asset.derivatives?.sourceSha256,
      });
      if (!current()) return;
      if (result.removedFrames <= 0) return onStatus("沒有偵測到足夠長的停頓，Timeline 保持原樣。");
      const keepRanges = result.ranges.map((range) => ({ start: range.startFrame / result.fps, end: range.endFrame / result.fps }));
      onCommand({
        type: "smart_cut_clip", clipId: selectedClip.id, keepRanges,
        segmentIds: keepRanges.map((_, index) => index === 0 ? selectedClip.id : makeId("clip-smart")),
      }, `智慧去停頓完成：刪除 ${(result.removedFrames / result.fps).toFixed(1)} 秒 · ${result.cutCount} 刀 · ${result.cacheHit ? "快取" : result.engine}`);
    } catch (error) {
      if (!current()) return;
      onStatus(error instanceof Error ? `智慧去停頓失敗：${error.message}` : "智慧去停頓失敗");
    } finally { pending.current = false; setBusy(false); }
  };
  return { busy, run };
}
