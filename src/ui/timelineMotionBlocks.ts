import type { EditProject, MotionGraphic } from "../domain/types";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import { isNativeReferenceMotionPresentation, referenceMotionTemplate } from "../motion/referenceMotionTemplates";
import { boundClipForGraphic, findTimelineClip, sceneGraphicOwners, templateGraphicOwners } from "../application/timelineMotionEdits";

/**
 * The 標題與圖卡 lane: every title, graphic and template on the timeline as one block.
 *
 * A Reference Motion template is ONE block (all its graphics move as the template); an original Motion scene is one
 * read-only block; every other graphic is its own block. Each block follows a main clip (主片段): a template its own
 * source clip, a tracked label the clip it tracks, any other graphic the 主畫面 clip under its first frame.
 * Ownership is never inferred from text or IDs; refusals carry the plain reason shown to the creator.
 */

export type TimelineMotionBlockKind = "template" | "scene" | "graphic";
export type TimelineMotionPermission = { allowed: true } | { allowed: false; reason: string };

export interface TimelineMotionBlock {
  /** "template:<instance>", "scene:<scene>" or "graphic:<graphic>". */
  id: string;
  kind: TimelineMotionBlockKind;
  /** The words a creator recognises: the title or the graphic's own text. */
  label: string;
  /** What kind of block this is, in plain words (a fixed, translatable label). */
  detail: string;
  /** A template's recipe name, shown after the kind. */
  recipeName?: string;
  /** A label that follows a tracked subject: it stays inside the tracked clip. */
  tracked: boolean;
  /** Seconds on the project frame grid. */
  start: number;
  duration: number;
  startFrame: number;
  endFrame: number;
  /** Every graphic drawn by this block. */
  graphicIds: string[];
  instanceId?: string;
  sceneId?: string;
  graphicId?: string;
  /** The clip this block follows when that clip moves. */
  boundClipId?: string;
  /** A template whose range no longer matches its main clip (it needs to be applied again). */
  stale: boolean;
  /** Stacking row inside the lane (overlapping blocks get their own row). */
  row: number;
  move: TimelineMotionPermission;
  trim: TimelineMotionPermission;
  remove: TimelineMotionPermission;
}

export const MOTION_LANE_ROW_PITCH = 46;
export const MOTION_LANE_PADDING = 3;

export const TEMPLATE_TRIM_REFUSAL = "標題模板的長度跟著主片段；要改長度，請修剪下面的主片段。";
export const TEMPLATE_DELETE_REFUSAL = "標題模板要在模板編輯器裡按「解除模板連結」，才能刪掉個別圖卡。";
export const TEMPLATE_PAINT_REFUSAL = "這個模板用原生繪製，不能直接拖動；請先在模板編輯器解除模板連結。";
export const TEMPLATE_MISSING_CLIP_REFUSAL = "找不到這個模板的主片段，無法移動。";
export const TEMPLATE_LOCKED_REFUSAL = "主片段所在的軌道已鎖定；請先解除鎖定。";
export const SCENE_REFUSAL = "這段原創動態場景要在「原創場景」編輯器裡修改，不能直接拖動或刪除。";

function laneFps(project: Pick<EditProject, "fps">): number {
  return Number.isFinite(project.fps) && project.fps > 0 && project.fps <= 240 ? project.fps : 30;
}

const frameOf = (seconds: number, fps: number) => Math.round(Math.max(0, seconds) * fps);
const lengthOf = (seconds: number, fps: number) => Math.max(1, Math.round(seconds * fps));

function graphicLabel(graphic: MotionGraphic): string {
  const text = graphic.text.replace(/\s+/g, " ").trim();
  return text || graphic.name.trim() || graphic.id;
}

function graphicDetail(graphic: MotionGraphic): string {
  if (graphic.trackId) return "追蹤標籤";
  if (graphic.templateOwner) return "成片模板圖卡";
  if (graphic.vectorV2 && !graphic.text.trim()) return "圖形";
  return ({ title: "標題", card: "重點卡", tag: "標籤", counter: "數字" } as const)[graphic.kind] ?? "圖卡";
}

function instanceRange(project: EditProject, instance: ReferenceMotionTemplateInstance, fps: number) {
  const ranges: Array<[number, number]> = [];
  const main = findTimelineClip(project, instance.input.clipId);
  if (main) ranges.push([frameOf(main.timelineStart, fps), frameOf(main.timelineStart, fps) + lengthOf(main.duration, fps)]);
  for (const role of instance.roles) {
    if (role.kind === "graphic") {
      const graphic = project.motionGraphics.find(item => item.id === role.id);
      if (graphic) ranges.push([frameOf(graphic.timelineStart, fps), frameOf(graphic.timelineStart, fps) + lengthOf(graphic.duration, fps)]);
    } else if (role.kind === "clip" && role.id !== instance.input.clipId) {
      const clip = findTimelineClip(project, role.id);
      if (clip) ranges.push([frameOf(clip.timelineStart, fps), frameOf(clip.timelineStart, fps) + lengthOf(clip.duration, fps)]);
    }
  }
  if (!ranges.length) ranges.push([instance.input.startFrame, instance.input.startFrame + instance.input.durationFrames]);
  return { start: Math.min(...ranges.map(range => range[0])), end: Math.max(...ranges.map(range => range[1])), main };
}

