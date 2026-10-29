import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { EditGraphError } from "../domain/editGraphError";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import { assertMotionGraphicV3Contract } from "../domain/motionCompositionV3Contract";
import { assertContinuityVectorFrameRange } from "../domain/motionContinuityContract";
import { formatEditSeconds, planClipExtension, type ClipEdge } from "../domain/clipSourceEdits";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import type { CaptionCue, EditProject, MotionGraphic, TimelineClip } from "../domain/types";
import { isNativeReferenceMotionPresentation, referenceMotionTemplate } from "../motion/referenceMotionTemplates";
import { isTemplateRebuildTooShort, plainReferenceMotionRebuildReason, prepareReferenceMotionTemplateFollow, ReferenceMotionRebuildRefusal,
  referenceMotionTemplateCarryCommands, referenceMotionTemplatesTouchedBy, TEMPLATE_REBUILD_OTHER, type ReferenceMotionTemplateFollowOptions,
  type ReferenceMotionTemplateRebuildDependencies } from "./referenceMotionTemplateInstances";
import { createMotionTemplateTextPreparer, type MotionTemplateTextPreparer } from "../typography/motionTemplateTextPreparation";
import { planTimelineClipMove, type TimelinePlacementIdFactory } from "./timelinePlacement";
import { buildClipTrimCommand } from "./timelineTrim";
import { yieldToBrowser } from "./templateFollowProgress";
import { planRippleDelete, rippleMessage } from "./timelineRippleEdits";

/**
 * Timeline edits for titles, graphics and templates (the 標題與圖卡 lane), and the content that follows a main clip.
 *
 * Binding (what follows a clip when it moves):
 *  - a saved Reference Motion template follows its own source clip (input.clipId): its graphics and generated
 *    source clips move with it as one unit, never torn apart;
 *  - a tracked label follows the clip it tracks;
 *  - any other graphic follows the 主畫面 clip under its first frame (a title connected to the main storyline);
 *  - a caption follows the clip that holds its whole time (the 主畫面 clip when several do); a caption that only
 *    partly overlaps the clip, or belongs to another clip, stays put.
 * Scene-owned graphics never move from the timeline; their scene owns the clock.
 *
 * Every accepted gesture is ONE command (a batch) so one Undo restores it. Moving a template whose saved instance is
 * CURRENT also re-records the instance at its new start (input.startFrame + Δ, a new instance revision and the scope
 * hash of the moved graph): a pure frame-exact translation of everything the template owns, so the template keeps its
 * editable state; a ripple (a delete that closes the gap, or an extension that pushes later content) that carries a
 * template along is recorded the same way. A move onto or off 0 s, a trim, an extension, a split and a new in-point
 * (slip) change how the template plays, so the same command lays the template out again on the edited clip with the
 * real compiler (prepareReferenceMotionTemplateFollow) and it stays editable. When that is impossible (a clip too
 * short for the template's words), the clip edit still happens, the template stays as it was, and the message says
 * why; the template editor then offers 「依目前片段重新套用」. A template that was already edited by hand moves with
 * its clip but stays as it was (not CURRENT).
 */

export interface MotionEditPlan {
  command: EditorCommand;
  /** The status line after the edit; it always names the single Undo. */
  message: string;
}

export const TEMPLATE_TRACK_REFUSAL = "這段片段上有標題模板，只能在同一條軌道左右移動；要換軌道，請先在模板編輯器解除模板連結。";
export const TEMPLATE_OVERLAP_REFUSAL = "這裡已有片段；有標題模板的片段只能放在同一軌的空位。";
export const TEMPLATE_NATIVE_PAINT_REFUSAL = "這段片段上的標題模板用原生繪製，不能跟著片段移動；請先在模板編輯器解除模板連結。";
export const OWNED_GRAPHIC_REFUSAL = "這個圖卡屬於標題模板或原創場景，請拖動整個模板，或到對應的編輯器修改。";
export const TRACKED_RANGE_REFUSAL = "這個標籤跟著畫面裡的主體移動，只能放在追蹤的那段片段裡。";
export const NOTHING_CHANGED = "位置沒有改變。";

const MAX_EXTRA_FRAMES = 3600;

function fpsOf(project: Pick<EditProject, "fps">): number {
  if (!Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) throw new EditGraphError("專案影格率無效，無法調整圖卡。");
  return project.fps;
}

/** Whole project frames; legacy off-grid times round to the nearest frame like the rest of the timeline. */
export function frameOf(seconds: number, fps: number): number {
  return Math.round(Math.max(0, seconds) * fps);
}

function durationFramesOf(seconds: number, fps: number): number {
  return Math.max(1, Math.round(seconds * fps));
}

function seconds(frames: number, fps: number): string {
  const value = frames / fps;
  return (Math.abs(value) < 0.005 ? 0 : value).toFixed(2);
}

export function findTimelineClip(project: EditProject, clipId: string | undefined): TimelineClip | undefined {
  if (!clipId) return undefined;
  for (const track of project.tracks) {
    const clip = track.clips.find(item => item.id === clipId);
    if (clip) return clip;
  }
  return undefined;
}

/** Graphics owned by a saved template, keyed by graphic id. */
export function templateGraphicOwners(project: EditProject): Map<string, ReferenceMotionTemplateInstance> {
  const owners = new Map<string, ReferenceMotionTemplateInstance>();
  for (const instance of project.referenceMotionInstances ?? []) {
    for (const role of instance.roles) if (role.kind === "graphic") owners.set(role.id, instance);
  }
  return owners;
}

/** Graphics owned by an original Motion scene, keyed by graphic id. */
export function sceneGraphicOwners(project: EditProject): Map<string, string> {
  const owners = new Map<string, string>();
  for (const scene of project.motionScenes ?? []) for (const id of scene.graphicIds) owners.set(id, scene.id);
  return owners;
}

/** The 主畫面 clip under a frame (half-open), or undefined over a gap. */
export function mainClipAtFrame(project: EditProject, frame: number): TimelineClip | undefined {
  const fps = fpsOf(project);
  const main = project.tracks.find(track => track.id === "video-main");
  return main?.clips.find(clip => {
    const start = frameOf(clip.timelineStart, fps);
    return frame >= start && frame < start + durationFramesOf(clip.duration, fps);
  });
}

/** The clip a free or tracked graphic follows. Template and scene graphics follow their owner instead. */
export function boundClipForGraphic(project: EditProject, graphic: MotionGraphic): TimelineClip | undefined {
  if (graphic.trackId) return findTimelineClip(project, project.motionTracks.find(track => track.id === graphic.trackId)?.clipId);
  return mainClipAtFrame(project, frameOf(graphic.timelineStart, fpsOf(project)));
}

function graphicName(graphic: MotionGraphic): string {
  const text = graphic.text.replace(/\s+/g, " ").trim();
  const label = text || graphic.name.trim() || "圖卡";
  return Array.from(label).length > 16 ? `${Array.from(label).slice(0, 15).join("")}…` : label;
}

