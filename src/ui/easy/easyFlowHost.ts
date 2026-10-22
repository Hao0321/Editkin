import type { RecentProject } from "../../desktop/recentProjects";
import type { TemplateShortJobStatus } from "../../desktop/templateShortTypes";
import { combineEasyEngines, createDemoEasyEngine, createRoughCutEasyEngine, createUnavailableEasyEngine, type RoughCutBridge } from "./easyEngines";
import { createEasyFlowStore, type EasyAutoEditEngine, type EasyFlowStore, type EasyFormat, type EasyVideo } from "./easyFlowModel";
import type { EasyRecentProjects } from "./easyRecentProjects";
import { createTemplateShortEasyEngine, type TemplateShortEngineApi } from "./templateShortEngine";

export type EasyChooseOutcome =
  | { kind: "video"; video: EasyVideo }
  | { kind: "nothing" }
  | { kind: "failed"; detail?: string }
  | { kind: "not-video" }
  | { kind: "too-many" };

/**
 * Everything the easy flow needs from the app around it. The editor shell provides the real one
 * (useEasyFlowHost); the dev-only demo provides a standalone one. The flow never reaches past this.
 */
export interface EasyFlowHost {
  readonly store: EasyFlowStore;
  readonly engine: EasyAutoEditEngine;
  /** "dialog": the desktop file chooser; "file-input": a browser file input; "demo": a sample clip, no chooser. */
  readonly picker: "dialog" | "file-input" | "demo";
  /** Brings one video in through the app's normal import path. */
  chooseVideo(files?: readonly File[]): Promise<EasyChooseOutcome>;
  /** Removes the video the flow brought in (back to the start, or start over). */
  discardVideo(): void;
  /** Leaves the flow and shows the editor with whatever the flow made. */
  leaveToEditor(): void;
  /** The 「我想自己剪」 link: the existing editor workspace. */
  openWorkspace(): void;
  /** The 「打開之前的作品」 link: the existing open-project action. */
  openProject(): void;
  /** Fresh preview URLs for the chosen video; runtime URLs can arrive after the import itself. */
  videoUrls?(video: EasyVideo): { thumbnailUrl?: string; previewUrl?: string };
  /** Recent project files to reopen with one click (desktop only; the plain browser build leaves it out). */
  readonly recent?: EasyRecentProjects;
}

/**
 * plain / flags: the simulated template engine (flags adds one 需要修改 item);
 * today: the desktop availability before template Shorts (vertical → connecting, horizontal → rough cut) on a simulated bridge;
 * browser: no engine at all; fail: the template engine stops halfway;
 * shorts: the real template-Short adapter and screens (first-time rights question, story words, flags) over a simulated
 * desktop; shorts-words: the same, ending in the "words do not fit" failure; recent: the plain engine plus a simulated
 * recent-projects list (one file gone) on the start screen.
 */
export type EasyDemoSwitch = "plain" | "flags" | "today" | "browser" | "fail" | "shorts" | "shorts-words" | "recent";
const DEMO_SWITCHES: Record<string, EasyDemoSwitch> = { "1": "plain", true: "plain", flags: "flags", today: "today", browser: "browser", fail: "fail",
  shorts: "shorts", "shorts-words": "shorts-words", recent: "recent" };

/**
 * Dev-only simulation switch: `?easyDemo=1|flags|today|browser|fail|recent` on the dev server.
 * Production builds ignore it, so a shipped app can never show simulated progress or results.
 */
export function readEasyDemoSwitch(search: string = typeof window === "undefined" ? "" : window.location.search, dev: boolean = import.meta.env.DEV): EasyDemoSwitch | undefined {
  if (!dev) return undefined;
  const value = new URLSearchParams(search).get("easyDemo");
  return value !== null && Object.prototype.hasOwnProperty.call(DEMO_SWITCHES, value) ? DEMO_SWITCHES[value] : undefined;
}

