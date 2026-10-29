import type { SemanticAutoEditOutcome } from "../../desktop/useSemanticAutoEdit";
import type {
  EasyAutoEditEngine, EasyBrief, EasyEnginePlan, EasyFormat, EasyProblemKind, EasyResult, EasySavedVideo, EasyUnavailableReason, EasyVideo,
} from "./easyFlowModel";

/** Plain steps for the dev demo engine (titles and animation). */
export const TEMPLATE_STEPS = ["看你的影片", "挑最好看的畫面", "加上標題和動畫", "最後檢查一次"] as const;
/** Plain steps for the local rough cut: it listens, cuts pauses, adds subtitles and music. It writes no title. */
export const ROUGH_CUT_STEPS = ["聽你的影片在說什麼", "剪掉停頓的地方", "加上字幕和音樂", "整理好給你看"] as const;

/** An engine failure; `kind` picks a plainer screen than 「這次沒有剪成功」 when the engine knows why. */
export class EasyEngineError extends Error {
  constructor(message: string, readonly kind?: EasyProblemKind) {
    super(message);
    this.name = "EasyEngineError";
  }
}

/** No engine here (for example, a browser tab). Every choice ends in the honest "edit it yourself" screen. */
export function createUnavailableEasyEngine(reason: EasyUnavailableReason): EasyAutoEditEngine {
  return {
    formatStatus: () => reason,
    check: () => ({ ok: false, reason }),
    start: () => Promise.reject(new EasyEngineError("沒有可用的自動剪輯引擎。")),
    saveVideo: () => Promise.reject(new EasyEngineError("沒有可用的自動剪輯引擎。")),
  };
}

/** Bridge to the in-app rough cut (the existing 先做一版粗剪 path). Provided by the editor shell. */
export interface RoughCutBridge {
  /** Applies the genre to the project, selects the chosen clip and runs the rough cut. Stages arrive as 1–4. */
  start(brief: EasyBrief, onStage: (stage: 1 | 2 | 3 | 4) => void): Promise<SemanticAutoEditOutcome>;
  /** The desktop render as a visible job: the system save dialog, then the encode (progress, 停止存檔, close guard). */
  render(): Promise<{ canceled: boolean; outputPath?: string; outputUrl?: string }>;
  /** 打開資料夾: the folder with the saved file selected (desktop only). */
  reveal?: (path: string) => Promise<void>;
}

const ROUGH_CUT_PLAN: EasyEnginePlan = Object.freeze({
  needsTitle: false, steps: ROUGH_CUT_STEPS, canRestyle: false, canEditText: false, rendersPreview: false, canCancel: false,
});

export function savedVideoFromPath(path: string): EasySavedVideo {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return { path, fileName: parts.at(-1), folderName: parts.length > 1 ? parts.at(-2) : undefined };
}

/**
 * Horizontal footage goes through the existing local rough cut, described as what it really does. On its own it says
 * vertical Shorts are still being connected; the desktop pairs it with the template engine (combineEasyEngines).
 */
export function createRoughCutEasyEngine(bridge: RoughCutBridge): EasyAutoEditEngine {
  const reveal = bridge.reveal;
  return {
    formatStatus: format => format === "vertical" ? "shorts-connecting" : "ready",
    check: (format: EasyFormat, video: EasyVideo) => {
      if (format === "vertical") return { ok: false, reason: "shorts-connecting" };
      if (video.orientation !== "landscape") return { ok: false, reason: "video-not-horizontal" };
      return { ok: true, plan: ROUGH_CUT_PLAN };
    },
    start: async (brief, onProgress) => {
      const outcome = await bridge.start(brief, stage => onProgress({ step: (stage - 1) as 0 | 1 | 2 | 3, fraction: 0 }));
      if (!outcome.ok) throw new EasyEngineError(outcome.message ?? (outcome.reason === "stale" ? "影片在剪的時候被改動了，這次沒有套用。" : "這次沒有剪成功。"));
      return { orientation: "horizontal", flags: [], summary: { segments: outcome.segmentCount, captions: outcome.addedCaptions, music: outcome.music } };
    },
    saveVideo: async () => {
      const rendered = await bridge.render();
      if (rendered.canceled) return undefined;
      if (!rendered.outputPath) throw new EasyEngineError("影片輸出沒有回傳檔案位置。");
      return { ...savedVideoFromPath(rendered.outputPath), ...(rendered.outputUrl ? { url: rendered.outputUrl } : {}) };
    },
    // Without a reveal command the saved screen shows the full path instead.
    ...(reveal ? { revealInFolder: async (saved: EasySavedVideo) => { if (saved.path) await reveal(saved.path); } } : {}),
  };
}

