import type { EditorCommand } from "./commandTypes";
import { alignTime, animatedClipState, EditGraphError, validateClipForTrack, validateMediaAsset } from "./editGraph";
import { DEFAULT_CLIP_LAYER, type EditProject, type MediaAsset, type TimelineClip, type TimelineTrack } from "./types";

const EPSILON = 1e-6;

interface ClipLocation {
  trackIndex: number;
  clipIndex: number;
  track: TimelineTrack;
  clip: TimelineClip;
}

function locateClip(project: EditProject, clipId: string): ClipLocation {
  for (let trackIndex = 0; trackIndex < project.tracks.length; trackIndex += 1) {
    const track = project.tracks[trackIndex];
    const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
    if (clipIndex >= 0) return { trackIndex, clipIndex, track, clip: track.clips[clipIndex] };
  }
  throw new EditGraphError(`找不到片段：${clipId}`);
}

function touched(input: EditProject): EditProject {
  const previous = Date.parse(input.updatedAt);
  return {
    ...input,
    updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString(),
  };
}

function replaceClip(input: EditProject, location: ClipLocation, clip: TimelineClip): EditProject {
  const clips = [...location.track.clips];
  clips[location.clipIndex] = clip;
  const track = { ...location.track, clips };
  const tracks = [...input.tracks];
  tracks[location.trackIndex] = track;
  return { ...touched(input), tracks };
}

function cloneClip(clip: TimelineClip): TimelineClip {
  return {
    ...clip,
    transform: { ...clip.transform },
    color: { ...clip.color },
    creative: clip.creative ? {
      ...clip.creative,
      effectPresetIds: [...clip.creative.effectPresetIds],
      nativeEffectInstances: clip.creative.nativeEffectInstances?.map((instance) => ({ ...instance, parameters: { ...instance.parameters } })),
      transitionIn: clip.creative.transitionIn ? { ...clip.creative.transitionIn } : undefined,
      transitionOut: clip.creative.transitionOut ? { ...clip.creative.transitionOut } : undefined,
    } : undefined,
    layout: clip.layout ? { crop: { ...clip.layout.crop }, viewport: { ...clip.layout.viewport } } : undefined,
    layer: clip.layer ? { ...clip.layer, trackMatte: clip.layer.trackMatte ? { ...clip.layer.trackMatte } : undefined } : undefined,
    expressions: clip.expressions ? { ...clip.expressions } : undefined,
    keyframes: clip.keyframes.map((keyframe) => ({ ...keyframe, transform: { ...keyframe.transform }, color: { ...keyframe.color } })),
  };
}

function validateTrackOrder(track: TimelineTrack): void {
  for (let index = 0; index < track.clips.length; index += 1) {
    const clip = track.clips[index];
    const previous = track.clips[index - 1];
    const next = track.clips[index + 1];
    if (previous && previous.timelineStart + previous.duration > clip.timelineStart + EPSILON) {
      throw new EditGraphError(`軌道 ${track.name} 的片段重疊：${previous.id} / ${clip.id}`);
    }
    if (clip.creative?.transitionIn && (!previous || Math.abs(previous.timelineStart + previous.duration - clip.timelineStart) > EPSILON)) {
      throw new EditGraphError(`片段 ${clip.id} 的入場轉場需要前方相鄰片段`);
    }
    if (clip.creative?.transitionOut && (!next || Math.abs(clip.timelineStart + clip.duration - next.timelineStart) > EPSILON)) {
      throw new EditGraphError(`片段 ${clip.id} 的離場轉場需要後方相鄰片段`);
    }
  }
}

function clearBrokenTransitions(clips: TimelineClip[]): TimelineClip[] {
  let output = clips;
  for (let index = 0; index < clips.length; index += 1) {
    const clip = output[index];
    if (!clip.creative) continue;
    const previous = output[index - 1];
    const next = output[index + 1];
    const clearIn = Boolean(clip.creative.transitionIn && (!previous || Math.abs(previous.timelineStart + previous.duration - clip.timelineStart) > EPSILON));
    const clearOut = Boolean(clip.creative.transitionOut && (!next || Math.abs(clip.timelineStart + clip.duration - next.timelineStart) > EPSILON));
    if (!clearIn && !clearOut) continue;
    if (output === clips) output = [...clips];
    const creative = {
      ...clip.creative,
      effectPresetIds: [...clip.creative.effectPresetIds],
      nativeEffectInstances: clip.creative.nativeEffectInstances?.map((instance) => ({ ...instance, parameters: { ...instance.parameters } })),
    };
    if (clearIn) delete creative.transitionIn;
    if (clearOut) delete creative.transitionOut;
    output[index] = { ...clip, creative };
  }
  return output;
}

