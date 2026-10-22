import { useRef, useState } from "react";
import {
  NARRATION_SILENCE_DETECTION, VISUAL_ACTIVITY_DETECTION, audioKeepRangesFromSmartCut, planNarrationPauseTrim, planSemanticAutoEdit,
  planVisualQualityAutoEdit, visualHighlightTargetSeconds, type SemanticAutoEditPlan, type VisualActivitySample,
} from "../application/semanticAutoEdit";
import { isNoSpeechTranscriptError } from "../application/automaticCaptionOutcome";
import { assessTranscriptSpeech } from "../application/transcriptSpeech";
import { automaticMusicPreferences, selectAutomaticMusicAsset } from "../creative/musicSelection";
import { isVerticalCanvas } from "../creative/shortsCaptionStyle";
import type { EditorCommand } from "../domain/commands";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import type { AutomaticCaptionDesktopResult } from "./mediaTypes";
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

/** What one run actually did. The status line stays the user-facing record; callers may ignore this. */
export type SemanticAutoEditOutcome =
  | { ok: true; segmentCount: number; addedCaptions: number; music: boolean }
  | { ok: false; reason: "busy" | "policy" | "stale" | "no-engine" | "no-selection" | "unsupported" | "failed"; message?: string };

interface AnalysisSource { sourcePath: string; sourceStart: number; duration: number; sourceSha256?: string }

/** Frame-change samples for picture steadiness; unmeasured (undefined) rather than failing the edit. */
async function detectVisualActivity(api: HaoDesktopApi, source: AnalysisSource, fps: number): Promise<VisualActivitySample[] | undefined> {
  const minSceneDuration = Math.min(VISUAL_ACTIVITY_DETECTION.minSceneDuration, source.duration / 2);
  if (minSceneDuration < 1 / fps) return undefined;
  try {
    const result = await api.detectScenes({ ...source, fps, threshold: VISUAL_ACTIVITY_DETECTION.threshold, minSceneDuration });
    return result.cuts.map(({ time, score }) => ({ time, score }));
  } catch { return undefined; }
}

