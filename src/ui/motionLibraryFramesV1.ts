import { getMotionLibraryItem } from "../motionLibrary/catalog";
import { generateMotionFrame, generateTransitionFrame } from "../motionLibrary/frames";
import { resolveMotionLibraryParams } from "../motionLibrary/params";
import { createSvgDocument, path, transform, tf } from "../motionLibrary/svg/document";
import { layoutLine } from "../motionLibrary/svg/glyphs";
import { motionBackgroundLoopSeconds } from "../motionLibrary/catalog";
import type { MotionFrameSize, MotionLibraryItem, TransitionMotionParams } from "../motionLibrary/types";

/**
 * Library thumbnails and the inspector's live preview (PHASE3_INTEGRATION_DESIGN §4): the item's own generator draws
 * the frame in the webview, exactly the SVG the renderer rasterizes.
 * - text items show on their showcase plate in the library (ART_DIRECTION §9); the live preview shows the real params;
 * - transitions show out = mix(A, B, matte) ⊕ overlay over the ART_DIRECTION §6 demo planes
 *   (A = paper with an ink 「A」, B = accent with a paper 「B」), as the contact sheets do;
 * - backgrounds show the frame itself.
 * Shared by the thumbnail worker and the main-thread fallback; browser-safe.
 */

export interface MotionLibraryFrameRequestV1 {
  readonly itemId: string;
  /** Caller params input (partial); omitted means the item defaults. */
  readonly params?: Readonly<Record<string, unknown>>;
  readonly size: MotionFrameSize;
  readonly t: number;
  /** "card": library thumbnail (showcase plate for text). "preview": exactly the given params. */
  readonly purpose: "card" | "preview";
}

