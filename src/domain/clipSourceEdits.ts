import { shiftedClipAudioEnvelope } from "./clipAudioEnvelope";
import { EditGraphError } from "./editGraphError";
import type { ClipKeyframe, EditProject, MediaAsset, TimelineClip, TimelineTrack } from "./types";

/**
 * Source-range edits for one timeline clip: make it longer up to the real media
 * bounds (extend) or choose a different in-point without moving it (slip).
 *
 * Both stay on the project frame grid and never overwrite another clip. When an
 * extension needs room it pushes the following content later, using the same
 * scope as ripple delete (主畫面 moves the synced tracks, captions, graphics and
 * markers; any other track moves only its own later clips).
 *
 * Template ownership is not changed here: clips a template generated, and pushes
 * that would move a movie template's clips or Motion-scene content, are refused
 * with a reason. A saved title template's own main clip may grow or take a new
 * in-point, and a push may carry a saved title template further on; the editor
 * lays that template out again (or records it at its new place) in the same command.
 */

export type ClipSourceEditKind = "extend" | "slip";
export type ClipEdge = "start" | "end";

/** Seconds of tolerance for times stored as frame / fps. */
const TIME_EPSILON = 1e-6;
/** Frames of tolerance when reading a time back onto the frame grid. */
const FRAME_EPSILON = 1e-6;
const MAX_FPS = 240;

interface LocatedClip {
  clip: TimelineClip;
  track: TimelineTrack;
}

function locate(project: EditProject, clipId: string): LocatedClip | undefined {
  for (const track of project.tracks) {
    const clip = track.clips.find(item => item.id === clipId);
    if (clip) return { clip, track };
  }
  return undefined;
}

function validFps(fps: number): boolean {
  return Number.isFinite(fps) && fps > 0 && fps <= MAX_FPS;
}

/** Display seconds as a short decimal; the same text appears in statuses and errors. */
export function formatEditSeconds(seconds: number): string {
  return (Math.abs(seconds) < 0.005 ? 0 : seconds).toFixed(2);
}

/** Whole frames of `seconds`, never rounding up past real media. */
function floorFrames(seconds: number, fps: number): number {
  return Math.max(0, Math.floor(seconds * fps + FRAME_EPSILON));
}

/** Keep frame-grid times exact; legacy off-grid times are shifted without being re-rounded.
 * `+ 0` turns a rounded -0 into 0 so a saved or compared time is never negative zero. */
function shiftTime(time: number, delta: number, fps: number): number {
  const shifted = time + delta;
  const frame = Math.round(shifted * fps);
  return (Math.abs(shifted * fps - frame) <= FRAME_EPSILON ? frame / fps : shifted) + 0;
}

/**
 * The template ownership rule used for source replacement
 * (getClipSourceReplacementError): a saved Reference Motion instance or a
 * template application that lists this clip.
 */
export function isTemplateManagedClip(project: EditProject, clipId: string): boolean {
  return (project.referenceMotionInstances ?? []).some(instance => instance.input.clipId === clipId
      || instance.roles.some(role => role.id === clipId || role.parentId === clipId))
    || Boolean(project.templateApplication?.generatedClips?.some(candidate => candidate.clipId === clipId))
    || Boolean(project.templateApplication?.applied.clips.some(candidate => candidate.clipId === clipId));
}

/**
 * A clip whose timing a template owns: one a saved Reference Motion template generated, or one a movie template
 * applied. A saved template's own main clip is not one of them: the clip may grow or take a new in-point, and the
 * editor lays the template out again on it (or says plainly that the template needs re-applying), as it does for a trim.
 */
function isTemplateGeneratedClip(project: EditProject, clipId: string): boolean {
  return (project.referenceMotionInstances ?? []).some(instance => instance.input.clipId !== clipId
      && instance.roles.some(role => role.id === clipId || role.parentId === clipId))
    || isMovieTemplateClip(project, clipId);
}

/** A clip a movie template applied or generated: its timing belongs to that template, with no way to follow a push. */
function isMovieTemplateClip(project: EditProject, clipId: string): boolean {
  return Boolean(project.templateApplication?.generatedClips?.some(candidate => candidate.clipId === clipId))
    || Boolean(project.templateApplication?.applied.clips.some(candidate => candidate.clipId === clipId));
}

function hasSourceBoundAnalysis(project: EditProject, clip: TimelineClip): boolean {
  return project.motionTracks.some(motion => motion.clipId === clip.id)
    || Boolean(clip.masks?.some(mask => mask.trackId !== undefined || mask.matteSequence !== undefined || mask.frozenRange !== undefined
      || Boolean(mask.rotoCorrections?.length) || mask.keyframes.some(keyframe => keyframe.status !== "manual")));
}