function isTemplateOrSceneGraphic(project: EditProject, graphicId: string): boolean {
  return templateGraphicOwners(project).has(graphicId) || sceneGraphicOwners(project).has(graphicId);
}

function holdsFrames(clip: TimelineClip, start: number, end: number, fps: number): boolean {
  const clipStart = frameOf(clip.timelineStart, fps);
  return start >= clipStart && end <= clipStart + durationFramesOf(clip.duration, fps);
}

/**
 * The clip a caption belongs to: the picture or sound clip that holds its whole time. When several do, the 主畫面 clip
 * wins (the main storyline, like titles); when several other clips do, the caption belongs to none and stays put.
 * A template's generated copies and controller layers never own captions.
 */
export function captionOwnerClip(project: EditProject, caption: Pick<CaptionCue, "start" | "duration">): TimelineClip | undefined {
  const fps = fpsOf(project), start = frameOf(caption.start, fps), end = start + durationFramesOf(caption.duration, fps);
  const generated = new Set((project.referenceMotionInstances ?? []).flatMap(instance => instance.roles
    .filter(role => role.kind === "clip" && role.id !== instance.input.clipId).map(role => role.id)));
  const holders = project.tracks.filter(track => track.kind !== "caption").flatMap(track => track.clips.filter(clip =>
    !generated.has(clip.id) && (clip.layer?.role ?? "content") === "content" && holdsFrames(clip, start, end, fps)));
  return holders.find(clip => clip.trackId === "video-main") ?? (holders.length === 1 ? holders[0] : undefined);
}

/** What follows `clipId` when it moves: its templates, its free or tracked graphics, and the captions inside it. */
export function clipAttachments(project: EditProject, clipId: string): { instances: ReferenceMotionTemplateInstance[]; graphics: MotionGraphic[]; captions: CaptionCue[] } {
  const owned = new Set([...templateGraphicOwners(project).keys(), ...sceneGraphicOwners(project).keys()]);
  const clip = findTimelineClip(project, clipId), fps = fpsOf(project);
  return {
    instances: (project.referenceMotionInstances ?? []).filter(instance => instance.input.clipId === clipId),
    graphics: project.motionGraphics.filter(graphic => !owned.has(graphic.id) && boundClipForGraphic(project, graphic)?.id === clipId),
    captions: clip ? project.captions.filter(caption => {
      const start = frameOf(caption.start, fps);
      return holdsFrames(clip, start, start + durationFramesOf(caption.duration, fps), fps) && captionOwnerClip(project, caption)?.id === clipId;
    }) : [],
  };
}

export function hasClipAttachments(project: EditProject, clipId: string): boolean {
  const attached = clipAttachments(project, clipId);
  return attached.instances.length > 0 || attached.graphics.length > 0 || attached.captions.length > 0;
}

/** Template ranges a future recompile must keep free of other graphics (the compiler refuses overlap). */
function templateRanges(project: EditProject, exclude: ReadonlySet<string> = new Set()): Array<{ instance: ReferenceMotionTemplateInstance; start: number; end: number }> {
  return (project.referenceMotionInstances ?? []).filter(instance => !exclude.has(instance.id))
    .map(instance => ({ instance, start: instance.input.startFrame, end: instance.input.startFrame + instance.input.durationFrames }));
}

function overlaps(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && end > otherStart;
}

function newTemplateOverlap(project: EditProject, before: readonly [number, number], after: readonly [number, number],
  exclude: ReadonlySet<string> = new Set()): ReferenceMotionTemplateInstance | undefined {
  return templateRanges(project, exclude).find(range => overlaps(after[0], after[1], range.start, range.end)
    && !overlaps(before[0], before[1], range.start, range.end))?.instance;
}

function templateOverlapRefusal(instance: ReferenceMotionTemplateInstance): string {
  return `這裡是標題模板「${instance.input.title}」的範圍，放進去之後模板就不能再改字；請放到模板外面。`;
}

function validated(project: EditProject, command: EditorCommand): EditProject {
  try { return applyCommand(project, command); }
  catch (error) { throw new EditGraphError(error instanceof Error ? error.message : "這次調整沒有套用。"); }
}

function graphicDurationValid(graphic: MotionGraphic, frames: number, fps: number): boolean {
  const candidate = { ...graphic, duration: frames / fps };
  try {
    assertMotionGraphicV2Contract(candidate, fps);
    assertMotionGraphicV3Contract(candidate);
    assertContinuityVectorFrameRange(candidate, fps);
    return true;
  } catch { return false; }
}

/** Shortest and longest whole-frame lengths this graphic's own animation contract accepts. */
export function motionGraphicDurationLimits(project: EditProject, graphic: MotionGraphic): { minFrames: number; maxFrames: number } {
  const fps = fpsOf(project), current = durationFramesOf(graphic.duration, fps);
  if (!graphicDurationValid(graphic, current, fps)) return { minFrames: current, maxFrames: current };
  // Entrance+exit set a floor; the per-glyph frame budget sets a ceiling. Both are monotonic in length.
  let low = 1, high = current;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (graphicDurationValid(graphic, middle, fps)) high = middle; else low = middle + 1;
  }
  const minFrames = low;
  let reach = current, step = 1;
  while (reach < current + MAX_EXTRA_FRAMES && graphicDurationValid(graphic, Math.min(current + MAX_EXTRA_FRAMES, reach + step), fps)) {
    reach = Math.min(current + MAX_EXTRA_FRAMES, reach + step); step *= 2;
  }
  let lowMax = reach, highMax = Math.min(current + MAX_EXTRA_FRAMES, reach + step);
  while (lowMax < highMax) {
    const middle = Math.ceil((lowMax + highMax) / 2);
    if (graphicDurationValid(graphic, middle, fps)) lowMax = middle; else highMax = middle - 1;
  }
  return { minFrames, maxFrames: lowMax };
}

export interface MotionGraphicBounds {
  /** Earliest and latest first frame a move may use. */
  minStartFrame: number;
  maxStartFrame: number;
  minDurationFrames: number;
  maxDurationFrames: number;
  /** Tracked labels stay inside the tracked clip: [start, end) in project frames. */
  trackedRange?: [number, number];
}

