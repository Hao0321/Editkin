import type { ColorAdjustments, EditProject, Transform2D } from "./types";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, particleSimulationEmitters } from "./types";
import { EditGraphError } from "./editGraphError";
import { isTransformMotionBlurInstance } from "./transformMotionBlur";

const EPSILON = 1e-6;
const projectDuration = (project: EditProject) => Math.max(0, ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStart + clip.duration)));

export function validateScene25dProductContract(project: EditProject): void {
  const allClips = project.tracks.flatMap((track) => track.clips);
  const scene = project.scene25d;
  if (!scene?.enabled) {
    if (allClips.some((clip) => clip.transform3d)) throw new EditGraphError("2.5D 圖層存在，但場景尚未啟用");
    return;
  }
  if (project.particleSimulation?.enabled) throw new EditGraphError("螢幕空間粒子 VFX v1 不可與 2.5D 場景混用");
  const finite = (values: number[]) => values.every(Number.isFinite);
  const length = (value: [number, number, number]) => Math.hypot(...value);
  const cameraDirection = scene.camera.target.map((value, index) => value - scene.camera.position[index]) as [number, number, number];
  if (scene.schema !== "editkin.scene-25d/v1"
    || !finite([...scene.camera.position, ...scene.camera.target, ...scene.camera.up, scene.camera.verticalFovDegrees, scene.camera.near, scene.camera.far])
    || scene.camera.verticalFovDegrees <= 1 || scene.camera.verticalFovDegrees >= 179
    || scene.camera.near <= 0 || scene.camera.far <= scene.camera.near
    || length(cameraDirection) <= EPSILON || length(scene.camera.up) <= EPSILON) {
    throw new EditGraphError("2.5D 相機設定不合法");
  }
  if (scene.camera.keyframes.length > 16) throw new EditGraphError("2.5D 相機動畫最多 16 個關鍵幀");
  const cameraKeyframeIds = new Set<string>();
  let previousCameraFrame = 0;
  const durationFrames = Math.round(projectDuration(project) * project.fps);
  for (const keyframe of scene.camera.keyframes) {
    const frame = Math.round(keyframe.time * project.fps);
    const direction = keyframe.target.map((value, index) => value - keyframe.position[index]) as [number, number, number];
    if (!keyframe.id.trim() || cameraKeyframeIds.has(keyframe.id) || frame <= previousCameraFrame || frame >= durationFrames
      || !finite([...keyframe.position, ...keyframe.target, keyframe.verticalFovDegrees]) || length(direction) <= EPSILON
      || keyframe.verticalFovDegrees <= 1 || keyframe.verticalFovDegrees >= 179) {
      throw new EditGraphError(`2.5D 相機關鍵幀 ${keyframe.id} 不合法、重複或不在專案影格範圍內`);
    }
    cameraKeyframeIds.add(keyframe.id);
    previousCameraFrame = frame;
  }
  const lens = scene.depthOfField;
  if (![lens.focusDistance, lens.aperture, lens.maxBlurRadius].every(Number.isFinite)
    || lens.focusDistance <= scene.camera.near || lens.focusDistance >= scene.camera.far
    || lens.aperture <= 0 || lens.aperture > 16 || lens.maxBlurRadius <= 0 || lens.maxBlurRadius > 32) {
    throw new EditGraphError("2.5D 鏡頭景深必須位於裁切範圍內，光圈為 0–16、模糊半徑為 1–32 px");
  }
  if (lens.keyframes.length > 16) throw new EditGraphError("2.5D 鏡頭動畫最多 16 個關鍵幀");
  const lensKeyframeIds = new Set<string>();
  let previousLensFrame = 0;
  for (const keyframe of lens.keyframes) {
    const frame = Math.round(keyframe.time * project.fps);
    if (!keyframe.id.trim() || lensKeyframeIds.has(keyframe.id) || frame <= previousLensFrame || frame >= durationFrames
      || ![keyframe.focusDistance, keyframe.aperture, keyframe.maxBlurRadius].every(Number.isFinite)
      || keyframe.focusDistance <= scene.camera.near || keyframe.focusDistance >= scene.camera.far
      || keyframe.aperture <= 0 || keyframe.aperture > 16 || keyframe.maxBlurRadius < 1 || keyframe.maxBlurRadius > 32) {
      throw new EditGraphError(`2.5D 鏡頭關鍵幀 ${keyframe.id} 不合法、重複或不在專案影格範圍內`);
    }
    lensKeyframeIds.add(keyframe.id);
    previousLensFrame = frame;
  }
  if (!finite([...scene.ambientLight.color, scene.ambientLight.intensity, ...scene.directionalLight.color, scene.directionalLight.intensity, ...scene.directionalLight.direction])
    || scene.ambientLight.color.some((value) => Math.abs(value - 1) > EPSILON)
    || scene.ambientLight.intensity < 0 || scene.directionalLight.intensity < 0
    || scene.directionalLight.color.some((value) => value < 0)
    || length(scene.directionalLight.direction) <= EPSILON) {
    throw new EditGraphError("2.5D 環境光／方向光設定不合法");
  }
  const validateLightFrames = <T extends { id: string; time: number; intensity: number }>(
    name: string, keyframes: T[], values: (keyframe: T) => number[], direction?: (keyframe: T) => [number, number, number],
  ) => {
    if (keyframes.length > 16) throw new EditGraphError(`2.5D ${name}動畫最多 16 個關鍵幀`);
    const ids = new Set<string>();
    let previousFrame = 0;
    for (const keyframe of keyframes) {
      const frame = Math.round(keyframe.time * project.fps);
      if (!keyframe.id.trim() || ids.has(keyframe.id) || frame <= previousFrame || frame >= durationFrames
        || !finite(values(keyframe)) || keyframe.intensity < 0 || (direction && length(direction(keyframe)) <= EPSILON)) {
        throw new EditGraphError(`2.5D ${name}關鍵幀 ${keyframe.id} 不合法、重複或不在專案影格範圍內`);
      }
      ids.add(keyframe.id);
      previousFrame = frame;
    }
  };
  validateLightFrames("環境光", scene.ambientLight.keyframes, (keyframe) => [keyframe.intensity]);
  validateLightFrames("方向光", scene.directionalLight.keyframes,
    (keyframe) => [...keyframe.color, keyframe.intensity, ...keyframe.direction], (keyframe) => keyframe.direction);
  if (scene.directionalLight.keyframes.some((keyframe) => keyframe.color.some((value) => value < 0))) {
    throw new EditGraphError("2.5D 方向光關鍵幀顏色不可為負數");
  }
  const videoTracks = project.tracks.filter((track) => track.kind === "video" && !track.muted);
  const planes = videoTracks.flatMap((track) => track.clips);
  if (!(planes.length >= 1 && planes.length <= 8)) throw new EditGraphError("原生 2.5D 場景必須包含 1 至 8 個照片／影片平面");
  if (project.tracks.some((track) => track.kind === "audio" && !track.muted && track.clips.length > 0)) throw new EditGraphError("2.5D v1 尚未接受同一 GPU scene session 內的獨立音訊 graph");
  if (project.captions.length || project.motionGraphics.length) throw new EditGraphError("2.5D v1 尚未接受字幕或動態圖卡混合進場景");
  if (lens.enabled && (project.colorManagement?.mode !== "aces2" || project.colorManagement.outputTransform !== "rec709_sdr")) throw new EditGraphError("2.5D 鏡頭景深目前需要 ACES2 Rec.709 SDR 原生影片管線");
  const planeIds = new Set(planes.map((clip) => clip.id));
  for (const clip of planes) {
    const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
    const layer = { ...DEFAULT_CLIP_LAYER, ...clip.layer };
    const identityColor = Object.entries(DEFAULT_COLOR).every(([key, value]) => Math.abs(clip.color[key as keyof ColorAdjustments] - value) <= EPSILON);
    const identity2d = Object.entries(DEFAULT_TRANSFORM).every(([key, value]) => Math.abs(clip.transform[key as keyof Transform2D] - value) <= EPSILON);
    if (!clip.transform3d || !asset || !["image", "video"].includes(asset.kind) || asset.compositionId || !layer.enabled
      || (layer.role ?? "content") !== "content" || layer.blendMode !== "normal" || layer.trackMatte
      || !identityColor || !identity2d || clip.keyframes.length || Object.keys(clip.expressions ?? {}).length
      || (clip.masks?.length ?? 0) > 0 || (clip.creative?.effectPresetIds.length ?? 0) > 0
      || (clip.creative?.nativeEffectInstances?.some((instance) => instance.enabled) ?? false)) {
      throw new EditGraphError(`2.5D 平面 ${clip.id} 必須是無 2D 疊加、無特效的照片／影片圖層`);
    }
    if (lens.enabled && (asset.kind !== "video" || asset.alphaMode === "straight" || asset.alphaMode === "premultiplied")) throw new EditGraphError(`2.5D 鏡頭景深目前只接受不透明影片平面：${clip.id}`);
    if (layer.parentClipId && !planeIds.has(layer.parentClipId)) throw new EditGraphError(`2.5D 平面 ${clip.id} 的父圖層不在同一場景`);
    let parent = layer.parentClipId;
    let depth = 0;
    while (parent) {
      depth += 1;
      if (depth > 4) throw new EditGraphError(`2.5D 平面 ${clip.id} 的父子深度超過 4`);
      parent = planes.find((candidate) => candidate.id === parent)?.layer?.parentClipId;
    }
  }
}

