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
import { applyFastCommand } from "./fastCommands";
import type { EditorCommand } from "./commandTypes";
export type { EditorCommand } from "./commandTypes";
import { applyTimelineCommand } from "./timelineCommands";
import { reconcileAestheticReview } from "./aestheticReview";
import type { AestheticArtifactBinding } from "./types";
import { clearTemplateApplicationInPlace } from "./templateApplication";

/** Application-owned context, never an editable command payload or review field. */
export interface EditorCommandContext {
  currentAestheticArtifact?: (project: EditProject) => AestheticArtifactBinding | undefined;
}

function touch(project: EditProject): void {
  const previous = Date.parse(project.updatedAt);
  project.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}

function normalizeCreativeTransitions(project: EditProject): void {
  const tolerance = 0.5 / project.fps;
  for (const track of project.tracks) {
    const clips = [...track.clips].sort((left, right) => left.timelineStart - right.timelineStart);
    clips.forEach((clip, index) => {
      if (!clip.creative) return;
      const previous = clips[index - 1];
      const next = clips[index + 1];
      if (clip.creative.transitionIn && (!previous || Math.abs(previous.timelineStart + previous.duration - clip.timelineStart) > tolerance)) {
        delete clip.creative.transitionIn;
      }
      if (clip.creative.transitionOut && (!next || Math.abs(clip.timelineStart + clip.duration - next.timelineStart) > tolerance)) {
        delete clip.creative.transitionOut;
      }
      if (clip.creative.transitionIn) clip.creative.transitionIn.duration = Math.min(clip.creative.transitionIn.duration, clip.duration);
      if (clip.creative.transitionOut) clip.creative.transitionOut.duration = Math.min(clip.creative.transitionOut.duration, clip.duration);
    });
  }
}

