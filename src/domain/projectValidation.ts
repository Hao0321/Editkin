import type { ColorAdjustments, EditComposition, EditProject, MediaAsset, RotoMatteSequence, TimelineClip, TimelineTrack, Transform2D } from "./types";
import { DEFAULT_CAPTION_STYLE, DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM } from "./types";
import { assertHaoExpression } from "./expression";
import { isTransformMotionBlurInstance, transformMotionBlurParameters } from "./transformMotionBlur";
import { EditGraphError } from "./editGraphError";
import { validateParticleSimulationProductContract, validateScene25dProductContract } from "./sceneValidation";
import { projectFromComposition } from "./projectComposition";
import { assertMotionGraphicV2Contract } from "./motionCompositionV2Contract";
import {
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
  PRODUCT_AUTO_ROTO_MAX_FRAMES,
  productAutoRotoRouteReceiptShapeSchema,
} from "./autoRotoProductReceipt";

const EPSILON = 1e-6;
const SHA256 = /^[a-f0-9]{64}$/;

function validProductMatteArtifactInventory(sequence: RotoMatteSequence): boolean {
  const normalizedManifest = sequence.manifestUri.replaceAll("\\", "/");
  const match = /^(?:[A-Za-z]:\/|\/)(?:[^/]+\/)*auto-roto-product\/[a-f0-9]{64}\/matte-manifest\.json$/.exec(normalizedManifest);
  const artifactRoot = match ? normalizedManifest.slice(0, -"/matte-manifest.json".length) : undefined;
  if (!artifactRoot || normalizedManifest.split("/").some((part) => part === "." || part === "..")) return false;
  if (sequence.sequenceUri.replaceAll("\\", "/") !== `${artifactRoot}/matte-sequence.alpha8`
    || !sequence.sequenceSha256 || !SHA256.test(sequence.sequenceSha256)
    || sequence.sequenceBytes !== sequence.width * sequence.height * sequence.frameCount
    || sequence.frameArtifactUris?.length !== sequence.frameCount
    || (sequence.framePreviewUris !== undefined && sequence.framePreviewUris.length !== sequence.frameCount)) return false;
  return sequence.frameArtifactUris.every((path, frame) => path.replaceAll("\\", "/")
    === `${artifactRoot}/frame-${String(frame).padStart(6, "0")}.png`);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const contract = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  return JSON.stringify(actual) === JSON.stringify(contract);
}
const projectDuration = (project: EditProject) => Math.max(0, ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStart + clip.duration)));
function findAsset(project: EditProject, assetId: string): MediaAsset {
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset) throw new EditGraphError(`找不到素材：${assetId}`);
  return asset;
}