const demoPreviewUrl = () => {
  try { return new URL("editkin-demo-preview.mp4", document.baseURI).href; } catch { return "editkin-demo-preview.mp4"; }
};

export function demoEasyVideo(format: EasyFormat, previewUrl = demoPreviewUrl()): EasyVideo {
  return format === "vertical"
    ? { id: "easy-demo-vertical", name: "IMG_4022.MOV", durationSeconds: 42, orientation: "portrait", previewUrl }
    : { id: "easy-demo-horizontal", name: "IMG_3310.MOV", durationSeconds: 95, orientation: "landscape", previewUrl };
}

/** A stand-in for the editor shell's rough-cut bridge: same engine adapter, simulated timing and numbers. */
function simulatedRoughCutBridge(stepMs = 1_500): RoughCutBridge {
  const wait = () => new Promise(resolve => setTimeout(resolve, stepMs));
  return {
    start: async (_brief, onStage) => {
      for (const stage of [1, 2, 3, 4] as const) { onStage(stage); await wait(); }
      return { ok: true, segmentCount: 9, addedCaptions: 27, music: true };
    },
    render: async () => { await wait(); return { canceled: false, outputPath: "C:\\Users\\Editkin\\Videos\\IMG_3310.mp4" }; },
  };
}

/** A stand-in for the desktop's template-Short commands: the rights file starts missing, a run takes four steps, and the
 * result carries one art flag (or, with `words`, the template's "text outside the safe area" refusal). */
export function simulatedTemplateShortApi(previewUrl: string, options: { words?: boolean; stepMs?: number } = {}): TemplateShortEngineApi {
  const stepMs = options.stepMs ?? 1_500;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const jobs = new Map<string, { started: number; canceled: boolean }>();
  let confirmed = false;
  const runDir = "videos/_AUTOPILOT/editkin-short/20261010-img-4022-3f9a1c";
  return {
    templateShortPrepare: async () => ({ workspaceFound: true, defaults: confirmed ? "present" : "missing", scope: { name: "videos", kind: "folder" },
      source: "videos/_INBOX/IMG_4022.MOV" }),
    templateShortConfirmRights: async () => { await sleep(600); confirmed = true; return { written: true, exists: true }; },
    templateShortStart: async () => { const jobId = `demo-${jobs.size + 1}`; jobs.set(jobId, { started: Date.now(), canceled: false }); return { jobId }; },
    templateShortStatus: async (jobId): Promise<TemplateShortJobStatus> => {
      const job = jobs.get(jobId);
      if (!job) throw new Error("沒有這個工作");
      if (job.canceled) return { jobId, phase: "canceled", step: 0, fraction: 0, error: "已經停下來了" };
      const elapsed = Date.now() - job.started;
      if (elapsed < stepMs * 4) return { jobId, phase: "running", step: Math.floor(elapsed / stepMs), fraction: (elapsed % stepMs) / stepMs };
      const base = { schema: "editkin.template-short-in-app/v1" as const, shortId: "ts-20261010-img-4022-3f9a1c", runDir,
        window: { start: 0, end: 15, seconds: 15, clamped: true } };
      if (options.words) {
        return { jobId, phase: "finished", step: 3, fraction: 1, result: { ...base, status: "BLOCK_TEMPLATE_QA", delivered: false, flags: [],
          block: { code: "BLOCK_TEMPLATE_QA", detail: "Q3_safe_area（headline:0）：主標超出安全範圍" } } };
      }
      return { jobId, phase: "finished", step: 3, fraction: 1, outputPath: `D:\\${runDir.replaceAll("/", "\\")}\\output.mp4`, outputUrl: previewUrl,
        result: { ...base, status: "NEEDS_FIX", delivered: true, outputPath: `${runDir}/output.mp4`, projectPath: `${runDir}/short.editkin.json`,
          flags: [{ check: "Q8_stall", seconds: [3.7] }] } };
    },
    templateShortCancel: async jobId => { const job = jobs.get(jobId); if (job) job.canceled = true; return { jobId, canceled: Boolean(job) }; },
    templateShortSaveVideo: async (_jobId, name) => { await sleep(800); return { path: `C:\\Users\\Editkin\\Videos\\${name}.mp4`, fileName: `${name}.mp4`, folderName: "Videos" }; },
    revealInFolder: async () => undefined,
  };
}

