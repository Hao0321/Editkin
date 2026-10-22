/**
 * Easy flow (簡易流程): one question per screen, for people who just want the computer to edit.
 *
 * home → genre → title → working → result → saving → saved, plus two honest exits:
 * "unavailable" (no engine for this video yet) and "failed" (the engine stopped).
 * Template Shorts ask their words as a short story instead (plan.copy "story"):
 * home → (rights, the first time only) → genre → hook (大家原本以為…, can be skipped) → title (其實是…) → points (only when
 * the hook was skipped) → working → …
 * Pure state only: no React, no I/O. Side effects live in easyFlowController.ts.
 */
import { templateShortGlyphSupported } from "../../application/templateShortBrief";

export const EASY_FORMATS = ["vertical", "horizontal"] as const;
export type EasyFormat = typeof EASY_FORMATS[number];
export const EASY_GENRES = ["travel", "food", "teaching", "unboxing", "game", "life"] as const;
export type EasyGenre = typeof EASY_GENRES[number] | "auto";

/** Copy limits follow the template-short brief slots: payoff ≤32, proof ≤40 (TEMPLATE_SHORT_COPY_LIMITS). */
export const EASY_TITLE_MAX = 32;
export const EASY_DESCRIPTION_MAX = 40;
/** Story copy for template Shorts: hook ≤24, 2–4 points of ≤24 each; the optional name or brand ≤16 (brandMark). */
export const EASY_HOOK_MAX = 24;
export const EASY_POINT_MAX = 24;
export const EASY_POINTS_MIN = 2;
export const EASY_POINTS_MAX = 4;
export const EASY_BRAND_MAX = 16;

export type EasyScreen = "home" | "rights" | "genre" | "hook" | "title" | "points" | "working" | "result" | "saving" | "saved" | "unavailable" | "failed";
export type EasyOrientation = "portrait" | "landscape" | "square";

export interface EasyVideo {
  id: string;
  /** The creator's own file name. Shown as-is, never translated. */
  name: string;
  durationSeconds?: number;
  orientation?: EasyOrientation;
  thumbnailUrl?: string;
  previewUrl?: string;
}

/** Why automatic editing cannot run for this choice. Each reason has fixed plain wording in the UI. */
export type EasyUnavailableReason = "shorts-connecting" | "video-not-horizontal" | "needs-desktop" | "video-too-short" | "outside-workspace"
  | "not-own-footage" | "check-failed";
export type EasyFormatStatus = "ready" | EasyUnavailableReason;

/** What one engine really does for one video. The screens adapt to it instead of promising more. */
export interface EasyEnginePlan {
  /** False when the engine never writes a title on screen; the title screen is then skipped. */
  needsTitle: boolean;
  /** "story": 大家原本以為 → 其實是 (→ 2–4 個重點) instead of 大標題＋一句說明. */
  copy?: "story";
  /** Four plain progress steps (zh-TW interface keys). */
  steps: readonly [string, string, string, string];
  /** Only engines with a measured basis give an estimate; otherwise the screen shows elapsed time. */
  estimateSeconds?: number;
  canRestyle: boolean;
  canEditText: boolean;
  /** True when result.previewUrl is a real render of the finished video. */
  rendersPreview: boolean;
  canCancel: boolean;
}
export type EasyEngineCheck = { ok: true; plan: EasyEnginePlan } | { ok: false; reason: EasyUnavailableReason };

/** The one-time question 「這些影片是你自己拍的嗎？」 names what it covers: a folder of the workspace, or the video itself. */
export interface EasyRightsScope { name: string; kind: "folder" | "file" }
export type EasyRightsStatus = { kind: "confirmed" } | { kind: "ask"; scope: EasyRightsScope } | { kind: "unavailable"; reason: EasyUnavailableReason };
export interface EasyRightsQuestion { scope: EasyRightsScope; brandName: string; busy: boolean; problem?: EasyProblem }