export function validateClipForTrack(project: EditProject, track: TimelineTrack, clip: TimelineClip): void {
  if (clip.trackId !== track.id) {
    throw new EditGraphError(`片段 ${clip.id} 的 trackId 與所在軌道不一致`);
  }
  if (clip.timelineStart < 0 || clip.sourceStart < 0 || clip.duration <= 0) {
    throw new EditGraphError(`片段 ${clip.id} 的時間範圍不合法`);
  }
  if (clip.volume < 0 || clip.volume > 2) {
    throw new EditGraphError(`片段 ${clip.id} 的音量必須介於 0 與 2`);
  }
  if (!Number.isFinite(clip.transform.x) || !Number.isFinite(clip.transform.y)
    || !Number.isFinite(clip.transform.rotation) || clip.transform.scale <= 0
    || clip.transform.opacity < 0 || clip.transform.opacity > 1) {
    throw new EditGraphError(`片段 ${clip.id} 的 transform 不合法`);
  }
  if (clip.transform3d && (!Object.values(clip.transform3d).flat().every(Number.isFinite)
    || clip.transform3d.scale.some((value) => value <= 0)
    || clip.transform3d.rotationDegrees.some((value) => Math.abs(value) > 3_600)
    || clip.transform3d.position.some((value) => Math.abs(value) > 100_000))) {
    throw new EditGraphError(`片段 ${clip.id} 的 2.5D transform 不合法`);
  }
  const layer = { ...DEFAULT_CLIP_LAYER, ...clip.layer };
  if (!["normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn"].includes(layer.blendMode)) throw new EditGraphError(`片段 ${clip.id} 的圖層混合模式不合法`);
  for (const [property, expression] of Object.entries(clip.expressions ?? {})) {
    if (!["x", "y", "scale", "rotation", "opacity"].includes(property) || typeof expression !== "string") throw new EditGraphError(`片段 ${clip.id} 的表達式屬性不合法`);
    try { assertHaoExpression(expression); } catch (error) { throw new EditGraphError(`片段 ${clip.id} 的 ${property} 表達式不合法：${error instanceof Error ? error.message : String(error)}`); }
  }
  if (clip.color.brightness < -1 || clip.color.brightness > 1
    || clip.color.contrast < 0.1 || clip.color.contrast > 3
    || clip.color.saturation < 0 || clip.color.saturation > 3
    || clip.color.hue < -180 || clip.color.hue > 180
    || clip.color.exposure < -5 || clip.color.exposure > 5
    || clip.color.temperature < -1 || clip.color.temperature > 1
    || clip.color.tint < -1 || clip.color.tint > 1
    || ![clip.color.whiteBalanceRed, clip.color.whiteBalanceGreen, clip.color.whiteBalanceBlue].every(value => Number.isFinite(value) && Math.abs(value) <= 4)
    || clip.color.pivot < 0.1 || clip.color.pivot > 0.9
    || clip.color.shadows < -1 || clip.color.shadows > 1
    || clip.color.highlights < -1 || clip.color.highlights > 1
    || clip.color.blacks < -1 || clip.color.blacks > 1
    || clip.color.whites < -1 || clip.color.whites > 1
    || !Object.values(clip.color).every(Number.isFinite)) {
    throw new EditGraphError(`片段 ${clip.id} 的調色值不合法`);
  }
  if (clip.creative) {
    if (clip.creative.effectPresetIds.length > 4 || new Set(clip.creative.effectPresetIds).size !== clip.creative.effectPresetIds.length
      || clip.creative.effectPresetIds.some((id) => !id.trim()) || (clip.creative.lookPresetId !== undefined && !clip.creative.lookPresetId.trim())) {
      throw new EditGraphError(`片段 ${clip.id} 的 Creative presets 不合法`);
    }
    const nativeEffects = clip.creative.nativeEffectInstances ?? [];
    if (nativeEffects.length > 8 || new Set(nativeEffects.map((instance) => instance.id)).size !== nativeEffects.length) {
      throw new EditGraphError(`片段 ${clip.id} 的原生效果數量或 instance id 不合法`);
    }
    if (nativeEffects.filter(isTransformMotionBlurInstance).length > 1) {
      throw new EditGraphError(`片段 ${clip.id} 最多只能有一個動態模糊`);
    }
    const enabledNativeEffects = nativeEffects.filter((instance) => instance.enabled);
    const enabledMotionBlurIndex = enabledNativeEffects.findIndex(isTransformMotionBlurInstance);
    if (enabledMotionBlurIndex >= 0 && enabledMotionBlurIndex !== enabledNativeEffects.length - 1) {
      throw new EditGraphError(`片段 ${clip.id} 的動態模糊必須是最後一個視覺效果`);
    }
    for (const instance of nativeEffects) {
      if (!instance.id.trim() || !/^[a-z][a-z0-9.-]{2,127}$/.test(instance.pluginId)
        || !/^[a-z][a-z0-9_.-]{0,95}$/.test(instance.capabilityId)
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(instance.pluginVersion)
        || !/^[a-f0-9]{64}$/.test(instance.manifestSha256)
        || Object.keys(instance.parameters).length > 64
        || Object.entries(instance.parameters).some(([key, value]) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(key)
          || (typeof value === "number" && !Number.isFinite(value))
          || (typeof value === "string" && value.length > 500))) {
        throw new EditGraphError(`片段 ${clip.id} 的原生效果 instance 不合法：${instance.id}`);
      }
      if (isTransformMotionBlurInstance(instance)) {
        try { transformMotionBlurParameters(instance); } catch (error) {
          throw new EditGraphError(error instanceof Error ? error.message : String(error));
        }
        if (instance.enabled && ([clip.transform.opacity, ...clip.keyframes.map((keyframe) => keyframe.transform.opacity)]
            .some((opacity) => Math.abs(opacity - clip.transform.opacity) > EPSILON))) {
          throw new EditGraphError(`片段 ${clip.id} 的時間動態模糊取樣期間透明度必須固定`);
        }
      }
    }
    for (const transition of [clip.creative.transitionIn, clip.creative.transitionOut]) {
      if (transition && (!transition.presetId.trim() || transition.duration < 1 / project.fps || transition.duration > Math.min(2, clip.duration))) {
        throw new EditGraphError(`片段 ${clip.id} 的轉場不合法`);
      }
    }
  }
  if (clip.layout) {
    for (const [name, rect] of [["crop", clip.layout.crop], ["viewport", clip.layout.viewport]] as const) {
      if (!Object.values(rect).every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
        || rect.x + rect.width > 1 + EPSILON || rect.y + rect.height > 1 + EPSILON) {
        throw new EditGraphError(`片段 ${clip.id} 的 ${name} 版面範圍不合法`);
      }
    }
  }
  const keyframeIds = new Set<string>();
  let previousTime = -1;
  for (const keyframe of clip.keyframes) {
    if (!keyframe.id.trim() || keyframeIds.has(keyframe.id)) throw new EditGraphError(`片段 ${clip.id} 的關鍵幀 id 無效或重複`);
    if (!Number.isFinite(keyframe.time) || keyframe.time < 0 || keyframe.time > clip.duration + EPSILON || keyframe.time <= previousTime) {
      throw new EditGraphError(`片段 ${clip.id} 的關鍵幀時間不合法、重複或未排序`);
    }
    if (keyframe.transform.scale <= 0 || keyframe.transform.opacity < 0 || keyframe.transform.opacity > 1
      || !Object.values(keyframe.transform).every(Number.isFinite)) {
      throw new EditGraphError(`片段 ${clip.id} 的關鍵幀 transform 不合法`);
    }
    if (keyframe.color.brightness < -1 || keyframe.color.brightness > 1
      || keyframe.color.contrast < 0.1 || keyframe.color.contrast > 3
      || keyframe.color.saturation < 0 || keyframe.color.saturation > 3
      || keyframe.color.hue < -180 || keyframe.color.hue > 180
      || keyframe.color.exposure < -5 || keyframe.color.exposure > 5
      || keyframe.color.temperature < -1 || keyframe.color.temperature > 1
      || keyframe.color.tint < -1 || keyframe.color.tint > 1
      || ![keyframe.color.whiteBalanceRed, keyframe.color.whiteBalanceGreen, keyframe.color.whiteBalanceBlue].every(value => Number.isFinite(value) && Math.abs(value) <= 4)
      || keyframe.color.pivot < 0.1 || keyframe.color.pivot > 0.9
      || keyframe.color.shadows < -1 || keyframe.color.shadows > 1
      || keyframe.color.highlights < -1 || keyframe.color.highlights > 1
      || keyframe.color.blacks < -1 || keyframe.color.blacks > 1
      || keyframe.color.whites < -1 || keyframe.color.whites > 1
      || !Object.values(keyframe.color).every(Number.isFinite)) {
      throw new EditGraphError(`片段 ${clip.id} 的關鍵幀調色值不合法`);
    }
    keyframeIds.add(keyframe.id);
    previousTime = keyframe.time;
  }
  const asset = findAsset(project, clip.assetId);
  if (clip.chromaKey) {
    const key = clip.chromaKey;
    const values = [key.similarity, key.softness, key.edgeBias, key.despill];
    const colorMatch = /^#[0-9a-f]{6}$/i.test(key.screenColor);
    const channels = colorMatch ? [1, 3, 5].map((start) => Number.parseInt(key.screenColor.slice(start, start + 2), 16)) : [];
    const dominant = key.screen === "green" ? channels[1] : channels[2];
    const others = key.screen === "green" ? [channels[0], channels[2]] : [channels[0], channels[1]];
    if (key.schema !== "editkin.chroma-key/v1" || key.engine !== "editkin-chroma-distance-keyer/v1"
      || typeof key.enabled !== "boolean" || !["green", "blue"].includes(key.screen) || !colorMatch
      || !values.every(Number.isFinite) || key.similarity < 0 || key.similarity > .5 || key.softness < .005 || key.softness > .5
      || key.edgeBias < -.1 || key.edgeBias > .1 || key.despill < 0 || key.despill > 1
      || !Number.isFinite(dominant) || others.some((value) => !Number.isFinite(value)) || dominant < Math.max(...others) + 16) {
      throw new EditGraphError(`片段 ${clip.id} 的綠／藍幕 Keyer 設定不合法`);
    }
    if (key.enabled && project.colorManagement?.mode === "aces2") throw new EditGraphError("綠／藍幕 Keyer v1 目前只接受 Rec.709 專案；ACES 路徑會安全阻擋，不做錯誤色域運算");
    if (key.enabled && project.scene25d?.enabled) throw new EditGraphError("綠／藍幕 Keyer v1 尚未進入透明深度 2.5D 路徑");
    if (key.enabled && (clip.layer?.role ?? "content") !== "content") throw new EditGraphError("綠／藍幕 Keyer 只能套用在一般影像圖層");
  }
  if (clip.sourceStart + clip.duration > asset.duration + EPSILON) {
    throw new EditGraphError(`片段 ${clip.id} 超過素材 ${asset.name} 的時長`);
  }
  if (track.kind === "audio" && asset.kind !== "audio" && asset.kind !== "video") {
    throw new EditGraphError(`音訊軌不能使用 ${asset.kind} 素材`);
  }
  if (track.kind === "video" && asset.kind !== "video" && asset.kind !== "image") {
    throw new EditGraphError(`視訊軌不能使用 ${asset.kind} 素材`);
  }
}

