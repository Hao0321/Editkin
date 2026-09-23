import {
  alignTime,
  animatedClipState,
  cloneProject,
  EditGraphError,
  findCaption,
  findAsset,
  findClip,
  findTrack,
  validateProject,
} from "./editGraph";
import { DEFAULT_CAPTION_STYLE, DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_PARTICLE_SIMULATION, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, DEFAULT_TRANSFORM_3D, type ClipCreativeState, type EditComposition, type EditProject, type TimelineClip } from "./types";
import { assertHaoExpression } from "./expression";
import { applySmartCutToClip } from "./smartCut";
import { sliceClipVisuals } from "./clipSlicing";
import { applyFastCommand } from "./fastCommands";
import type { EditorCommand } from "./commandTypes";

export function applyTimelineCommand(project: EditProject, command: EditorCommand): boolean {
  switch (command.type) {
    case "import_asset": {
      if (project.assets.some((asset) => asset.id === command.asset.id)) {
        throw new EditGraphError(`素材 id 已存在：${command.asset.id}`);
      }
      project.assets.push({ ...command.asset });
      break;
    }
    case "delete_asset": {
      findAsset(project, command.assetId);
      if (project.tracks.some((track) => track.clips.some((clip) => clip.assetId === command.assetId))) {
        throw new EditGraphError("刪除素材前必須先移除使用中的片段");
      }
      project.assets = project.assets.filter((asset) => asset.id !== command.assetId);
      break;
    }
    case "add_clip": {
      findAsset(project, command.clip.assetId);
      const track = findTrack(project, command.clip.trackId);
      track.clips.push({ ...command.clip, layer: { ...DEFAULT_CLIP_LAYER, ...command.clip.layer }, expressions: { ...command.clip.expressions } });
      track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
      break;
    }
    case "add_track": {
      if (project.tracks.some((track) => track.id === command.track.id)) throw new EditGraphError(`軌道 id 已存在：${command.track.id}`);
      project.tracks.push(structuredClone(command.track));
      break;
    }
    case "precompose_clips": {
      const name = command.name.trim();
      if (!name || name.length > 80) throw new EditGraphError("預合成名稱必須是 1–80 個字");
      if (project.compositions.some((composition) => composition.id === command.compositionId)) throw new EditGraphError(`預合成 id 已存在：${command.compositionId}`);
      if (project.assets.some((asset) => asset.id === command.assetId)) throw new EditGraphError(`素材 id 已存在：${command.assetId}`);
      if (project.tracks.some((track) => track.clips.some((clip) => clip.id === command.replacementClipId))) throw new EditGraphError(`片段 id 已存在：${command.replacementClipId}`);
      const targetTrack = findTrack(project, command.targetTrackId);
      if (targetTrack.kind !== "video" || targetTrack.locked) throw new EditGraphError("預合成必須放在未鎖定的畫面軌");
      const uniqueIds = [...new Set(command.clipIds)];
      if (uniqueIds.length !== command.clipIds.length || uniqueIds.length === 0) throw new EditGraphError("預合成片段不可空白或重複");
      const selected = uniqueIds.map((clipId) => findClip(project, clipId));
      const selectedIds = new Set(uniqueIds);
      for (const clip of selected) {
        const sourceTrack = findTrack(project, clip.trackId);
        if (sourceTrack.locked) throw new EditGraphError(`片段 ${clip.id} 位於鎖定軌道`);
        const parentId = clip.layer?.parentClipId;
        const matteId = clip.layer?.trackMatte?.sourceClipId;
        if ((parentId && !selectedIds.has(parentId)) || (matteId && !selectedIds.has(matteId))) {
          throw new EditGraphError(`片段 ${clip.id} 的 parent／matte 必須一起放入預合成`);
        }
      }
      for (const clip of project.tracks.flatMap((track) => track.clips).filter((candidate) => !selectedIds.has(candidate.id))) {
        if ((clip.layer?.parentClipId && selectedIds.has(clip.layer.parentClipId))
          || (clip.layer?.trackMatte?.sourceClipId && selectedIds.has(clip.layer.trackMatte.sourceClipId))) {
          throw new EditGraphError(`片段 ${clip.id} 仍依賴要移入預合成的片段`);
        }
      }
      const movedTrackIds = new Set(project.motionTracks.filter((track) => selectedIds.has(track.clipId)).map((track) => track.id));
      const movedMotionGraphics = project.motionGraphics.filter((graphic) => graphic.trackId && movedTrackIds.has(graphic.trackId));
      const start = Math.min(...selected.map((clip) => clip.timelineStart));
      const end = Math.max(
        ...selected.map((clip) => clip.timelineStart + clip.duration),
        ...movedMotionGraphics.map((graphic) => graphic.timelineStart + graphic.duration),
      );
      const duration = alignTime(end - start, project.fps);
      const now = new Date().toISOString();
      const composition: EditComposition = {
        schema: "editkin.composition/v1",
        id: command.compositionId,
        name,
        width: project.width,
        height: project.height,
        fps: project.fps,
        duration,
        tracks: project.tracks.flatMap((track) => {
          const clips = track.clips.filter((clip) => selectedIds.has(clip.id)).map((clip) => ({
            ...structuredClone(clip),
            timelineStart: alignTime(clip.timelineStart - start, project.fps),
          }));
          return clips.length ? [{ ...structuredClone(track), clips }] : [];
        }),
        captions: [],
        captionStyle: structuredClone(project.captionStyle ?? DEFAULT_CAPTION_STYLE),
        motionTracks: project.motionTracks.filter((track) => selectedIds.has(track.clipId)).map((track) => structuredClone(track)),
        motionGraphics: movedMotionGraphics.map((graphic) => ({ ...structuredClone(graphic), timelineStart: alignTime(graphic.timelineStart - start, project.fps) })),
        director: { schema: "editkin.director-console/v1", reviewState: "draft", markers: [], updatedAt: now },
        colorManagement: structuredClone(project.colorManagement),
        updatedAt: now,
      };
      project.compositions.push(composition);
      project.assets.push({
        id: command.assetId, name, kind: "video", uri: `editkin-composition://${command.compositionId}`, duration,
        width: project.width, height: project.height, role: "precomposition", provenance: "Editkin nested composition", redistributable: true,
        compositionId: command.compositionId,
      });
      for (const track of project.tracks) track.clips = track.clips.filter((clip) => !selectedIds.has(clip.id));
      project.motionTracks = project.motionTracks.filter((track) => !selectedIds.has(track.clipId));
      project.motionGraphics = project.motionGraphics.filter((graphic) => !graphic.trackId || !movedTrackIds.has(graphic.trackId));
      targetTrack.clips.push({
        id: command.replacementClipId, assetId: command.assetId, trackId: targetTrack.id, timelineStart: alignTime(start, project.fps), sourceStart: 0, duration, volume: 1,
        transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
      });
      targetTrack.clips.sort((left, right) => left.timelineStart - right.timelineStart);
      break;
    }
    case "delete_track": {
      const track = findTrack(project, command.trackId);
      if (track.kind === "caption" || track.id === "video-main" || track.id === "audio-main") throw new EditGraphError("主軌與字幕軌不能刪除");
      if (track.clips.length > 0) throw new EditGraphError("刪除軌道前必須先清空片段");
      project.tracks = project.tracks.filter((item) => item.id !== command.trackId);
      break;
    }
    case "rename_track": {
      const track = findTrack(project, command.trackId);
      const name = command.name.trim();
      if (!name || name.length > 40) throw new EditGraphError("軌道名稱必須是 1–40 個字");
      track.name = name;
      break;
    }
    case "toggle_track_lock": {
      const track = findTrack(project, command.trackId);
      track.locked = !track.locked;
      break;
    }
    case "toggle_track_mute": {
      const track = findTrack(project, command.trackId);
      track.muted = !track.muted;
      break;
    }
    case "split_clip": {
      const clip = findClip(project, command.clipId);
      const track = findTrack(project, clip.trackId);
      const splitAt = alignTime(command.at, project.fps);
      const clipEnd = clip.timelineStart + clip.duration;
      if (splitAt <= clip.timelineStart || splitAt >= clipEnd) {
        throw new EditGraphError("分割位置必須位於片段內部");
      }
      if (project.tracks.some((item) => item.clips.some((candidate) => candidate.id === command.newClipId))) {
        throw new EditGraphError(`新片段 id 已存在：${command.newClipId}`);
      }
      const leftDuration = alignTime(splitAt - clip.timelineStart, project.fps);
      const rightDuration = alignTime(clip.duration - leftDuration, project.fps);
      const [leftMasks, rightMasks] = sliceClipVisuals(project, clip, [
        { clipId: clip.id, start: 0, end: leftDuration },
        { clipId: command.newClipId, start: leftDuration, end: clip.duration },
      ]);
      const splitState = animatedClipState(clip, leftDuration);
      const originalKeyframes = structuredClone(clip.keyframes);
      const originalCreative = structuredClone(clip.creative);
      clip.duration = leftDuration;
      clip.masks = leftMasks;
      if (clip.creative?.transitionOut) delete clip.creative.transitionOut;
      const leftKeyframes = originalKeyframes.filter((keyframe) => keyframe.time <= leftDuration)
        .map((keyframe) => ({ ...keyframe, transform: { ...keyframe.transform }, color: { ...keyframe.color } }));
      if (originalKeyframes.some((keyframe) => keyframe.time > leftDuration)
        && !leftKeyframes.some((keyframe) => Math.abs(keyframe.time - leftDuration) <= 1e-6)) {
        leftKeyframes.push({
          id: `${clip.id}-split-boundary-${command.newClipId}`,
          time: leftDuration,
          transform: splitState.transform,
          color: splitState.color,
          easing: "linear",
        });
      }
      clip.keyframes = leftKeyframes;
      const right: TimelineClip = {
        ...clip,
        id: command.newClipId,
        timelineStart: splitAt,
        sourceStart: alignTime(clip.sourceStart + leftDuration, project.fps),
        duration: rightDuration,
        masks: rightMasks,
        transform: splitState.transform,
        color: splitState.color,
        creative: originalCreative ? {
          ...originalCreative,
          effectPresetIds: [...originalCreative.effectPresetIds],
          transitionIn: undefined,
          transitionOut: originalCreative.transitionOut ? { ...originalCreative.transitionOut } : undefined,
        } : undefined,
        keyframes: originalKeyframes.filter((keyframe) => keyframe.time > leftDuration)
          .map((keyframe) => ({ ...keyframe, id: `${command.newClipId}-${keyframe.id}`, time: alignTime(keyframe.time - leftDuration, project.fps), transform: { ...keyframe.transform }, color: { ...keyframe.color } })),
      };
      track.clips.push(right);
      track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
      break;
    }
    case "delete_clip": {
      const clip = findClip(project, command.clipId);
      const track = findTrack(project, clip.trackId);
      track.clips = track.clips.filter((item) => item.id !== clip.id);
      for (const candidate of project.tracks.flatMap((item) => item.clips)) {
        if (candidate.layer?.parentClipId === clip.id) candidate.layer.parentClipId = undefined;
        if (candidate.layer?.trackMatte?.sourceClipId === clip.id) candidate.layer.trackMatte = undefined;
      }
      break;
    }
    case "ripple_delete_clip": {
      const clip = findClip(project, command.clipId);
      const sourceTrack = findTrack(project, clip.trackId);
      if (sourceTrack.locked) throw new EditGraphError("鎖定的軌道不能刪除片段");
      const rippleStart = alignTime(clip.timelineStart + clip.duration, project.fps);
      const rippleDuration = clip.duration;
      sourceTrack.clips = sourceTrack.clips.filter((item) => item.id !== clip.id);
      for (const candidate of project.tracks.flatMap((item) => item.clips)) {
        if (candidate.layer?.parentClipId === clip.id) candidate.layer.parentClipId = undefined;
        if (candidate.layer?.trackMatte?.sourceClipId === clip.id) candidate.layer.trackMatte = undefined;
      }
      const affectedTracks = sourceTrack.id === "video-main"
        ? project.tracks.filter((track) => !track.locked && track.kind !== "caption")
        : [sourceTrack];
      for (const track of affectedTracks) {
        for (const item of track.clips) {
          if (item.timelineStart + 1e-6 >= rippleStart) {
            item.timelineStart = alignTime(Math.max(0, item.timelineStart - rippleDuration), project.fps);
          }
        }
        track.clips.sort((left, right) => left.timelineStart - right.timelineStart);
      }
      if (sourceTrack.id === "video-main") {
        for (const caption of project.captions) {
          if (caption.start + 1e-6 >= rippleStart) caption.start = alignTime(Math.max(0, caption.start - rippleDuration), project.fps);
        }
        for (const graphic of project.motionGraphics) {
          if (graphic.timelineStart + 1e-6 >= rippleStart) graphic.timelineStart = alignTime(Math.max(0, graphic.timelineStart - rippleDuration), project.fps);
        }
        for (const marker of project.director.markers) {
          if (marker.time + 1e-6 >= rippleStart) marker.time = alignTime(Math.max(0, marker.time - rippleDuration), project.fps);
        }
      }
      break;
    }
    case "move_clip": {
      const clip = findClip(project, command.clipId);
      clip.timelineStart = alignTime(command.timelineStart, project.fps);
      if (clip.timelineStart < 0) throw new EditGraphError("片段不能移到 0 秒以前");
      findTrack(project, clip.trackId).clips.sort((a, b) => a.timelineStart - b.timelineStart);
      break;
    }
    case "move_clip_to_track": {
      const clip = findClip(project, command.clipId);
      const source = findTrack(project, clip.trackId);
      const target = findTrack(project, command.trackId);
      if (source.kind !== target.kind) throw new EditGraphError("片段只能移動到相同類型的軌道");
      source.clips = source.clips.filter((item) => item.id !== clip.id);
      clip.trackId = target.id;
      clip.timelineStart = alignTime(command.timelineStart, project.fps);
      target.clips.push(clip);
      target.clips.sort((a, b) => a.timelineStart - b.timelineStart);
      break;
    }
    case "trim_clip_start": {
      const clip = findClip(project, command.clipId);
      const seconds = alignTime(command.seconds, project.fps);
      if (seconds <= 0 || seconds >= clip.duration) {
        throw new EditGraphError("裁掉長度必須大於 0 且小於片段時長");
      }
      const trimState = animatedClipState(clip, seconds);
      const [masks] = sliceClipVisuals(project, clip, [{ clipId: clip.id, start: seconds, end: clip.duration }]);
      clip.masks = masks;
      clip.sourceStart = alignTime(clip.sourceStart + seconds, project.fps);
      clip.duration = alignTime(clip.duration - seconds, project.fps);
      if (clip.creative?.transitionIn && clip.creative.transitionIn.duration > clip.duration) clip.creative.transitionIn.duration = clip.duration;
      if (clip.creative?.transitionOut && clip.creative.transitionOut.duration > clip.duration) clip.creative.transitionOut.duration = clip.duration;
      clip.transform = trimState.transform;
      clip.color = trimState.color;
      clip.keyframes = clip.keyframes.filter((keyframe) => keyframe.time > seconds)
        .map((keyframe) => ({ ...keyframe, time: alignTime(keyframe.time - seconds, project.fps), transform: { ...keyframe.transform }, color: { ...keyframe.color } }));
      break;
    }
    case "trim_clip_end": {
      const clip = findClip(project, command.clipId);
      const seconds = alignTime(command.seconds, project.fps);
      if (seconds <= 0 || seconds >= clip.duration) {
        throw new EditGraphError("裁掉長度必須大於 0 且小於片段時長");
      }
      const [masks] = sliceClipVisuals(project, clip, [{ clipId: clip.id, start: 0, end: clip.duration - seconds }]);
      clip.masks = masks;
      clip.duration = alignTime(clip.duration - seconds, project.fps);
      if (clip.creative?.transitionIn && clip.creative.transitionIn.duration > clip.duration) clip.creative.transitionIn.duration = clip.duration;
      if (clip.creative?.transitionOut && clip.creative.transitionOut.duration > clip.duration) clip.creative.transitionOut.duration = clip.duration;
      clip.keyframes = clip.keyframes.filter((keyframe) => keyframe.time <= clip.duration);
      break;
    }
    case "set_clip_volume": {
      const clip = findClip(project, command.clipId);
      clip.volume = command.volume;
      break;
    }
    case "compact_track": {
      const track = findTrack(project, command.trackId);
      let cursor = 0;
      for (const clip of [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart)) {
        clip.timelineStart = alignTime(cursor, project.fps);
        cursor += clip.duration;
      }
      track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
      break;
    }
    default:
      return false;
  }
  return true;
}