const BLOCKERS = {
  missing: "找不到這個片段，請重新選取。",
  fps: "專案影格率無效，無法調整片段。",
  asset: "找不到這個片段素材的實際長度，無法調整。",
  locked: { extend: "這條軌道已鎖定；請先解除鎖定再延長片段。", slip: "這條軌道已鎖定；請先解除鎖定再換入點。" },
  template: { extend: "此片段由模板管理；請透過模板重新編譯或解除模板連結，再延長片段。", slip: "此片段由模板管理；請透過模板重新編譯或解除模板連結，再換入點。" },
  analysis: { extend: "此片段含追蹤或逐格遮罩資料，延長會讓它們對不上；請先移除追蹤／遮罩分析。", slip: "此片段含追蹤或逐格遮罩資料，換入點會讓它們對不上；請先移除追蹤／遮罩分析。" },
  mesh: { extend: "此片段已綁定 3D 影片材質；請先在 3D 場景解除綁定，再延長片段。", slip: "此片段已綁定 3D 影片材質；請先在 3D 場景解除綁定，再換入點。" },
  image: "照片每一格都是同一張畫面，沒有入點可以換。",
  controller: "Null 控制器不顯示素材，沒有入點可以換。",
} as const;

/** Why this clip's source range cannot be edited right now; undefined when it can. */
export function clipSourceEditBlocker(project: EditProject, clipId: string, kind: ClipSourceEditKind): string | undefined {
  const located = locate(project, clipId);
  if (!located) return BLOCKERS.missing;
  const { clip, track } = located;
  if (track.locked) return BLOCKERS.locked[kind];
  if (!validFps(project.fps)) return BLOCKERS.fps;
  const asset = project.assets.find(item => item.id === clip.assetId);
  if (!asset || !Number.isFinite(asset.duration) || asset.duration <= 0) return BLOCKERS.asset;
  if (kind === "slip" && asset.kind === "image") return BLOCKERS.image;
  if (kind === "slip" && clip.layer?.role === "controller") return BLOCKERS.controller;
  if (isTemplateGeneratedClip(project, clip.id)) return BLOCKERS.template[kind];
  if (hasSourceBoundAnalysis(project, clip)) return BLOCKERS.analysis[kind];
  if (project.scene3d?.segments.some(segment => segment.objects.some(object => object.material.clipId === clip.id))) return BLOCKERS.mesh[kind];
  return undefined;
}

export interface ClipSourceWindow {
  fps: number;
  asset: MediaAsset;
  /** Whole project frames of real media before the clip's in-point. */
  headFrames: number;
  /** Whole project frames of real media after the clip's out-point. */
  tailFrames: number;
  /** Latest frame-grid in-point that still covers the whole clip. */
  maxSourceStartFrame: number;
}

export function clipSourceWindow(project: EditProject, clipId: string): ClipSourceWindow | undefined {
  const located = locate(project, clipId);
  const asset = located && project.assets.find(item => item.id === located.clip.assetId);
  if (!located || !asset || !validFps(project.fps) || !Number.isFinite(asset.duration) || asset.duration <= 0) return undefined;
  const { clip } = located, fps = project.fps;
  return {
    fps,
    asset,
    headFrames: floorFrames(clip.sourceStart, fps),
    tailFrames: floorFrames(asset.duration - clip.sourceStart - clip.duration, fps),
    maxSourceStartFrame: floorFrames(asset.duration - clip.duration, fps),
  };
}

interface PushScope {
  /** Timeline time at and after which content moves. */
  from: number;
  clipIds: string[];
  captionIds: string[];
  graphicIds: string[];
  markerIds: string[];
}

const PUSH_BLOCKED_TEMPLATE_CLIP = "延長需要把後面的片段往後推，但後面有模板管理的片段；請先在這段後面留出空位，或解除模板連結。";
const PUSH_BLOCKED_MANAGED_GRAPHIC = "延長需要把後面的內容往後推，但後面有模板或 Motion 場景管理的圖卡；請先在這段後面留出空位，或解除模板連結。";