export interface EasyBrief {
  format: EasyFormat;
  genre: EasyGenre;
  title: string;
  description: string;
  video: EasyVideo;
  /** 0 for the first run; 換一種風格 asks the engine for the next look with the same footage and words. */
  styleVariant: number;
  /** Story copy only: 大家原本以為… (absent when skipped). */
  hook?: string;
  /** Story copy only, when the hook was skipped: 2–4 short points. */
  points?: string[];
}
export type EasyStepIndex = 0 | 1 | 2 | 3;
export interface EasyProgress { step: EasyStepIndex; fraction: number }
export type EasyArtFlagKind = "text-cut" | "text-small" | "text-overlap" | "stutter" | "too-still" | "check-again";
/** A finished video is still delivered with art flags; the screen says which second needs a fix. */
export interface EasyArtFlag { second: number; kind: EasyArtFlagKind }
export interface EasyResultSummary { segments: number; captions: number; music: boolean }
export interface EasyResult {
  orientation: EasyFormat;
  videoPath?: string;
  previewUrl?: string;
  posterUrl?: string;
  flags: readonly EasyArtFlag[];
  summary?: EasyResultSummary;
  /** Which part of the clip was used: its first `seconds` (cut at the engine's maximum when `clamped`). */
  usedRange?: { seconds: number; clamped: boolean };
  /** Not checked as fully as a certified style: ask the creator to watch it once before saving. */
  review?: boolean;
  /** The engine's own reference to this result (saving, opening it in the editor). */
  handle?: string;
}
export interface EasySavedVideo {
  path?: string;
  fileName?: string;
  folderName?: string;
  /** The engine saved into the system Videos folder (shown as 「影片」). */
  inVideosFolder?: boolean;
}

export interface EasyAutoEditEngine {
  /** Availability before any video is chosen (badges on the first screen). */
  formatStatus(format: EasyFormat): EasyFormatStatus;
  check(format: EasyFormat, video: EasyVideo): EasyEngineCheck;
  start(brief: EasyBrief, onProgress: (progress: EasyProgress) => void, signal: AbortSignal): Promise<EasyResult>;
  /** Resolves undefined when the person cancels the save. */
  saveVideo(result: EasyResult, brief: EasyBrief): Promise<EasySavedVideo | undefined>;
  revealInFolder?: (saved: EasySavedVideo) => Promise<void>;
  /** Engines that may only use the creator's own footage ask once; confirm() writes nothing before that explicit click. */
  rights?: {
    status(format: EasyFormat, video: EasyVideo): Promise<EasyRightsStatus>;
    confirm(video: EasyVideo, input: { brandName: string }): Promise<void>;
  };
}

export type EasyProblemKind = "import-failed" | "not-video" | "too-many" | "engine-failed" | "save-failed" | "words" | "no-space" | "stalled"
  | "not-allowed" | "settings" | "rights-failed" | "open-failed";
export interface EasyProblem { kind: EasyProblemKind; detail?: string }

export interface EasyRun {
  id: number;
  step: EasyStepIndex;
  fraction: number;
  startedAt: number;
  estimateSeconds?: number;
}

export interface EasyFlowState {
  screen: EasyScreen;
  format?: EasyFormat;
  formatHint: boolean;
  picking: boolean;
  pickProblem?: EasyProblem;
  video?: EasyVideo;
  plan?: EasyEnginePlan;
  unavailable?: EasyUnavailableReason;
  rights?: EasyRightsQuestion;
  genre: EasyGenre;
  title: string;
  description: string;
  titleError: boolean;
  hook: string;
  hookSkipped: boolean;
  points: string[];
  pointsError: boolean;
  styleVariant: number;
  run?: EasyRun;
  result?: EasyResult;
  saveProblem?: EasyProblem;
  saved?: EasySavedVideo;
  failure?: EasyProblem;
}