export function validateParticleSimulationProductContract(project: EditProject): void {
  const simulation = project.particleSimulation;
  if (!simulation) return;
  const emitters = particleSimulationEmitters(simulation);
  const emitterIds = new Set(emitters.map((emitter) => emitter.id));
  if (simulation.schema !== "editkin.particle-simulation/v1" || emitters.length > 4
    || emitterIds.size !== emitters.length || (simulation.additionalEmitters ?? []).some((emitter) => emitter.id === "primary")
    || emitters.reduce((sum, emitter) => sum + emitter.maxParticles, 0) > 192) {
    throw new EditGraphError("粒子 VFX 最多 4 個發射器、總粒子預算不得超過 192，且 ID 不可重複");
  }
  for (const emitter of emitters) {
    const values = [
      emitter.seed, emitter.ratePerSecond, emitter.lifetimeSeconds, emitter.maxParticles,
      ...emitter.emitterPosition, ...emitter.initialVelocity, ...emitter.gravity,
      emitter.radiusPixels, ...emitter.color,
    ];
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(emitter.id) || values.some((value) => !Number.isFinite(value))
      || !Number.isInteger(emitter.seed) || emitter.seed < 0 || emitter.seed > 0xffff_ffff
      || emitter.ratePerSecond <= 0 || emitter.ratePerSecond > 240
      || emitter.lifetimeSeconds <= 0 || emitter.lifetimeSeconds > 10
      || !Number.isInteger(emitter.maxParticles) || emitter.maxParticles < 1 || emitter.maxParticles > 64
      || emitter.emitterPosition.some((value) => value < 0 || value > 1)
      || emitter.radiusPixels <= 0 || emitter.radiusPixels > 64
      || emitter.color.some((value) => value < 0 || value > 1)) {
      throw new EditGraphError(`粒子 VFX 發射器 ${emitter.id} 設定超出目前原生 GPU 契約`);
    }
    if (!emitter.timeline) continue;
    const { start, duration } = emitter.timeline;
    const end = start + duration;
    const projectEnd = projectDuration(project);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0
      || duration < 1 / project.fps || !Number.isFinite(end) || end > projectEnd + EPSILON) {
      throw new EditGraphError(`粒子 VFX 區間（發射器 ${emitter.id}）必須至少一格，且不可超出專案內容`);
    }
  }
  if (simulation.enabled && projectDuration(project) <= 0) {
    throw new EditGraphError("粒子 VFX 需要至少一格可見的專案內容");
  }
  if (simulation.enabled && project.scene25d?.enabled) {
    throw new EditGraphError("螢幕空間粒子 VFX v1 不可與 2.5D 場景混用");
  }
}