export function demoEasyEngine(demo: EasyDemoSwitch, previewUrl = demoPreviewUrl()): EasyAutoEditEngine {
  if (demo === "today") return createRoughCutEasyEngine(simulatedRoughCutBridge());
  if (demo === "browser") return createUnavailableEasyEngine("needs-desktop");
  if (demo === "shorts" || demo === "shorts-words") {
    return combineEasyEngines({ horizontal: createRoughCutEasyEngine(simulatedRoughCutBridge()),
      vertical: createTemplateShortEasyEngine(simulatedTemplateShortApi(previewUrl, { words: demo === "shorts-words" }), { sourcePathOf: video => `D:/videos/_INBOX/${video.name}` }) });
  }
  return createDemoEasyEngine({ previewUrl, flags: demo === "flags", failAtStep: demo === "fail" ? 2 : undefined });
}

/**
 * Dev-only: a simulated recent list for screenshots of the start screen. Four projects (today, yesterday, three days
 * ago and twelve days ago); the third file is gone, so its row shows the plain "not found" line and 「從清單移除」.
 */
export function createDemoRecentProjects(onOpened: () => void, now: number = Date.now(), openDelayMs = 700): EasyRecentProjects {
  const hour = 3_600_000, day = 24 * hour;
  const gone = "D:\\舊硬碟\\鶯歌老街散步.editkin.json";
  let list: readonly RecentProject[] = [
    { path: "C:\\Users\\Editkin\\Videos\\我的旅行 vlog.editkin.json", name: "我的旅行 vlog", openedAt: now - 2 * hour },
    { path: "C:\\Users\\Editkin\\Videos\\拉麵開箱.editkin.json", name: "拉麵開箱", openedAt: now - day - hour },
    { path: gone, name: "鶯歌老街散步", openedAt: now - 3 * day },
    { path: "C:\\Users\\Editkin\\Videos\\生日派對.editkin.json", name: "生日派對", openedAt: now - 12 * day },
  ];
  const listeners = new Set<() => void>();
  return {
    list: () => list,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    exists: async paths => paths.map(path => path !== gone),
    open: async path => {
      await new Promise(resolve => setTimeout(resolve, openDelayMs));
      if (path === gone) return { kind: "missing" };
      onOpened();
      return { kind: "opened" };
    },
    forget: path => {
      list = list.filter(item => item.path !== path);
      for (const listener of listeners) listener();
    },
  };
}

export function createDemoEasyFlowHost(input: {
  demo: EasyDemoSwitch;
  onWorkspace: () => void;
  onOpenProject: () => void;
  engine?: EasyAutoEditEngine;
  pickDelayMs?: number;
}): EasyFlowHost {
  const store = createEasyFlowStore();
  const previewUrl = demoPreviewUrl();
  return {
    ...(input.demo === "recent" ? { recent: createDemoRecentProjects(() => input.onWorkspace()) } : {}),
    store,
    engine: input.engine ?? demoEasyEngine(input.demo, previewUrl),
    picker: "demo",
    chooseVideo: async () => {
      await new Promise(resolve => setTimeout(resolve, input.pickDelayMs ?? 500));
      return { kind: "video", video: demoEasyVideo(store.getState().format ?? "vertical", previewUrl) };
    },
    discardVideo: () => undefined,
    leaveToEditor: () => { store.dispatch({ type: "reset" }); input.onWorkspace(); },
    openWorkspace: input.onWorkspace,
    openProject: input.onOpenProject,
  };
}