/** The limits a drag or trim of this graphic is held to, before release. */
export function motionGraphicBounds(project: EditProject, graphicId: string): MotionGraphicBounds {
  const fps = fpsOf(project);
  const graphic = project.motionGraphics.find(item => item.id === graphicId);
  if (!graphic) throw new EditGraphError("找不到這個圖卡，請重新選取。");
  const limits = motionGraphicDurationLimits(project, graphic), duration = durationFramesOf(graphic.duration, fps);
  const tracked = graphic.trackId ? boundClipForGraphic(project, graphic) : undefined;
  const trackedRange: [number, number] | undefined = tracked
    ? [frameOf(tracked.timelineStart, fps), frameOf(tracked.timelineStart, fps) + durationFramesOf(tracked.duration, fps)] : undefined;
  return { minStartFrame: trackedRange?.[0] ?? 0, maxStartFrame: trackedRange ? Math.max(trackedRange[0], trackedRange[1] - duration) : Number.MAX_SAFE_INTEGER,
    minDurationFrames: limits.minFrames, maxDurationFrames: trackedRange ? Math.min(limits.maxFrames, trackedRange[1] - trackedRange[0]) : limits.maxFrames, trackedRange };
}

/** Give one free graphic a new first frame and length (a move keeps the length). */
export function planMotionGraphicRange(project: EditProject, graphicId: string, startFrame: number, durationFrames: number): MotionEditPlan {
  const fps = fpsOf(project);
  const graphic = project.motionGraphics.find(item => item.id === graphicId);
  if (!graphic) throw new EditGraphError("找不到這個圖卡，請重新選取。");
  if (isTemplateOrSceneGraphic(project, graphicId)) throw new EditGraphError(OWNED_GRAPHIC_REFUSAL);
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(durationFrames) || durationFrames < 1) {
    throw new EditGraphError("圖卡不能移到 0 秒以前。");
  }
  const oldStart = frameOf(graphic.timelineStart, fps), oldDuration = durationFramesOf(graphic.duration, fps);
  if (startFrame === oldStart && durationFrames === oldDuration) throw new EditGraphError(NOTHING_CHANGED);
  const bounds = motionGraphicBounds(project, graphicId);
  if (bounds.trackedRange && (startFrame < bounds.trackedRange[0] || startFrame + durationFrames > bounds.trackedRange[1])) {
    throw new EditGraphError(TRACKED_RANGE_REFUSAL);
  }
  if (durationFrames !== oldDuration) {
    if (durationFrames < bounds.minDurationFrames) {
      throw new EditGraphError(`「${graphicName(graphic)}」最短要 ${seconds(bounds.minDurationFrames, fps)} 秒，才放得下進場和退場動畫。`);
    }
    if (durationFrames > bounds.maxDurationFrames) throw new EditGraphError(`「${graphicName(graphic)}」最長只能 ${seconds(bounds.maxDurationFrames, fps)} 秒。`);
  }
  const overlap = newTemplateOverlap(project, [oldStart, oldStart + oldDuration], [startFrame, startFrame + durationFrames]);
  if (overlap) throw new EditGraphError(templateOverlapRefusal(overlap));
  const patch: Partial<MotionGraphic> = durationFrames === oldDuration ? { timelineStart: startFrame / fps }
    : { timelineStart: startFrame / fps, duration: durationFrames / fps };
  const command: EditorCommand = { type: "update_motion_graphic", graphicId, patch };
  validated(project, command);
  const message = durationFrames === oldDuration
    ? `已把「${graphicName(graphic)}」移到 ${seconds(startFrame, fps)} 秒；一次復原即可還原。`
    : `已調整「${graphicName(graphic)}」：${seconds(startFrame, fps)} 秒開始，長 ${seconds(durationFrames, fps)} 秒；一次復原即可還原。`;
  return { command, message };
}

export function planMotionGraphicDelete(project: EditProject, graphicId: string): MotionEditPlan {
  const graphic = project.motionGraphics.find(item => item.id === graphicId);
  if (!graphic) throw new EditGraphError("找不到這個圖卡，請重新選取。");
  if (isTemplateOrSceneGraphic(project, graphicId)) throw new EditGraphError(OWNED_GRAPHIC_REFUSAL);
  const command: EditorCommand = { type: "delete_motion_graphic", graphicId };
  validated(project, command);
  return { command, message: `已刪除「${graphicName(graphic)}」；一次復原即可還原。` };
}

function flatten(command: EditorCommand): EditorCommand[] {
  return command.type === "batch" ? command.commands : [command];
}

function attachmentNote(instances: number, graphics: number): string {
  if (instances && graphics) return `，標題模板和另外 ${graphics} 個標題也一起移動`;
  if (instances) return "，標題模板也一起移動";
  return graphics === 1 ? "，上面的標題也一起移動" : `，上面的 ${graphics} 個標題和圖卡也一起移動`;
}

function captionLabel(caption: CaptionCue): string {
  const text = caption.text.replace(/\s+/g, " ").trim() || "字幕";
  return Array.from(text).length > 16 ? `${Array.from(text).slice(0, 15).join("")}…` : text;
}

/** Captions riding with a clip never land on captions that stay: the plain refusal, or undefined when they fit. */
function captionClashFrames(project: EditProject, riding: readonly CaptionCue[], delta: number, fps: number): string | undefined {
  const ids = new Set(riding.map(caption => caption.id));
  for (const caption of riding) {
    const from = frameOf(caption.start, fps) + delta, to = from + durationFramesOf(caption.duration, fps);
    const crowded = project.captions.find(other => !ids.has(other.id)
      && overlaps(from, to, frameOf(other.start, fps), frameOf(other.start, fps) + durationFramesOf(other.duration, fps)));
    if (crowded) return `字幕「${captionLabel(caption)}」跟著片段移過去，會和字幕「${captionLabel(crowded)}」疊在一起；請換個位置。`;
  }
  return undefined;
}

/** For a drag preview: would these captions, moved `deltaSeconds` with their clip, land on other captions? */
export function captionClashForMove(project: EditProject, captionIds: readonly string[], deltaSeconds: number): string | undefined {
  const fps = fpsOf(project), wanted = new Set(captionIds);
  return captionClashFrames(project, project.captions.filter(caption => wanted.has(caption.id)), Math.round(deltaSeconds * fps), fps);
}

/** The status after a clip moved with what follows it; it always names the single Undo. */
function clipMoveMessage(startFrame: number, fps: number, attached: ReturnType<typeof clipAttachments>, needsReapply: boolean): string {
  const where = seconds(startFrame, fps), instances = attached.instances.length, graphics = attached.graphics.length, captions = attached.captions.length;
  const reapply = needsReapply ? "；標題模板要重新套用後才能改字" : "";
  if (!captions) return `已把片段移到 ${where} 秒${attachmentNote(instances, graphics)}${reapply}；一次復原即可還原。`;
  const what = instances && graphics ? `標題模板、其他標題和 ${captions} 段字幕` : instances ? `標題模板和 ${captions} 段字幕`
    : graphics ? `上面的標題和 ${captions} 段字幕` : `上面的 ${captions} 段字幕`;
  return `已把片段移到 ${where} 秒，${what}也一起移動${reapply}；一次復原即可還原。`;
}

