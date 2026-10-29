import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { EditGraphError } from "../domain/editGraphError";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import type { CaptionCue, ClipMask, EditProject, TimelineClip } from "../domain/types";
import type { TimelineSelection } from "./timelineSelection";
import { expandLinkedClipIds, unusedLinkGroupId } from "../domain/clipLinks";

export const CLIPBOARD_EMPTY = "請先選取要複製的片段或字幕。";
export const CLIPBOARD_OTHER_PROJECT = "剪貼簿的來源軌道或素材不在這個專案，請重新複製。";
export const CLIPBOARD_TEMPLATE_NOTE = "標題模板沒有一起複製。";
export const CLIPBOARD_DEPENDENCY = "這段片段依賴其他片段或追蹤遮罩，請一起選取相關片段，或先解除連結再複製。";

/** A value snapshot, never live references. The editor keeps it only for the current project session. */
export interface TimelineClipboard {
  projectId: string;
  fps: number;
  clips: TimelineClip[];
  captions: CaptionCue[];
  primaryClipId?: string;
  primaryCaptionId?: string;
  origin: number;
  end: number;
  templatesSkipped: boolean;
}

/** Copy the selected source clips and text, excluding a title template's generated layers and saved recipe. */
export function copyTimelineSelection(project: EditProject, selection: TimelineSelection): TimelineClipboard {
  const chosen = new Set(expandLinkedClipIds(project, selection.clipIds)), captionIds = new Set(selection.captionIds);
  const generated = new Set((project.referenceMotionInstances ?? []).flatMap(instance => instance.roles
    .filter(role => role.kind === "clip" && role.id !== instance.input.clipId).map(role => role.id)));
  const clips = project.tracks.flatMap(track => track.clips).filter(clip => chosen.has(clip.id) && !generated.has(clip.id))
    .map(clip => sourceClipWithoutTemplate(project, clip));
  const captions = project.captions.filter(caption => captionIds.has(caption.id)).map(caption => {
    const copy = structuredClone(caption); delete copy.templateOwner; return copy;
  });
  if (!clips.length && !captions.length) throw new EditGraphError(CLIPBOARD_EMPTY);
  const times = [...clips.map(clip => ({ start: clip.timelineStart, end: clip.timelineStart + clip.duration })),
    ...captions.map(caption => ({ start: caption.start, end: caption.start + caption.duration }))];
  return { projectId: project.id, fps: project.fps, clips, captions,
    primaryClipId: clips.some(clip => clip.id === selection.primaryClipId) ? selection.primaryClipId : undefined,
    primaryCaptionId: captions.some(caption => caption.id === selection.primaryCaptionId) ? selection.primaryCaptionId : undefined,
    origin: Math.min(...times.map(item => item.start)), end: Math.max(...times.map(item => item.end)),
    templatesSkipped: (project.referenceMotionInstances ?? []).some(instance => chosen.has(instance.input.clipId)
      || instance.roles.some(role => role.kind === "clip" && chosen.has(role.id))) };
}

function sourceClipWithoutTemplate(project: EditProject, clip: TimelineClip): TimelineClip {
  const copy = structuredClone(clip);
  for (const instance of project.referenceMotionInstances ?? []) {
    if (instance.input.clipId !== clip.id) continue;
    const owned = new Set(instance.roles.map(role => role.id));
    copy.keyframes = copy.keyframes.filter(keyframe => !owned.has(keyframe.id));
    if (copy.masks) copy.masks = copy.masks.filter(mask => !owned.has(mask.id));
    if (!instance.roles.some(role => role.kind === "clip" && role.id === clip.id)) continue;
    if (instance.primaryBefore.layout) copy.layout = structuredClone(instance.primaryBefore.layout); else delete copy.layout;
    if (instance.primaryBefore.transform) copy.transform = structuredClone(instance.primaryBefore.transform);
    if (instance.primaryBefore.creative !== undefined) {
      if (instance.primaryBefore.creative) copy.creative = structuredClone(instance.primaryBefore.creative); else delete copy.creative;
    }
    if (instance.input.templateId === "comparison_pair" && instance.input.mediaPresentation === "source_soft_v2") delete copy.floatingFrame;
  }
  // A transition belongs to an adjacent pair; the copy has different neighbours.
  if (copy.creative) { delete copy.creative.transitionIn; delete copy.creative.transitionOut; }
  return copy;
}

export interface TimelinePastePlan {
  command: EditorCommand;
  selection: TimelineSelection;
  start: number;
  moved: boolean;
  templatesSkipped: boolean;
}