export type EasyFlowAction =
  | { type: "choose-format"; format: EasyFormat }
  | { type: "format-required" }
  | { type: "pick-started" }
  | { type: "pick-ended"; problem?: EasyProblem }
  | { type: "pick-finished"; video: EasyVideo; check: EasyEngineCheck; rights?: EasyRightsStatus }
  | { type: "set-brand"; value: string }
  | { type: "rights-started" }
  | { type: "rights-failed"; problem: EasyProblem }
  | { type: "rights-confirmed" }
  | { type: "rights-declined" }
  | { type: "choose-genre"; genre: EasyGenre }
  | { type: "show-title" }
  | { type: "show-hook" }
  | { type: "set-hook"; value: string }
  | { type: "hook-done"; skipped: boolean }
  | { type: "show-points" }
  | { type: "set-point"; index: number; value: string }
  | { type: "points-missing" }
  | { type: "set-title"; value: string }
  | { type: "set-description"; value: string }
  | { type: "title-missing" }
  | { type: "run-started"; runId: number; startedAt: number; estimateSeconds?: number }
  | { type: "run-progress"; runId: number; step: EasyStepIndex; fraction: number }
  | { type: "run-finished"; runId: number; result: EasyResult }
  | { type: "run-failed"; runId: number; problem: EasyProblem }
  | { type: "run-canceled"; runId: number }
  | { type: "edit-text" }
  | { type: "restyle" }
  | { type: "save-started" }
  | { type: "save-finished"; saved: EasySavedVideo }
  | { type: "save-canceled" }
  | { type: "save-failed"; problem: EasyProblem }
  | { type: "result-problem"; problem: EasyProblem }
  | { type: "back" }
  | { type: "reset"; keepFormat?: boolean };

const emptyPoints = () => Array.from({ length: EASY_POINTS_MAX }, () => "");

export function initialEasyFlowState(format?: EasyFormat): EasyFlowState {
  return { screen: "home", format, formatHint: false, picking: false, genre: "auto", title: "", description: "", titleError: false,
    hook: "", hookSkipped: false, points: emptyPoints(), pointsError: false, styleVariant: 0 };
}

/** Counts code points so a CJK title and its limit mean the same thing. */
export function clampText(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length > max ? characters.slice(0, max).join("") : value;
}
export const textLength = (value: string) => Array.from(value).length;

/** The first character the template's bundled faces cannot put on screen (the brief's glyph rule; one UTF-16 unit
 * only, so a limit in characters equals the brief's limit in units). Undefined when every character is fine. */
export function firstUnsupportedCharacter(value: string): string | undefined {
  for (const character of value) {
    if (character.length !== 1 || character === "\n" || !templateShortGlyphSupported(character)) return character;
  }
  return undefined;
}
/** The name or brand is written into the rights file by the desktop, which accepts only ASCII, CJK ideographs, full-width
 * forms and 、。〈〉《》「」『』【】 (validate_brand_mark in src-tauri/src/template_short.rs). Checking the same set here
 * shows the inline 「換一個字」 message instead of a save that fails on a character the template could have drawn. */
export function firstUnsupportedBrandCharacter(value: string): string | undefined {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const desktop = (code >= 0x20 && code <= 0x7e) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xff01 && code <= 0xff5e) || code === 0x3001 || code === 0x3002 || (code >= 0x3008 && code <= 0x3011);
    if (!desktop || !templateShortGlyphSupported(character)) return character;
  }
  return undefined;
}
export const filledPoints = (points: readonly string[]) => points.map(point => point.trim()).filter(Boolean);

const clampStep = (step: number): EasyStepIndex => Math.max(0, Math.min(3, Math.floor(step))) as EasyStepIndex;
const clampFraction = (fraction: number) => Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
const story = (state: EasyFlowState) => state.plan?.copy === "story";
/** The last question before a run: where a stopped or failed run goes back to. */
const lastQuestion = (state: EasyFlowState): EasyScreen => story(state) ? (state.hookSkipped ? "points" : "title") : state.plan?.needsTitle ? "title" : "genre";

