/**
 * What the export panel says about a running export, from the renderer's own progress snapshots
 * (src/render/renderProgress.ts). A percentage and a remaining time appear only for a step whose progress FFmpeg
 * actually measured; every other step shows its name and an indeterminate bar. All strings are zh-TW interface
 * message keys (src/ui/i18n/interfaceMessages.15.ts).
 */
export type RenderStageName = "prepare" | "precompose" | "scene3d" | "frames" | "audio" | "effects" | "encode" | "verify";

export interface RenderProgressView {
  stage: RenderStageName;
  part?: number;
  parts?: number;
  fraction?: number;
  doneSeconds?: number;
  totalSeconds?: number;
  sequence?: number;
}

export const EXPORT_STEPS = [
  { id: "prepare", label: "準備素材", stages: ["prepare"] },
  { id: "media", label: "處理畫面和聲音", stages: ["precompose", "scene3d", "frames", "audio", "effects"] },
  { id: "encode", label: "合成影片", stages: ["encode"] },
  { id: "verify", label: "最後檢查一次", stages: ["verify"] },
] as const satisfies ReadonlyArray<{ id: string; label: string; stages: readonly RenderStageName[] }>;

const STAGE_DETAIL: Record<RenderStageName, string> = {
  prepare: "正在檢查素材和磁碟空間",
  precompose: "正在先做好預合成的片段",
  scene3d: "正在畫 3D 場景",
  frames: "正在一格一格畫出畫面",
  audio: "正在處理聲音",
  effects: "正在處理特效",
  encode: "正在把畫面和聲音合成影片",
  verify: "正在確認影片可以正常播放",
};

export function isRenderStageName(value: unknown): value is RenderStageName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STAGE_DETAIL, value);
}

/** Reads the host's `progress` object; anything malformed is treated as "no progress yet". */
export function parseRenderProgress(value: unknown): RenderProgressView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== "editkin.render-progress/v1" || !isRenderStageName(raw.stage)) return undefined;
  const finite = (input: unknown) => typeof input === "number" && Number.isFinite(input) ? input : undefined;
  const fraction = finite(raw.fraction);
  const part = finite(raw.part), parts = finite(raw.parts);
  return {
    stage: raw.stage,
    ...(part !== undefined && parts !== undefined && part >= 1 && part <= parts ? { part, parts } : {}),
    ...(fraction !== undefined ? { fraction: Math.max(0, Math.min(1, fraction)) } : {}),
    ...(finite(raw.doneSeconds) !== undefined ? { doneSeconds: finite(raw.doneSeconds) } : {}),
    ...(finite(raw.totalSeconds) !== undefined ? { totalSeconds: finite(raw.totalSeconds) } : {}),
    ...(finite(raw.sequence) !== undefined ? { sequence: finite(raw.sequence) } : {}),
  };
}

export function exportStepIndex(stage: RenderStageName): number {
  return EXPORT_STEPS.findIndex(step => (step.stages as readonly string[]).includes(stage));
}

export function renderStageDetail(stage: RenderStageName): string {
  return STAGE_DETAIL[stage];
}

/** One observation of a measured step, on the UI's own clock. */
export interface ProgressSample { atMs: number; key: string; doneSeconds: number; totalSeconds: number }

export function progressSampleKey(view: RenderProgressView): string {
  return `${view.stage}:${view.part ?? 0}:${view.totalSeconds ?? 0}`;
}

const RATE_WINDOW_MS = 30_000;
const MIN_SPAN_MS = 3_000;

/** Keeps the samples of the current measured step inside the rate window. */
export function addProgressSample(samples: readonly ProgressSample[], view: RenderProgressView | undefined, atMs: number): ProgressSample[] {
  if (!view || view.doneSeconds === undefined || view.totalSeconds === undefined || view.fraction === undefined) return [];
  const key = progressSampleKey(view);
  const kept = samples.filter(sample => sample.key === key && atMs - sample.atMs <= RATE_WINDOW_MS);
  const last = kept[kept.length - 1];
  if (last && last.doneSeconds === view.doneSeconds) return kept;
  return [...kept, { atMs, key, doneSeconds: view.doneSeconds, totalSeconds: view.totalSeconds }];
}

/**
 * Remaining time of the measured step from its recent speed, or undefined while there is not enough evidence
 * (less than MIN_SPAN_MS of samples or no advance). Never invented from elapsed time alone.
 */
export function estimateRemainingMs(samples: readonly ProgressSample[]): number | undefined {
  if (samples.length < 2) return undefined;
  const first = samples[0], last = samples[samples.length - 1];
  const span = last.atMs - first.atMs, advanced = last.doneSeconds - first.doneSeconds;
  if (span < MIN_SPAN_MS || advanced <= 0) return undefined;
  const remainingSeconds = Math.max(0, last.totalSeconds - last.doneSeconds);
  return Math.round(remainingSeconds / (advanced / span));
}

export interface DurationWords { key: string; values?: Record<string, number> }

/** Remaining time in friendly words: under a minute, whole minutes, or hours and minutes. */
export function remainingWords(ms: number): DurationWords {
  if (ms < 60_000) return { key: "剩不到 1 分鐘" };
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return { key: "大約還要 {minutes} 分鐘", values: { minutes } };
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? { key: "大約還要 {hours} 小時 {minutes} 分鐘", values: { hours, minutes: rest } } : { key: "大約還要 {hours} 小時", values: { hours } };
}

export function elapsedWords(ms: number): DurationWords {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return { key: "已經過 {seconds} 秒", values: { seconds } };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: "已經過 {minutes} 分 {seconds} 秒", values: { minutes, seconds: seconds % 60 } };
  return { key: "已經過 {hours} 小時 {minutes} 分", values: { hours: Math.floor(minutes / 60), minutes: minutes % 60 } };
}

/** How long a finished export took. */
export function spentWords(ms: number): DurationWords {
  const words = elapsedWords(ms);
  return { key: words.key.replace("已經過", "花了"), values: words.values };
}

export function renderProgressMessageKeys(): string[] {
  return [
    ...EXPORT_STEPS.map(step => step.label), ...Object.values(STAGE_DETAIL),
    "剩不到 1 分鐘", "大約還要 {minutes} 分鐘", "大約還要 {hours} 小時 {minutes} 分鐘", "大約還要 {hours} 小時",
    "已經過 {seconds} 秒", "已經過 {minutes} 分 {seconds} 秒", "已經過 {hours} 小時 {minutes} 分",
    "花了 {seconds} 秒", "花了 {minutes} 分 {seconds} 秒", "花了 {hours} 小時 {minutes} 分",
  ];
}
