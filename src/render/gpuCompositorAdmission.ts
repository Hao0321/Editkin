import { animatedClipState, validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, particleSimulationEmitters } from "../domain/types";
import type { ColorAdjustments, EditProject, LayerBlendMode, TimelineClip, Transform2D } from "../domain/types";
import { buildEngineRenderGraph, motionGraphicTracking, type EngineNode, type EngineRenderGraph } from "./engineGraph";
import { isTransformMotionBlurInstance, transformMotionBlurParameters } from "../domain/transformMotionBlur";

export function nativeMediaPath(uri: string): string | undefined {
  if (/^https?:/i.test(uri) || uri.startsWith("local://")) return undefined;
  if (!uri.startsWith("file:")) return uri;
  const url = new URL(uri);
  const decoded = decodeURIComponent(url.pathname);
  return /^\/[a-zA-Z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}

export interface GpuVideoPreviewSource {
  structureKey: string;
  inputPath: string;
  sourceTime: number;
}

export interface GpuEnginePreviewGraph {
  structureKey: string;
  graph: EngineRenderGraph;
  assetBindings: Record<string, string>;
  timelineFrame: number;
  scene25dExpectation?: {
    planeCount: number;
    videoPlaneCount?: number;
    parentedPlaneCount: number;
    cameraNodeId: string;
  };
  vfxSimulationExpectation?: {
    emitterCount: number;
    particleCeiling: number;
    executor: "wgpu-bounded-particle-compute/v1" | "wgpu-resident-video-particle-overlay/v1";
  };
}

export interface GpuEngineVideoPreviewGraph extends GpuEnginePreviewGraph {
  decoderDimensions: Record<string, { width: number; height: number; source: "original" | "proxy" | "overlay-proxy" }>;
}

export interface GpuEngineVideoResourceEstimate {
  schema: "editkin.resident-video-resource-plan/v1";
  pixelCount: number;
  bytesPerVideoLayer: number;
  workingBytesPerPixel: 4 | 8;
  temporalSampleCount: number;
  temporalResidentRingSlots: number;
  temporalResidentBytes: number;
  compositorWorkingBytes: number;
  overlayBytes: number;
  particleCount: number;
  particleSnapshotCapacityPerEmitter: 2;
  particleSnapshotBytes: number;
  adjustmentCount: number;
  matteCount: number;
  adjustmentWorkingBytes: number;
  sceneDepthAttachmentCount: number;
  sceneDepthBytes: number;
  depthOfFieldPassCount: number;
  depthOfFieldAdditionalWorkingBytes: number;
  maximumFullFramePassesPerPresent: number;
  requiredBytes: number;
  budgetBytes: number;
  maxVideoLayers: number;
}

/** Mirrors the native executor's product-owned allocation model before selecting it. */
export function estimateGpuEngineVideoResources(width: number, height: number, cacheBudgetMb: number, videoLayerCount: number, overlayCount: number, adjustmentCount = 0, matteCount = 0, particleCount = 0, temporalSampleCount = 0, workingBytesPerPixel: 4 | 8 = 4, sceneDepthAttachmentCount = 0, depthOfFieldPassCount = 0): GpuEngineVideoResourceEstimate | undefined {
  if (![width, height, cacheBudgetMb, videoLayerCount, overlayCount, adjustmentCount, matteCount, particleCount, temporalSampleCount, workingBytesPerPixel, sceneDepthAttachmentCount, depthOfFieldPassCount].every(Number.isSafeInteger)
    || width <= 0 || height <= 0 || cacheBudgetMb < 64 || videoLayerCount < 1 || overlayCount < 0 || adjustmentCount < 0 || matteCount < 0 || matteCount > videoLayerCount || particleCount < 0 || particleCount > overlayCount
    || (temporalSampleCount !== 0 && (temporalSampleCount < 2 || temporalSampleCount > 8))
    || sceneDepthAttachmentCount < 0 || sceneDepthAttachmentCount > 1 || depthOfFieldPassCount < 0 || depthOfFieldPassCount > 1
    || (depthOfFieldPassCount === 1 && sceneDepthAttachmentCount !== 1)) return undefined;
  const pixelCount = width * height;
  const bytesPerVideoLayer = pixelCount * 36;
  const temporalResidentRingSlots = Math.max(0, temporalSampleCount - 3);
  const temporalResidentBytes = pixelCount * temporalResidentRingSlots * 12;
  const compositorWorkingBytes = pixelCount * 3 * workingBytesPerPixel;
  const overlayBytes = pixelCount * 4 * overlayCount;
  const particleSnapshotCapacityPerEmitter = 2 as const;
  const particleSnapshotBytes = pixelCount * 4 * particleCount * particleSnapshotCapacityPerEmitter;
  const adjustmentWorkingBytes = adjustmentCount ? pixelCount * 2 * workingBytesPerPixel : 0;
  const sceneDepthBytes = pixelCount * 4 * sceneDepthAttachmentCount;
  const depthOfFieldAdditionalWorkingBytes = 0;
  const maximumFullFramePassesPerPresent = sceneDepthAttachmentCount ? 2 + depthOfFieldPassCount : videoLayerCount + overlayCount + adjustmentCount + 1;
  const requiredBytes = bytesPerVideoLayer * videoLayerCount + temporalResidentBytes + compositorWorkingBytes + overlayBytes + particleSnapshotBytes + adjustmentWorkingBytes + sceneDepthBytes;
  const budgetBytes = cacheBudgetMb * 1024 * 1024;
  const maxVideoLayers = Math.max(0, Math.floor((budgetBytes - temporalResidentBytes - compositorWorkingBytes - overlayBytes - particleSnapshotBytes - adjustmentWorkingBytes - sceneDepthBytes) / bytesPerVideoLayer));
  if (![pixelCount, bytesPerVideoLayer, temporalResidentRingSlots, temporalResidentBytes, compositorWorkingBytes, overlayBytes, particleSnapshotBytes, adjustmentWorkingBytes, sceneDepthBytes, maximumFullFramePassesPerPresent, requiredBytes, budgetBytes, maxVideoLayers].every(Number.isSafeInteger)) return undefined;
  return { schema: "editkin.resident-video-resource-plan/v1", pixelCount, bytesPerVideoLayer, workingBytesPerPixel, temporalSampleCount, temporalResidentRingSlots, temporalResidentBytes, compositorWorkingBytes, overlayBytes, particleCount, particleSnapshotCapacityPerEmitter, particleSnapshotBytes, adjustmentCount, matteCount, adjustmentWorkingBytes, sceneDepthAttachmentCount, sceneDepthBytes, depthOfFieldPassCount, depthOfFieldAdditionalWorkingBytes, maximumFullFramePassesPerPresent, requiredBytes, budgetBytes, maxVideoLayers };
}

/**
 * The native swap-chain host owns the bounded caption subset in the same graph. Motion graphics
 * and unsupported typography still stay out of the HWND airspace path so authored content cannot
 * disappear behind a native surface.
 */
export function canPresentGpuVideoOnNativeSurface(project: EditProject): boolean {
  return commonVideoCaptionsSupported(project) && commonVideoMotionGraphicsSupported(project);
}

const COMMON_VIDEO_CAPTION_FONTS = new Set(["Noto Sans TC", "Noto Serif TC", "LXGW WenKai Mono TC", "Bebas Neue", "Fredoka"]);
const COMMON_VIDEO_CAPTION_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

export function validSurfaceQuad(quad: Array<{ x: number; y: number }> | undefined): boolean {
  if (quad?.length !== 4 || quad.some((corner) => !Number.isFinite(corner.x) || !Number.isFinite(corner.y) || corner.x < .02 || corner.x > .98 || corner.y < .02 || corner.y > .98)) return false;
  const crosses = quad.map((corner, index) => {
    const next = quad[(index + 1) % 4];
    const after = quad[(index + 2) % 4];
    return (next.x - corner.x) * (after.y - next.y) - (next.y - corner.y) * (after.x - next.x);
  });
  if (crosses.some((cross) => Math.abs(cross) <= Number.EPSILON || Math.sign(cross) !== Math.sign(crosses[0]))) return false;
  const area = Math.abs(quad.reduce((sum, corner, index) => sum + corner.x * quad[(index + 1) % 4].y - quad[(index + 1) % 4].x * corner.y, 0)) / 2;
  return area >= .0001 && quad.every((corner, index) => Math.hypot(quad[(index + 1) % 4].x - corner.x, quad[(index + 1) % 4].y - corner.y) >= .01);
}

export function commonVideoRanges(project: EditProject): Array<{ start: number; end: number }> {
  return project.tracks.filter((track) => track.kind === "video" && !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.layer?.enabled !== false && (clip.layer?.role ?? "content") === "content")
    .map((clip) => ({
      start: Math.round(clip.timelineStart * project.fps),
      end: Math.round(clip.timelineStart * project.fps) + Math.round(clip.duration * project.fps),
    }));
}

export function coveredByCommonVideoRange(start: number, duration: number, project: EditProject): boolean {
  const startFrame = Math.round(start * project.fps);
  const durationFrames = Math.round(duration * project.fps);
  return durationFrames > 0 && commonVideoRanges(project)
    .some((range) => range.start <= startFrame && startFrame + durationFrames <= range.end);
}

export function commonVideoCaptionsSupported(project: EditProject): boolean {
  if (project.captions.length > 8) return false;
  const style = project.captionStyle;
  if (!COMMON_VIDEO_CAPTION_FONTS.has(style.fontFamily)
    || !Number.isFinite(style.fontSize) || style.fontSize < 8 || style.fontSize > 192
    || !Number.isFinite(style.outlineWidth) || style.outlineWidth < 0 || style.outlineWidth > 12
    || !Number.isFinite(style.marginV) || style.marginV < 0 || style.marginV > 4096
    || !Number.isFinite(style.shadow) || style.shadow < 0 || style.shadow > 10
    || !Number.isFinite(style.letterSpacing) || style.letterSpacing < -5 || style.letterSpacing > 20
    || style.italic || ![style.color, style.outlineColor, style.backgroundColor].every((color) => COMMON_VIDEO_CAPTION_COLOR.test(color))) return false;
  return project.captions.every((cue) => cue.text.trim().length > 0 && [...cue.text].length <= 256
    && !cue.translation?.text.trim()
    && [cue.start, cue.duration].every(Number.isFinite) && cue.start >= 0
    && coveredByCommonVideoRange(cue.start, cue.duration, project));
}

export function commonVideoMotionGraphicsSupported(project: EditProject): boolean {
  if (project.motionGraphics.length > 4) return false;
  return project.motionGraphics.every((graphic) => {
    if (graphic.schema !== "hao.motion-composition/v1") return false;
    const fontFamily = graphic.fontFamily ?? "Noto Sans TC";
    const fontWeight = graphic.fontWeight ?? 700;
    const letterSpacing = graphic.letterSpacing ?? 0;
    const outlineWidth = graphic.outlineWidth ?? (graphic.kind === "card" ? 4 : 2);
    const shadowDepth = graphic.shadowDepth ?? 2;
    const cornerRadius = graphic.cornerRadius ?? 18;
    const boxHeight = graphic.fontSize * 1.25 + Math.ceil(graphic.fontSize * .36) * 2;
    let tracking: ReturnType<typeof motionGraphicTracking>;
    try { tracking = motionGraphicTracking(project, graphic); } catch { return false; }
    const trackingValid = graphic.trackId
      ? Boolean(tracking && tracking.samples.length >= 1 && tracking.samples.length <= 18_000
        && tracking.samples.every((sample) => Number.isInteger(sample.timelineFrame) && Number.isFinite(sample.x) && Number.isFinite(sample.y)
          && Number.isFinite(sample.confidence) && sample.confidence >= 0 && sample.confidence <= 1
          && ["tracked", "held", "lost", "manual"].includes(sample.status)
          && sample.x >= 0 && sample.x + graphic.width <= 1 && sample.y >= 0 && sample.y * project.height + boxHeight <= project.height
          && (graphic.trackingMode !== "surface" || (sample.status === "lost" ? sample.destinationQuad === undefined : validSurfaceQuad(sample.destinationQuad)))))
      : tracking === undefined && graphic.offsetX === 0 && graphic.offsetY === 0;
    return trackingValid && ["fade", "slide_up", "pop", "spring_soft"].includes(graphic.animation)
      && (graphic.trackingMode !== "surface" || graphic.animation === "fade")
      && graphic.text.trim().length > 0 && [...graphic.text].length <= 128
      && [graphic.timelineStart, graphic.duration, graphic.x, graphic.y, graphic.width, graphic.fontSize,
        fontWeight, letterSpacing, outlineWidth, shadowDepth, cornerRadius, graphic.offsetX, graphic.offsetY].every(Number.isFinite)
      && graphic.timelineStart >= 0 && coveredByCommonVideoRange(graphic.timelineStart, graphic.duration, project)
      && graphic.x >= 0 && graphic.x <= 1 && graphic.y >= 0 && graphic.y <= 1
      && graphic.width >= .05 && graphic.width <= 1 && graphic.x + graphic.width <= 1
      && boxHeight <= project.height && graphic.y * project.height + boxHeight <= project.height
      && graphic.fontSize >= 8 && graphic.fontSize <= 192 && fontWeight >= 100 && fontWeight <= 900
      && letterSpacing >= -5 && letterSpacing <= 20 && outlineWidth >= 0 && outlineWidth <= 12
      && shadowDepth >= 0 && shadowDepth <= 10 && cornerRadius >= 0 && cornerRadius <= 96
      && COMMON_VIDEO_CAPTION_FONTS.has(fontFamily)
      && [graphic.textColor, graphic.backgroundColor, graphic.accentColor]
        .every((color) => COMMON_VIDEO_CAPTION_COLOR.test(color));
  });
}

const WHITE_BALANCE_KEYS = ["whiteBalanceRed", "whiteBalanceGreen", "whiteBalanceBlue"] as const;
function whiteBalanceValue(color: ColorAdjustments, key: typeof WHITE_BALANCE_KEYS[number]): number {
  return color[key] === undefined ? 0 : color[key];
}
function hasLinearWhiteBalance(color: ColorAdjustments): boolean {
  return WHITE_BALANCE_KEYS.some(key => whiteBalanceValue(color, key) !== 0);
}
export function defaultColor(color: ColorAdjustments): boolean {
  return (Object.keys(DEFAULT_COLOR) as Array<keyof ColorAdjustments>).every((key) =>
    WHITE_BALANCE_KEYS.includes(key as typeof WHITE_BALANCE_KEYS[number])
      ? whiteBalanceValue(color, key as typeof WHITE_BALANCE_KEYS[number]) === 0 : color[key] === DEFAULT_COLOR[key]);
}

export function commonVideoGradeSupported(color: ColorAdjustments): boolean {
  return (Object.values(color) as number[]).every(Number.isFinite)
    && WHITE_BALANCE_KEYS.every(key => Number.isFinite(whiteBalanceValue(color, key)) && Math.abs(whiteBalanceValue(color, key)) <= 4)
    && color.hue === 0
    && color.brightness >= -1 && color.brightness <= 1
    && color.contrast >= .1 && color.contrast <= 3
    && color.saturation >= 0 && color.saturation <= 3
    && color.exposure >= -3 && color.exposure <= 3
    && color.temperature >= -1 && color.temperature <= 1
    && color.tint >= -1 && color.tint <= 1
    && color.pivot >= .1 && color.pivot <= .9
    && [color.shadows, color.highlights, color.blacks, color.whites].every((value) => value >= -1 && value <= 1);
}

export function commonVideoTransformSupported(transform: Transform2D): boolean {
  return Number.isFinite(transform.x) && Number.isFinite(transform.y)
    && Number.isFinite(transform.scale) && transform.scale > 0.0001
    && Number.isFinite(transform.rotation)
    && Number.isFinite(transform.opacity) && transform.opacity >= 0 && transform.opacity <= 1;
}

const COMMON_VIDEO_EASINGS = new Set(["linear", "hold", "ease_in", "ease_out", "ease_in_out", "spring_soft"]);

export function commonVideoAnimationSupported(clip: TimelineClip, fps: number): boolean {
  if (clip.expressions && Object.keys(clip.expressions).length) return false;
  if (clip.keyframes.length > 64) return false;
  const durationFrames = Math.round(clip.duration * fps);
  let previousFrame = 0;
  for (const keyframe of clip.keyframes) {
    const frame = Math.round(keyframe.time * fps);
    if (frame <= previousFrame || frame >= durationFrames
      || !COMMON_VIDEO_EASINGS.has(keyframe.easing)
      || !commonVideoTransformSupported(keyframe.transform)
      || !(Object.keys(DEFAULT_COLOR) as Array<keyof ColorAdjustments>)
        .every((key) => WHITE_BALANCE_KEYS.includes(key as typeof WHITE_BALANCE_KEYS[number])
          ? whiteBalanceValue(keyframe.color, key as typeof WHITE_BALANCE_KEYS[number]) === whiteBalanceValue(clip.color, key as typeof WHITE_BALANCE_KEYS[number])
          : keyframe.color[key] === clip.color[key])) return false;
    previousFrame = frame;
  }
  return true;
}

const COMMON_GPU_EFFECTS = new Set(["mono_halftone", "xerox_pulse"]);
const MAX_GPU_EFFECT_GRAPHS_PER_VISUAL = 4;

export interface ResolvedNativePrecomposition {
  clipId: string;
  nestedGraphIds: string[];
  timeline: { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number };
}

export function composeTransforms(parent: Transform2D, child: Transform2D): Transform2D {
  const radians = parent.rotation * Math.PI / 180;
  return {
    x: parent.x + (child.x * Math.cos(radians) - child.y * Math.sin(radians)) * parent.scale,
    y: parent.y + (child.x * Math.sin(radians) + child.y * Math.cos(radians)) * parent.scale,
    scale: parent.scale * child.scale,
    rotation: parent.rotation + child.rotation,
    opacity: parent.opacity * child.opacity,
  };
}

export function composeColors(parent: ColorAdjustments, child: ColorAdjustments): ColorAdjustments {
  if (hasLinearWhiteBalance(parent) || hasLinearWhiteBalance(child)) {
    throw new Error("Nested linear white balance requires a proven shared linear domain without intermediate display transforms");
  }
  return {
    brightness: parent.brightness + child.brightness,
    contrast: parent.contrast * child.contrast,
    saturation: parent.saturation * child.saturation,
    hue: parent.hue + child.hue,
    exposure: parent.exposure + child.exposure,
    temperature: parent.temperature + child.temperature,
    tint: parent.tint + child.tint,
    whiteBalanceRed: 0,
    whiteBalanceGreen: 0,
    whiteBalanceBlue: 0,
    pivot: child.pivot,
    shadows: parent.shadows + child.shadows,
    highlights: parent.highlights + child.highlights,
    blacks: parent.blacks + child.blacks,
    whites: parent.whites + child.whites,
  };
}

/**
 * Resolves a deliberately bounded precomposition chain without materializing an intermediate
 * movie. Every nested composition must be a same-canvas, same-fps, one-visual-branch graph whose
 * child covers the complete requested source window. The returned marker nodes preserve exact
 * graph coverage while the leaf media remains the only decoder binding.
 */
export function resolveNativeVideoPrecompositions(project: EditProject): { project: EditProject; markers: ResolvedNativePrecomposition[] } | undefined {
  const flattened = structuredClone(project);
  const assets = new Map(flattened.assets.map((asset) => [asset.id, asset]));
  const compositions = new Map(flattened.compositions.map((composition) => [composition.id, composition]));
  const markers: ResolvedNativePrecomposition[] = [];
  for (const track of flattened.tracks.filter((candidate) => candidate.kind === "video" && !candidate.muted)) {
    for (const clip of track.clips) {
      if ((clip.layer?.role ?? "content") !== "content") continue;
      let asset = assets.get(clip.assetId);
      if (!asset?.compositionId) continue;
      let sourceWindowStart = clip.sourceStart;
      let composedTransform = structuredClone(clip.transform);
      let composedColor = structuredClone(clip.color);
      const effectIds = [...(clip.creative?.effectPresetIds ?? [])];
      const nestedGraphIds: string[] = [];
      const visiting = new Set<string>();
      for (let depth = 0; asset?.compositionId; depth += 1) {
        if (depth >= 4 || visiting.has(asset.compositionId)) return undefined;
        visiting.add(asset.compositionId);
        const composition = compositions.get(asset.compositionId);
        if (!composition || composition.width !== project.width || composition.height !== project.height || Math.abs(composition.fps - project.fps) > 1e-6
          || composition.colorManagement?.mode === "aces2" || composition.captions.length || composition.motionGraphics.length) return undefined;
        const visualTracks = composition.tracks.filter((candidate) => candidate.kind === "video" && !candidate.muted);
        const visualClips = visualTracks.flatMap((candidate) => candidate.clips).filter((candidate) => (candidate.layer?.enabled ?? true));
        if (visualClips.length !== 1) return undefined;
        const child = visualClips[0];
        if ((child.layer?.role ?? "content") !== "content" || child.layer?.parentClipId || child.layer?.trackMatte
          || child.layout || child.masks?.some((mask) => mask.enabled) || child.chromaKey?.enabled || child.keyframes.length
          || (child.expressions && Object.keys(child.expressions).length)
          || child.creative?.lookPresetId || child.creative?.nativeEffectInstances?.some((instance) => instance.enabled)
          || child.creative?.transitionIn || child.creative?.transitionOut) return undefined;
        const windowEnd = sourceWindowStart + clip.duration;
        if (child.timelineStart > sourceWindowStart + 1e-6 || child.timelineStart + child.duration + 1e-6 < windowEnd) return undefined;
        sourceWindowStart = child.sourceStart + sourceWindowStart - child.timelineStart;
        composedTransform = composeTransforms(composedTransform, child.transform);
        // These nested graphs may include a display transform between grades.
        // Do not pretend that adding log gains preserves that execution order.
        if (hasLinearWhiteBalance(composedColor) || hasLinearWhiteBalance(child.color)) return undefined;
        composedColor = composeColors(composedColor, child.color);
        effectIds.push(...(child.creative?.effectPresetIds ?? []));
        nestedGraphIds.push(`composition:${asset.compositionId}`);
        asset = assets.get(child.assetId);
        if (!asset) return undefined;
      }
      if (!asset || asset.kind !== "video" || asset.compositionId || effectIds.length > 1 || !commonVideoTransformSupported(composedTransform) || !commonVideoGradeSupported(composedColor)) return undefined;
      clip.assetId = asset.id;
      clip.sourceStart = sourceWindowStart;
      clip.transform = composedTransform;
      clip.color = composedColor;
      clip.keyframes = [];
      clip.creative = { ...(clip.creative ?? { effectPresetIds: [] }), effectPresetIds: effectIds };
      markers.push({ clipId: clip.id, nestedGraphIds, timeline: {
        timelineStartFrame: Math.round(clip.timelineStart * project.fps), sourceStartFrame: Math.round(sourceWindowStart * project.fps), durationFrames: Math.round(clip.duration * project.fps),
      } });
    }
  }
  return { project: flattened, markers };
}

export function applyResolvedPrecompositionMarkers(graph: EngineRenderGraph, markers: ResolvedNativePrecomposition[]): EngineRenderGraph {
  if (!markers.length) return graph;
  const nodes = [...graph.nodes];
  for (const marker of markers) {
    const wrapperId = `source:${marker.clipId.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`;
    const source = nodes.find((node) => node.id === wrapperId && node.kind === "source");
    if (!source) throw new Error(`Resolved precomposition 缺少 leaf source：${marker.clipId}`);
    const leafId = `${wrapperId}:resolved-leaf`;
    source.id = leafId;
    let input = leafId;
    for (const [index, nestedGraphId] of [...marker.nestedGraphIds].reverse().entries()) {
      const id = index + 1 === marker.nestedGraphIds.length ? wrapperId : `${wrapperId}:precomp:${index}`;
      nodes.push({ id, inputs: [input], enabled: true, kind: "precomposition", nestedGraphId, timeline: marker.timeline });
      input = id;
    }
    const transform = nodes.find((node) => node.id === `transform:${marker.clipId.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`);
    if (!transform || transform.inputs[0] !== wrapperId) throw new Error(`Resolved precomposition transform contract 不完整：${marker.clipId}`);
  }
  return { ...graph, nodes };
}

export function commonGpuEffectsSupported(project: EditProject): boolean {
  return project.tracks.filter((track) => track.kind === "video" && !track.muted).flatMap((track) => track.clips)
    .every((clip) => !(clip.creative?.nativeEffectInstances?.some((instance) => instance.enabled))
      && (clip.creative?.effectPresetIds ?? []).every((id) => COMMON_GPU_EFFECTS.has(id)));
}

export function enabledGpuEffectGraphs(clip: TimelineClip) {
  return clip.creative?.nativeEffectInstances?.filter((instance) => instance.enabled && instance.runtimeType === "gpu_effect_graph" && !isTransformMotionBlurInstance(instance)) ?? [];
}

export function hasEnabledCpuNativeEffect(clip: TimelineClip): boolean {
  return clip.creative?.nativeEffectInstances?.some((instance) => instance.enabled && instance.runtimeType !== "gpu_effect_graph" && !isTransformMotionBlurInstance(instance)) ?? false;
}

export function hasEnabledTransformMotionBlur(clip: TimelineClip): boolean {
  return clip.creative?.nativeEffectInstances?.some((instance) => instance.enabled && isTransformMotionBlurInstance(instance)) ?? false;
}

export function commonVideoTransformMotionBlurSupported(clip: TimelineClip): boolean {
  const enabled = clip.creative?.nativeEffectInstances?.filter((instance) => instance.enabled) ?? [];
  const instances = enabled.filter(isTransformMotionBlurInstance);
  if (!instances.length) return true;
  if (instances.length !== 1 || !isTransformMotionBlurInstance(enabled.at(-1)!) || Boolean(clip.expressions && Object.keys(clip.expressions).length)) return false;
  try { transformMotionBlurParameters(instances[0]); } catch { return false; }
  const opacities = [clip.transform.opacity, ...clip.keyframes.map((keyframe) => keyframe.transform.opacity)];
  return opacities.every((opacity) => Math.abs(opacity - opacities[0]) <= 1e-6);
}

export function commonVideoEffectStackSupported(effectIds: string[], gpuGraphCount: number): boolean {
  return effectIds.every((effect) => COMMON_GPU_EFFECTS.has(effect))
    && ((effectIds.length <= 1 && gpuGraphCount === 0)
      || (effectIds.length === 0 && gpuGraphCount >= 1 && gpuGraphCount <= MAX_GPU_EFFECT_GRAPHS_PER_VISUAL));
}

/** Closed native parenting admission: visible video transforms only, complete timeline coverage,
 * no cycles, and at most four ancestors. This mirrors the Rust graph-lowering contract. */
export function commonVideoParentingSupported(clips: TimelineClip[]): boolean {
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  for (const child of clips) {
    let current = child;
    const chain = new Set([child.id]);
    let depth = 0;
    while (current.layer?.parentClipId) {
      const parent = byId.get(current.layer.parentClipId);
      if (!parent || chain.has(parent.id) || !(parent.layer?.enabled ?? true)) return false;
      if (parent.timelineStart > current.timelineStart + 1e-6
        || parent.timelineStart + parent.duration + 1e-6 < current.timelineStart + current.duration) return false;
      chain.add(parent.id);
      depth += 1;
      if (depth > 4) return false;
      current = parent;
    }
  }
  return true;
}