function pushScope(project: EditProject, clip: TimelineClip, track: TimelineTrack, from: number): PushScope {
  const after = (time: number) => time >= from - TIME_EPSILON;
  const main = track.id === "video-main";
  // Same scope as ripple delete: 主畫面 keeps its synced content together.
  const tracks = main ? project.tracks.filter(item => !item.locked && item.kind !== "caption") : [track];
  const clipIds = tracks.flatMap(item => item.clips.filter(candidate => candidate.id !== clip.id && after(candidate.timelineStart)).map(candidate => candidate.id));
  // A graphic that follows a moved clip's motion track moves with that clip.
  const moved = new Set(clipIds);
  const followingTracks = new Set(project.motionTracks.filter(motion => moved.has(motion.clipId)).map(motion => motion.id));
  return {
    from,
    clipIds,
    captionIds: main ? project.captions.filter(caption => after(caption.start)).map(caption => caption.id) : [],
    graphicIds: project.motionGraphics.filter(graphic => (main && after(graphic.timelineStart))
      || (graphic.trackId !== undefined && followingTracks.has(graphic.trackId))).map(graphic => graphic.id),
    markerIds: main ? project.director.markers.filter(marker => after(marker.time)).map(marker => marker.id) : [],
  };
}

function pushBlocker(project: EditProject, scope: PushScope, track: TimelineTrack): string | undefined {
  // A saved title template further on is carried along (a ripple insert): the editor lays it out again, or records it at
  // its new place, in the same command. A movie template's clips and Motion-scene content keep their own clocks.
  if (scope.clipIds.some(id => isMovieTemplateClip(project, id))) return PUSH_BLOCKED_TEMPLATE_CLIP;
  const sceneGraphics = new Set((project.motionScenes ?? []).flatMap(scene => scene.graphicIds));
  if (scope.graphicIds.some(id => sceneGraphics.has(id))) return PUSH_BLOCKED_MANAGED_GRAPHIC;
  if (track.id === "video-main" && (project.motionScenes ?? []).some(scene => scene.startFrame / project.fps >= scope.from - TIME_EPSILON)) {
    return PUSH_BLOCKED_MANAGED_GRAPHIC;
  }
  return undefined;
}

interface Neighbours {
  /** End of the latest clip before this one on the same track, or 0. */
  floor: number;
  next?: TimelineClip;
}

function neighbours(clip: TimelineClip, track: TimelineTrack): Neighbours {
  const others = track.clips.filter(item => item.id !== clip.id);
  const end = clip.timelineStart + clip.duration;
  const floor = Math.max(0, ...others.filter(item => item.timelineStart + item.duration <= clip.timelineStart + TIME_EPSILON)
    .map(item => item.timelineStart + item.duration));
  const next = others.filter(item => item.timelineStart >= end - TIME_EPSILON)
    .sort((left, right) => left.timelineStart - right.timelineStart)[0];
  return { floor, next };
}

export interface ClipExtensionLimits {
  edge: ClipEdge;
  /** Frames of real media available beyond this edge. */
  sourceFrames: number;
  /** Frames the clip can grow without moving anything else. */
  freeFrames: number;
  /** Set when growing past the free space would move content that must not move. */
  pushBlockedReason?: string;
  /** What a gesture may reach: the source bound, or the free space when a push is refused. */
  maxFrames: number;
}

/** Limits for an extension gesture; a string when this clip cannot be extended at all. */
export function clipExtensionLimits(project: EditProject, clipId: string, edge: ClipEdge): ClipExtensionLimits | string {
  const blocker = clipSourceEditBlocker(project, clipId, "extend");
  if (blocker) return blocker;
  const { clip, track } = locate(project, clipId)!;
  const window = clipSourceWindow(project, clipId)!;
  const fps = project.fps;
  const { floor, next } = neighbours(clip, track);
  const end = clip.timelineStart + clip.duration;
  const after = next ? floorFrames(next.timelineStart - end, fps) : Number.POSITIVE_INFINITY;
  const before = floorFrames(clip.timelineStart - floor, fps);
  const freeFrames = edge === "end" ? after : before + after;
  const sourceFrames = edge === "start" ? window.headFrames : window.tailFrames;
  const pushBlockedReason = next ? pushBlocker(project, pushScope(project, clip, track, next.timelineStart), track) : undefined;
  return { edge, sourceFrames, freeFrames, pushBlockedReason,
    maxFrames: pushBlockedReason ? Math.min(sourceFrames, freeFrames) : sourceFrames };
}