/** Validate one asset with the exact same contract used by whole-project validation. */
export function validateMediaAsset(project: Pick<EditProject, "fps">, asset: MediaAsset): void {
    if (!asset.name.trim() || !asset.uri.trim() || asset.duration <= 0) {
      throw new EditGraphError(`素材 ${asset.id} 缺少必要資料`);
    }
    if (asset.derivatives && (!/^[a-f0-9]{64}$/i.test(asset.derivatives.sourceSha256)
      || !asset.derivatives.generatedAt.trim()
      || (asset.derivatives.previewRecipe !== undefined && (typeof asset.derivatives.previewRecipe !== "string"
        || asset.derivatives.previewRecipe.length > 160 || !/^editkin\.browser-proxy[-a-z0-9./]+$/.test(asset.derivatives.previewRecipe)))
      || ((asset.derivatives.proxyWidth === undefined) !== (asset.derivatives.proxyHeight === undefined))
      || (asset.derivatives.proxyWidth !== undefined && (!Number.isSafeInteger(asset.derivatives.proxyWidth) || !Number.isSafeInteger(asset.derivatives.proxyHeight)
        || asset.derivatives.proxyWidth <= 0 || asset.derivatives.proxyHeight! <= 0))
      || (asset.derivatives.proxyUri === undefined && (asset.derivatives.proxyWidth !== undefined || asset.derivatives.proxyHeight !== undefined))
      || ((asset.derivatives.proxyColor === undefined) !== (asset.derivatives.proxyColorContract === undefined))
      || (asset.derivatives.proxyColor !== undefined && (!asset.derivatives.proxyUri
        || asset.derivatives.proxyColorContract !== "editkin.browser-display-proxy/v1"
        || !["auto", "rec709"].includes(asset.derivatives.proxyColor.interpretation)
        || (asset.derivatives.proxyColor.interpretation === "rec709" && (asset.derivatives.proxyColor.primaries !== "bt709"
          || asset.derivatives.proxyColor.transfer !== "bt709" || asset.derivatives.proxyColor.matrix !== "bt709" || asset.derivatives.proxyColor.range !== "tv"))))
      || ((asset.derivatives.overlayProxyWidth === undefined) !== (asset.derivatives.overlayProxyHeight === undefined))
      || ((asset.derivatives.overlayProxyFrameRateNumerator === undefined) !== (asset.derivatives.overlayProxyFrameRateDenominator === undefined))
      || (asset.derivatives.overlayProxyUri === undefined && (asset.derivatives.overlayProxyWidth !== undefined || asset.derivatives.overlayProxyHeight !== undefined
        || asset.derivatives.overlayProxyFrameRateNumerator !== undefined || asset.derivatives.overlayProxyFrameRateDenominator !== undefined || asset.derivatives.overlayProxyProfile !== undefined))
      || (asset.derivatives.overlayProxyUri !== undefined && (!Number.isSafeInteger(asset.derivatives.overlayProxyWidth) || !Number.isSafeInteger(asset.derivatives.overlayProxyHeight)
        || !Number.isSafeInteger(asset.derivatives.overlayProxyFrameRateNumerator) || !Number.isSafeInteger(asset.derivatives.overlayProxyFrameRateDenominator)
        || asset.derivatives.overlayProxyWidth! <= 0 || asset.derivatives.overlayProxyHeight! <= 0
        || asset.derivatives.overlayProxyFrameRateNumerator! <= 0 || asset.derivatives.overlayProxyFrameRateDenominator! <= 0
        || asset.derivatives.overlayProxyProfile !== "editkin-small-overlay-performance/v1")))) {
      throw new EditGraphError(`素材 ${asset.id} 的衍生檔 metadata 不合法`);
    }
    if (asset.color && !["auto", "rec709", "linear_rec709", "srgb", "hlg", "pq", "acescct", "apple_log", "arri_logc3", "arri_logc4", "bmd_film_gen5", "canon_log2", "canon_log3", "dji_dlog", "panasonic_vlog", "red_log3g10", "sony_slog3_cine", "log_unresolved"].includes(asset.color.interpretation)) {
      throw new EditGraphError(`素材 ${asset.id} 的色彩空間解讀不合法`);
    }
    if (asset.imageSequence) {
      const sequence = asset.imageSequence;
      const duration = sequence.frameCount * sequence.timebase.numerator / sequence.timebase.denominator;
      const projectTimebase = Math.abs(project.fps - 24_000 / 1_001) < 0.001 ? { numerator: 1_001, denominator: 24_000 }
        : Math.abs(project.fps - 30_000 / 1_001) < 0.001 ? { numerator: 1_001, denominator: 30_000 }
          : Math.abs(project.fps - 60_000 / 1_001) < 0.001 ? { numerator: 1_001, denominator: 60_000 }
            : { numerator: 1, denominator: Math.round(project.fps) };
      if (asset.kind !== "image" || asset.color?.interpretation !== "linear_rec709" || asset.alphaMode !== "straight"
        || sequence.lastFrame !== sequence.startFrame + sequence.frameCount - 1
        || Math.abs(asset.duration - duration) > EPSILON
        || sequence.timebase.numerator !== projectTimebase.numerator || sequence.timebase.denominator !== projectTimebase.denominator
        || !/^[a-f0-9]{64}$/i.test(sequence.sequenceSha256) || !/^[a-f0-9]{64}$/i.test(sequence.manifestSha256)
        || !sequence.previewUri.trim()) {
        throw new EditGraphError(`OpenEXR 序列 ${asset.id} 的影格、時間基準或色彩契約不合法`);
      }
    }
}