export function easyFlowReducer(state: EasyFlowState, action: EasyFlowAction): EasyFlowState {
  switch (action.type) {
    case "choose-format":
      if (state.screen !== "home" || state.picking || !(EASY_FORMATS as readonly string[]).includes(action.format)) return state;
      return { ...state, format: action.format, formatHint: false, pickProblem: undefined };
    case "format-required":
      return state.screen === "home" ? { ...state, formatHint: true } : state;
    case "pick-started":
      return state.screen === "home" && state.format && !state.picking ? { ...state, picking: true, pickProblem: undefined, formatHint: false } : state;
    case "pick-ended":
      return state.picking ? { ...state, picking: false, pickProblem: action.problem } : state;
    case "pick-finished": {
      if (!state.picking) return state;
      const base = { ...state, picking: false, pickProblem: undefined, video: action.video, genre: "auto" as const, title: "", description: "",
        titleError: false, hook: "", hookSkipped: false, points: emptyPoints(), pointsError: false, rights: undefined,
        styleVariant: 0, run: undefined, result: undefined, saved: undefined, saveProblem: undefined, failure: undefined };
      if (!action.check.ok) return { ...base, screen: "unavailable", plan: undefined, unavailable: action.check.reason };
      if (action.rights?.kind === "unavailable") return { ...base, screen: "unavailable", plan: undefined, unavailable: action.rights.reason };
      if (action.rights?.kind === "ask") {
        return { ...base, screen: "rights", plan: action.check.plan, unavailable: undefined, rights: { scope: action.rights.scope, brandName: "", busy: false } };
      }
      return { ...base, screen: "genre", plan: action.check.plan, unavailable: undefined };
    }
    case "set-brand":
      return state.screen === "rights" && state.rights && !state.rights.busy
        ? { ...state, rights: { ...state.rights, brandName: clampText(action.value, EASY_BRAND_MAX), problem: undefined } } : state;
    case "rights-started":
      return state.screen === "rights" && state.rights && !state.rights.busy ? { ...state, rights: { ...state.rights, busy: true, problem: undefined } } : state;
    case "rights-failed":
      return state.screen === "rights" && state.rights ? { ...state, rights: { ...state.rights, busy: false, problem: action.problem } } : state;
    case "rights-confirmed":
      return state.screen === "rights" ? { ...state, screen: "genre", rights: undefined } : state;
    case "rights-declined":
      return state.screen === "rights" && !state.rights?.busy ? { ...state, screen: "unavailable", unavailable: "not-own-footage", plan: undefined, rights: undefined } : state;
    case "choose-genre":
      return state.screen === "genre" ? { ...state, genre: action.genre } : state;
    case "show-title":
      return state.screen === "genre" && state.plan?.needsTitle && !story(state) ? { ...state, screen: "title", titleError: false } : state;
    case "show-hook":
      return state.screen === "genre" && story(state) ? { ...state, screen: "hook" } : state;
    case "set-hook":
      return { ...state, hook: clampText(action.value, EASY_HOOK_MAX) };
    case "hook-done":
      return state.screen === "hook" ? { ...state, screen: "title", hookSkipped: action.skipped, hook: action.skipped ? "" : state.hook, titleError: false } : state;
    case "show-points":
      return state.screen === "title" && story(state) && state.hookSkipped ? { ...state, screen: "points", pointsError: false } : state;
    case "set-point": {
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= EASY_POINTS_MAX) return state;
      const points = state.points.map((point, index) => index === action.index ? clampText(action.value, EASY_POINT_MAX) : point);
      return { ...state, points, pointsError: state.pointsError && filledPoints(points).length < EASY_POINTS_MIN };
    }
    case "points-missing":
      return state.screen === "points" ? { ...state, pointsError: true } : state;
    case "set-title": {
      const title = clampText(action.value, EASY_TITLE_MAX);
      return { ...state, title, titleError: state.titleError && !title.trim() };
    }
    case "set-description":
      return { ...state, description: clampText(action.value, EASY_DESCRIPTION_MAX) };
    case "title-missing":
      return state.screen === "title" ? { ...state, titleError: true } : state;
    case "run-started":
      if (!state.video || !state.plan || !["genre", "title", "points", "result", "failed"].includes(state.screen)) return state;
      return { ...state, screen: "working", titleError: false, pointsError: false, failure: undefined, saveProblem: undefined, result: undefined, saved: undefined,
        run: { id: action.runId, step: 0, fraction: 0, startedAt: action.startedAt, estimateSeconds: action.estimateSeconds } };
    case "run-progress": {
      const run = state.run;
      if (state.screen !== "working" || !run || run.id !== action.runId) return state;
      const step = clampStep(action.step), fraction = clampFraction(action.fraction);
      // Progress only moves forward; a late or repeated report never rewinds the bar.
      if (step < run.step || (step === run.step && fraction <= run.fraction)) return state;
      return { ...state, run: { ...run, step, fraction } };
    }
    case "run-finished":
      return state.screen === "working" && state.run?.id === action.runId ? { ...state, screen: "result", run: undefined, result: action.result } : state;
    case "run-failed":
      return state.screen === "working" && state.run?.id === action.runId ? { ...state, screen: "failed", run: undefined, failure: action.problem } : state;
    case "run-canceled":
      return state.screen === "working" && state.run?.id === action.runId ? { ...state, screen: lastQuestion(state), run: undefined } : state;
    case "edit-text":
      // 改文字 goes back to the first word question with everything still filled in.
      return (state.screen === "result" || state.screen === "failed") && state.plan?.canEditText
        ? { ...state, screen: story(state) ? "hook" : "title", titleError: false, failure: undefined } : state;
    case "restyle":
      return state.screen === "result" && state.plan?.canRestyle ? { ...state, styleVariant: state.styleVariant + 1 } : state;
    case "save-started":
      return state.screen === "result" && state.result ? { ...state, screen: "saving", saveProblem: undefined } : state;
    case "save-finished":
      return state.screen === "saving" ? { ...state, screen: "saved", saved: action.saved } : state;
    case "save-canceled":
      return state.screen === "saving" ? { ...state, screen: "result" } : state;
    case "save-failed":
      return state.screen === "saving" ? { ...state, screen: "result", saveProblem: action.problem } : state;
    case "result-problem":
      return state.screen === "result" ? { ...state, saveProblem: action.problem } : state;
    case "back":
      if (state.screen === "title") return { ...state, screen: story(state) ? "hook" : "genre", titleError: false };
      if (state.screen === "hook") return { ...state, screen: "genre" };
      if (state.screen === "points") return { ...state, screen: "title", pointsError: false };
      if (state.screen === "failed") return { ...state, screen: lastQuestion(state), failure: undefined };
      return state;
    case "reset":
      return initialEasyFlowState(action.keepFormat ? state.format : undefined);
    default:
      return state;
  }
}