/** The message shown when an extension reaches the end of the available media. */
export function clipSourceLimitMessage(edge: ClipEdge, availableFrames: number, fps: number): string {
  if (availableFrames <= 0) {
    return edge === "start"
      ? "這段已從素材的第一格開始，開頭沒有更早的畫面可以延長。"
      : "這段已用到素材的最後一格，結尾沒有更多畫面可以延長。";
  }
  const seconds = formatEditSeconds(availableFrames / fps);
  return edge === "start"
    ? `開頭最多只能再延長 ${seconds} 秒：素材在這之前沒有更多畫面。`
    : `結尾最多只能再延長 ${seconds} 秒：素材在這之後就結束了。`;
}

export interface ClipExtensionPlan {
  clipId: string;
  edge: ClipEdge;
  frames: number;
  seconds: number;
  timelineStart: number;
  sourceStart: number;
  duration: number;
  /** The start edge met the previous clip or the timeline start, so the clip grew later instead. */
  grewLater: boolean;
  /** Seconds the following content moves later; 0 when the extension fit into free space. */
  pushSeconds: number;
  push?: PushScope;
}

/** Plan an extension of `frames` project frames; throws a readable reason when it is not allowed. */
export function planClipExtension(project: EditProject, clipId: string, edge: ClipEdge, frames: number): ClipExtensionPlan {
  const limits = clipExtensionLimits(project, clipId, edge);
  if (typeof limits === "string") throw new EditGraphError(limits);
  if (!Number.isSafeInteger(frames) || frames < 1) throw new EditGraphError("延長長度至少要一個影格。");
  const fps = project.fps;
  if (frames > limits.sourceFrames) throw new EditGraphError(clipSourceLimitMessage(edge, limits.sourceFrames, fps));
  if (frames > limits.freeFrames && limits.pushBlockedReason) throw new EditGraphError(limits.pushBlockedReason);
  const { clip, track } = locate(project, clipId)!;
  const seconds = frames / fps;
  const { floor, next } = neighbours(clip, track);
  let timelineStart = clip.timelineStart, sourceStart = clip.sourceStart, grewLater = false;
  if (edge === "start") {
    sourceStart = shiftTime(clip.sourceStart, -seconds, fps);
    if (Math.abs(sourceStart) < TIME_EPSILON) sourceStart = 0;
    const desired = shiftTime(clip.timelineStart, -seconds, fps);
    // Never round onto the previous clip: an off-grid neighbour end rounds up.
    const earliest = Math.min(clip.timelineStart, Math.ceil(floor * fps - FRAME_EPSILON) / fps) + 0;
    if (desired < earliest - TIME_EPSILON) { timelineStart = earliest; grewLater = true; }
    else timelineStart = desired;
  }
  const duration = shiftTime(clip.duration, seconds, fps);
  const end = timelineStart + duration;
  const overlap = next ? end - next.timelineStart : 0;
  const pushFrames = overlap > TIME_EPSILON ? Math.ceil(overlap * fps - FRAME_EPSILON) : 0;
  const push = pushFrames > 0 && next ? pushScope(project, clip, track, next.timelineStart) : undefined;
  return { clipId, edge, frames, seconds, timelineStart, sourceStart, duration, grewLater, pushSeconds: pushFrames / fps, push };
}

/** Keep the animation on the same content when a clip's head grows by `seconds`. */
function shiftKeyframesForHead(clip: TimelineClip, seconds: number, fps: number): void {
  if (!clip.keyframes.length) return;
  const sorted = [...clip.keyframes].sort((left, right) => left.time - right.time);
  const first = sorted[0];
  const shifted: ClipKeyframe[] = sorted.map(keyframe => ({ ...keyframe, transform: { ...keyframe.transform }, color: { ...keyframe.color },
    time: shiftTime(keyframe.time, seconds, fps) }));
  if (first.time <= TIME_EPSILON) {
    // The first key owned the old start; the new head holds that same state.
    clip.transform = { ...first.transform };
    clip.color = { ...first.color };
  } else {
    // The old start was the clip's own base value; pin it where the old start now is.
    const ids = new Set(clip.keyframes.map(keyframe => keyframe.id));
    let id = `${clip.id}-extended-head`, suffix = 2;
    while (ids.has(id)) id = `${clip.id}-extended-head-${suffix++}`;
    shifted.unshift({ id, time: shiftTime(0, seconds, fps), transform: { ...clip.transform }, color: { ...clip.color }, easing: "linear" });
  }
  clip.keyframes = shifted;
}

/** Manual mask keys are clip-local; they follow the content when the head grows. */
function shiftMaskKeyframesForHead(clip: TimelineClip, frames: number, seconds: number, fps: number): void {
  if (!clip.masks?.some(mask => mask.keyframes.length)) return;
  clip.masks = clip.masks.map(mask => mask.keyframes.length ? {
    ...mask,
    keyframes: mask.keyframes.map(keyframe => ({ ...keyframe, frame: keyframe.frame + frames, time: shiftTime(keyframe.time, seconds, fps) })),
  } : mask);
}

