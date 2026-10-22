import { rationalRate, type RationalRate } from "../domain/clipAlphaPlan";
import {
  assertMotionFrameSize,
  type BackgroundMotionItem,
  type BackgroundMotionParams,
  type MotionFrameSize,
  type MotionLibraryItem,
  type MotionLibraryKind,
  type MotionLibraryParams,
  type TextMotionItem,
  type TextMotionParams,
  type TransitionFrame,
  type TransitionMotionItem,
  type TransitionMotionParams,
} from "./types";

/**
 * Frame clock and checked frame generation shared by the renderer, the
 * contact sheet and live previews. A clip of duration d has round(d · fps)
 * frames. Text and background frame i is sampled at t = i / fps, so a seamless
 * loop item gives frame N (t = loop) equal to frame 0; transitions use the
 * endpoint clock (transitionFrameTime) so their first and last frames are pure A and B.
 */

export type { RationalRate };

export interface MotionFrameRate extends RationalRate {
  /** numerator / denominator. */
  readonly value: number;
  /** "num/den" for FFmpeg. */
  readonly text: string;
}

/** Accept 30, 29.97002997… (→ 30000/1001), 23.976 (→ 2997/125) or an explicit rational; 1..240 fps. */
export function motionFrameRate(fps: number | RationalRate): MotionFrameRate {
  const rate = typeof fps === "number" ? rationalRate(fps, 1001) : fps;
  if (!rate || !Number.isSafeInteger(rate.numerator) || !Number.isSafeInteger(rate.denominator) || rate.numerator < 1 || rate.denominator < 1) {
    throw new Error("Motion library fps must be a positive rational");
  }
  const value = rate.numerator / rate.denominator;
  if (!(value >= 1 && value <= 240)) throw new Error("Motion library fps must be within 1..240");
  return Object.freeze({ numerator: rate.numerator, denominator: rate.denominator, value, text: `${rate.numerator}/${rate.denominator}` });
}

export function motionFrameCount(durationSeconds: number, fps: MotionFrameRate): number {
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) throw new Error("Motion library duration must be a positive number of seconds");
  return Math.max(1, Math.round((durationSeconds * fps.numerator) / fps.denominator));
}

/** Exact sample time of frame `index` (seconds) for text and background clips. */
export function motionFrameTime(index: number, fps: MotionFrameRate): number {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Frame index must be a non-negative integer");
  return (index * fps.denominator) / fps.numerator;
}

/**
 * Transition clock (ART_DIRECTION §4): frame i of N samples t = D · i / (N − 1), so
 * the first frame is exactly t = 0 (matte 0, pure A) and the last exactly t = D
 * (matte 1, pure B). Generators only need matte(0) = 0 and matte(D) = 1.
 * A single-frame transition is a cut and samples t = D.
 */
export function transitionFrameTime(index: number, frameCount: number, durationSeconds: number): number {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || !Number.isSafeInteger(index) || index < 0 || index >= frameCount) {
    throw new Error("Transition frame index must be within 0..frameCount-1");
  }
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) throw new Error("Transition duration must be a positive number of seconds");
  if (index === frameCount - 1) return durationSeconds;
  return (durationSeconds * index) / (frameCount - 1);
}

/** Sample time of frame `index` for an item kind: transitions use the endpoint clock, text and backgrounds t = i / fps. */
export function itemFrameTime(kind: MotionLibraryKind, index: number, frameCount: number, fps: MotionFrameRate, durationSeconds: number): number {
  return kind === "transition" ? transitionFrameTime(index, frameCount, durationSeconds) : motionFrameTime(index, fps);
}

function assertSvg(svg: unknown, itemId: string, what: string): string {
  if (typeof svg !== "string" || !svg.startsWith("<svg ") || !svg.endsWith("</svg>")) {
    throw new Error(`Motion library item ${itemId} returned an invalid ${what} SVG document`);
  }
  if (/<(?:text|image|script|foreignObject|iframe|use)\b/i.test(svg)) throw new Error(`Motion library item ${itemId} ${what} SVG uses a forbidden element`);
  return svg;
}

function assertTime(tSeconds: number): void {
  if (!Number.isFinite(tSeconds) || tSeconds < 0) throw new Error("Frame time must be a finite, non-negative number of seconds");
}

/** One checked text or background frame. */
export function generateMotionFrame(item: TextMotionItem, params: TextMotionParams, tSeconds: number, size: MotionFrameSize): string;
export function generateMotionFrame(item: BackgroundMotionItem, params: BackgroundMotionParams, tSeconds: number, size: MotionFrameSize): string;
export function generateMotionFrame(item: TextMotionItem | BackgroundMotionItem, params: TextMotionParams | BackgroundMotionParams,
  tSeconds: number, size: MotionFrameSize): string {
  assertMotionFrameSize(size); assertTime(tSeconds);
  const svg = item.kind === "text"
    ? item.generate(params as TextMotionParams, tSeconds, size)
    : item.generate(params as BackgroundMotionParams, tSeconds, size);
  return assertSvg(svg, item.id, "frame");
}

/** One checked transition frame (matte always, overlay when the item draws one). */
export function generateTransitionFrame(item: TransitionMotionItem, params: TransitionMotionParams, tSeconds: number,
  size: MotionFrameSize): TransitionFrame {
  assertMotionFrameSize(size); assertTime(tSeconds);
  const frame = item.generate(params, tSeconds, size);
  if (!frame || typeof frame !== "object") throw new Error(`Motion library item ${item.id} returned no transition frame`);
  const matte = assertSvg(frame.matte, item.id, "matte");
  return frame.overlay === undefined ? { matte } : { matte, overlay: assertSvg(frame.overlay, item.id, "overlay") };
}

/** Generic dispatch for callers holding a MotionLibraryItem union. */
export function generateAnyMotionFrame(item: MotionLibraryItem, params: MotionLibraryParams, tSeconds: number,
  size: MotionFrameSize): { readonly svg: string } | TransitionFrame {
  return item.kind === "transition"
    ? generateTransitionFrame(item, params as TransitionMotionParams, tSeconds, size)
    : { svg: item.kind === "text" ? generateMotionFrame(item, params as TextMotionParams, tSeconds, size)
      : generateMotionFrame(item, params as BackgroundMotionParams, tSeconds, size) };
}