export function useSemanticAutoEdit({ api, project, projectSession, selectedClip, onCommand, onStatus, onRuntimeUrls }: UseSemanticAutoEditOptions) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<SemanticAutoEditStage>();
  const pending = useRef(false);
  const refuse = (reason: Exclude<SemanticAutoEditOutcome, { ok: true }>["reason"], message?: string): SemanticAutoEditOutcome => {
    if (message) onStatus(message);
    return { ok: false, reason, message };
  };
  const stale: SemanticAutoEditOutcome = { ok: false, reason: "stale" };
  const runWithOutcome = async (requestedPolicy: NativeEditingPolicy = conservativePolicy): Promise<SemanticAutoEditOutcome> => {
    if (pending.current) return { ok: false, reason: "busy" };
    // A run owns its explicit choice; later UI/caller changes cannot rewrite it
    // while native analysis is pending. Project changes still invalidate the task.
    const policy = { ...requestedPolicy };
    try { validatePolicy(policy); } catch {
      return refuse("policy", "請重新選擇長片或短片，以及字幕與轉場的套用方式。");
    }
    const task = projectSession.beginTask(project);
    const current = () => acceptProjectTask(task, onStatus, "智慧成片");
    if (!current()) return stale;
    if (!api) return refuse("no-engine", "智慧成片需要桌面版的本機 Whisper／FFmpeg 引擎。");
    if (!selectedClip) return refuse("no-selection", "請先選一段要自動濃縮的影片或聲音片段。");
    const asset = project.assets.find((item) => item.id === selectedClip.assetId);
    if (!asset || asset.kind === "image") return refuse("unsupported", "智慧成片只支援含聲音的影片或音訊。");
    pending.current = true;
    try {
      setBusy(true);
      setStage({ step: 1, title: "正在聽懂內容與找鏡頭", detail: "本機分析語音、停頓與畫面切換" });
      onStatus("正在本機聽懂內容、找場景並挑出重點；第一次會安裝並驗證 Whisper 模型，素材不會上傳…");
      const source: AnalysisSource = { sourcePath: asset.uri, sourceStart: selectedClip.sourceStart, duration: selectedClip.duration, sourceSha256: asset.derivatives?.sourceSha256 };
      // Long-form and unspecified runs keep every spoken word and cut only pauses; an explicit Shorts run condenses.
      const narration = policy.format !== "shorts";
      // "No usable speech" (or no audio stream) selects the picture-only edit; any other failure stays an error.
      const captionPromise = api.automaticCaptionMedia({ ...source, language: "auto" }).then(
        (result): AutomaticCaptionDesktopResult | undefined => result,
        (error: unknown) => { if (isNoSpeechTranscriptError(error)) return undefined; throw error; });
      const scenePromise = asset.kind === "video" ? api.detectScenes({ ...source, fps: project.fps })
        : Promise.resolve({ cuts: [] as Array<{ time: number; score: number; frame: number }> });
      // Independent silence evidence: audible speech the transcript missed is never trimmed as a pause.
      const pausePromise = narration
        ? Promise.resolve().then(() => api.smartCutMedia({ ...source, fps: project.fps, options: { ...NARRATION_SILENCE_DETECTION } }))
          .then(audioKeepRangesFromSmartCut, () => undefined)
        : Promise.resolve(undefined);
      const [heard, scenes, audioKeepRanges] = await Promise.all([captionPromise, scenePromise, pausePromise]);
      if (!current()) return stale;
      // Whisper fills ambient-only footage with sound descriptions and outro boilerplate; only plausible speech counts.
      const speech = heard ? assessTranscriptSpeech(heard.cues, selectedClip.duration) : undefined;
      const transcript = heard && speech?.usable ? { ...heard, cues: speech.speechCues } : undefined;
      setStage({ step: 2, title: "正在安排影片節奏", detail: "挑重點、剪停頓並規劃可編輯字幕" });
      let plan: SemanticAutoEditPlan;
      if (transcript) {
        plan = narration
          ? planNarrationPauseTrim({ duration: selectedClip.duration, fps: project.fps, cues: transcript.cues, audioKeepRanges })
          : planSemanticAutoEdit({ duration: selectedClip.duration, fps: project.fps, cues: transcript.cues, cuts: scenes.cuts });
      } else {
        // Without speech, keep the steadiest footage and let music carry it; audio-only material has nothing to pick.
        if (asset.kind !== "video") throw new Error("沒有可用來判斷重點的語音內容");
        const shortForm = policy.format === "shorts" || isVerticalCanvas(project.width, project.height);
        const activity = await detectVisualActivity(api, source, project.fps);
        if (!current()) return stale;
        plan = planVisualQualityAutoEdit({ duration: selectedClip.duration, fps: project.fps, cuts: scenes.cuts, activity,
          targetDuration: visualHighlightTargetSeconds(selectedClip.duration, shortForm) });
      }
      const cues = transcript?.cues ?? [];
      const { buildNativeAutopilotCommand, planNativeAutopilotCreative } = await import("../application/nativeAutopilot");
      if (!current()) return stale;
      const creative = planNativeAutopilotCreative({
        duration: selectedClip.duration,
        width: asset.width ?? project.width,
        height: asset.height ?? project.height,
        cues,
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
        if (!current()) return stale;
        const selectedMusic = selectAutomaticMusicAsset(library.assets, { projectName: project.name, duration: plan.keptDuration, targetBpm: creative.rhythm.targetBpm, ...automaticMusicPreferences(project.editorialProfile) });
        if (selectedMusic) {
          const picked = await api.importCreativeAsset(selectedMusic.id);
          if (!current()) return stale;
          const prepared = await api.prepareMedia(picked.asset);
          if (!current()) return stale;
          musicAsset = { ...picked.asset, derivatives: prepared.derivatives, role: "background-music", bpm: selectedMusic.bpm, license: selectedMusic.license, provenance: selectedMusic.provenance, redistributable: selectedMusic.redistributable };
          musicSelectionId = selectedMusic.id;
          pendingRuntimeUrls = { ...prepared.runtimeUrls, [musicAsset.id]: picked.previewUrl };
        }
      } catch (error) {
        if (!current()) return stale;
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
          if (!current()) return stale;
        } catch {
          if (!current()) return stale;
          trackingResult = undefined;
        }
      }
      setStage({ step: 4, title: "正在寫入可編輯時間軸", detail: "所有變更會合成一次可復原操作" });
      const built = buildNativeAutopilotCommand({ project, clip: selectedClip, transcript: transcript ?? { cues: [] }, semantic: plan, creative, musicAsset, musicSelectionId, trackingResult,
        speechFilter: speech && { dropped: speech.discarded.length, usable: speech.usable } });
      if (!current()) return stale;
      const captionNote = policy.ownership === "manual" ? "保留自訂字幕與有效原邊界轉場"
        : built.captionStyle === "longform-monochrome" ? "長片白字黑底字幕"
          : built.captionStyle === "preserved" ? "未指定片型，保留字幕樣式" : "短片字幕樣式";
      onCommand(built.command, `本機規則式粗剪完成：${built.segmentCount} 段 · ${built.addedCaptions} 句字幕 · ${musicAsset ? "已配樂" : "未配樂"} · ${captionNote} · 新剪點不加轉場 · 可一次復原。可在時間軸繼續調整。`);
      // The accepted synchronous batch advances content ownership itself. Commit its
      // staged URLs in the same turn, but never into a replacement session.
      if (pendingRuntimeUrls && task.isSessionCurrent()) onRuntimeUrls?.(pendingRuntimeUrls);
      return { ok: true, segmentCount: built.segmentCount, addedCaptions: built.addedCaptions, music: Boolean(musicAsset) };
    } catch (error) {
      if (!current()) return stale;
      return refuse("failed", error instanceof Error ? `智慧成片失敗：${error.message}` : "智慧成片失敗");
    } finally { pending.current = false; setBusy(false); setStage(undefined); }
  };
  const run = async (requestedPolicy?: NativeEditingPolicy): Promise<void> => { await runWithOutcome(requestedPolicy); };
  return { busy, stage, run, runWithOutcome };
}