function insertionIndex(clips: TimelineClip[], start: number): number {
  let low = 0;
  let high = clips.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (clips[middle].timelineStart < start) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isIndependentClip(clip: TimelineClip, allowLayout = false): boolean {
  const layer = { ...DEFAULT_CLIP_LAYER, ...clip.layer };
  return [clip.timelineStart, clip.sourceStart, clip.duration, clip.volume].every(Number.isFinite)
    && Array.isArray(clip.keyframes)
    && clip.keyframes.length === 0
    && clip.transform3d === undefined
    && clip.creative === undefined
    && (allowLayout || clip.layout === undefined)
    && clip.masks === undefined
    && clip.chromaKey === undefined
    && clip.expressions !== null
    && typeof (clip.expressions ?? {}) === "object"
    && !Array.isArray(clip.expressions)
    && Object.keys(clip.expressions ?? {}).length === 0
    && layer.enabled
    && layer.blendMode === "normal"
    && (layer.role ?? "content") === "content"
    && layer.parentClipId === undefined
    && layer.trackMatte === undefined;
}

function isOrdinaryImportedAsset(asset: MediaAsset): boolean {
  return typeof asset.id === "string"
    && typeof asset.name === "string"
    && typeof asset.uri === "string"
    && ["video", "audio", "image"].includes(asset.kind)
    && Number.isFinite(asset.duration)
    && asset.duration > 0
    && (asset.width === undefined || Number.isFinite(asset.width) && asset.width > 0)
    && (asset.height === undefined || Number.isFinite(asset.height) && asset.height > 0)
    && asset.compositionId === undefined
    && asset.imageSequence === undefined;
}

function applyFastAddClip(input: EditProject, command: Extract<EditorCommand, { type: "add_clip" }>): EditProject | undefined {
  const source = command.clip;
  // 2.5D has a whole-scene plane-count/transform contract. Rich clips can also
  // introduce graph references, so both deliberately stay on full validation.
  if (input.scene25d?.enabled || !isIndependentClip(source)) return undefined;
  if (!input.assets.some((asset) => asset.id === source.assetId)) throw new EditGraphError(`找不到素材：${source.assetId}`);
  const trackIndex = input.tracks.findIndex((track) => track.id === source.trackId);
  if (trackIndex < 0) throw new EditGraphError(`找不到軌道：${source.trackId}`);
  if (input.tracks.some((track) => track.clips.some((clip) => clip.id === source.id))) throw new EditGraphError(`重複片段 id：${source.id}`);
  const clip: TimelineClip = {
    ...source,
    transform: { ...source.transform },
    color: { ...source.color },
    keyframes: [],
    layer: { ...DEFAULT_CLIP_LAYER, ...source.layer },
    expressions: { ...source.expressions },
  };
  const previousTrack = input.tracks[trackIndex];
  const clips = [...previousTrack.clips];
  clips.splice(insertionIndex(clips, clip.timelineStart), 0, clip);
  const track = { ...previousTrack, clips: clearBrokenTransitions(clips) };
  validateTrackOrder(track);
  const tracks = [...input.tracks];
  tracks[trackIndex] = track;
  const project = { ...touched(input), tracks };
  validateClipForTrack(project, track, clip);
  return project;
}

function projectWithImportedAsset(input: EditProject, asset: MediaAsset): EditProject | undefined {
  if (!isOrdinaryImportedAsset(asset)) return undefined;
  if (input.assets.some((candidate) => candidate.id === asset.id)) throw new EditGraphError(`素材 id 已存在：${asset.id}`);
  validateMediaAsset(input, asset);
  return { ...input, assets: [...input.assets, structuredClone(asset)] };
}

function applyFastImportAndAddClip(
  input: EditProject,
  assetCommand: Extract<EditorCommand, { type: "import_asset" }>,
  clipCommand: Extract<EditorCommand, { type: "add_clip" }>,
  resolutionCommand?: Extract<EditorCommand, { type: "set_project_resolution" }>,
): EditProject | undefined {
  const source = clipCommand.clip;
  if (source.assetId !== assetCommand.asset.id || !isIndependentClip(source) || input.scene25d?.enabled) return undefined;
  if (resolutionCommand) {
    if (!Number.isInteger(resolutionCommand.width) || !Number.isInteger(resolutionCommand.height)
      || resolutionCommand.width <= 0 || resolutionCommand.height <= 0
      // Height changes rescale every graphic. Keep that richer mutation on the
      // existing whole-project path rather than partially reproducing it here.
      || input.motionGraphics.length > 0) return undefined;
  }
  const resized = resolutionCommand
    ? { ...input, width: resolutionCommand.width, height: resolutionCommand.height }
    : input;
  const imported = projectWithImportedAsset(resized, assetCommand.asset);
  return imported ? applyFastAddClip(imported, clipCommand) : undefined;
}

function applyFastPictureInPictureTrack(
  input: EditProject,
  trackCommand: Extract<EditorCommand, { type: "add_track" }>,
  clipCommand: Extract<EditorCommand, { type: "add_clip" }>,
): EditProject | undefined {
  const sourceTrack = trackCommand.track;
  const sourceClip = clipCommand.clip;
  // This route is intentionally the exact UI PIP shape: one empty, unlocked
  // video track plus one independent layout clip. Rich layer graphs, masks,
  // effects, transitions, 2.5D, or pre-populated tracks use full validation.
  if (input.scene25d?.enabled || sourceTrack.kind !== "video" || sourceTrack.locked || sourceTrack.muted
    || !sourceTrack.id.trim() || !sourceTrack.name.trim() || sourceTrack.clips.length !== 0
    || sourceClip.trackId !== sourceTrack.id || sourceClip.layout === undefined
    || !isIndependentClip(sourceClip, true)) return undefined;
  if (input.tracks.some((track) => track.id === sourceTrack.id)) throw new EditGraphError(`軌道 id 已存在：${sourceTrack.id}`);
  if (input.tracks.some((track) => track.clips.some((clip) => clip.id === sourceClip.id))) throw new EditGraphError(`重複片段 id：${sourceClip.id}`);
  const clip = cloneClip(sourceClip);
  clip.layer = { ...DEFAULT_CLIP_LAYER, ...clip.layer };
  clip.expressions = { ...clip.expressions };
  const track: TimelineTrack = { ...sourceTrack, clips: [clip] };
  validateTrackOrder(track);
  const project = { ...touched(input), tracks: [...input.tracks, track] };
  validateClipForTrack(project, track, clip);
  return project;
}

function applyFastImportedPictureInPicture(
  input: EditProject,
  assetCommand: Extract<EditorCommand, { type: "import_asset" }>,
  trackCommand: Extract<EditorCommand, { type: "add_track" }>,
  clipCommand: Extract<EditorCommand, { type: "add_clip" }>,
): EditProject | undefined {
  if (clipCommand.clip.assetId !== assetCommand.asset.id) return undefined;
  const imported = projectWithImportedAsset(input, assetCommand.asset);
  return imported ? applyFastPictureInPictureTrack(imported, trackCommand, clipCommand) : undefined;
}

function applyFastClipProperty(input: EditProject, command: EditorCommand): EditProject | undefined {
  if (!["set_clip_volume", "update_clip_transform", "set_clip_color", "add_keyframe", "update_keyframe", "delete_keyframe"].includes(command.type)) return undefined;
  const location = locateClip(input, "clipId" in command ? command.clipId : "");
  const clip = cloneClip(location.clip);
  if (command.type === "set_clip_volume") clip.volume = command.volume;
  if (command.type === "update_clip_transform") clip.transform = { ...clip.transform, ...command.patch };
  if (command.type === "set_clip_color") clip.color = { ...clip.color, ...command.patch };
  if (command.type === "add_keyframe") {
    if (clip.keyframes.some((keyframe) => keyframe.id === command.keyframe.id)) throw new EditGraphError(`關鍵幀 id 已存在：${command.keyframe.id}`);
    clip.keyframes.push(structuredClone(command.keyframe));
    clip.keyframes.sort((left, right) => left.time - right.time);
  }
  if (command.type === "update_keyframe") {
    const keyframe = clip.keyframes.find((item) => item.id === command.keyframeId);
    if (!keyframe) throw new EditGraphError(`找不到關鍵幀：${command.keyframeId}`);
    if (command.patch.time !== undefined) keyframe.time = alignTime(command.patch.time, input.fps);
    if (command.patch.transform !== undefined) keyframe.transform = { ...command.patch.transform };
    if (command.patch.color !== undefined) keyframe.color = { ...command.patch.color };
    if (command.patch.easing !== undefined) keyframe.easing = command.patch.easing;
    clip.keyframes.sort((left, right) => left.time - right.time);
  }
  if (command.type === "delete_keyframe") {
    if (!clip.keyframes.some((item) => item.id === command.keyframeId)) throw new EditGraphError(`找不到關鍵幀：${command.keyframeId}`);
    clip.keyframes = clip.keyframes.filter((item) => item.id !== command.keyframeId);
  }
  const project = replaceClip(input, location, clip);
  validateClipForTrack(project, project.tracks[location.trackIndex], clip);
  return project;
}

function applyFastMove(input: EditProject, command: Extract<EditorCommand, { type: "move_clip" }>): EditProject {
  const location = locateClip(input, command.clipId);
  const clip = cloneClip(location.clip);
  clip.timelineStart = alignTime(command.timelineStart, input.fps);
  if (clip.timelineStart < 0) throw new EditGraphError("片段不能移到 0 秒以前");
  const clips = [...location.track.clips];
  clips.splice(location.clipIndex, 1);
  clips.splice(insertionIndex(clips, clip.timelineStart), 0, clip);
  const normalized = clearBrokenTransitions(clips);
  const track = { ...location.track, clips: normalized };
  validateTrackOrder(track);
  const tracks = [...input.tracks];
  tracks[location.trackIndex] = track;
  const project = { ...touched(input), tracks };
  validateClipForTrack(project, track, clip);
  return project;
}

function applyFastTrim(input: EditProject, command: Extract<EditorCommand, { type: "trim_clip_start" | "trim_clip_end" }>): EditProject {
  const location = locateClip(input, command.clipId);
  const clip = cloneClip(location.clip);
  const seconds = alignTime(command.seconds, input.fps);
  if (seconds <= 0 || seconds >= clip.duration) throw new EditGraphError("裁掉長度必須大於 0 且小於片段時長");
  if (command.type === "trim_clip_start") {
    const trimState = animatedClipState(clip, seconds);
    clip.sourceStart = alignTime(clip.sourceStart + seconds, input.fps);
    clip.duration = alignTime(clip.duration - seconds, input.fps);
    clip.transform = trimState.transform;
    clip.color = trimState.color;
    clip.keyframes = clip.keyframes.filter((keyframe) => keyframe.time > seconds)
      .map((keyframe) => ({ ...keyframe, time: alignTime(keyframe.time - seconds, input.fps) }));
  } else {
    clip.duration = alignTime(clip.duration - seconds, input.fps);
    clip.keyframes = clip.keyframes.filter((keyframe) => keyframe.time <= clip.duration);
  }
  if (clip.creative?.transitionIn && clip.creative.transitionIn.duration > clip.duration) clip.creative.transitionIn.duration = clip.duration;
  if (clip.creative?.transitionOut && clip.creative.transitionOut.duration > clip.duration) clip.creative.transitionOut.duration = clip.duration;
  let project = replaceClip(input, location, clip);
  const track = { ...project.tracks[location.trackIndex], clips: clearBrokenTransitions(project.tracks[location.trackIndex].clips) };
  validateTrackOrder(track);
  const tracks = [...project.tracks];
  tracks[location.trackIndex] = track;
  const motionTracks = project.motionTracks.map((motion) => motion.clipId === clip.id ? {
    ...motion,
    points: motion.points.filter((point) => point.time <= clip.duration + EPSILON),
  } : motion).map((motion) => ({ ...motion, lostRatio: motion.points.filter((point) => point.status === "lost").length / Math.max(1, motion.points.length) }));
  project = { ...project, tracks, motionTracks };
  validateClipForTrack(project, track, clip);
  return project;
}

export function applyFastCommand(input: EditProject, command: EditorCommand): EditProject | undefined {
  if (command.type === "add_clip") return applyFastAddClip(input, command);
  if (command.type === "batch") {
    const children = command.commands;
    if (children.length === 1 && children[0]?.type === "add_clip") return applyFastAddClip(input, children[0]);
    if (children.length === 2 && children[0]?.type === "import_asset" && children[1]?.type === "add_clip") {
      return applyFastImportAndAddClip(input, children[0], children[1]);
    }
    if (children.length === 3 && children[0]?.type === "set_project_resolution"
      && children[1]?.type === "import_asset" && children[2]?.type === "add_clip") {
      return applyFastImportAndAddClip(input, children[1], children[2], children[0]);
    }
    if (children.length === 2 && children[0]?.type === "add_track" && children[1]?.type === "add_clip") {
      return applyFastPictureInPictureTrack(input, children[0], children[1]);
    }
    if (children.length === 3 && children[0]?.type === "import_asset"
      && children[1]?.type === "add_track" && children[2]?.type === "add_clip") {
      return applyFastImportedPictureInPicture(input, children[0], children[1], children[2]);
    }
  }
  const clipProperty = applyFastClipProperty(input, command);
  if (clipProperty) return clipProperty;
  if (command.type === "move_clip") return applyFastMove(input, command);
  if (command.type === "trim_clip_start" || command.type === "trim_clip_end") {
    const clip = locateClip(input, command.clipId).clip;
    // Temporal mask/track edits require the shared slice plan and whole-graph
    // validation. Keep the low-allocation path only for independent clips.
    if (clip.masks?.length || input.motionTracks.some((track) => track.clipId === clip.id)) return undefined;
    return applyFastTrim(input, command);
  }
  return undefined;
}