export function validateProject(project: EditProject): EditProject {
  if (project.schemaVersion !== 8) throw new EditGraphError("不支援的 EditGraph schema");
  if (!Number.isInteger(project.revision) || project.revision < 0) throw new EditGraphError("專案 revision 不合法");
  if (!project.id.trim() || !project.name.trim()) throw new EditGraphError("專案 id 與名稱不可空白");
  if (project.width <= 0 || project.height <= 0 || project.fps <= 0 || project.fps > 240) {
    throw new EditGraphError("專案解析度或 fps 不合法");
  }

  const assetIds = new Set<string>();
  for (const asset of project.assets) {
    if (assetIds.has(asset.id)) throw new EditGraphError(`重複素材 id：${asset.id}`);
    validateMediaAsset(project, asset);
    assetIds.add(asset.id);
  }

  const compositionsById = new Map<string, EditComposition>();
  for (const composition of project.compositions) {
    if (composition.schema !== "editkin.composition/v1" || !composition.id.trim() || compositionsById.has(composition.id) || !composition.name.trim()) {
      throw new EditGraphError(`預合成 ${composition.id} 的識別不合法或重複`);
    }
    if (![composition.width, composition.height, composition.fps, composition.duration].every(Number.isFinite)
      || composition.width <= 0 || composition.height <= 0 || composition.fps <= 0 || composition.fps > 240 || composition.duration <= 0) {
      throw new EditGraphError(`預合成 ${composition.id} 的畫布或時間設定不合法`);
    }
    compositionsById.set(composition.id, composition);
  }
  for (const asset of project.assets.filter((candidate) => candidate.compositionId)) {
    const composition = compositionsById.get(asset.compositionId!);
    if (asset.kind !== "video" || !composition || asset.uri !== `editkin-composition://${asset.compositionId}`
      || Math.abs(asset.duration - composition.duration) > EPSILON) {
      throw new EditGraphError(`預合成素材 ${asset.id} 的 composition 參照或時長不合法`);
    }
  }
  const compositionDependencies = new Map<string, Set<string>>();
  for (const composition of project.compositions) {
    const dependencies = new Set<string>();
    for (const clip of composition.tracks.flatMap((track) => track.clips)) {
      const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
      if (asset?.compositionId) dependencies.add(asset.compositionId);
    }
    compositionDependencies.set(composition.id, dependencies);
  }
  const visitingCompositions = new Set<string>();
  const visitedCompositions = new Set<string>();
  const visitComposition = (compositionId: string): void => {
    if (visitingCompositions.has(compositionId)) throw new EditGraphError(`預合成出現環狀參照：${compositionId}`);
    if (visitedCompositions.has(compositionId)) return;
    visitingCompositions.add(compositionId);
    for (const dependency of compositionDependencies.get(compositionId) ?? []) {
      if (!compositionsById.has(dependency)) throw new EditGraphError(`預合成 ${compositionId} 參照不存在的 composition：${dependency}`);
      visitComposition(dependency);
    }
    visitingCompositions.delete(compositionId);
    visitedCompositions.add(compositionId);
  };
  for (const composition of project.compositions) visitComposition(composition.id);
  for (const composition of project.compositions) {
    const validationAssets = project.assets.map((asset) => ({ ...asset, compositionId: undefined }));
    const nested = projectFromComposition(project, composition, validationAssets, []);
    validateProject(nested);
    const actualDuration = projectDuration(nested);
    if (Math.abs(actualDuration - composition.duration) > Math.max(EPSILON, 0.5 / composition.fps)) {
      throw new EditGraphError(`預合成 ${composition.id} 的時長 ${composition.duration} 與內容 ${actualDuration} 不一致`);
    }
  }

  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const track of project.tracks) {
    if (trackIds.has(track.id)) throw new EditGraphError(`重複軌道 id：${track.id}`);
    trackIds.add(track.id);
    const ordered = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
    ordered.forEach((clip, index) => {
      if (clipIds.has(clip.id)) throw new EditGraphError(`重複片段 id：${clip.id}`);
      clipIds.add(clip.id);
      validateClipForTrack(project, track, clip);
      const previous = ordered[index - 1];
      const next = ordered[index + 1];
      if (previous && previous.timelineStart + previous.duration > clip.timelineStart + EPSILON) {
        throw new EditGraphError(`軌道 ${track.name} 的片段重疊：${previous.id} / ${clip.id}`);
      }
      if (clip.creative?.transitionIn && (!previous || Math.abs(previous.timelineStart + previous.duration - clip.timelineStart) > EPSILON)) {
        throw new EditGraphError(`片段 ${clip.id} 的入場轉場需要前方相鄰片段`);
      }
      if (clip.creative?.transitionOut && (!next || Math.abs(clip.timelineStart + clip.duration - next.timelineStart) > EPSILON)) {
        throw new EditGraphError(`片段 ${clip.id} 的離場轉場需要後方相鄰片段`);
      }
    });
  }
  const clipsById = new Map(project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
  const visualClipIds = new Set(project.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips.map((clip) => clip.id)));
  const contentClipIds = new Set(project.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips.filter((clip) => (clip.layer?.role ?? "content") === "content").map((clip) => clip.id)));
  const parentableClipIds = new Set(project.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips.filter((clip) => (clip.layer?.role ?? "content") !== "adjustment").map((clip) => clip.id)));
  const layerEdges = new Map<string, string[]>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const layer = { ...DEFAULT_CLIP_LAYER, ...clip.layer };
      if (!["content", "adjustment", "controller"].includes(layer.role ?? "content")) throw new EditGraphError(`片段 ${clip.id} 的圖層角色不合法`);
      if ((layer.role === "adjustment" || layer.role === "controller") && track.kind !== "video") throw new EditGraphError(`${layer.role === "controller" ? "Null 控制器" : "調整圖層"} ${clip.id} 必須位於影像軌`);
      if (layer.role === "adjustment" && layer.parentClipId) throw new EditGraphError(`調整圖層 ${clip.id} 不能作為子圖層`);
      const references: string[] = [];
      if (layer.parentClipId) {
        if (layer.parentClipId === clip.id || !clipsById.has(layer.parentClipId) || !visualClipIds.has(layer.parentClipId) || !parentableClipIds.has(layer.parentClipId)) throw new EditGraphError(`片段 ${clip.id} 的父圖層參照不合法`);
        references.push(layer.parentClipId);
      }
      if (layer.trackMatte) {
        if (!["alpha", "alpha_inverted", "luma", "luma_inverted"].includes(layer.trackMatte.mode)
          || layer.trackMatte.sourceClipId === clip.id || !visualClipIds.has(layer.trackMatte.sourceClipId) || !contentClipIds.has(layer.trackMatte.sourceClipId)) {
          throw new EditGraphError(`片段 ${clip.id} 的 Track Matte 參照不合法`);
        }
        if (layer.role === "adjustment" || layer.role === "controller") throw new EditGraphError(`${layer.role === "controller" ? "Null 控制器" : "調整圖層"} ${clip.id} 不能使用 Track Matte`);
        references.push(layer.trackMatte.sourceClipId);
      }
      layerEdges.set(clip.id, references);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitLayer = (clipId: string) => {
    if (visiting.has(clipId)) throw new EditGraphError(`圖層參照形成循環：${clipId}`);
    if (visited.has(clipId)) return;
    visiting.add(clipId);
    for (const reference of layerEdges.get(clipId) ?? []) visitLayer(reference);
    visiting.delete(clipId);
    visited.add(clipId);
  };
  for (const clipId of layerEdges.keys()) visitLayer(clipId);
  validateScene25dProductContract(project);
  validateParticleSimulationProductContract(project);
  const captionIds = new Set<string>();
  for (const caption of project.captions) {
    if (captionIds.has(caption.id)) throw new EditGraphError(`重複字幕 id：${caption.id}`);
    if (!caption.text.trim()) throw new EditGraphError(`字幕 ${caption.id} 不可空白`);
    if (caption.translation && (!caption.translation.text.trim() || !caption.translation.language.trim())) throw new EditGraphError(`字幕 ${caption.id} 的第二行翻譯不合法`);
    if (caption.start < 0 || caption.duration <= 0) throw new EditGraphError(`字幕 ${caption.id} 的時間範圍不合法`);
    captionIds.add(caption.id);
  }
  if (!project.captionStyle.presetId.trim() || !project.captionStyle.fontFamily.trim() || project.captionStyle.fontSize <= 0
    || project.captionStyle.outlineWidth < 0 || project.captionStyle.marginV < 0 || project.captionStyle.shadow < 0
    || !Number.isFinite(project.captionStyle.letterSpacing) || !project.captionStyle.translationFontFamily.trim()
    || project.captionStyle.translationFontSize <= 0 || !project.captionStyle.translationColor.trim()) {
    throw new EditGraphError("字幕樣式不合法");
  }
  const validRect = (rect: { x: number; y: number; width: number; height: number }) => Object.values(rect).every(Number.isFinite)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1 + EPSILON && rect.y + rect.height <= 1 + EPSILON;
  const motionTrackIds = new Set<string>();
  for (const track of project.motionTracks) {
    if (!track.id.trim() || motionTrackIds.has(track.id) || !track.name.trim() || !track.engine.trim() || !clipIds.has(track.clipId)) throw new EditGraphError(`追蹤資料 ${track.id} 的識別或片段參照不合法`);
    if (!Number.isFinite(track.analysisFps) || track.analysisFps <= 0 || track.analysisFps > 120 || !validRect(track.initialRect)
      || !Number.isFinite(track.lostRatio) || track.lostRatio < 0 || track.lostRatio > 1 || !track.createdAt.trim()) throw new EditGraphError(`追蹤資料 ${track.id} 的 metadata 不合法`);
    let previousFrame = -1;
    let previousTime = -1;
    for (const point of track.points) {
      if (!Number.isInteger(point.frame) || point.frame < 0 || point.frame <= previousFrame || !Number.isFinite(point.time) || point.time < 0
        || point.time <= previousTime || !validRect(point.rect) || !Number.isFinite(point.confidence) || point.confidence < 0 || point.confidence > 1
        || !["tracked", "held", "lost", "manual"].includes(point.status)
        || (point.activity !== undefined && (!Number.isFinite(point.activity) || point.activity < 0 || point.activity > 1))
        || (point.rotationDegrees !== undefined && !Number.isFinite(point.rotationDegrees))
        || (point.scale !== undefined && (!Number.isFinite(point.scale) || point.scale <= 0))
        || (point.quad !== undefined && point.quad.some((corner) => !Number.isFinite(corner.x) || !Number.isFinite(corner.y) || corner.x < 0 || corner.x > 1 || corner.y < 0 || corner.y > 1))) throw new EditGraphError(`追蹤資料 ${track.id} 的 frame 資料不合法`);
      previousFrame = point.frame;
      previousTime = point.time;
    }
    motionTrackIds.add(track.id);
  }
  const maskIds = new Set<string>();
  for (const clip of project.tracks.flatMap((track) => track.clips)) {
    const asset = project.assets.find((item) => item.id === clip.assetId);
    if (clip.masks?.length && asset?.kind === "audio") throw new EditGraphError(`音訊片段 ${clip.id} 不能使用遮罩`);
    for (const mask of clip.masks ?? []) {
      if (!mask.id.trim() || maskIds.has(mask.id) || !mask.name.trim()) throw new EditGraphError(`遮罩 ${mask.id} 的識別不合法`);
      if (!Number.isFinite(mask.opacity) || mask.opacity < 0 || mask.opacity > 1 || !Number.isFinite(mask.feather) || mask.feather < 0 || mask.feather > 0.25
        || !Number.isFinite(mask.expansion) || mask.expansion < -0.5 || mask.expansion > 0.5 || mask.path.length < 3 || mask.path.length > 64) throw new EditGraphError(`遮罩 ${mask.id} 的基本參數不合法`);
      const pointIds = new Set<string>();
      const validPoint = (point: { id: string; x: number; y: number }) => point.id.trim() && !pointIds.has(point.id) && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
      for (const point of mask.path) { if (!validPoint(point)) throw new EditGraphError(`遮罩 ${mask.id} 的路徑點不合法`); pointIds.add(point.id); }
      let previousFrame = -1;
      for (const keyframe of mask.keyframes) {
        if (!Number.isInteger(keyframe.frame) || keyframe.frame < 0 || keyframe.frame <= previousFrame || keyframe.time < 0 || keyframe.time > clip.duration + EPSILON
          || keyframe.points.length < 3 || keyframe.points.length > 64 || keyframe.confidence < 0 || keyframe.confidence > 1) throw new EditGraphError(`遮罩 ${mask.id} 的關鍵幀不合法`);
        previousFrame = keyframe.frame;
      }
      if (mask.trackId) {
        const track = project.motionTracks.find((item) => item.id === mask.trackId);
        if (!track || track.clipId !== clip.id) throw new EditGraphError(`遮罩 ${mask.id} 的追蹤參照不合法`);
      }
      if (![mask.refine.edgeShift, mask.refine.contrast, mask.refine.chatterReduction].every(Number.isFinite)
        || mask.refine.edgeShift < -0.25 || mask.refine.edgeShift > 0.25 || mask.refine.contrast < 0 || mask.refine.contrast > 1 || mask.refine.chatterReduction < 0 || mask.refine.chatterReduction > 1) throw new EditGraphError(`遮罩 ${mask.id} 的邊緣精修不合法`);
      if (mask.frozenRange && (mask.frozenRange.fromFrame < 0 || mask.frozenRange.toFrame < mask.frozenRange.fromFrame || mask.frozenRange.toFrame > Math.ceil(clip.duration * project.fps))) throw new EditGraphError(`遮罩 ${mask.id} 的凍結範圍不合法`);
      if (mask.rotoCorrections) {
        const correctionIds = new Set<string>();
        for (const stroke of mask.rotoCorrections) {
          if (!stroke.id.trim() || correctionIds.has(stroke.id) || !Number.isInteger(stroke.frame) || stroke.frame < 0 || stroke.frame > Math.ceil(clip.duration * 12) || !["foreground", "background"].includes(stroke.mode) || !Number.isFinite(stroke.radius) || stroke.radius < .001 || stroke.radius > .25 || stroke.points.length < 1 || stroke.points.length > 4096 || stroke.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) throw new EditGraphError(`遮罩 ${mask.id} 的 Roto 修正筆刷不合法`);
          correctionIds.add(stroke.id);
        }
      }
      if (mask.matteSequence) {
        const sequence = mask.matteSequence;
        const routing = sequence.regionMemoryRouting;
        const alpha = sequence.alphaRefinement;
        const alphaLimit = sequence.width * sequence.height * sequence.frameCount;
        const validAlpha = alpha !== undefined && hasExactKeys(alpha, [
          "schema", "engine", "appliedFrames", "radius", "backgroundThreshold", "foregroundThreshold", "coarseWeight",
          "temporalStability", "temporalGate", "changedPixels", "fractionalPixels", "solvedPixels", "meanSolveConfidence",
        ]) && alpha.schema === "editkin.optical-alpha-refinement-aggregate/v1"
          && alpha.engine === "editkin-self-authored-optical-alpha-refiner/v1"
          && alpha.appliedFrames === sequence.frameCount && Number.isInteger(alpha.radius) && alpha.radius >= 2 && alpha.radius <= 32
          && [alpha.backgroundThreshold, alpha.foregroundThreshold, alpha.coarseWeight, alpha.temporalStability, alpha.temporalGate, alpha.meanSolveConfidence].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
          && alpha.backgroundThreshold + .05 < alpha.foregroundThreshold
          && [alpha.changedPixels, alpha.fractionalPixels, alpha.solvedPixels].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= alphaLimit)
          && alpha.solvedPixels <= alpha.fractionalPixels;
        const validRouting = routing !== undefined && hasExactKeys(routing, [
          "schema", "requested", "executed", "candidateAttempted", "deterministicFallback",
        ]) && routing.schema === "editkin.region-memory-routing/v1"
          && routing.requested === "fixed_baseline" && routing.executed === "fixed_baseline"
          && routing.candidateAttempted === false && routing.deterministicFallback === false;
        const correctedFrames = sequence.correctedFrames ?? [];
        const validCorrections = (sequence.correctionStrokesApplied === undefined
          || Number.isInteger(sequence.correctionStrokesApplied) && sequence.correctionStrokesApplied >= 0)
          && correctedFrames.length <= PRODUCT_AUTO_ROTO_MAX_FRAMES
          && correctedFrames.every((frame, index) => Number.isInteger(frame) && frame >= 0 && frame < sequence.frameCount
            && (index === 0 || frame > correctedFrames[index - 1]));
        if (mask.kind !== "subject"
          || sequence.schema !== "editkin.auto-roto-matte/v1" || sequence.engine !== PRODUCT_AUTO_ROTO_ENGINE
          || sequence.qualityState !== "diagnostic" || sequence.frozen !== true
          || (sequence.staleReason !== undefined && (sequence.staleReason !== "clip-time-range-changed" || sequence.stale !== true))
          || !productAutoRotoRouteReceiptShapeSchema.safeParse(sequence.routeReceipt).success
          || !validAlpha || !validRouting || !validCorrections || !validProductMatteArtifactInventory(sequence)
          || !Number.isInteger(sequence.width) || sequence.width < 16 || sequence.width > 32_768
          || !Number.isInteger(sequence.height) || sequence.height < 16 || sequence.height > 32_768
          || !Number.isFinite(sequence.analysisFps) || sequence.analysisFps <= 0 || sequence.analysisFps > 12
          || !Number.isInteger(sequence.frameCount) || sequence.frameCount <= 0 || sequence.frameCount > PRODUCT_AUTO_ROTO_MAX_FRAMES
          || !Number.isSafeInteger(sequence.sequenceBytes) || (sequence.sequenceBytes ?? 0) <= 0
          || (sequence.sequenceBytes ?? 0) > PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES
          || !Number.isFinite(sequence.meanBoundaryChatter) || sequence.meanBoundaryChatter < 0 || sequence.meanBoundaryChatter > 1) {
          throw new EditGraphError(`遮罩 ${mask.id} 的逐像素 matte sequence 不合法`);
        }
      }
      maskIds.add(mask.id);
    }
  }
  const graphicIds = new Set<string>();
  const cssColor = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
  for (const graphic of project.motionGraphics) {
    if (!["hao.motion-composition/v1", "hao.motion-composition/v2"].includes(graphic.schema) || !graphic.id.trim() || graphicIds.has(graphic.id) || !graphic.name.trim() || !graphic.text.trim()) throw new EditGraphError(`動態圖卡 ${graphic.id} 的識別或文字不合法`);
    if (![graphic.timelineStart, graphic.duration, graphic.x, graphic.y, graphic.width, graphic.fontSize, graphic.offsetX, graphic.offsetY, graphic.fontWeight ?? 700, graphic.letterSpacing ?? 0, graphic.outlineWidth ?? 0, graphic.shadowDepth ?? 0, graphic.cornerRadius ?? 0].every(Number.isFinite)
      || graphic.timelineStart < 0 || graphic.duration <= 0 || graphic.x < 0 || graphic.x > 1 || graphic.y < 0 || graphic.y > 1 || graphic.width <= 0 || graphic.width > 1 || graphic.fontSize <= 0
      || (graphic.fontFamily !== undefined && !graphic.fontFamily.trim()) || (graphic.fontWeight ?? 700) < 100 || (graphic.fontWeight ?? 700) > 1000 || (graphic.outlineWidth ?? 0) < 0 || (graphic.outlineWidth ?? 0) > 30 || (graphic.shadowDepth ?? 0) < 0 || (graphic.shadowDepth ?? 0) > 40
      || !cssColor.test(graphic.textColor) || !cssColor.test(graphic.backgroundColor) || !cssColor.test(graphic.accentColor)
      || (graphic.visualStyle !== undefined && !["solid_panel", "holo_scan_cyan", "holo_grid_lime", "target_lock_red", "spectral_wire_violet", "depth_glass_blue", "telemetry_beam_amber", "neon_extrude_white", "quantum_label_magenta"].includes(graphic.visualStyle))
      || (graphic.trackId !== undefined && !motionTrackIds.has(graphic.trackId))
      || (graphic.trackingMode !== undefined && !["anchor", "surface"].includes(graphic.trackingMode))
      || (graphic.trackingMode === "surface" && (!graphic.trackId || project.motionTracks.find((track) => track.id === graphic.trackId)?.points.some((point) => point.status !== "lost" && !point.quad)))) throw new EditGraphError(`動態圖卡 ${graphic.id} 的版面或追蹤參照不合法`);
    try { assertMotionGraphicV2Contract(graphic, project.fps); } catch (error) {
      throw new EditGraphError(`動態圖卡 ${graphic.id} 的 v2 合成契約不合法：${error instanceof Error ? error.message : String(error)}`);
    }
    graphicIds.add(graphic.id);
  }
  if (project.director.schema !== "editkin.director-console/v1" || !["draft", "reviewing", "changes_requested", "ready_for_hao_review"].includes(project.director.reviewState)) {
    throw new EditGraphError("導演台狀態不合法");
  }
  const markerIds = new Set<string>();
  for (const marker of project.director.markers) {
    if (!marker.id.trim() || markerIds.has(marker.id) || !marker.title.trim() || marker.time < 0 || !Number.isFinite(marker.time)
      || !["beat", "note", "risk", "pickup"].includes(marker.kind) || !["open", "resolved"].includes(marker.status) || !marker.createdAt.trim()) {
      throw new EditGraphError(`導演台註記 ${marker.id} 不合法`);
    }
    markerIds.add(marker.id);
  }
  const application = project.templateApplication;
  const ownedElements = [
    ...project.motionGraphics.map((item) => item.templateOwner),
    ...project.captions.map((item) => item.templateOwner),
    ...project.director.markers.map((item) => item.templateOwner),
  ].filter((owner) => owner !== undefined);
  if (ownedElements.length && !application) throw new EditGraphError("模板元素缺少有效的模板套用紀錄");
  for (const owner of ownedElements) {
    if (!application || owner!.schema !== "editkin.template-element-owner/v1"
      || owner!.sessionId !== application.sessionId || owner!.templateId !== application.templateId
      || owner!.format !== application.format || !owner!.role.trim()) {
      throw new EditGraphError("模板元素所有權與目前模板套用紀錄不一致");
    }
  }
  if (application) {
    const beforeIds = application.before.clips.map((clip) => clip.clipId);
    const appliedIds = application.applied.clips.map((clip) => clip.clipId);
    if (!application.sessionId.trim() || !application.templateId.trim() || !application.templateName.trim()
      || new Set(beforeIds).size !== beforeIds.length || new Set(appliedIds).size !== appliedIds.length
      || beforeIds.length !== appliedIds.length || beforeIds.some((id, index) => id !== appliedIds[index])
    ) {
      throw new EditGraphError("模板套用回復紀錄不完整或已失效");
    }
  }
  return project;
}