/** Prefix every id (and every reference to it) of one embedded document, so several documents share one SVG. */
function namespaced(svg: string, prefix: string): string {
  const open = svg.indexOf(">"), close = svg.lastIndexOf("</svg>");
  const inner = open >= 0 && close > open ? svg.slice(open + 1, close) : svg;
  return inner.replace(/\bid="([A-Za-z0-9_-]+)"/g, `id="${prefix}$1"`).replace(/url\(#([A-Za-z0-9_-]+)\)/g, `url(#${prefix}$1)`)
    .replace(/href="#([A-Za-z0-9_-]+)"/g, `href="#${prefix}$1"`);
}

function demoPlane(size: MotionFrameSize, fill: string, letter: string, letterFill: string): string {
  const doc = createSvgDocument(size, { background: fill, idPrefix: "dp" });
  const glyphSize = Math.min(size.width, size.height) * 0.5;
  const line = layoutLine(letter, { font: "latin", size: glyphSize });
  const ink = line.inkBox ?? { x0: 0, y0: -glyphSize, x1: line.width, y1: 0 };
  const x = size.width / 2 - (ink.x0 + ink.x1) / 2, y = size.height / 2 - (ink.y0 + ink.y1) / 2;
  return doc.render(path(line.pathD, { fill: letterFill, transform: transform(tf.translate(x, y)) }));
}

function root(size: MotionFrameSize, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${body}</svg>`;
}

/** One frame as a self-contained SVG document. Throws the generator's own error (missing font, unsupported text…). */
export function composeMotionLibraryFrameV1(request: MotionLibraryFrameRequestV1): string {
  const item = getMotionLibraryItem(request.itemId);
  const input = { ...(request.params ?? {}) } as Record<string, unknown>;
  if (item.kind === "text") {
    if (request.purpose === "card" && input.plate === undefined) input.plate = item.showcasePlate;
    return generateMotionFrame(item, resolveMotionLibraryParams(item, input), request.t, request.size);
  }
  if (item.kind === "background") return generateMotionFrame(item, resolveMotionLibraryParams(item, input), request.t, request.size);
  const params = resolveMotionLibraryParams(item, input) as TransitionMotionParams;
  const frame = generateTransitionFrame(item, params, Math.min(request.t, params.durationSeconds), request.size);
  const { width, height } = request.size;
  const a = demoPlane(request.size, params.palette.paper, "A", params.palette.ink);
  const b = demoPlane(request.size, params.palette.accent, "B", params.palette.paper);
  return root(request.size, `<defs><mask id="tvMatte" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">`
    + `${namespaced(frame.matte, "tm")}</mask></defs>${namespaced(a, "ta")}<g mask="url(#tvMatte)">${namespaced(b, "tb")}</g>`
    + `${frame.overlay ? namespaced(frame.overlay, "to") : ""}`);
}

const hasTag = (item: MotionLibraryItem, tag: string) => item.tags.includes(tag);

/** The still a library card shows: a moment where the item reads clearly. */
export function motionLibraryStillTimeV1(item: MotionLibraryItem): number {
  if (item.kind === "transition") return item.defaultDurationSeconds * 0.5;
  if (item.kind === "background") return item.loopSeconds * 0.3;
  // Exits start whole and break apart: show them early. Everything else: the reference card moment (1.2 s), within the clip.
  if (hasTag(item, "exit")) return Math.min(0.35, item.defaultDurationSeconds * 0.2);
  return Math.min(1.2, item.defaultDurationSeconds * 0.55);
}

export interface MotionLibraryAnimationV1 {
  /** Sample times on the item clock, in display order. */
  readonly times: readonly number[];
  /** Display time of each sample (ms). */
  readonly frameMs: readonly number[];
}

/** 20 fps; a loop longer than 8 s (160 frames) is sampled more sparsely but still plays in real time. */
const PREVIEW_FPS = 20, MAX_LOOP_FRAMES = 160;

/**
 * Turns a display cycle so it begins on `anchor`. The sample nearest to it moves onto it exactly (at most half a sample
 * away), so the first frame is the very still the card showed (the same cached request) and the loop runs on from there.
 */
function startingAt(times: readonly number[], frameMs: readonly number[], anchor: number): MotionLibraryAnimationV1 {
  let start = 0;
  for (let index = 1; index < times.length; index += 1) if (Math.abs(times[index] - anchor) < Math.abs(times[start] - anchor)) start = index;
  const shifted = [...times];
  if (anchor >= Math.min(...times) && anchor <= Math.max(...times)) shifted[start] = anchor;
  const order = times.map((_, step) => (start + step) % times.length);
  return { times: order.map(index => shifted[index]), frameMs: order.map(index => frameMs[index]) };
}

/**
 * The hover / live-preview loop for an item at these params (input, partial): one pass of the item's whole duration
 * (a looping item: one loop period), starting at `startAt` (default: the card still) and wrapping round to it.
 */
export function motionLibraryAnimationV1(itemId: string, input: Readonly<Record<string, unknown>> = {}, startAt?: number): MotionLibraryAnimationV1 {
  const item = getMotionLibraryItem(itemId);
  const anchor = startAt ?? motionLibraryStillTimeV1(item);
  if (item.kind === "transition") {
    const params = resolveMotionLibraryParams(item, input) as TransitionMotionParams;
    // A 0.5 s wipe is too quick to read on a card: hold A, play the wipe at ~half speed, hold B.
    const samples = Math.max(8, Math.round(params.durationSeconds * PREVIEW_FPS * 1.8));
    const times = Array.from({ length: samples }, (_, index) => (params.durationSeconds * index) / (samples - 1));
    return startingAt([0, ...times, params.durationSeconds], [380, ...times.map(() => 1000 / PREVIEW_FPS), 620], anchor);
  }
  const params = resolveMotionLibraryParams(item, input) as { durationSeconds: number; speed?: number };
  const loop = item.kind === "background" ? motionBackgroundLoopSeconds(item, { speed: params.speed ?? 1 }) : item.loopSeconds ?? params.durationSeconds;
  const span = Math.max(0.5, Math.min(loop, params.durationSeconds));
  const count = Math.max(2, Math.min(MAX_LOOP_FRAMES, Math.round(span * PREVIEW_FPS)));
  const times = Array.from({ length: count }, (_, index) => (span * index) / count);
  // A one-shot entrance holds its last frame a moment before it starts again.
  const oneShot = item.kind === "text" && item.loopSeconds === undefined;
  return startingAt(times, times.map((_, index) => oneShot && index === count - 1 ? 700 : (span * 1000) / count), anchor);
}
