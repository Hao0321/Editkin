import { useRef, useState } from "react";
import { planSemanticAutoEdit } from "../application/semanticAutoEdit";
import { selectAutomaticMusicAsset } from "../creative/musicSelection";
import type { EditorCommand } from "../domain/commands";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import type { HaoDesktopApi } from "./types";
import type { ProjectSession } from "../application/projectSession";
import { acceptProjectTask } from "../application/projectTask";
import { conservativePolicy, validatePolicy, type NativeEditingPolicy } from "../application/nativeAutopilotPolicy";

interface UseSemanticAutoEditOptions {
  api?: HaoDesktopApi;
  project: EditProject;
  projectSession: ProjectSession;
  selectedClip?: TimelineClip;
  onCommand: (command: EditorCommand, message: string) => void;
  onStatus: (message: string) => void;
  onRuntimeUrls?: (urls: Record<string, string>) => void;
}

export interface SemanticAutoEditStage {
  step: 1 | 2 | 3 | 4;
  title: string;
  detail: string;
}

export function useSemanticAutoEdit({ api, project, projectSession, selectedClip, onCommand, onStatus, onRuntimeUrls }: UseSemanticAutoEditOptions) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<SemanticAutoEditStage>();
  const pending = useRef(false);
  const run = async (requestedPolicy: NativeEditingPolicy = conservativePolicy) => {
    if (pending.current) return;
    // A run owns its explicit choice; later UI/caller changes cannot rewrite it
    // while native analysis is pending. Project changes still invalidate the task.
    const policy = { ...requestedPolicy };
    try { validatePolicy(policy); } catch {
      return onStatus("請重新選擇長片或短片，以及字幕與轉場的套用方式。");
    }
    const task = projectSession.beginTask(project);
    const current = () => acceptProjectTask(task, onStatus, "智慧成片");
    if (!current()) return;
    if (!api) return onStatus("智慧成片需要桌面版的本機 Whisper／FFmpeg 引擎。");
    if (!selectedClip) return onStatus("請先選一段要自動濃縮的影片或聲音片段。");
    const asset = project.assets.find((item) => item.id === selectedClip.assetId);
    if (!asset || asset.kind === "image") return onStatus("智慧成片只支援含聲音的影片或音訊。");
    pending.current = true;
    try {
      setBusy(true);
      setStage({ step: 1, title: "正在聽懂內容與找鏡頭", detail: "本機分析語音、停頓與畫面切換" });
      onStatus("正在本機聽懂內容、找場景並挑出重點；第一次會安裝並驗證 Whisper 模型，素材不會上傳…");
      const captionPromise = api.automaticCaptionMedia({
        sourcePath: asset.uri, sourceStart: selectedClip.sourceStart, duration: selectedClip.duration,
        sourceSha256: asset.derivatives?.sourceSha256, language: "auto",
      });
      const scenePromise = asset.kind === "video" ? api.detectScenes({
        sourcePath: asset.uri, sourceStart: selectedClip.sourceStart, duration: selectedClip.duration,
        fps: project.fps, sourceSha256: asset.derivatives?.sourceSha256,
      }) : Promise.resolve({ cuts: [] as Array<{ time: number; score: number; frame: number }> });
      const [transcript, scenes] = await Promise.all([captionPromise, scenePromise]);
      if (!current()) return;
      setStage({ step: 2, title: "正在安排影片節奏", detail: "挑重點、剪停頓並規劃可編輯字幕" });
      const plan = planSemanticAutoEdit({ duration: selectedClip.duration, fps: project.fps, cues: transcript.cues, cuts: scenes.cuts });
      const { buildNativeAutopilotCommand, planNativeAutopilotCreative } = await import("../application/nativeAutopilot");
      if (!current()) return;
      const creative = planNativeAutopilotCreative({
        duration: selectedClip.duration,
        width: asset.width ?? project.width,
        height: asset.height ?? project.height,
        cues: transcript.cues,
        cuts: scenes.cuts,
        video: asset.kind === "video",
        profile: project.editorialProfile,
        policy,
      });
      let musicAsset: MediaAsset | undefined;
      let musicSelectionId: string | undefined;
      let pendingRuntimeUrls: Record<string, string> | undefined;
      setStage({ step: 3, title: "正在搭配音樂與效果", detail: "安排配樂與畫面；新剪點保持乾淨切換" });
      try {
        const library = await api.listCreativeLibrary();
        if (!current()) return;
        const selectedMusic = selectAutomaticMusicAsset(library.assets, { projectName: project.name, duration: plan.keptDuration, targetBpm: creative.rhythm.targetBpm });
        if (selectedMusic) {
          const picked = await api.importCreativeAsset(selectedMusic.id);
          if (!current()) return;
          const prepared = await api.prepareMedia(picked.asset);
          if (!current()) return;
          musicAsset = { ...picked.asset, derivatives: prepared.derivatives, role: "background-music", bpm: selectedMusic.bpm, license: selectedMusic.license, provenance: selectedMusic.provenance, redistributable: selectedMusic.redistributable };
          musicSelectionId = selectedMusic.id;
          pendingRuntimeUrls = { ...prepared.runtimeUrls, [musicAsset.id]: picked.previewUrl };
        }
      } catch (error) {
        if (!current()) return;
        onStatus(`自動配樂素材略過：${error instanceof Error ? error.message : String(error)}；其他自動剪輯照常完成。`);
      }
      let trackingResult;
      if (creative.tracking.requested && plan.keepRanges.length) {
        const first = plan.keepRanges[0];
        try {
          trackingResult = await api.analyzeMotionTrack({
            sourcePath: asset.uri,
            sourceStart: selectedClip.sourceStart + first.start,
            duration: first.end - first.start,
            fps: project.fps,
            sourceWidth: asset.width ?? project.width,
            sourceHeight: asset.height ?? project.height,
            initialTime: 0,
            initialRect: creative.tracking.initialRect,
            sourceSha256: asset.derivatives?.sourceSha256,
          });
          if (!current()) return;
        } catch {
          if (!current()) return;
          trackingResult = undefined;
        }
      }
      setStage({ step: 4, title: "正在寫入可編輯時間軸", detail: "所有變更會合成一次可復原操作" });
      const built = buildNativeAutopilotCommand({ project, clip: selectedClip, transcript, semantic: plan, creative, musicAsset, musicSelectionId, trackingResult });
      if (!current()) return;
      onCommand(built.command, `本機規則式粗剪完成：${built.segmentCount} 段 · ${built.addedCaptions} 句字幕 · ${musicAsset ? "已配樂" : "未配樂"} · ${policy.ownership === "manual" ? "保留自訂字幕與有效原邊界轉場" : policy.format === "longform" ? "長片白字黑底字幕" : policy.format === "shorts" ? "短片字幕樣式" : "未指定片型，保留字幕樣式"} · 新剪點不加轉場 · 可一次復原。尚未完成 AI 畫面判讀與人工審片。`);
      // The accepted synchronous batch advances content ownership itself. Commit its
      // staged URLs in the same turn, but never into a replacement session.
      if (pendingRuntimeUrls && task.isSessionCurrent()) onRuntimeUrls?.(pendingRuntimeUrls);
    } catch (error) {
      if (!current()) return;
      onStatus(error instanceof Error ? `智慧成片失敗：${error.message}` : "智慧成片失敗");
    } finally { pending.current = false; setBusy(false); setStage(undefined); }
  };
  return { busy, stage, run };
}
