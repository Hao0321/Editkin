import type { TemplateShortInAppResult } from "../service/templateShortService";

/** In-app template Shorts over the desktop bridge (src-tauri/src/template_short.rs; the child runs
 * src/service/templateShortService.ts). The webview never sees workspace internals beyond what these carry. */
export interface TemplateShortPrepareResult {
  /** False when no folder above the video holds the workspace's `.autopilot` folder. */
  workspaceFound: boolean;
  /** The one-time rights file `.autopilot/template-short-defaults.json`. */
  defaults?: "present" | "missing";
  /** What the rights question names: the first folder under the workspace (or the video itself). */
  scope?: { name: string; kind: "folder" | "file" };
  /** The video's workspace-relative path. */
  source?: string;
}

/** Exactly what the creator typed: 原本以為 (hook) → 其實是 (payoff), or 2–4 points. */
export interface TemplateShortInAppCopy {
  payoff: string;
  hook?: string;
  points?: string[];
}

export interface TemplateShortStartRequest {
  /** The chosen video's path on this computer (the project asset's uri). */
  sourcePath: string;
  /** A start_template_short genre (REFERENCE_MOTION_VIDEO_TYPES key). */
  genre: string;
  copy: TemplateShortInAppCopy;
}

export type TemplateShortJobPhase = "running" | "finished" | "failed" | "canceled" | "interrupted";

export interface TemplateShortJobStatus {
  jobId: string;
  phase: TemplateShortJobPhase;
  /** 0–3: 看你的影片 → 加上標題和動畫 → 做成影片 → 最後檢查一次. */
  step: number;
  fraction: number;
  shortId?: string;
  /** The child's result once the job finished. */
  result?: TemplateShortInAppResult;
  /** The delivered mp4 on this computer (only `<run folder>/output.mp4`). */
  outputPath?: string;
  /** A webview URL for outputPath (added by the bridge). */
  outputUrl?: string;
  /** Why a job failed, was interrupted by the no-progress watchdog, or stopped. */
  error?: string;
}

export interface TemplateShortSavedVideo {
  path: string;
  fileName?: string;
  folderName?: string;
}