const KIND_ORDER = { template: 0, scene: 1, graphic: 2 } as const;

function assignRows(blocks: TimelineMotionBlock[]): TimelineMotionBlock[] {
  const rowEnds: number[] = [];
  const order = [...blocks].sort((left, right) => left.startFrame - right.startFrame || right.endFrame - left.endFrame
    || KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || left.id.localeCompare(right.id));
  for (const block of order) {
    let row = rowEnds.findIndex(end => end <= block.startFrame);
    if (row < 0) { row = rowEnds.length; rowEnds.push(block.endFrame); } else rowEnds[row] = block.endFrame;
    block.row = row;
  }
  return order;
}

/** Every block of the lane, in drawing order, each with its row. */
export function timelineMotionBlocks(project: EditProject): TimelineMotionBlock[] {
  const fps = laneFps(project);
  const blocks: TimelineMotionBlock[] = [];
  const templateOwners = templateGraphicOwners(project), sceneOwners = sceneGraphicOwners(project);
  const lockedTracks = new Set(project.tracks.filter(track => track.locked).map(track => track.id));
  for (const instance of project.referenceMotionInstances ?? []) {
    const range = instanceRange(project, instance, fps), main = range.main;
    const mainStart = main ? frameOf(main.timelineStart, fps) : -1, mainEnd = main ? mainStart + lengthOf(main.duration, fps) : -1;
    const stale = !main || instance.input.startFrame !== mainStart || instance.input.startFrame + instance.input.durationFrames !== mainEnd
      || range.start !== mainStart || range.end !== mainEnd;
    const graphicIds = instance.roles.filter(role => role.kind === "graphic" && project.motionGraphics.some(graphic => graphic.id === role.id)).map(role => role.id);
    const move: TimelineMotionPermission = !main ? { allowed: false, reason: TEMPLATE_MISSING_CLIP_REFUSAL }
      : lockedTracks.has(main.trackId) ? { allowed: false, reason: TEMPLATE_LOCKED_REFUSAL }
        : isNativeReferenceMotionPresentation(instance.input.graphicPresentation) ? { allowed: false, reason: TEMPLATE_PAINT_REFUSAL }
          : { allowed: true };
    let recipeName = "";
    try { recipeName = referenceMotionTemplate(instance.input.templateId)?.name ?? ""; } catch { /* An unknown saved recipe still shows its title. */ }
    blocks.push({ id: `template:${instance.id}`, kind: "template", label: instance.input.title, detail: "標題模板", ...(recipeName ? { recipeName } : {}), tracked: false,
      start: range.start / fps, duration: (range.end - range.start) / fps, startFrame: range.start, endFrame: range.end, graphicIds,
      instanceId: instance.id, boundClipId: main?.id, stale, row: 0, move,
      trim: { allowed: false, reason: TEMPLATE_TRIM_REFUSAL }, remove: { allowed: false, reason: TEMPLATE_DELETE_REFUSAL } });
  }
  for (const scene of project.motionScenes ?? []) {
    const first = scene.graphicIds.map(id => project.motionGraphics.find(graphic => graphic.id === id)).find((graphic): graphic is MotionGraphic => Boolean(graphic));
    blocks.push({ id: `scene:${scene.id}`, kind: "scene", label: first ? graphicLabel(first) : "原創動態場景", detail: "原創動態場景", tracked: false,
      start: scene.startFrame / fps, duration: scene.durationFrames / fps, startFrame: scene.startFrame, endFrame: scene.startFrame + scene.durationFrames,
      graphicIds: [...scene.graphicIds], sceneId: scene.id, stale: false, row: 0,
      move: { allowed: false, reason: SCENE_REFUSAL }, trim: { allowed: false, reason: SCENE_REFUSAL }, remove: { allowed: false, reason: SCENE_REFUSAL } });
  }
  for (const graphic of project.motionGraphics) {
    if (templateOwners.has(graphic.id) || sceneOwners.has(graphic.id)) continue;
    const startFrame = frameOf(graphic.timelineStart, fps), endFrame = startFrame + lengthOf(graphic.duration, fps);
    let bound: string | undefined;
    try { bound = boundClipForGraphic(project, graphic)?.id; } catch { bound = undefined; }
    blocks.push({ id: `graphic:${graphic.id}`, kind: "graphic", label: graphicLabel(graphic), detail: graphicDetail(graphic), tracked: Boolean(graphic.trackId),
      start: startFrame / fps, duration: (endFrame - startFrame) / fps, startFrame, endFrame, graphicIds: [graphic.id], graphicId: graphic.id,
      boundClipId: bound, stale: false, row: 0, move: { allowed: true }, trim: { allowed: true }, remove: { allowed: true } });
  }
  return assignRows(blocks);
}