/** Mutates a working copy; the command layer validates the whole project afterwards. */
export function applyClipExtension(project: EditProject, command: { clipId: string; edge: ClipEdge; seconds: number }): void {
  if (command.edge !== "start" && command.edge !== "end") throw new EditGraphError("延長邊緣必須是開頭或結尾。");
  if (!validFps(project.fps)) throw new EditGraphError(BLOCKERS.fps);
  const exact = command.seconds * project.fps, frames = Math.round(exact);
  if (!Number.isFinite(exact) || Math.abs(exact - frames) > FRAME_EPSILON) throw new EditGraphError("延長長度必須對齊專案影格。");
  const plan = planClipExtension(project, command.clipId, command.edge, frames);
  const fps = project.fps;
  if (plan.push) {
    const delta = plan.pushSeconds;
    const clipIds = new Set(plan.push.clipIds), captionIds = new Set(plan.push.captionIds);
    const graphicIds = new Set(plan.push.graphicIds), markerIds = new Set(plan.push.markerIds);
    for (const candidate of project.tracks.flatMap(track => track.clips)) {
      if (clipIds.has(candidate.id)) candidate.timelineStart = shiftTime(candidate.timelineStart, delta, fps);
    }
    for (const caption of project.captions) if (captionIds.has(caption.id)) caption.start = shiftTime(caption.start, delta, fps);
    for (const graphic of project.motionGraphics) if (graphicIds.has(graphic.id)) graphic.timelineStart = shiftTime(graphic.timelineStart, delta, fps);
    for (const marker of project.director.markers) if (markerIds.has(marker.id)) marker.time = shiftTime(marker.time, delta, fps);
  }
  const { clip, track } = locate(project, command.clipId)!;
  if (plan.edge === "start") {
    if (clip.audioEnvelope) clip.audioEnvelope = shiftedClipAudioEnvelope(clip, -plan.seconds);
    shiftKeyframesForHead(clip, plan.seconds, fps);
    shiftMaskKeyframesForHead(clip, plan.frames, plan.seconds, fps);
  }
  clip.timelineStart = plan.timelineStart;
  clip.sourceStart = plan.sourceStart;
  clip.duration = plan.duration;
  for (const item of project.tracks) {
    if (item === track || plan.push) item.clips.sort((left, right) => left.timelineStart - right.timelineStart);
  }
}

/** Why `sourceStart` cannot become this clip's in-point; undefined when it can. */
export function clipSlipError(project: EditProject, clipId: string, sourceStart: number): string | undefined {
  const blocker = clipSourceEditBlocker(project, clipId, "slip");
  if (blocker) return blocker;
  const { clip } = locate(project, clipId)!;
  const window = clipSourceWindow(project, clipId)!;
  const fps = project.fps;
  if (!Number.isFinite(sourceStart)) return "請輸入入點秒數。";
  if (sourceStart < -TIME_EPSILON) return "入點不能早於素材開頭（0 秒）。";
  const exact = sourceStart * fps, frame = Math.round(exact);
  if (Math.abs(exact - frame) > FRAME_EPSILON) return "入點必須對齊專案影格。";
  if (frame > window.maxSourceStartFrame) {
    if (window.maxSourceStartFrame === 0) return "這段已用到整段素材，沒有空間換入點；先把片段剪短再試。";
    return `從 ${formatEditSeconds(sourceStart)} 秒開始只剩 ${formatEditSeconds(Math.max(0, window.asset.duration - sourceStart))} 秒素材，不夠這個片段的 ${formatEditSeconds(clip.duration)} 秒；最晚只能從 ${formatEditSeconds(window.maxSourceStartFrame / fps)} 秒開始。`;
  }
  if (Math.abs(frame / fps - clip.sourceStart) <= TIME_EPSILON) return "入點沒有改變。";
  return undefined;
}

/** Mutates a working copy: a new in-point; timeline position, length and authored animation stay. */
export function applyClipSlip(project: EditProject, command: { clipId: string; sourceStart: number }): void {
  const error = clipSlipError(project, command.clipId, command.sourceStart);
  if (error) throw new EditGraphError(error);
  const { clip } = locate(project, command.clipId)!;
  // `+ 0` keeps a rounded -0 from reaching the saved project.
  clip.sourceStart = Math.round(command.sourceStart * project.fps) / project.fps + 0;
}