export interface EasyFlowStore {
  getState(): EasyFlowState;
  dispatch(action: EasyFlowAction): void;
  subscribe(listener: () => void): () => void;
}

export function createEasyFlowStore(initial: EasyFlowState = initialEasyFlowState()): EasyFlowStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: action => {
      const next = easyFlowReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** How many question screens this plan shows: 1 video, 2 genre, then the words (story: hook, title, and points when
 * the hook was skipped). */
export const easyQuestionCount = (plan?: EasyEnginePlan, hookSkipped = false) =>
  plan?.copy === "story" ? (hookSkipped ? 5 : 4) : plan && !plan.needsTitle ? 2 : 3;

/** True once a chosen video belongs to the flow; the start screen must stay in front of the editor. */
export const easyFlowOwnsVideo = (state: EasyFlowState) => state.picking || state.screen !== "home";

export function easyBriefOf(state: EasyFlowState): EasyBrief | undefined {
  if (!state.format || !state.video) return undefined;
  const brief: EasyBrief = { format: state.format, genre: state.genre, title: state.title.trim(), description: state.description.trim(), video: state.video,
    styleVariant: state.styleVariant };
  if (!story(state)) return brief;
  const hook = state.hookSkipped ? "" : state.hook.trim();
  return hook ? { ...brief, hook } : { ...brief, points: filledPoints(state.points) };
}

/** 0:42 / 12:05 / 1:02:03 — digits only, so it reads the same in every language. */
export function formatEasyClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
