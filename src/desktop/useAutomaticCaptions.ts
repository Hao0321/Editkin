import { useRef, useState } from "react";
import type { HaoDesktopApi } from "./types";
import type { EditorCommand } from "../domain/commands";
import type { EditProject, TimelineClip } from "../domain/types";
import { buildAutomaticCaptionCommand } from "../application/automaticCaptionCommands";
import type { ProjectSession } from "../application/projectSession";
import { acceptProjectTask } from "../application/projectTask";

interface UseAutomaticCaptionsOptions {
  api?: HaoDesktopApi;
  project: EditProject;
  projectSession: ProjectSession;
  selectedClip?: TimelineClip;
  onCommand: (command: EditorCommand, message: string) => void;
  onStatus: (message: string) => void;
}

export function useAutomaticCaptions({ api, project, projectSession, selectedClip, onCommand, onStatus }: UseAutomaticCaptionsOptions) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = async (mode: "original" | "bilingual-en" = "original") => {
    if (pending.current) return;
    const task = projectSession.beginTask(project);
    const current = () => acceptProjectTask(task, onStatus, "自動字幕");
    if (!current()) return;
    if (!api) return onStatus("自動字幕需要桌面版的本機 FFmpeg／whisper.cpp 引擎。");
    if (!selectedClip) return onStatus("請先選一段有人聲的影片或聲音片段。");
    const asset = project.assets.find((item) => item.id === selectedClip.assetId);
    if (!asset || asset.kind === "image") return onStatus("自動字幕只支援含聲音的影片或音訊。");
    pending.current = true;
    try {
      setBusy(true);
      onStatus(mode === "bilingual-en"
        ? "正在本機辨識原文並翻成英文；兩行都會放進 Timeline，完成後可逐句修改…"
        : "正在本機產生字幕；第一次會下載並驗證約 190 MB 的多語 Whisper 模型，素材不會上傳…");
      const result = await api.automaticCaptionMedia({
        sourcePath: asset.uri,
        sourceStart: selectedClip.sourceStart,
        duration: selectedClip.duration,
        sourceSha256: asset.derivatives?.sourceSha256,
        language: "auto",
        translationTarget: mode === "bilingual-en" ? "en" : undefined,
      });
      if (!current()) return;
      const planned = buildAutomaticCaptionCommand(project, selectedClip, result);
      const source = result.cacheHit ? "快取" : `${result.acceleration.toUpperCase()} · 本機 whisper.cpp`;
      const download = result.modelDownloaded ? " · 模型已驗證安裝" : "";
      const bilingual = result.translationTarget ? " · 原文＋英文雙行可編輯" : "";
      if (!current()) return;
      onCommand(planned.command, `自動字幕完成：${planned.added} 句${planned.replaced ? ` · 取代 ${planned.replaced} 句舊字幕` : ""}${bilingual} · ${source}${download}`);
    } catch (error) {
      if (!current()) return;
      onStatus(error instanceof Error ? `自動字幕失敗：${error.message}` : "自動字幕失敗");
    } finally { pending.current = false; setBusy(false); }
  };
  return { busy, run };
}