export function motionLaneRowCount(blocks: readonly TimelineMotionBlock[]): number {
  return Math.max(1, ...blocks.map(block => block.row + 1));
}

export function motionLaneHeight(blocks: readonly TimelineMotionBlock[]): number {
  return motionLaneRowCount(blocks) * MOTION_LANE_ROW_PITCH + 2 * MOTION_LANE_PADDING;
}

/**
 * Simple mode, overlapping titles: one-line blocks (the words, then the kind) on 30 px rows instead of two-line blocks
 * on 46 px rows. Two compact rows (62 px) leave the ruler and the whole 主畫面 track in view in a 1280×720 window.
 */
export const MOTION_LANE_COMPACT_ROW_PITCH = 30;
export const MOTION_LANE_COMPACT_BLOCK_HEIGHT = 26;
/** Compact rows shown at once; blocks below them open from the lane's 「還有 N 個」 button. */
export const MOTION_LANE_COMPACT_VISIBLE_ROWS = 2;

export interface MotionLaneLayout {
  /** One-line blocks on the compact pitch. */
  compact: boolean;
  pitch: number;
  /** Rows the blocks need. */
  rows: number;
  /** Rows drawn now; blocks in later rows wait behind the 「還有 N 個」 button. */
  visibleRows: number;
  /** Blocks not drawn now. */
  hidden: number;
  /** More rows than the compact lane shows at once (the lane has its 「還有 N 個」／「收起」 button). */
  overflow: boolean;
  /** Lane height in px. */
  height: number;
}

/**
 * How the 標題與圖卡 lane is drawn. Advanced mode and a single row keep the two-line blocks; simple mode with
 * overlapping titles uses compact rows, at most two unless the creator opened the rest (`expanded`).
 */
export function motionLaneLayout(blocks: readonly TimelineMotionBlock[], options: { simple: boolean; expanded?: boolean }): MotionLaneLayout {
  const rows = motionLaneRowCount(blocks);
  const compact = options.simple && rows > 1;
  if (!compact) return { compact, pitch: MOTION_LANE_ROW_PITCH, rows, visibleRows: rows, hidden: 0, overflow: false, height: motionLaneHeight(blocks) };
  const overflow = rows > MOTION_LANE_COMPACT_VISIBLE_ROWS;
  const visibleRows = overflow && !options.expanded ? MOTION_LANE_COMPACT_VISIBLE_ROWS : rows;
  return { compact, pitch: MOTION_LANE_COMPACT_ROW_PITCH, rows, visibleRows, hidden: blocks.filter(block => block.row >= visibleRows).length, overflow,
    height: visibleRows * MOTION_LANE_COMPACT_ROW_PITCH - (MOTION_LANE_COMPACT_ROW_PITCH - MOTION_LANE_COMPACT_BLOCK_HEIGHT) + 2 * MOTION_LANE_PADDING };
}

/** The top of a block in `row`, in px from the top of the lane. */
export function motionBlockTop(layout: Pick<MotionLaneLayout, "pitch">, row: number): number {
  return MOTION_LANE_PADDING + row * layout.pitch;
}

/** Blocks that follow `clipId` when it moves (its templates, tracked labels and connected titles). */
export function motionBlocksBoundToClip(blocks: readonly TimelineMotionBlock[], clipId: string): TimelineMotionBlock[] {
  return blocks.filter(block => block.boundClipId === clipId && block.kind !== "scene");
}

/** Seconds as creators read them: "3.50". */
export function formatMotionSeconds(seconds: number): string {
  return (Math.abs(seconds) < 0.005 ? 0 : seconds).toFixed(2);
}

/** Saved templates whose main clip is `clipId`. */
export function templateInstancesForClip(project: EditProject, clipId: string | undefined): ReferenceMotionTemplateInstance[] {
  if (!clipId) return [];
  return (project.referenceMotionInstances ?? []).filter(instance => instance.input.clipId === clipId);
}

/** The asset name of a clip, for plain readouts instead of IDs. */
export function clipDisplayName(project: EditProject, clipId: string | undefined): string | undefined {
  const clip = findTimelineClip(project, clipId);
  return clip ? project.assets.find(asset => asset.id === clip.assetId)?.name : undefined;
}