interface ClipMovePreparation {
  attached: ReturnType<typeof clipAttachments>;
  /** Frames the clip moves along the timeline (0 for a pure track change). */
  delta: number;
  /** The clip move with its free titles and captions: all a recompiled template follows. */
  edit: EditorCommand[];
  /** The templates' own layers shifted by the same frames: the pure translation of a template. */
  translation: EditorCommand[];
}

/**
 * The synchronous part of a move with attachments: every refusal a creator can be told before anything changes.
 * Undefined when nothing follows the clip.
 */
function prepareClipMove(project: EditProject, clipId: string, trackId: string, start: number, makeId: TimelinePlacementIdFactory): ClipMovePreparation | undefined {
  const fps = fpsOf(project);
  const clip = findTimelineClip(project, clipId);
  if (!clip) throw new EditGraphError("找不到這個片段，請重新選取。");
  const attached = clipAttachments(project, clipId);
  if (!attached.instances.length && !attached.graphics.length && !attached.captions.length) return undefined;
  const base = planTimelineClipMove(project, clipId, trackId, start, makeId);
  const delta = frameOf(start, fps) - frameOf(clip.timelineStart, fps);
  // A move onto another clip would need a new layer, and a template stays on its own track.
  if (attached.instances.length && base.newLayer) throw new EditGraphError(TEMPLATE_OVERLAP_REFUSAL);
  if (attached.instances.length && base.trackId !== clip.trackId) throw new EditGraphError(TEMPLATE_TRACK_REFUSAL);
  if (attached.instances.some(instance => isNativeReferenceMotionPresentation(instance.input.graphicPresentation))) {
    throw new EditGraphError(TEMPLATE_NATIVE_PAINT_REFUSAL);
  }
  const edit: EditorCommand[] = [...flatten(base.command)], translation: EditorCommand[] = [];
  if (delta === 0) {
    validated(project, { type: "batch", commands: edit });
    return { attached, delta, edit, translation };
  }
  const moving = new Set<string>(attached.graphics.map(graphic => graphic.id));
  const shift = (time: number) => (frameOf(time, fps) + delta) / fps;
  for (const graphic of attached.graphics) {
    const startFrame = frameOf(graphic.timelineStart, fps) + delta;
    if (startFrame < 0) throw new EditGraphError(`「${graphicName(graphic)}」會被移到 0 秒以前；請少移一點。`);
    edit.push({ type: "update_motion_graphic", graphicId: graphic.id, patch: { timelineStart: startFrame / fps } });
  }
  // Captions inside the clip ride with it (they cannot reach before 0 s, the clip does not), but never onto others.
  const clash = captionClashFrames(project, attached.captions, delta, fps);
  if (clash) throw new EditGraphError(clash);
  for (const caption of attached.captions) edit.push({ type: "update_caption", captionId: caption.id, patch: { start: shift(caption.start) } });
  for (const instance of attached.instances) {
    for (const role of instance.roles) {
      if (role.kind === "graphic") {
        const graphic = project.motionGraphics.find(item => item.id === role.id);
        if (!graphic) continue;
        moving.add(graphic.id);
        translation.push({ type: "update_motion_graphic", graphicId: graphic.id, patch: { timelineStart: shift(graphic.timelineStart) } });
      } else if (role.kind === "clip" && role.id !== instance.input.clipId) {
        const generated = findTimelineClip(project, role.id);
        if (generated) translation.push({ type: "move_clip", clipId: generated.id, timelineStart: shift(generated.timelineStart) });
      }
    }
  }
  // Ownership: moving a template onto other graphics, or graphics into another template, would lock that template.
  const movingInstances = new Set(attached.instances.map(instance => instance.id));
  for (const instance of attached.instances) {
    const before: [number, number] = [instance.input.startFrame, instance.input.startFrame + instance.input.durationFrames];
    const after: [number, number] = [before[0] + delta, before[1] + delta];
    const owned = new Set(instance.roles.map(role => role.id));
    const blocking = project.motionGraphics.find(graphic => !moving.has(graphic.id) && !owned.has(graphic.id)
      && overlaps(frameOf(graphic.timelineStart, fps), frameOf(graphic.timelineStart, fps) + durationFramesOf(graphic.duration, fps), after[0], after[1])
      && !overlaps(frameOf(graphic.timelineStart, fps), frameOf(graphic.timelineStart, fps) + durationFramesOf(graphic.duration, fps), before[0], before[1]));
    if (blocking) throw new EditGraphError(`標題模板「${instance.input.title}」移過去會和「${graphicName(blocking)}」重疊，模板就不能再改字；請換個位置。`);
  }
  for (const graphic of attached.graphics) {
    const startFrame = frameOf(graphic.timelineStart, fps), length = durationFramesOf(graphic.duration, fps);
    const overlap = newTemplateOverlap(project, [startFrame, startFrame + length], [startFrame + delta, startFrame + delta + length], movingInstances);
    if (overlap) throw new EditGraphError(`「${graphicName(graphic)}」跟著片段移動後會進到標題模板「${overlap.input.title}」的範圍，模板就不能再改字；請換個位置。`);
  }
  validated(project, { type: "batch", commands: [...edit, ...translation] });
  return { attached, delta, edit, translation };
}