/** One engine per kind of video: vertical Shorts and horizontal footage. Without a vertical engine the horizontal one
 * answers for both (it says vertical Shorts are still being connected). */
export function combineEasyEngines(engines: { horizontal: EasyAutoEditEngine; vertical?: EasyAutoEditEngine }): EasyAutoEditEngine {
  const pick = (format: EasyFormat) => format === "vertical" ? engines.vertical ?? engines.horizontal : engines.horizontal;
  const reveal = engines.vertical?.revealInFolder ?? engines.horizontal.revealInFolder;
  const rights = engines.vertical?.rights;
  return {
    formatStatus: format => pick(format).formatStatus(format),
    check: (format, video) => pick(format).check(format, video),
    start: (brief, onProgress, signal) => pick(brief.format).start(brief, onProgress, signal),
    saveVideo: (result, brief) => pick(brief.format).saveVideo(result, brief),
    ...(reveal ? { revealInFolder: reveal } : {}),
    ...(rights ? { rights: {
      status: (format: EasyFormat, video: EasyVideo) => format === "vertical" ? rights.status(format, video) : Promise.resolve({ kind: "confirmed" as const }),
      confirm: (video: EasyVideo, input: { brandName: string }) => rights.confirm(video, input),
    } } : {}),
  };
}

export interface DemoEasyEngineOptions {
  previewUrl: string;
  /** Adds one art flag so the 需要修改 banner can be reviewed. */
  flags?: boolean;
  /** Stops with an error when this step starts, so the failure screen can be reviewed. */
  failAtStep?: 0 | 1 | 2 | 3;
  stepMs?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableWait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new EasyEngineError("已停止")); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(new EasyEngineError("已停止")); };
  signal.addEventListener("abort", stop, { once: true });
});

/**
 * Simulated engine for screenshots and tests only (URL ?easyDemo=1 on the dev server).
 * It never runs in a production build: see readEasyDemoSwitch.
 */
export function createDemoEasyEngine(options: DemoEasyEngineOptions): EasyAutoEditEngine {
  const stepMs = options.stepMs ?? 2_000;
  const wait = options.wait ?? abortableWait;
  const plan: EasyEnginePlan = Object.freeze({
    needsTitle: true, steps: TEMPLATE_STEPS, estimateSeconds: Math.round((stepMs * 4) / 1000),
    canRestyle: true, canEditText: true, rendersPreview: true, canCancel: true,
  });
  return {
    formatStatus: () => "ready",
    check: () => ({ ok: true, plan }),
    start: async (brief, onProgress, signal) => {
      for (const step of [0, 1, 2, 3] as const) {
        if (options.failAtStep === step) throw new EasyEngineError("這次沒有剪成功。");
        onProgress({ step, fraction: 0 });
        await wait(stepMs / 2, signal);
        onProgress({ step, fraction: 0.5 });
        await wait(stepMs / 2, signal);
      }
      onProgress({ step: 3, fraction: 1 });
      const result: EasyResult = {
        orientation: brief.format,
        previewUrl: options.previewUrl,
        flags: options.flags ? [{ second: 3, kind: "text-cut" }] : [],
      };
      return result;
    },
    saveVideo: async (_result, brief) => {
      await wait(Math.min(stepMs, 1_200), new AbortController().signal);
      return { fileName: `${brief.title || brief.video.name}.mp4`, inVideosFolder: true };
    },
    revealInFolder: async () => undefined,
  };
}
