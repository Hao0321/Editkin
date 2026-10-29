import type { TimelineTransition } from "../domain/timelineTransitionV1";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";

/**
 * Cut points for the Motion Library GUI (PHASE3_INTEGRATION_DESIGN §4, roadmap 2.4): where two content clips meet on
 * a video track, how many frames a transition window may take on each side, and the window a requested duration gets.
 *
 * Browser-safe and pure. The domain (compileTimelineTransitionHandleV1) stays the authority; these limits mirror its
 * rules so the GUI offers only windows it will accept:
 * - the window stays inside the two clips and never overlaps the neighbouring cuts' windows;
 * - the outgoing clip needs `after` frames of unused source after its out point, the incoming clip `before` frames
 *   before its in point (stills have unlimited handles);
 * - a window has at least 2 frames (dissolve/dip) or the matte's 0.2 s minimum, and a matte at most 2.0 s.
 */

export interface MotionLibraryCutRefV1 {
  readonly trackId: string;
  readonly fromClipId: string;
  readonly toClipId: string;
}

export interface MotionLibraryCutPointV1 extends MotionLibraryCutRefV1 {
  /** Project frame of the cut (the incoming clip's first frame). */
  readonly cutFrame: number;
  readonly time: number;
  /** The transition already on this cut, if any. */
  readonly transition?: TimelineTransition;
  /** Frames a window may take before / after the cut (this cut's own transition does not count against it). */
  readonly maxBefore: number;
  readonly maxAfter: number;
  readonly locked: boolean;
  /** False when the clips cannot take a transition at all (not content, not picture). */
  readonly eligible: boolean;
}

export interface MotionLibraryTransitionWindowV1 { readonly before: number; readonly after: number }

const EPSILON = 1e-6;
export const MOTION_TRANSITION_DEFAULT_SECONDS_V1 = 0.5;
const MATTE_MIN_SECONDS = 0.2, MATTE_MAX_SECONDS = 2.0;

const framesAt = (seconds: number, fps: number) => Math.round(seconds * fps);
const floorFrames = (seconds: number, fps: number) => Math.max(0, Math.floor(seconds * fps + EPSILON));

/** The default transition length in frames (0.5 s), never shorter than the domain's 2 frames. */
export function defaultTransitionFramesV1(fps: number): number {
  return Math.max(2, Math.round(MOTION_TRANSITION_DEFAULT_SECONDS_V1 * fps));
}

/** The frame range a matte transition may use at this fps (its params duration is 0.2–2.0 s). */
export function matteTransitionFrameLimitsV1(fps: number): { readonly min: number; readonly max: number } {
  return { min: Math.max(2, Math.ceil(MATTE_MIN_SECONDS * fps - EPSILON)), max: Math.max(2, Math.floor(MATTE_MAX_SECONDS * fps + EPSILON)) };
}

function pictureHandle(asset: MediaAsset | undefined, seconds: number, fps: number): number {
  if (!asset) return 0;
  if (asset.kind === "image") return Number.POSITIVE_INFINITY;
  if (asset.kind !== "video" || !Number.isFinite(seconds)) return 0;
  return floorFrames(seconds, fps);
}

function eligibleClip(clip: TimelineClip, asset: MediaAsset | undefined): boolean {
  return (clip.layer?.role ?? "content") === "content" && Boolean(asset && (asset.kind === "video" || asset.kind === "image"));
}

/** Every cut on one video track, in time order. */
export function listTrackCutsV1(project: EditProject, trackId: string): MotionLibraryCutPointV1[] {
  const track = project.tracks.find(candidate => candidate.id === trackId);
  if (!track || track.kind !== "video") return [];
  const fps = project.fps;
  const ordered = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
  const transitions = (project.timelineTransitions ?? []).filter(transition => transition.trackId === track.id);
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const cuts: MotionLibraryCutPointV1[] = [];
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const from = ordered[index], to = ordered[index + 1];
    if (Math.abs(from.timelineStart + from.duration - to.timelineStart) > EPSILON) continue;
    const fromAsset = assets.get(from.assetId), toAsset = assets.get(to.assetId);
    const cutFrame = framesAt(to.timelineStart, fps);
    const fromStart = framesAt(from.timelineStart, fps), toEnd = framesAt(to.timelineStart + to.duration, fps);
    // Neighbouring windows on the same track: the cut at the outgoing clip's start and the one at the incoming clip's end.
    const previous = transitions.find(transition => transition.toClipId === from.id);
    const next = transitions.find(transition => transition.fromClipId === to.id);
    const previousEnd = previous ? fromStart + previous.afterFrames : fromStart;
    const nextStart = next ? toEnd - next.beforeFrames : toEnd;
    const maxBefore = Math.max(0, Math.min(cutFrame - Math.max(fromStart, previousEnd),
      pictureHandle(toAsset, to.sourceStart, fps)));
    const maxAfter = Math.max(0, Math.min(Math.min(toEnd, nextStart) - cutFrame,
      pictureHandle(fromAsset, (fromAsset?.duration ?? 0) - from.sourceStart - from.duration, fps)));
    const transition = transitions.find(candidate => candidate.fromClipId === from.id && candidate.toClipId === to.id);
    cuts.push({ trackId: track.id, fromClipId: from.id, toClipId: to.id, cutFrame, time: cutFrame / fps, ...(transition ? { transition } : {}),
      maxBefore, maxAfter, locked: Boolean(track.locked), eligible: eligibleClip(from, fromAsset) && eligibleClip(to, toAsset) });
  }
  return cuts;
}