const previewIds: TimelinePlacementIdFactory = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`;

/**
 * Why moving this clip to `start` (and `trackId`) would be refused, in plain words, or undefined when it can move.
 * The same checks the move itself makes before anything changes, so a field can say why right where it was typed.
 */
export function clipMoveRefusal(project: EditProject, clipId: string, start: number, trackId?: string): string | undefined {
  try {
    const clip = findTimelineClip(project, clipId);
    if (!clip) return "找不到這個片段，請重新選取。";
    if (!prepareClipMove(project, clipId, trackId ?? clip.trackId, start, previewIds)) {
      validated(project, planTimelineClipMove(project, clipId, trackId ?? clip.trackId, start, previewIds).command);
    }
    return undefined;
  } catch (error) { return error instanceof Error ? error.message : "無法移動片段。"; }
}

/**
 * Move a clip together with everything that follows it. Returns undefined when nothing follows the clip, so the
 * caller keeps the ordinary clip move. Its title templates follow through followTemplatesThroughEdit, the same path as an
 * agent's move_clip: carried along and re-recorded at the new start (a pure frame-exact translation), or laid out again
 * on the moved clip when it moves onto or off 0 s (that needs `templates`, a glyph source; without one the template
 * moves with its clip as it is and asks to be re-applied).
 */
export async function planClipMoveWithAttachments(project: EditProject, clipId: string, trackId: string, start: number,
  makeId: TimelinePlacementIdFactory, templates?: ReferenceMotionTemplateRebuildDependencies): Promise<(MotionEditPlan & { needsReapply: boolean }) | undefined> {
  const fps = fpsOf(project);
  const prepared = prepareClipMove(project, clipId, trackId, start, makeId);
  if (!prepared) return undefined;
  const { attached, delta, edit } = prepared;
  if (delta === 0) return { command: { type: "batch", commands: edit }, message: "已移到另一條軌道；時間不變，一次復原即可還原。", needsReapply: false };
  const outcome = await followTemplatesThroughEdit(project, edit, templates);
  const command: EditorCommand = { type: "batch", commands: outcome.commands };
  validated(project, command);
  const needsReapply = outcome.needsReapply.length > 0;
  return { command, message: clipMoveMessage(frameOf(start, fps), fps, attached, needsReapply), needsReapply };
}

/** Graphics bound to the clip whose first or last frame sits exactly on the clip edge that changes. */
function edgeAlignedGraphics(project: EditProject, clip: TimelineClip, edge: ClipEdge): MotionGraphic[] {
  const fps = fpsOf(project), clipStart = frameOf(clip.timelineStart, fps), clipEnd = clipStart + durationFramesOf(clip.duration, fps);
  return clipAttachments(project, clip.id).graphics.filter(graphic => {
    const start = frameOf(graphic.timelineStart, fps), end = start + durationFramesOf(graphic.duration, fps);
    return edge === "start" ? start === clipStart : end === clipEnd;
  });
}

/** Titles that will follow a trim or extension of this clip edge (for the drag readout). */
export function edgeAlignedGraphicIds(project: EditProject, clipId: string, edge: ClipEdge): string[] {
  const clip = findTimelineClip(project, clipId);
  return clip ? edgeAlignedGraphics(project, clip, edge).map(graphic => graphic.id) : [];
}

/**
 * Trim a clip; a title lined up exactly with the trimmed edge keeps lining up with it (a title that starts with the
 * clip starts with it again; one that ends with the clip ends with it again). Others keep their place over the
 * unchanged picture. Returns undefined when no title needs to follow, so the caller keeps the ordinary trim.
 */
export function planClipTrimWithAttachments(project: EditProject, clipId: string, edge: ClipEdge, trimSeconds: number): MotionEditPlan | undefined {
  const fps = fpsOf(project);
  const clip = findTimelineClip(project, clipId);
  if (!clip) throw new EditGraphError("找不到這個片段，請重新選取。");
  const frames = Math.round(trimSeconds * fps);
  if (frames < 1) return undefined;
  const followers: EditorCommand[] = [];
  for (const graphic of edgeAlignedGraphics(project, clip, edge)) {
    const start = frameOf(graphic.timelineStart, fps), length = durationFramesOf(graphic.duration, fps);
    const nextStart = edge === "start" ? start + frames : start, nextLength = length - frames;
    const limits = motionGraphicDurationLimits(project, graphic);
    if (nextLength < limits.minFrames || nextLength > limits.maxFrames) continue;
    followers.push({ type: "update_motion_graphic", graphicId: graphic.id, patch: { timelineStart: nextStart / fps, duration: nextLength / fps } });
  }
  if (!followers.length) return undefined;
  const command: EditorCommand = { type: "batch", commands: [...flatten(buildClipTrimCommand(clip, edge, trimSeconds)), ...followers] };
  validated(project, command);
  return { command, message: `已修剪片段${edge === "start" ? "開頭" : "結尾"} ${seconds(frames, fps)} 秒，貼齊這個邊的標題也一起調整；一次復原即可還原。` };
}

/**
 * Extend a clip; titles follow its picture, and a title lined up with the growing edge grows with it. When the start
 * edge has no room before the clip, the clip grows later: its picture moves later, and so do the titles on it.
 * Undefined when nothing needs to follow, so the caller keeps the ordinary extension.
 */
export function planClipExtensionWithAttachments(project: EditProject, clipId: string, edge: ClipEdge, extendSeconds: number): MotionEditPlan | undefined {
  const fps = fpsOf(project);
  const clip = findTimelineClip(project, clipId);
  if (!clip) throw new EditGraphError("找不到這個片段，請重新選取。");
  const frames = Math.round(extendSeconds * fps);
  const plan = planClipExtension(project, clipId, edge, frames);
  const oldStart = frameOf(clip.timelineStart, fps), oldEnd = oldStart + durationFramesOf(clip.duration, fps);
  const newStart = frameOf(plan.timelineStart, fps), newEnd = newStart + durationFramesOf(plan.duration, fps);
  // Where the clip's own picture moved: 0 unless the start edge had to grow later.
  const pictureShift = edge === "start" ? newStart - oldStart + frames : 0;
  const followers: EditorCommand[] = [];
  for (const graphic of clipAttachments(project, clipId).graphics) {
    const start = frameOf(graphic.timelineStart, fps), end = start + durationFramesOf(graphic.duration, fps);
    let nextStart = start + pictureShift, nextEnd = end + pictureShift;
    if (edge === "start" && start === oldStart) nextStart = newStart;
    if (edge === "end" && end === oldEnd) nextEnd = newEnd;
    if (nextStart === start && nextEnd === end) continue;
    const limits = motionGraphicDurationLimits(project, graphic), nextLength = nextEnd - nextStart;
    if (nextStart < 0 || nextLength < limits.minFrames || nextLength > limits.maxFrames) continue;
    followers.push({ type: "update_motion_graphic", graphicId: graphic.id, patch: nextLength === end - start
      ? { timelineStart: nextStart / fps } : { timelineStart: nextStart / fps, duration: nextLength / fps } });
  }
  if (!followers.length) return undefined;
  const command: EditorCommand = { type: "batch", commands: [{ type: "extend_clip", clipId, edge, seconds: frames / fps }, ...followers] };
  validated(project, command);
  return { command, message: `已把片段${edge === "start" ? "開頭" : "結尾"}延長 ${seconds(frames, fps)} 秒，貼齊的標題也跟著調整；一次復原即可還原。` };
}

/**
 * The glyph source for one clip gesture that may lay a title template out again. The font preparer is made only when
 * the compiler actually asks for text (most moves are pure translations), and dispose() releases it.
 */
export function templateFollowGlyphs(create: () => MotionTemplateTextPreparer = () => createMotionTemplateTextPreparer()): ReferenceMotionTemplateRebuildDependencies & { dispose(): void } {
  let preparer: MotionTemplateTextPreparer | undefined;
  return { prepareText: (faceId, text) => (preparer ??= create()).prepareText(faceId, text), dispose: () => preparer?.dispose() };
}

/** True when a saved title template sits on this clip: its trims and extensions are planned with the template. */
export function clipHasTemplate(project: EditProject, clipId: string): boolean {
  return (project.referenceMotionInstances ?? []).some(instance => instance.input.clipId === clipId);
}

/**
 * True when `edit` changes a saved title template (its main clip or its own layers): the gesture is then planned with the
 * template, which takes a moment, instead of running at once. False for an edit the editor refuses: the ordinary
 * command then says why.
 */
export function editTouchesTemplates(project: EditProject, edit: readonly EditorCommand[]): boolean {
  try {
    const after = applyCommand(project, { type: "batch", commands: [...edit] });
    return withoutRemoved(withoutSelfManaged(referenceMotionTemplatesTouchedBy(project, after), edit), after).length > 0;
  } catch { return false; }
}

/** The saved templates the edit changes; the edit is applied first and refused with its reason when the editor would. */
function templatesChangedBy(project: EditProject, edit: readonly EditorCommand[]): ReferenceMotionTemplateInstance[] {
  const after = validated(project, { type: "batch", commands: [...edit] });
  return withoutRemoved(withoutSelfManaged(referenceMotionTemplatesTouchedBy(project, after), edit), after);
}

/** A template the edit removed with its main clip (a ripple delete of the clip it sits on) has nothing left to follow. */
function withoutRemoved(touched: ReferenceMotionTemplateInstance[], after: EditProject): ReferenceMotionTemplateInstance[] {
  const remaining = new Set((after.referenceMotionInstances ?? []).map(instance => instance.id));
  return touched.filter(instance => remaining.has(instance.id));
}

/**
 * An edit that writes or removes a template's own saved record (an update to the new version, a re-apply, a copy
 * revision or a detach, as an agent applies them through apply_edit_commands) already manages that template: it is
 * not followed, and never reported as needing a re-apply.
 */
function withoutSelfManaged(touched: ReferenceMotionTemplateInstance[], edit: readonly EditorCommand[]): ReferenceMotionTemplateInstance[] {
  const managed = new Set<string>();
  const visit = (command: EditorCommand): void => {
    if (command.type === "batch") command.commands.forEach(visit);
    else if (command.type === "upsert_reference_motion_instance") managed.add(command.instance.id);
    else if (command.type === "remove_reference_motion_instance") managed.add(command.id);
  };
  edit.forEach(visit);
  return managed.size ? touched.filter(instance => !managed.has(instance.id)) : touched;
}

/** A template that went out of date stays as it was; the editor or an agent re-applies it in the template editor. */
export interface TemplateNeedsReapply {
  instanceId: string;
  title: string;
  /** Why it could not follow, in plain words (片段太短…, 這個模板或字型的版本已經更新…). */
  reason: string;
}

export interface TemplateFollowOutcome {
  /** The whole gesture as one flat command list: commit it as one batch for one Undo. */
  commands: EditorCommand[];
  /** Templates laid out again on the edited clip, or re-recorded at the place a move or ripple carried them to. */
  followed: ReferenceMotionTemplateInstance[];
  /** Templates that could not follow: the edit still happens and they stay as they were (on a moved clip, they move along). */
  needsReapply: TemplateNeedsReapply[];
}

/** Which piece keeps the template when its main clip is cut at `at` (the rule is spelled out on splitTemplatePiece). */
function splitPieceOf(project: EditProject, instance: ReferenceMotionTemplateInstance, clipId: string, at: number): SplitTemplatePiece {
  const fps = fpsOf(project), clip = findTimelineClip(project, clipId);
  if (!clip) return "first";
  const start = frameOf(clip.timelineStart, fps), total = durationFramesOf(clip.duration, fps);
  const first = frameOf(at, fps) - start, second = total - first;
  const startFrames = Math.ceil(referenceMotionTemplate(instance.input.templateId).minSeconds * fps);
  if (first >= startFrames) return "first";
  return second > first ? "second" : "first";
}

const flatCommands = (commands: readonly EditorCommand[]): EditorCommand[] =>
  commands.flatMap(command => command.type === "batch" ? flatCommands(command.commands) : [command]);

/**
 * How the edit carries this template. A split of its main clip lifts the template off the whole clip (both pieces are
 * the user's own clip again) and gives it to the piece splitTemplatePiece names; when one batch cuts it several times,
 * it ends on the piece the last of those cuts leaves it on. Any other edit keeps it on its own main clip.
 */
function followOptionsFor(project: EditProject, edit: readonly EditorCommand[], instance: ReferenceMotionTemplateInstance): ReferenceMotionTemplateFollowOptions | undefined {
  const commands = flatCommands(edit);
  if (!commands.some(command => command.type === "split_clip")) return undefined;
  let working = project, primaryId = instance.input.clipId, split = false;
  for (const command of commands) {
    if (command.type === "split_clip" && command.clipId === primaryId) {
      split = true;
      if (splitPieceOf(working, instance, primaryId, command.at) === "second") primaryId = command.newClipId;
    }
    working = applyCommand(working, command);
  }
  return split ? { liftWholeClip: true, ...(primaryId !== instance.input.clipId ? { retargetTo: primaryId } : {}) } : undefined;
}

/** Without a glyph source (a preview or a test) a template can still be carried along by a move, never laid out again. */
const WITHOUT_GLYPHS: ReferenceMotionTemplateRebuildDependencies = {
  prepareText: () => Promise.reject(new ReferenceMotionRebuildRefusal(TEMPLATE_REBUILD_OTHER)),
};

/**
 * THE way a clip edit and its saved title templates become one command — the editor's gestures (trim, extension, move,
 * split, new in-point, ripple delete) and an agent's apply_edit_commands (trim_clip_start/end, move_clip, split_clip,
 * extend_clip, slip_clip, ripple_delete_clip, compact_track…) all come through here.
 *
 * Every template `edit` changes follows it in the same command, in timeline order, each on the graph the ones before it
 * left: carried along and re-recorded where the edit only moved it by whole frames, otherwise laid out again on its
 * edited main clip by the real compiler (a split per followOptionsFor). A template that cannot follow (too short for its
 * words, edited by hand, its recipe or font updated, no glyph source) stays as it was — on a clip that only moved, its
 * layers still move along — and is reported in `needsReapply` with its plain reason; the edit itself still happens.
 * When `templates.signal` is aborted (the project changed under an editor gesture), it stops and throws.
 */
export async function followTemplatesThroughEdit(project: EditProject, edit: readonly EditorCommand[], templates?: ReferenceMotionTemplateRebuildDependencies,
  changed = templatesChangedBy(project, edit)): Promise<TemplateFollowOutcome> {
  let commands = [...edit];
  const followed: ReferenceMotionTemplateInstance[] = [], needsReapply: TemplateNeedsReapply[] = [];
  for (const instance of [...changed].sort((a, b) => a.input.startFrame - b.input.startFrame)) {
    // Each template is a long piece of work: let the editor paint its hint and take input in between.
    await yieldToBrowser();
    try {
      commands = (await prepareReferenceMotionTemplateFollow(project, instance.id, commands, templates ?? WITHOUT_GLYPHS, followOptionsFor(project, edit, instance))).commands;
      followed.push(instance);
    } catch (error) {
      if (templates?.signal?.aborted) throw error;
      needsReapply.push({ instanceId: instance.id, title: instance.input.title, reason: plainReferenceMotionRebuildReason(error) });
      const carry = referenceMotionTemplateCarryCommands(project, applyCommand(project, { type: "batch", commands }), instance);
      if (carry.length) {
        try { validated(project, { type: "batch", commands: [...commands, ...carry] }); commands = [...commands, ...carry]; }
        catch { /* It stays exactly where it was. */ }
      }
    }
  }
  return { commands, followed, needsReapply };
}

/** The template on this clip, the one a gesture's message is about (a clip carries at most one that can follow). */
function ownTemplate(project: EditProject, clipId: string): ReferenceMotionTemplateInstance | undefined {
  const own = (project.referenceMotionInstances ?? []).filter(instance => instance.input.clipId === clipId);
  return own.length === 1 ? own[0] : undefined;
}

/** What the templates did, after `done` (what happened to the clip); it always names the single Undo. */
export function templateEditMessage(done: string, outcome: Pick<TemplateFollowOutcome, "needsReapply">, followedWords = "標題模板也照新的長度重新排好"): string {
  const stale = outcome.needsReapply[0];
  if (!stale) return `${done}，${followedWords}；一次復原即可還原。`;
  return isTemplateRebuildTooShort(stale.reason)
    ? `${done}；片段太短，標題模板「${stale.title}」放不下文字，沒有跟著改。把片段拉長後，可以在模板編輯器重新套用；一次復原即可還原。`
    : `${done}；標題模板「${stale.title}」沒有跟著改，打開模板編輯器可以看原因並重新套用；一次復原即可還原。`;
}

/**
 * Trim a clip that carries a saved title template. Titles lined up with the trimmed edge follow as in
 * planClipTrimWithAttachments, and the template is laid out again on the trimmed clip in the same command, so it stays
 * editable. When it cannot be (the clip became too short for its words, for example), the trim still happens, the
 * template stays as it was, and the message says why and where to re-apply it. Without a template on the clip this is
 * planClipTrimWithAttachments.
 */
export async function planClipTrimWithTemplates(project: EditProject, clipId: string, edge: ClipEdge, trimSeconds: number,
  templates: ReferenceMotionTemplateRebuildDependencies): Promise<MotionEditPlan | undefined> {
  const fps = fpsOf(project);
  const clip = findTimelineClip(project, clipId);
  if (!clip) throw new EditGraphError("找不到這個片段，請重新選取。");
  if (!clipHasTemplate(project, clipId)) return planClipTrimWithAttachments(project, clipId, edge, trimSeconds);
  const frames = Math.round(trimSeconds * fps);
  if (frames < 1) return undefined;
  const titles = planClipTrimWithAttachments(project, clipId, edge, trimSeconds);
  const edit = flatten(titles?.command ?? buildClipTrimCommand(clip, edge, trimSeconds));
  validated(project, { type: "batch", commands: edit });
  const outcome = await followTemplatesThroughEdit(project, edit, templates);
  return { command: { type: "batch", commands: outcome.commands },
    message: templateEditMessage(`已修剪片段${edge === "start" ? "開頭" : "結尾"} ${seconds(frames, fps)} 秒`, outcome) };
}

/**
 * Extend a clip: titles follow as in planClipExtensionWithAttachments, and every saved title template the extension
 * changes follows in the same command — the clip's own template is laid out again on the longer clip, and a template
 * further on that the extension pushes later moves with the content it sits on (a ripple insert). Without a template
 * involved this is planClipExtensionWithAttachments.
 */
export async function planClipExtensionWithTemplates(project: EditProject, clipId: string, edge: ClipEdge, extendSeconds: number,
  templates: ReferenceMotionTemplateRebuildDependencies): Promise<MotionEditPlan | undefined> {
  const fps = fpsOf(project);
  if (!findTimelineClip(project, clipId)) throw new EditGraphError("找不到這個片段，請重新選取。");
  const frames = Math.round(extendSeconds * fps);
  const titles = planClipExtensionWithAttachments(project, clipId, edge, extendSeconds);
  const edit = flatten(titles?.command ?? { type: "extend_clip", clipId, edge, seconds: frames / fps });
  const changed = templatesChangedBy(project, edit);
  if (!changed.length) return titles;
  const own = ownTemplate(project, clipId), push = planClipExtension(project, clipId, edge, frames).pushSeconds > 0;
  const outcome = await followTemplatesThroughEdit(project, edit, templates, changed);
  const done = `已把片段${edge === "start" ? "開頭" : "結尾"}延長 ${seconds(frames, fps)} 秒${push ? "，後面的內容一起往後移" : ""}`;
  return { command: { type: "batch", commands: outcome.commands },
    message: templateEditMessage(done, outcome, own ? "標題模板也照新的長度重新排好" : "標題模板也跟著移好") };
}

/**
 * The Inspector's in or out point at the playhead (a trim that keeps the clip's start where it is): a title template on
 * the clip is laid out again on the trimmed clip in the same command. Undefined when no template sits on the clip, so
 * the caller keeps its ordinary command.
 */
export async function planPlayheadTrimWithTemplates(project: EditProject, clipId: string, edge: ClipEdge, trimSeconds: number,
  templates: ReferenceMotionTemplateRebuildDependencies): Promise<MotionEditPlan | undefined> {
  const fps = fpsOf(project);
  if (!findTimelineClip(project, clipId)) throw new EditGraphError("找不到這個片段，請重新選取。");
  if (!clipHasTemplate(project, clipId)) return undefined;
  const edit: EditorCommand[] = [edge === "start" ? { type: "trim_clip_start", clipId, seconds: trimSeconds } : { type: "trim_clip_end", clipId, seconds: trimSeconds }];
  validated(project, { type: "batch", commands: edit });
  const outcome = await followTemplatesThroughEdit(project, edit, templates);
  return { command: { type: "batch", commands: outcome.commands },
    message: templateEditMessage(`已修剪片段${edge === "start" ? "開頭" : "結尾"} ${seconds(Math.round(trimSeconds * fps), fps)} 秒`, outcome) };
}

/** Which piece of a split clip keeps its title template. */
export type SplitTemplatePiece = "first" | "second";

/**
 * Which piece of a split clip keeps its saved title template — the rule, in one place:
 *  - A template spans its whole main clip and needs at least its minimum reading time from its first frame: that span is
 *    the template's start.
 *  - When the cut leaves the template's start whole on the first piece, only the first piece still covers it: the
 *    first piece keeps the template, so a title stays where it began (cutting off a tail or a middle part never moves it).
 *  - When the cut falls inside the template's start, both pieces cover part of it: the longer piece keeps the template
 *    (cutting off a few seconds of head gives it to the rest of the clip); on a tie, the first piece keeps it.
 * The piece that does not keep it becomes a plain clip, as the main clip was before the template was applied.
 */
export function splitTemplatePiece(project: EditProject, clipId: string, at: number): SplitTemplatePiece | undefined {
  const instance = ownTemplate(project, clipId);
  return instance && findTimelineClip(project, clipId) ? splitPieceOf(project, instance, clipId, at) : undefined;
}

/**
 * Split a clip at `at` (timeline seconds). When the clip carries a saved title template, the template follows the piece
 * splitTemplatePiece names (followTemplatesThroughEdit, the same path as an agent's split_clip): it is lifted off the whole
 * clip, the clip is split plain, and the template is laid out again on its piece in the same command (one Undo). When
 * that piece is too short for the template's words, the split still happens and the template stays as it was, with the
 * reason. Undefined when no template is involved, so the caller runs the editor's own split.
 */
export async function planClipSplitWithTemplates(project: EditProject, clipId: string, at: number, newClipId: string,
  templates: ReferenceMotionTemplateRebuildDependencies): Promise<(MotionEditPlan & { keptBy?: SplitTemplatePiece }) | undefined> {
  if (!findTimelineClip(project, clipId)) throw new EditGraphError("找不到這個片段，請重新選取。");
  const split: EditorCommand = { type: "split_clip", clipId, at, newClipId };
  const changed = templatesChangedBy(project, [split]);
  if (!changed.length) return undefined;
  const own = ownTemplate(project, clipId), keptBy = splitTemplatePiece(project, clipId, at);
  const outcome = await followTemplatesThroughEdit(project, [split], templates, changed);
  const kept = own && outcome.followed.includes(own) ? keptBy : undefined;
  const followedWords = kept === "second" ? "標題模板移到後一段，照新的長度重新排好" : kept === "first" ? "標題模板留在前一段，照新的長度重新排好" : undefined;
  return { command: { type: "batch", commands: outcome.commands }, keptBy: kept,
    message: templateEditMessage(`已在 ${at.toFixed(2)} 秒切開片段`, outcome, followedWords) };
}

/**
 * Delete a clip and close the gap (ripple, planRippleDelete). Saved title templates further on that the ripple carries
 * earlier move with their clips and stay editable, in the same command; a template on the deleted clip goes with it.
 * Undefined when no template has to follow, so the caller runs the plain ripple delete with its own status line.
 */
export async function planRippleDeleteWithTemplates(project: EditProject, clipId: string,
  templates: ReferenceMotionTemplateRebuildDependencies): Promise<MotionEditPlan | undefined> {
  if (!findTimelineClip(project, clipId)) throw new EditGraphError("找不到這個片段，請重新選取。");
  const ripple = planRippleDelete(project, [clipId]);
  const edit = flatten(ripple.command);
  const changed = templatesChangedBy(project, edit);
  if (!changed.length) return undefined;
  const outcome = await followTemplatesThroughEdit(project, edit, templates, changed);
  // What did not move (another track kept its place) is said before the template's own words.
  const message = !ripple.note || outcome.needsReapply.length ? templateEditMessage(ripple.done, outcome, "後面的標題模板也跟著移好")
    : rippleMessage(`${ripple.done}，後面的標題模板也跟著移好`, ripple.note);
  return { command: { type: "batch", commands: outcome.commands }, message };
}

/**
 * A new in-point for a clip (slip): the clip keeps its place and length and shows other moments of its media. A saved
 * title template on it is laid out again on the clip as it now plays (its generated copies follow the new in-point), in
 * the same command. Undefined when no template is involved, so the caller runs the editor's own slip.
 */
export async function planClipSlipWithTemplates(project: EditProject, clipId: string, sourceStart: number,
  templates: ReferenceMotionTemplateRebuildDependencies): Promise<MotionEditPlan | undefined> {
  if (!findTimelineClip(project, clipId)) throw new EditGraphError("找不到這個片段，請重新選取。");
  const command: EditorCommand = { type: "slip_clip", clipId, sourceStart };
  const changed = templatesChangedBy(project, [command]);
  if (!changed.length) return undefined;
  const outcome = await followTemplatesThroughEdit(project, [command], templates, changed);
  return { command: { type: "batch", commands: outcome.commands },
    message: templateEditMessage(`已換入點：素材改從 ${formatEditSeconds(sourceStart)} 秒開始，片段位置和長度不變`, outcome, "標題模板也照新的畫面重新排好") };
}

/**
 * Any batch of edit commands (an agent's apply_edit_commands): every saved title template they change follows in the
 * same batch through followTemplatesThroughEdit, exactly as the editor's gestures do; a template that cannot follow is
 * listed in needsReapply with its plain reason. Undefined when no template is involved.
 */
export async function planEditCommandsWithTemplates(project: EditProject, commands: readonly EditorCommand[],
  templates: ReferenceMotionTemplateRebuildDependencies): Promise<{ command: EditorCommand; followed: Array<{ instanceId: string; title: string }>;
    needsReapply: TemplateNeedsReapply[] } | undefined> {
  const edit = [...commands], changed = templatesChangedBy(project, edit);
  if (!changed.length) return undefined;
  const outcome = await followTemplatesThroughEdit(project, edit, templates, changed);
  return { command: { type: "batch", commands: outcome.commands },
    followed: outcome.followed.map(instance => ({ instanceId: instance.id, title: instance.input.title })), needsReapply: outcome.needsReapply };
}

/** Drag a template block: its main clip moves, and the template with it. */
export async function planTemplateMove(project: EditProject, instanceId: string, deltaFrames: number,
  makeId: TimelinePlacementIdFactory, templates?: ReferenceMotionTemplateRebuildDependencies): Promise<MotionEditPlan> {
  const fps = fpsOf(project);
  const instance = project.referenceMotionInstances?.find(item => item.id === instanceId);
  if (!instance) throw new EditGraphError("找不到這個標題模板，請重新選取。");
  const clip = findTimelineClip(project, instance.input.clipId);
  if (!clip) throw new EditGraphError("找不到這個模板的主片段，無法移動。");
  if (deltaFrames === 0) throw new EditGraphError(NOTHING_CHANGED);
  const startFrame = frameOf(clip.timelineStart, fps) + deltaFrames;
  if (startFrame < 0) throw new EditGraphError("模板不能移到 0 秒以前。");
  const plan = await planClipMoveWithAttachments(project, clip.id, clip.trackId, startFrame / fps, makeId, templates);
  if (!plan) throw new EditGraphError("這次調整沒有套用。");
  const note = plan.needsReapply ? "；標題模板要重新套用後才能改字" : "";
  return { command: plan.command, message: `已把標題模板「${instance.input.title}」和主片段一起移到 ${seconds(startFrame, fps)} 秒${note}；一次復原即可還原。` };
}

/** Which graphics visually follow a clip during a drag preview (template graphics included). */
export function graphicIdsFollowingClip(project: EditProject, clipId: string): string[] {
  const attached = clipAttachments(project, clipId);
  return [...attached.instances.flatMap(instance => instance.roles.filter(role => role.kind === "graphic").map(role => role.id)),
    ...attached.graphics.map(graphic => graphic.id)];
}