function normalizeMotionReferences(project: EditProject): void {
  const clips = new Map(project.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
  project.motionTracks = project.motionTracks.filter((track) => clips.has(track.clipId)).map((track) => {
    const duration = clips.get(track.clipId)!.duration;
    const points = track.points.filter((point) => point.time <= duration + 1e-6);
    return { ...track, points, lostRatio: points.filter((point) => point.status === "lost").length / Math.max(1, points.length) };
  });
  const trackIds = new Set(project.motionTracks.map((track) => track.id));
  project.motionGraphics = project.motionGraphics.map((graphic) => graphic.trackId && !trackIds.has(graphic.trackId) ? { ...graphic, trackId: undefined } : graphic);
  for (const clip of clips.values()) {
    if (clip.masks) clip.masks = clip.masks.map((mask) => mask.trackId && !trackIds.has(mask.trackId) ? { ...mask, trackId: undefined, frozenRange: undefined } : mask);
  }
}

function normalizeLayerState(project: EditProject): void {
  for (const clip of project.tracks.flatMap((track) => track.clips)) {
    clip.layer = { ...DEFAULT_CLIP_LAYER, ...clip.layer };
    clip.expressions ??= {};
  }
}

function commandInternal(project: EditProject, command: EditorCommand, context?: EditorCommandContext): EditProject {
  if (applyTimelineCommand(project, command)) return project;
  switch (command.type) {
    case "smart_cut_clip": {
      applySmartCutToClip(project, command.clipId, command.keepRanges, command.segmentIds);
      break;
    }
    case "update_clip_transform": {
      const clip = findClip(project, command.clipId);
      clip.transform = { ...clip.transform, ...command.patch };
      break;
    }
    case "configure_scene_25d": {
      if (!command.enabled) {
        project.scene25d = undefined;
        for (const clip of project.tracks.flatMap((track) => track.clips)) clip.transform3d = undefined;
        break;
      }
      if (project.particleSimulation?.enabled) throw new EditGraphError("請先關閉粒子 VFX，再啟用 2.5D 場景");
      const planes = project.tracks.filter((track) => track.kind === "video" && !track.muted).flatMap((track) => track.clips);
      if (planes.length < 1 || planes.length > 8) throw new EditGraphError("2.5D 場景需要 1 至 8 個照片／影片片段");
      for (const clip of planes) {
        const asset = findAsset(project, clip.assetId);
        if (!["image", "video"].includes(asset.kind) || asset.compositionId) throw new EditGraphError(`2.5D v1 只接受照片、透明圖片或影片平面：${asset.name}`);
        if (clip.keyframes.length || clip.masks?.length || clip.creative?.effectPresetIds.length || clip.creative?.nativeEffectInstances?.some((instance) => instance.enabled)) {
          throw new EditGraphError(`啟用 2.5D 前，請先移除片段 ${clip.id} 的 2D 動畫、遮罩或效果`);
        }
        clip.transform3d ??= structuredClone(DEFAULT_TRANSFORM_3D);
      }
      project.scene25d = structuredClone(DEFAULT_SCENE_25D);
      break;
    }
    case "set_scene_25d_settings": {
      if (!project.scene25d?.enabled) throw new EditGraphError("請先啟用 2.5D 場景");
      project.scene25d = structuredClone(command.settings);
      break;
    }
    case "update_clip_transform_3d": {
      if (!project.scene25d?.enabled) throw new EditGraphError("請先啟用 2.5D 場景");
      const clip = findClip(project, command.clipId);
      clip.transform3d = { ...(clip.transform3d ?? structuredClone(DEFAULT_TRANSFORM_3D)), ...structuredClone(command.patch) };
      break;
    }
    case "configure_particle_simulation": {
      if (!command.enabled) {
        project.particleSimulation = undefined;
        break;
      }
      if (project.scene25d?.enabled) throw new EditGraphError("請先退出 2.5D 場景，再啟用螢幕空間粒子 VFX");
      project.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
      break;
    }
    case "set_particle_simulation_settings": {
      if (!project.particleSimulation?.enabled) throw new EditGraphError("請先啟用粒子 VFX");
      project.particleSimulation = structuredClone(command.settings);
      break;
    }
    case "set_clip_color": {
      const clip = findClip(project, command.clipId);
      clip.color = { ...clip.color, ...command.patch };
      break;
    }
    case "set_clip_creative": {
      const clip = findClip(project, command.clipId);
      const track = findTrack(project, clip.trackId);
      const ordered = [...track.clips].sort((left, right) => left.timelineStart - right.timelineStart);
      const index = ordered.findIndex((item) => item.id === clip.id);
      const tolerance = 0.5 / project.fps;
      if (command.patch.transitionIn && (index <= 0 || Math.abs(ordered[index - 1].timelineStart + ordered[index - 1].duration - clip.timelineStart) > tolerance)) {
        throw new EditGraphError("入場轉場需要前方相鄰片段");
      }
      if (command.patch.transitionOut && (index < 0 || index >= ordered.length - 1 || Math.abs(clip.timelineStart + clip.duration - ordered[index + 1].timelineStart) > tolerance)) {
        throw new EditGraphError("離場轉場需要後方相鄰片段");
      }
      const creative: ClipCreativeState = structuredClone(clip.creative ?? { effectPresetIds: [] });
      if (command.patch.lookPresetId !== undefined) {
        if (command.patch.lookPresetId === null) delete creative.lookPresetId;
        else creative.lookPresetId = command.patch.lookPresetId;
      }
      if (command.patch.effectPresetIds !== undefined) creative.effectPresetIds = [...new Set(command.patch.effectPresetIds)];
      if (command.patch.transitionIn !== undefined) {
        if (command.patch.transitionIn === null) delete creative.transitionIn;
        else creative.transitionIn = { ...command.patch.transitionIn };
      }
      if (command.patch.transitionOut !== undefined) {
        if (command.patch.transitionOut === null) delete creative.transitionOut;
        else creative.transitionOut = { ...command.patch.transitionOut };
      }
      clip.creative = creative;
      break;
    }
    case "add_native_effect": {
      const clip = findClip(project, command.clipId);
      const creative: ClipCreativeState = structuredClone(clip.creative ?? { effectPresetIds: [] });
      creative.nativeEffectInstances ??= [];
      if (creative.nativeEffectInstances.some((instance) => instance.id === command.instance.id)) {
        throw new EditGraphError(`原生效果 instance id 已存在：${command.instance.id}`);
      }
      const runtimeType = command.instance.runtimeType ?? "native_effect";
      const existingRuntimeTypes = new Set(creative.nativeEffectInstances.map((instance) => instance.runtimeType ?? "native_effect"));
      if (existingRuntimeTypes.size && !existingRuntimeTypes.has(runtimeType)) {
        throw new EditGraphError("同一片段不可混用 GPU graph 與 CPU 原生效果；請先移除原有效果");
      }
      const limit = runtimeType === "gpu_effect_graph" ? 4 : 8;
      if (creative.nativeEffectInstances.length >= limit) throw new EditGraphError(`每個片段最多 ${limit} 個${runtimeType === "gpu_effect_graph" ? " GPU graph" : "原生"}效果`);
      creative.nativeEffectInstances.push(structuredClone(command.instance));
      clip.creative = creative;
      break;
    }
    case "update_native_effect": {
      const clip = findClip(project, command.clipId);
      const instance = clip.creative?.nativeEffectInstances?.find((item) => item.id === command.instanceId);
      if (!instance) throw new EditGraphError(`找不到原生效果：${command.instanceId}`);
      if (command.patch.enabled !== undefined) instance.enabled = command.patch.enabled;
      if (command.patch.parameters !== undefined) instance.parameters = structuredClone(command.patch.parameters);
      break;
    }
    case "reorder_native_effect": {
      const clip = findClip(project, command.clipId);
      const instances = clip.creative?.nativeEffectInstances;
      const fromIndex = instances?.findIndex((item) => item.id === command.instanceId) ?? -1;
      if (!instances || fromIndex < 0) throw new EditGraphError(`找不到原生效果：${command.instanceId}`);
      if (!Number.isSafeInteger(command.toIndex) || command.toIndex < 0 || command.toIndex >= instances.length) {
        throw new EditGraphError(`效果堆疊位置超出範圍：${command.toIndex}`);
      }
      const [instance] = instances.splice(fromIndex, 1);
      instances.splice(command.toIndex, 0, instance);
      break;
    }
    case "remove_native_effect": {
      const clip = findClip(project, command.clipId);
      const instances = clip.creative?.nativeEffectInstances;
      if (!instances?.some((item) => item.id === command.instanceId)) throw new EditGraphError(`找不到原生效果：${command.instanceId}`);
      clip.creative!.nativeEffectInstances = instances.filter((item) => item.id !== command.instanceId);
      break;
    }
    case "set_clip_layout": {
      const clip = findClip(project, command.clipId);
      clip.layout = command.layout ? structuredClone(command.layout) : undefined;
      break;
    }
    case "add_clip_mask": {
      const clip = findClip(project, command.clipId);
      clip.masks ??= [];
      if (clip.masks.some((mask) => mask.id === command.mask.id)) throw new EditGraphError(`遮罩 id 已存在：${command.mask.id}`);
      if (clip.masks.length >= 12) throw new EditGraphError("每個片段最多 12 個遮罩");
      clip.masks.push(structuredClone(command.mask));
      break;
    }
    case "update_clip_mask": {
      const clip = findClip(project, command.clipId);
      const mask = clip.masks?.find((item) => item.id === command.maskId);
      if (!mask) throw new EditGraphError(`找不到遮罩：${command.maskId}`);
      const timeStale = mask.matteSequence?.staleReason === "clip-time-range-changed";
      if (timeStale) {
        // A brush patch cannot repair the changed clip clock, even via MCP.
        if ("rotoCorrections" in command.patch) throw new EditGraphError("片段已分割／裁切；請先重新分析 Auto Roto，再修改筆刷。");
        if ("matteSequence" in command.patch) {
          const replacement = command.patch.matteSequence;
          const artifactPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) ? path.replaceAll("\\", "/").toLowerCase() : path.replaceAll("\\", "/");
          if (!replacement || replacement.stale === true || replacement.staleReason !== undefined
            || artifactPath(replacement.manifestUri) === artifactPath(mask.matteSequence!.manifestUri)
            || artifactPath(replacement.sequenceUri) === artifactPath(mask.matteSequence!.sequenceUri)) {
            throw new EditGraphError("片段已分割／裁切；請重新分析 Auto Roto 取得新時間範圍的完整 Matte，不能重用或清除舊分析標記。");
          }
        }
      }
      const invalidatesMatte = ["kind", "path", "keyframes", "trackId", "feather", "expansion", "refine"].some((key) => key in command.patch) && !("matteSequence" in command.patch);
      Object.assign(mask, structuredClone(command.patch));
      if (invalidatesMatte && !timeStale) { mask.matteSequence = undefined; mask.frozenRange = undefined; }
      break;
    }
    case "delete_clip_mask": {
      const clip = findClip(project, command.clipId);
      if (!clip.masks?.some((mask) => mask.id === command.maskId)) throw new EditGraphError(`找不到遮罩：${command.maskId}`);
      clip.masks = clip.masks.filter((mask) => mask.id !== command.maskId);
      break;
    }
    case "set_clip_mask_track": {
      const clip = findClip(project, command.clipId);
      const mask = clip.masks?.find((item) => item.id === command.maskId);
      if (!mask) throw new EditGraphError(`找不到遮罩：${command.maskId}`);
      if (command.trackId) {
        const track = project.motionTracks.find((item) => item.id === command.trackId);
        if (!track || track.clipId !== clip.id) throw new EditGraphError("遮罩只能綁定同一片段的追蹤資料");
      }
      mask.trackId = command.trackId;
      mask.frozenRange = undefined;
      if (mask.matteSequence?.staleReason !== "clip-time-range-changed") mask.matteSequence = undefined;
      break;
    }
    case "set_clip_mask_keyframe": {
      const clip = findClip(project, command.clipId);
      const mask = clip.masks?.find((item) => item.id === command.maskId);
      if (!mask) throw new EditGraphError(`找不到遮罩：${command.maskId}`);
      const index = mask.keyframes.findIndex((item) => item.frame === command.keyframe.frame);
      const keyframe = { ...structuredClone(command.keyframe), status: "manual" as const, confidence: 1 };
      if (index >= 0) mask.keyframes[index] = keyframe; else mask.keyframes.push(keyframe);
      mask.keyframes.sort((left, right) => left.frame - right.frame);
      mask.frozenRange = undefined;
      if (mask.matteSequence?.staleReason !== "clip-time-range-changed") mask.matteSequence = undefined;
      break;
    }
    case "freeze_clip_mask_range": {
      const clip = findClip(project, command.clipId);
      const mask = clip.masks?.find((item) => item.id === command.maskId);
      if (!mask) throw new EditGraphError(`找不到遮罩：${command.maskId}`);
      if (command.fromFrame < 0 || command.toFrame < command.fromFrame || command.toFrame > Math.ceil(clip.duration * project.fps)) throw new EditGraphError("遮罩凍結範圍不合法");
      mask.frozenRange = { fromFrame: command.fromFrame, toFrame: command.toFrame };
      break;
    }
    case "set_clip_chroma_key": {
      const clip = findClip(project, command.clipId);
      clip.chromaKey = command.settings ? structuredClone(command.settings) : undefined;
      break;
    }
    case "set_clip_layer": {
      const clip = findClip(project, command.clipId);
      const layer = { ...DEFAULT_CLIP_LAYER, ...clip.layer, ...command.patch };
      clip.layer = layer;
      if (layer.role === "adjustment") {
        layer.parentClipId = undefined;
        layer.trackMatte = undefined;
      } else if (layer.role === "controller") {
        layer.blendMode = "normal";
        layer.trackMatte = undefined;
      }
      break;
    }
    case "set_clip_expression": {
      const clip = findClip(project, command.clipId);
      clip.expressions ??= {};
      if (command.expression === null) delete clip.expressions[command.property];
      else {
        try { assertHaoExpression(command.expression); } catch (error) {
          throw new EditGraphError(`表達式無效：${error instanceof Error ? error.message : String(error)}`);
        }
        clip.expressions[command.property] = command.expression;
      }
      break;
    }
    case "add_keyframe": {
      const clip = findClip(project, command.clipId);
      if (clip.keyframes.some((keyframe) => keyframe.id === command.keyframe.id)) throw new EditGraphError(`關鍵幀 id 已存在：${command.keyframe.id}`);
      clip.keyframes.push(structuredClone(command.keyframe));
      clip.keyframes.sort((a, b) => a.time - b.time);
      break;
    }
    case "update_keyframe": {
      const clip = findClip(project, command.clipId);
      const keyframe = clip.keyframes.find((item) => item.id === command.keyframeId);
      if (!keyframe) throw new EditGraphError(`找不到關鍵幀：${command.keyframeId}`);
      if (command.patch.time !== undefined) keyframe.time = alignTime(command.patch.time, project.fps);
      if (command.patch.transform !== undefined) keyframe.transform = { ...command.patch.transform };
      if (command.patch.color !== undefined) keyframe.color = { ...command.patch.color };
      if (command.patch.easing !== undefined) keyframe.easing = command.patch.easing;
      clip.keyframes.sort((a, b) => a.time - b.time);
      break;
    }
    case "delete_keyframe": {
      const clip = findClip(project, command.clipId);
      if (!clip.keyframes.some((item) => item.id === command.keyframeId)) throw new EditGraphError(`找不到關鍵幀：${command.keyframeId}`);
      clip.keyframes = clip.keyframes.filter((item) => item.id !== command.keyframeId);
      break;
    }
    case "add_motion_track": {
      findClip(project, command.track.clipId);
      if (project.motionTracks.some((track) => track.id === command.track.id)) throw new EditGraphError(`追蹤資料 id 已存在：${command.track.id}`);
      project.motionTracks.push(structuredClone(command.track));
      break;
    }
    case "delete_motion_track": {
      if (!project.motionTracks.some((track) => track.id === command.trackId)) throw new EditGraphError(`找不到追蹤資料：${command.trackId}`);
      project.motionTracks = project.motionTracks.filter((track) => track.id !== command.trackId);
      project.motionGraphics = project.motionGraphics.map((graphic) => graphic.trackId === command.trackId ? { ...graphic, trackId: undefined } : graphic);
      for (const clip of project.tracks.flatMap((item) => item.clips)) {
        if (clip.masks) clip.masks = clip.masks.map((mask) => mask.trackId === command.trackId ? { ...mask, trackId: undefined, frozenRange: undefined } : mask);
      }
      break;
    }
    case "set_motion_track_point": {
      const track = project.motionTracks.find((item) => item.id === command.trackId);
      if (!track) throw new EditGraphError(`找不到追蹤資料：${command.trackId}`);
      const index = track.points.findIndex((point) => point.frame === command.point.frame);
      const point = { ...structuredClone(command.point), status: "manual" as const, confidence: 1 };
      if (index >= 0) track.points[index] = point; else track.points.push(point);
      track.points.sort((left, right) => left.frame - right.frame);
      track.lostRatio = track.points.filter((item) => item.status === "lost").length / Math.max(1, track.points.length);
      break;
    }
    case "add_motion_graphic": {
      if (project.motionGraphics.some((graphic) => graphic.id === command.graphic.id)) throw new EditGraphError(`動態圖卡 id 已存在：${command.graphic.id}`);
      project.motionGraphics.push(structuredClone(command.graphic));
      break;
    }
    case "update_motion_graphic": {
      const graphic = project.motionGraphics.find((item) => item.id === command.graphicId);
      if (!graphic) throw new EditGraphError(`找不到動態圖卡：${command.graphicId}`);
      Object.assign(graphic, structuredClone(command.patch));
      break;
    }
    case "delete_motion_graphic": {
      if (!project.motionGraphics.some((graphic) => graphic.id === command.graphicId)) throw new EditGraphError(`找不到動態圖卡：${command.graphicId}`);
      project.motionGraphics = project.motionGraphics.filter((graphic) => graphic.id !== command.graphicId);
      break;
    }
    case "set_asset_derivatives": {
      const asset = findAsset(project, command.assetId);
      asset.derivatives = command.derivatives ? { ...command.derivatives } : undefined;
      break;
    }
    case "set_asset_color_interpretation": {
      const asset = findAsset(project, command.assetId);
      asset.color = { ...asset.color, interpretation: command.interpretation };
      break;
    }
    case "set_asset_alpha_mode": {
      const asset = findAsset(project, command.assetId);
      asset.alphaMode = command.alphaMode;
      break;
    }
    case "set_project_color_management": {
      project.colorManagement = { ...project.colorManagement, mode: "rec709", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5", ...command.patch };
      break;
    }
    case "add_caption": {
      if (project.captions.some((caption) => caption.id === command.caption.id)) {
        throw new EditGraphError(`字幕 id 已存在：${command.caption.id}`);
      }
      project.captions.push({ ...command.caption });
      project.captions.sort((a, b) => a.start - b.start);
      break;
    }
    case "update_caption": {
      const caption = findCaption(project, command.captionId);
      if (command.patch.text !== undefined) caption.text = command.patch.text;
      if (command.patch.translation !== undefined) caption.translation = command.patch.translation ? { ...command.patch.translation } : undefined;
      if (command.patch.start !== undefined) caption.start = alignTime(command.patch.start, project.fps);
      if (command.patch.duration !== undefined) caption.duration = alignTime(command.patch.duration, project.fps);
      project.captions.sort((a, b) => a.start - b.start);
      break;
    }
    case "delete_caption": {
      findCaption(project, command.captionId);
      project.captions = project.captions.filter((caption) => caption.id !== command.captionId);
      break;
    }
    case "set_caption_style": {
      project.captionStyle = { ...project.captionStyle, ...command.patch };
      break;
    }
    case "add_director_marker": {
      if (project.director.markers.some((marker) => marker.id === command.marker.id)) throw new EditGraphError(`導演台註記 id 已存在：${command.marker.id}`);
      project.director.markers.push(structuredClone(command.marker));
      project.director.markers.sort((left, right) => left.time - right.time);
      project.director.updatedAt = new Date().toISOString();
      break;
    }
    case "update_director_marker": {
      const marker = project.director.markers.find((item) => item.id === command.markerId);
      if (!marker) throw new EditGraphError(`找不到導演台註記：${command.markerId}`);
      Object.assign(marker, structuredClone(command.patch));
      project.director.markers.sort((left, right) => left.time - right.time);
      project.director.updatedAt = new Date().toISOString();
      break;
    }
    case "delete_director_marker": {
      if (!project.director.markers.some((marker) => marker.id === command.markerId)) throw new EditGraphError(`找不到導演台註記：${command.markerId}`);
      project.director.markers = project.director.markers.filter((marker) => marker.id !== command.markerId);
      project.director.updatedAt = new Date().toISOString();
      break;
    }
    case "set_director_review_state": {
      project.director.reviewState = command.reviewState;
      project.director.updatedAt = new Date().toISOString();
      break;
    }
    case "set_editorial_profile": {
      project.editorialProfile = command.profile;
      break;
    }
    case "set_aesthetic_system": {
      project.aestheticSystem = structuredClone(command.aestheticSystem);
      project.aestheticSystem.review = reconcileAestheticReview(project.aestheticSystem, project.aestheticSystem.review, context?.currentAestheticArtifact?.(project));
      break;
    }
    case "set_aesthetic_review": {
      if (!project.aestheticSystem) throw new EditGraphError("專案尚未套用美感標準");
      project.aestheticSystem.review = reconcileAestheticReview(project.aestheticSystem, command.review, context?.currentAestheticArtifact?.(project));
      break;
    }
    case "set_project_resolution": {
      if (!Number.isInteger(command.width) || !Number.isInteger(command.height) || command.width <= 0 || command.height <= 0) {
        throw new EditGraphError("畫布寬高必須是正整數");
      }
      const scale = command.height / project.height;
      if (scale !== 1) {
        const scaled = (value: number, minimum = 0) => Math.max(minimum, Math.round(value * scale * 1_000_000) / 1_000_000);
        for (const graphic of project.motionGraphics) {
          graphic.fontSize = scaled(graphic.fontSize, 1);
          if (graphic.letterSpacing !== undefined) graphic.letterSpacing = Math.round(graphic.letterSpacing * scale * 1_000_000) / 1_000_000;
          if (graphic.outlineWidth !== undefined) graphic.outlineWidth = scaled(graphic.outlineWidth);
          if (graphic.shadowDepth !== undefined) graphic.shadowDepth = scaled(graphic.shadowDepth);
          if (graphic.cornerRadius !== undefined) graphic.cornerRadius = scaled(graphic.cornerRadius);
          if (graphic.layoutV2) {
            graphic.layoutV2.minFontSize = scaled(graphic.layoutV2.minFontSize, 8);
            graphic.layoutV2.lineGap = scaled(graphic.layoutV2.lineGap);
          }
        }
      }
      project.width = command.width;
      project.height = command.height;
      break;
    }
    case "set_template_application": {
      project.templateApplication = structuredClone(command.application);
      break;
    }
    case "clear_template_application": {
      clearTemplateApplicationInPlace(project);
      break;
    }
    case "rename_project": {
      const name = command.name.trim();
      if (!name) throw new EditGraphError("專案名稱不可空白");
      project.name = name;
      break;
    }
    case "batch": {
      for (const child of command.commands) commandInternal(project, child, context);
      break;
    }
    default: {
      throw new EditGraphError(`不支援的 command：${String((command as EditorCommand).type)}`);
    }
  }
  return project;
}

function revalidateAestheticAcceptance(project: EditProject, context?: EditorCommandContext): EditProject {
  const system = project.aestheticSystem;
  if (!system || system.review.status !== "PASSED") return project;
  // Fast commands may share this nested object with Undo history: never mutate it.
  const review = reconcileAestheticReview(system, system.review, context?.currentAestheticArtifact?.(project));
  return { ...project, aestheticSystem: { ...system, review } };
}

export function applyCommand(input: EditProject, command: EditorCommand, context?: EditorCommandContext): EditProject {
  const fast = applyFastCommand(input, command);
  if (fast) return revalidateAestheticAcceptance(fast, context);
  const project = cloneProject(input);
  commandInternal(project, command, context);
  normalizeCreativeTransitions(project);
  normalizeMotionReferences(project);
  normalizeLayerState(project);
  touch(project);
  return validateProject(revalidateAestheticAcceptance(project, context));
}