/** Paste the whole relative arrangement at the first free frame on its original tracks. Never overwrite. */
export function planTimelinePaste(project: EditProject, clipboard: TimelineClipboard, requestedStart: number,
  makeId: (prefix: string) => string): TimelinePastePlan {
  if (!clipboard.clips.length && !clipboard.captions.length) throw new EditGraphError(CLIPBOARD_EMPTY);
  if (clipboard.projectId !== project.id || clipboard.fps !== project.fps) throw new EditGraphError(CLIPBOARD_OTHER_PROJECT);
  if (!Number.isFinite(requestedStart) || requestedStart < 0) throw new EditGraphError("貼上的時間不合法。");
  for (const clip of clipboard.clips) {
    const track = project.tracks.find(item => item.id === clip.trackId);
    if (!track || !project.assets.some(asset => asset.id === clip.assetId)) throw new EditGraphError(CLIPBOARD_OTHER_PROJECT);
    if (track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  }
  if (clipboard.captions.length && captionTrackLocked(project)) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  const selected = new Set(clipboard.clips.map(clip => clip.id));
  for (const clip of clipboard.clips) {
    if ((clip.layer?.parentClipId && !selected.has(clip.layer.parentClipId))
      || (clip.layer?.trackMatte && !selected.has(clip.layer.trackMatte.sourceClipId))
      || clip.masks?.some(mask => mask.trackId)) throw new EditGraphError(CLIPBOARD_DEPENDENCY);
  }
  const start = firstFreeFrame(project, clipboard, requestedStart);
  const newClipIds = new Map(clipboard.clips.map(clip => [clip.id, makeId("clip")]));
  const newCaptionIds = new Map(clipboard.captions.map(caption => [caption.id, makeId("caption")]));
  const newGroups = new Map<string, string>();
  for (const clip of clipboard.clips) if (clip.linkGroupId && !newGroups.has(clip.linkGroupId)) {
    let id = unusedLinkGroupId(project, makeId("clip-link"));
    const base = id;
    for (let suffix = 1; [...newGroups.values()].includes(id); suffix++) id = unusedLinkGroupId(project, `${base}-${suffix}`);
    newGroups.set(clip.linkGroupId, id);
  }
  const captions = clipboard.captions.map(caption => ({ ...structuredClone(caption), id: newCaptionIds.get(caption.id)!,
    start: start + caption.start - clipboard.origin }));
  const clips = clipboard.clips.map(clip => {
    const copy = structuredClone(clip);
    copy.id = newClipIds.get(clip.id)!;
    if (copy.linkGroupId) copy.linkGroupId = newGroups.get(copy.linkGroupId)!;
    copy.timelineStart = start + clip.timelineStart - clipboard.origin;
    copy.keyframes = copy.keyframes.map(keyframe => ({ ...keyframe, id: makeId("keyframe") }));
    if (copy.masks) copy.masks = copy.masks.map(mask => remapMaskIds(mask, makeId));
    if (copy.creative?.nativeEffectInstances) copy.creative.nativeEffectInstances = copy.creative.nativeEffectInstances
      .map(effect => ({ ...effect, id: makeId("effect") }));
    if (copy.layer?.parentClipId) copy.layer.parentClipId = newClipIds.get(copy.layer.parentClipId)!;
    if (copy.layer?.trackMatte) copy.layer.trackMatte.sourceClipId = newClipIds.get(copy.layer.trackMatte.sourceClipId)!;
    return copy;
  });
  const commands: EditorCommand[] = [...clips.map(clip => ({ type: "add_clip" as const, clip })),
    ...captions.map(caption => ({ type: "add_caption" as const, caption }))];
  const command: EditorCommand = { type: "batch", commands };
  applyCommand(project, command);
  const clipIds = clips.map(clip => clip.id), captionIds = captions.map(caption => caption.id);
  const primaryClipId = clipboard.primaryClipId ? newClipIds.get(clipboard.primaryClipId) : undefined;
  const primaryCaptionId = clipboard.primaryCaptionId ? newCaptionIds.get(clipboard.primaryCaptionId) : undefined;
  return { command, selection: { clipIds, captionIds,
    ...(primaryClipId ? { primaryClipId } : primaryCaptionId ? { primaryCaptionId }
      : clipIds.length ? { primaryClipId: clipIds[0] } : { primaryCaptionId: captionIds[0] }) },
    start, moved: Math.round(start * project.fps) !== Math.round(requestedStart * project.fps), templatesSkipped: clipboard.templatesSkipped };
}

/** The same control point across mask keyframes keeps its correspondence, with a new identity on the copy. */
function remapMaskIds(mask: ClipMask, makeId: (prefix: string) => string): ClipMask {
  const pointIds = new Map<string, string>();
  const pointId = (oldId: string) => {
    if (!pointIds.has(oldId)) pointIds.set(oldId, makeId("mask-point"));
    return pointIds.get(oldId)!;
  };
  return { ...mask, id: makeId("mask"),
    path: mask.path.map(point => ({ ...point, id: pointId(point.id) })),
    keyframes: mask.keyframes.map(keyframe => ({ ...keyframe,
      points: keyframe.points.map(point => ({ ...point, id: pointId(point.id) })) })),
    ...(mask.rotoCorrections ? { rotoCorrections: mask.rotoCorrections.map(stroke => ({ ...stroke, id: makeId("roto-stroke") })) } : {}),
  };
}

function firstFreeFrame(project: EditProject, clipboard: TimelineClipboard, requestedStart: number): number {
  const frame = (time: number) => Math.round(time * project.fps);
  const origin = frame(clipboard.origin);
  const candidates = [...clipboard.clips.map(clip => ({ offset: frame(clip.timelineStart) - origin, duration: frame(clip.duration),
    occupied: project.tracks.find(track => track.id === clip.trackId)!.clips.map(other => ({ start: frame(other.timelineStart), end: frame(other.timelineStart + other.duration) })) })),
  ...clipboard.captions.map(caption => ({ offset: frame(caption.start) - origin, duration: frame(caption.duration),
    occupied: project.captions.map(other => ({ start: frame(other.start), end: frame(other.start + other.duration) })) }))];
  let at = frame(requestedStart);
  const bound = candidates.reduce((count, item) => count + item.occupied.length, 0) + 1;
  for (let pass = 0; pass <= bound; pass += 1) {
    let next = at;
    for (const item of candidates) for (const other of item.occupied) {
      if (at + item.offset < other.end && at + item.offset + item.duration > other.start) next = Math.max(next, other.end - item.offset);
    }
    if (next === at) return at / project.fps;
    at = next;
  }
  throw new EditGraphError("找不到可以貼上的空位，請把播放頭移到片段後面再試。");
}
