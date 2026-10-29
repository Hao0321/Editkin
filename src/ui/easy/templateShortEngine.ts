import type { TemplateShortGenre } from "../../application/templateShortBrief";
import type { HaoDesktopApi } from "../../desktop/apiTypes";
import type { TemplateShortInAppCopy, TemplateShortJobStatus, TemplateShortPrepareResult, TemplateShortSavedVideo,
  TemplateShortStartRequest } from "../../desktop/templateShortTypes";
import type { TemplateShortInAppResult } from "../../service/templateShortService";
import { EasyEngineError } from "./easyEngines";
import {
  EASY_POINTS_MIN, type EasyArtFlag, type EasyArtFlagKind, type EasyAutoEditEngine, type EasyBrief, type EasyEnginePlan, type EasyGenre,
  type EasyProblemKind, type EasyResult, type EasySavedVideo, type EasyStepIndex, type EasyVideo,
} from "./easyFlowModel";

/**
 * 「直的短影音」: Editkin's one-tool template Short (M1) run in the desktop app. The desktop starts one owned child per
 * run (src-tauri/src/template_short.rs → src/service/templateShortService.ts); this adapter only asks, polls, maps and
 * saves. The creator types every word on screen; nothing is invented here.
 */

/** Each step is a real stage of the run: prepare the clip → template and plan → render → final checks. */
export const TEMPLATE_SHORT_STEPS = ["看你的影片", "加上標題和動畫", "做成影片", "最後檢查一次"] as const;
/** A template Short uses 5–15 seconds of one clip (the first 15 s of a longer one). */
export const TEMPLATE_SHORT_MIN_SECONDS = 5;

const TEMPLATE_SHORT_PLAN: EasyEnginePlan = Object.freeze({
  needsTitle: true, copy: "story", steps: TEMPLATE_SHORT_STEPS, canRestyle: false, canEditText: true, rendersPreview: true, canCancel: true,
});

/** Easy genre → the engine's genre (its theme is that video type's first style). 旅遊/美食 → trip_pop_v1, the pair being
 * certified first. 教學/開箱/遊戲 keep their own themes (swiss_blue_v1 / tech_spec_v1 / game_hud_v1); 生活 and
 * 讓電腦幫我選 use 知識, whose theme is the engine's first one (swiss_blue_v1). UX owner 2026-10-10: everything outside
 * 旅遊/美食 is shown as "watch it once before saving", whatever status the engine reports. */
export const EASY_TEMPLATE_GENRES: Readonly<Record<EasyGenre, TemplateShortGenre>> = Object.freeze({
  travel: "travel", food: "food", teaching: "teaching", unboxing: "unboxing", game: "game", life: "knowledge", auto: "knowledge",
});
export const templateGenreReviewCapped = (genre: EasyGenre) => genre !== "travel" && genre !== "food";

export interface TemplateShortEngineApi {
  templateShortPrepare(sourcePath: string): Promise<TemplateShortPrepareResult>;
  templateShortConfirmRights(sourcePath: string, brandMark?: string): Promise<{ written: boolean; exists?: boolean }>;
  templateShortStart(request: TemplateShortStartRequest): Promise<{ jobId: string }>;
  templateShortStatus(jobId: string): Promise<TemplateShortJobStatus>;
  templateShortCancel(jobId: string): Promise<{ jobId: string; canceled: boolean }>;
  templateShortSaveVideo(jobId: string, fileName: string): Promise<TemplateShortSavedVideo>;
  revealInFolder?(path: string): Promise<void>;
}

/** The desktop API when it can run template Shorts (every required method present), otherwise undefined. */
export function templateShortApiOf(api: Partial<HaoDesktopApi> | undefined): TemplateShortEngineApi | undefined {
  if (!api?.templateShortPrepare || !api.templateShortConfirmRights || !api.templateShortStart || !api.templateShortStatus
    || !api.templateShortCancel || !api.templateShortSaveVideo) return undefined;
  return {
    templateShortPrepare: api.templateShortPrepare, templateShortConfirmRights: api.templateShortConfirmRights, templateShortStart: api.templateShortStart,
    templateShortStatus: api.templateShortStatus, templateShortCancel: api.templateShortCancel, templateShortSaveVideo: api.templateShortSaveVideo,
    ...(api.revealInFolder ? { revealInFolder: api.revealInFolder } : {}),
  };
}

