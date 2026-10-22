import { canonicalJson } from "../motionLibrary/params";
import { hashString32 } from "../motionLibrary/svg/random";
import { kineticCaptionFrame, type KineticCaptionParams } from "./components/kineticCaption";
import { lightLeakFrame, type LightLeakParams } from "./components/lightLeak";
import { sectionTitleFrame, type SectionTitleParams } from "./components/sectionTitle";
import { explainerFrame, type ExplainerParams } from "./components/explainerKit";
import { annotationFrame, type AnnotationParams } from "./components/annotationKit";
import { insertFrame, type InsertFrameParams } from "./components/insertLayouts";
import { stagePropsFrame, stageTextureSvg, type StagePropsParams, type StageTextureJobParams } from "./components/illustrationStage";
import { STYLE_ENGINE_VERSION } from "./types";
import {
  cardChromeSvg, chapterChipFrame, cursorClickFrame, lowerThirdFrame, promptBubbleFrame, toolTagFrame, uiBackdropSvg,
  type CardChromeParams, type ChapterChipParams, type CursorClickParams, type LowerThirdParams, type PromptBubbleParams, type ToolTagParams, type UiBackdropParams,
} from "./uiCard/components";

/**
 * A render job is one overlay clip: a component, its fully resolved params and a
 * frame-aligned time range. A frame is a pure function of (params, local t), so
 * preview frames, contact sheets and the cached clip all come from one evaluator.
 */

export type StyleComponentParams = KineticCaptionParams | SectionTitleParams | LightLeakParams | ExplainerParams | AnnotationParams
  | InsertFrameParams | StagePropsParams | StageTextureJobParams
  | UiBackdropParams | CardChromeParams | ChapterChipParams | LowerThirdParams | ToolTagParams | PromptBubbleParams | CursorClickParams;
export type StyleComponentId = StyleComponentParams["component"];

export const STYLE_JOB_TRACKS = ["backdrop", "cardUnderTail", "cardOverTail", "cardUnder", "cardOver", "calloutUnder", "calloutOver", "finish", "insertUnder", "insertOver", "stage", "titles", "annotations", "explainers", "overlay", "captions"] as const;
export type StyleJobTrack = typeof STYLE_JOB_TRACKS[number];

export interface StyleRenderJobV1 {
  readonly id: string;
  /** Deterministic key over engine version + component params + frame range: the clip cache key. */
  readonly key: string;
  readonly component: StyleComponentId;
  readonly params: StyleComponentParams;
  /** Timeline start (s), frame aligned. */
  readonly timelineStart: number;
  readonly startFrame: number;
  readonly frameCount: number;
  readonly fps: number;
  /** alpha: ProRes 4444 straight alpha, composited normally. opaque: drawn on black, composited with screen.
   * still: one RGBA PNG (frame 0) held for the job's frames (a backdrop or stage texture). */
  readonly output: "alpha" | "opaque" | "still";
  readonly blendMode: "normal" | "screen";
  /** Layer order, bottom → top: finish (screen) · insertUnder · [insert clips] · insertOver · stage · titles · annotations · explainers · captions. */
  readonly track: StyleJobTrack;
  /** The plan beat this job came from. */
  readonly beatIndex: number;
  /** A still that moves with something (a card's chrome): job-local pose keys, linear; scale is about `pivot` (px). */
  readonly pose?: ReadonlyArray<{ readonly t: number; readonly dx: number; readonly dy: number; readonly scale: number; readonly opacity: number }>;
  readonly pivot?: { readonly x: number; readonly y: number };
}

/** Frame i of a job samples t = i / fps (job-local). */
export function styleJobFrameTime(job: Pick<StyleRenderJobV1, "fps">, index: number): number {
  return index / job.fps;
}

export function styleComponentFrame(params: StyleComponentParams, t: number): string {
  switch (params.component) {
    case "caption": return kineticCaptionFrame(params, t);
    case "section": return sectionTitleFrame(params, t);
    case "lightLeak": return lightLeakFrame(params, t);
    case "explainer": return explainerFrame(params, t);
    case "annotation": return annotationFrame(params, t);
    case "insertFrame": return insertFrame(params, t);
    case "stage": return stagePropsFrame(params, t);
    case "stageTexture": return stageTextureSvg(params);
    case "uiBackdrop": return uiBackdropSvg(params);
    case "cardChrome": return cardChromeSvg(params);
    case "chapterChip": return chapterChipFrame(params, t);
    case "lowerThird": return lowerThirdFrame(params, t);
    case "toolTag": return toolTagFrame(params, t);
    case "promptBubble": return promptBubbleFrame(params, t);
    case "cursorClick": return cursorClickFrame(params, t);
  }
}

export function styleJobFrame(job: StyleRenderJobV1, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= job.frameCount) throw new Error(`Frame ${index} is outside job ${job.id}`);
  return styleComponentFrame(job.params, styleJobFrameTime(job, index));
}

/** 128-bit hex digest from four independent 32-bit string hashes (browser-safe; not a security hash). */
export function styleKey(value: unknown): string {
  const text = canonicalJson(value);
  return [0, 1, 2, 3].map(lane => hashString32(`${lane}\u0000${text}`).toString(16).padStart(8, "0")).join("");
}

export function styleJobKey(component: StyleComponentId, params: StyleComponentParams, frameCount: number, fps: number): string {
  return styleKey({ engine: STYLE_ENGINE_VERSION, component, params, frameCount, fps });
}
