import { useRef, useState } from "react";
import { buildSceneSplitCommand } from "../application/sceneSplitCommands";
import type { EditorCommand } from "../domain/commands";
import type { EditProject, TimelineClip } from "../domain/types";
import type { HaoDesktopApi } from "./types";
import type { ProjectSession } from "../application/projectSession";
import { acceptProjectTask } from "../application/projectTask";

interface UseSceneDetectionOptions {
  api?: HaoDesktopApi;
  project: EditProject;
  projectSession: ProjectSession;
  selectedClip?: TimelineClip;
  onCommand: (command: EditorCommand, message: string) => void;
  onStatus: (message: string) => void;
}

export function useSceneDetection({ api, project, projectSession, selectedClip, onCommand, onStatus }: UseSceneDetectionOptions) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = async () => {
    if (pending.current) return;
    const task = projectSession.beginTask(project);
    const current = () => acceptProjectTask(task, onStatus, "自動分鏡");
    if (!current()) return;
    if (!api) return onStatus("自動分鏡需要桌面版的本機 FFmpeg scdet 引擎。");
    if (!selectedClip) return onStatus("請先選一段要自動分鏡的影片。");
    const asset = project.assets.find((item) => item.id === selectedClip.assetId);
    if (!asset || asset.kind !== "video") return onStatus("自動分鏡只支援影片片段。");
    pending.current = true;
    try {
      setBusy(true);
      onStatus("正在本機尋找鏡頭切換；素材不會上傳…");
      const result = await api.detectScenes({
        sourcePath: asset.uri,
        sourceStart: selectedClip.sourceStart,
        duration: selectedClip.duration,
        fps: project.fps,
        sourceSha256: asset.derivatives?.sourceSha256,
      });
      if (!current()) return;
      if (!result.cuts.length) return onStatus("這段影片沒有偵測到明確硬切點，Timeline 保持原樣。");
      const planned = buildSceneSplitCommand(project, selectedClip, result.cuts);
      if (!current()) return;
      onCommand(planned.command, `自動分鏡完成：切成 ${planned.splitCount + 1} 個鏡頭 · ${result.cacheHit ? "快取" : result.engine}`);
    } catch (error) {
      if (!current()) return;
      onStatus(error instanceof Error ? `自動分鏡失敗：${error.message}` : "自動分鏡失敗");
    } finally { pending.current = false; setBusy(false); }
  };
  return { busy, run };
}