export interface TemplateShortEngineOptions {
  /** The chosen video's path on this computer (the project asset's uri), or undefined when there is none. */
  sourcePathOf(video: EasyVideo): string | undefined;
  pollMs?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Consecutive failed status reads before the run is reported as failed. */
  maxStatusFailures?: number;
}

const abortableWait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new EasyEngineError("已停止")); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(new EasyEngineError("已停止")); };
  signal.addEventListener("abort", stop, { once: true });
});
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const fileStem = (name: string) => name.replace(/\.[^./\\]+$/, "").trim() || name;

/** Exactly the creator's words: 原本以為 → 其實是, or 其實是 with 2–4 points. */
export function templateShortCopyOf(brief: EasyBrief): TemplateShortInAppCopy {
  const payoff = brief.title.trim(), hook = brief.hook?.trim();
  if (!payoff) throw new EasyEngineError("先寫一句大標題。", "words");
  if (hook) return { payoff, hook };
  const points = (brief.points ?? []).map(point => point.trim()).filter(Boolean);
  if (points.length < EASY_POINTS_MIN) throw new EasyEngineError("至少寫兩個重點。", "words");
  return { payoff, points };
}

/** Why a run did not deliver, as one of the plain failure screens. */
export function templateShortProblemKind(result: Pick<TemplateShortInAppResult, "status" | "block">): EasyProblemKind {
  const code = result.block?.code ?? result.status, field = result.block?.field ?? "", detail = result.block?.detail ?? "";
  if (code === "BLOCK_DISK") return "no-space";
  if (code === "BLOCK_START" && field === "defaults") return "settings";
  if (code === "BLOCK_START" && field === "source.path") return "not-allowed";
  if (code === "BLOCK_COPY_GLYPH" || code === "BLOCK_UNSUPPORTED_NUMBER" || (code === "BLOCK_BRIEF" && field.startsWith("copy"))) return "words";
  // The words did not fit the template: text outside the safe area or below the reading size, or a compile refusal that says so.
  if (code === "BLOCK_TEMPLATE_QA" && /^Q[34]_/.test(detail)) return "words";
  if (code === "BLOCK_TEMPLATE" && /太長|縮短/.test(detail)) return "words";
  return "engine-failed";
}

const FLAG_KINDS: Readonly<Record<string, EasyArtFlagKind>> = {
  Q3_safe_area: "text-cut", Q4_text_size: "text-small", Q7_text_overlap: "text-overlap", Q8_stall: "stutter", R3_stall: "stutter",
};
/** Art flags as 「第 N 秒」 rows: whole seconds, one row per second and kind, at most six. */
export function templateShortFlags(flags: TemplateShortInAppResult["flags"]): EasyArtFlag[] {
  const seen = new Set<string>(), rows: EasyArtFlag[] = [];
  for (const flag of flags) {
    for (const raw of flag.seconds) {
      if (!Number.isFinite(raw) || raw < 0) continue;
      const row: EasyArtFlag = { second: Math.floor(raw), kind: FLAG_KINDS[flag.check] ?? "check-again" };
      const key = `${row.second}:${row.kind}`;
      if (!seen.has(key)) { seen.add(key); rows.push(row); }
    }
  }
  return rows.sort((left, right) => left.second - right.second).slice(0, 6);
}

/** A finished job → the result screen, or the plain failure it was. Hao 2026-10-09: an art flag still delivers. */
export function templateShortEasyResult(status: TemplateShortJobStatus, genre: EasyGenre): EasyResult {
  if (status.phase === "interrupted") throw new EasyEngineError(status.error ?? "很久都沒有進展。", "stalled");
  if (status.phase === "canceled") throw new EasyEngineError(status.error ?? "已停止");
  if (status.phase !== "finished" || !status.result) throw new EasyEngineError(status.error ?? "這次沒有剪成功。");
  const result = status.result;
  if (!result.delivered || !status.outputUrl) {
    throw new EasyEngineError(result.block?.detail ?? result.detail ?? result.status, templateShortProblemKind(result));
  }
  const flags = templateShortFlags(result.flags);
  return {
    orientation: "vertical", videoPath: status.outputPath, previewUrl: status.outputUrl, flags,
    ...(result.window ? { usedRange: { seconds: result.window.seconds, clamped: result.window.clamped } } : {}),
    // Certified and fully green is READY / SPOT_CHECK_DUE; anything else, and every genre outside 旅遊/美食, asks for a look.
    review: templateGenreReviewCapped(genre) || !["READY", "SPOT_CHECK_DUE"].includes(result.status) || (result.flags.length > 0 && !flags.length),
    handle: status.jobId,
  };
}