/** Every cut on every video track. */
export function listProjectCutsV1(project: EditProject): MotionLibraryCutPointV1[] {
  return project.tracks.filter(track => track.kind === "video").flatMap(track => listTrackCutsV1(project, track.id));
}

export function sameCutV1(left: MotionLibraryCutRefV1 | undefined, right: MotionLibraryCutRefV1 | undefined): boolean {
  return Boolean(left && right && left.trackId === right.trackId && left.fromClipId === right.fromClipId && left.toClipId === right.toClipId);
}

export function findCutV1(project: EditProject, ref: MotionLibraryCutRefV1): MotionLibraryCutPointV1 | undefined {
  return listTrackCutsV1(project, ref.trackId).find(cut => sameCutV1(cut, ref));
}

export function findTransitionCutV1(project: EditProject, transitionId: string): MotionLibraryCutPointV1 | undefined {
  const transition = project.timelineTransitions?.find(candidate => candidate.id === transitionId);
  return transition ? findCutV1(project, transition) : undefined;
}

/**
 * The editable cut nearest `time`: on `preferTrackId` when that track has one (the selected clip's track), else on
 * any unlocked video track; ties go to the earlier track in project order.
 */
export function nearestCutV1(project: EditProject, time: number, preferTrackId?: string): MotionLibraryCutPointV1 | undefined {
  const usable = (cut: MotionLibraryCutPointV1) => cut.eligible && !cut.locked;
  const pick = (cuts: MotionLibraryCutPointV1[]) => cuts.filter(usable).reduce<MotionLibraryCutPointV1 | undefined>((best, cut) =>
    !best || Math.abs(cut.time - time) < Math.abs(best.time - time) - EPSILON ? cut : best, undefined);
  return (preferTrackId ? pick(listTrackCutsV1(project, preferTrackId)) : undefined) ?? pick(listProjectCutsV1(project));
}

export type MotionLibraryWindowResultV1 = { readonly window: MotionLibraryTransitionWindowV1 } | { readonly refusal: string };

/**
 * The window for `desiredFrames` at a cut: centred on the cut, then shifted to whichever side has handle room.
 * Refused when even the shortest allowed window does not fit.
 */
export function transitionWindowV1(cut: Pick<MotionLibraryCutPointV1, "maxBefore" | "maxAfter">, desiredFrames: number,
  limits: { readonly min: number; readonly max: number }): MotionLibraryWindowResultV1 {
  const desired = Math.max(limits.min, Math.min(limits.max, Math.round(desiredFrames)));
  let before = Math.min(Math.floor(desired / 2), cut.maxBefore), after = Math.min(desired - Math.floor(desired / 2), cut.maxAfter);
  let deficit = desired - before - after;
  const moreAfter = Math.min(deficit, cut.maxAfter - after); after += moreAfter; deficit -= moreAfter;
  before += Math.min(deficit, cut.maxBefore - before);
  if (before + after < limits.min) {
    return { refusal: "這個剪接點兩側的素材太短，放不下轉場；請讓前一段結尾後、後一段開頭前多保留一點原始畫面。" };
  }
  return { window: { before, after } };
}

/** Dragging one edge of an applied window: that side changes by `deltaFrames`, clamped to the handles and the limits. */
export function resizeTransitionWindowV1(cut: Pick<MotionLibraryCutPointV1, "maxBefore" | "maxAfter">, current: MotionLibraryTransitionWindowV1,
  edge: "before" | "after", deltaFrames: number, limits: { readonly min: number; readonly max: number }): MotionLibraryTransitionWindowV1 {
  const other = edge === "before" ? current.after : current.before;
  const room = edge === "before" ? cut.maxBefore : cut.maxAfter;
  const requested = (edge === "before" ? current.before : current.after) + Math.round(deltaFrames);
  const lowest = Math.max(0, limits.min - other), highest = Math.min(room, limits.max - other);
  const side = Math.max(lowest, Math.min(highest, requested));
  return edge === "before" ? { before: side, after: current.after } : { before: current.before, after: side };
}