export function createTemplateShortEasyEngine(api: TemplateShortEngineApi, options: TemplateShortEngineOptions): EasyAutoEditEngine {
  const pollMs = options.pollMs ?? 1_000, wait = options.wait ?? abortableWait, maxFailures = options.maxStatusFailures ?? 5;
  const sourceOf = (video: EasyVideo) => {
    const path = options.sourcePathOf(video);
    if (!path) throw new EasyEngineError("找不到這支影片在電腦上的位置。");
    return path;
  };
  return {
    formatStatus: format => format === "vertical" ? "ready" : "needs-desktop",
    check: (format, video) => {
      if (format !== "vertical" || !options.sourcePathOf(video)) return { ok: false, reason: "needs-desktop" };
      if (video.durationSeconds !== undefined && video.durationSeconds < TEMPLATE_SHORT_MIN_SECONDS) return { ok: false, reason: "video-too-short" };
      return { ok: true, plan: TEMPLATE_SHORT_PLAN };
    },
    rights: {
      status: async (_format, video) => {
        const prepared = await api.templateShortPrepare(sourceOf(video));
        if (!prepared.workspaceFound) return { kind: "unavailable", reason: "outside-workspace" };
        if (prepared.defaults === "present") return { kind: "confirmed" };
        return { kind: "ask", scope: prepared.scope ?? { name: video.name, kind: "file" } };
      },
      // Reached only from the 「是，這是我自己拍的素材」 click (the controller); the desktop writes the file once, never over one.
      confirm: async (video, input) => {
        const written = await api.templateShortConfirmRights(sourceOf(video), input.brandName.trim() || undefined);
        if (!written.written && !written.exists) throw new EasyEngineError("沒有記下來。");
      },
    },
    start: async (brief, onProgress, signal) => {
      const copy = templateShortCopyOf(brief);
      const { jobId } = await api.templateShortStart({ sourcePath: sourceOf(brief.video), genre: EASY_TEMPLATE_GENRES[brief.genre], copy });
      // 停下來 kills the job's whole process tree on the desktop side.
      const stop = () => { void api.templateShortCancel(jobId).catch(() => undefined); };
      if (signal.aborted) { stop(); throw new EasyEngineError("已停止"); }
      signal.addEventListener("abort", stop, { once: true });
      try {
        let failures = 0;
        for (;;) {
          let status: TemplateShortJobStatus;
          try {
            status = await api.templateShortStatus(jobId);
            failures = 0;
          } catch (error) {
            if (++failures >= maxFailures) throw new EasyEngineError(`讀不到剪輯進度：${messageOf(error)}`);
            await wait(pollMs, signal);
            continue;
          }
          if (signal.aborted) throw new EasyEngineError("已停止");
          onProgress({ step: Math.max(0, Math.min(3, Math.floor(status.step))) as EasyStepIndex, fraction: status.fraction });
          if (status.phase === "running") { await wait(pollMs, signal); continue; }
          return templateShortEasyResult(status, brief.genre);
        }
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },
    saveVideo: async (result, brief): Promise<EasySavedVideo> => {
      if (!result.handle) throw new EasyEngineError("找不到剪好的影片。");
      const saved = await api.templateShortSaveVideo(result.handle, brief.title || fileStem(brief.video.name));
      return { path: saved.path, fileName: saved.fileName, folderName: saved.folderName, inVideosFolder: true };
    },
    ...(api.revealInFolder ? { revealInFolder: async (saved: EasySavedVideo) => { if (saved.path) await api.revealInFolder!(saved.path); } } : {}),
  };
}
