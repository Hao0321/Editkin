import { findClip, projectDuration } from "../domain/editGraph";
import { motionTrackPoseAt } from "../domain/motionTrackSampling";
import type { EditProject, MotionGraphic, NormalizedPoint, TimelineClip } from "../domain/types";
import { particleSimulationEmitters } from "../domain/types";
import { isTransformMotionBlurInstance, transformMotionBlurParameters } from "../domain/transformMotionBlur";
import { scene25dCameraNode, scene25dDepthOfFieldNode, scene25dLightNodes } from "./scene25dDepthOfFieldNode";

export type EnginePixelFormat = "rgba8" | "rgba16_float" | "rgba32_float" | "alpha8" | "alpha16";
export type EngineStage = "decode" | "analysis" | "geometry" | "matte" | "color" | "effect" | "composite" | "simulation" | "audio" | "output";

export interface EngineNode {
  id: string;
  inputs: string[];
  enabled: boolean;
  kind: string;
  [key: string]: unknown;
}

export interface EngineFrameRange {
  timelineStartFrame: number;
  sourceStartFrame: number;
  durationFrames: number;
}

export interface EngineAudioNode {
  id: string;
  inputs: string[];
  operation: { kind: string; [key: string]: unknown };
  automation: Array<{ property: string; points: Array<{ sample: number; value: number; interpolation: "hold" | "linear" | "smooth" }> }>;
}

export interface EngineRenderGraph {
  schema: "editkin.engine-graph/v1";
  graphId: string;
  width: number;
  height: number;
  timebase: { numerator: number; denominator: number };
  workingFormat: EnginePixelFormat;
  cacheBudgetMb: number;
  nodes: EngineNode[];
  outputNode: string;
  audio?: { sampleRate: number; channels: number; masterNode: string; nodes: EngineAudioNode[] };
}

export interface NativeCompiledGraph {
  schema: "editkin.engine-graph/v1";
  engineAbiVersion: number;
  graphId: string;
  timebase: { numerator: number; denominator: number };
  workingFormat: EnginePixelFormat;
  outputNode: string;
  passes: Array<{ nodeId: string; stage: EngineStage; inputs: string[] }>;
  audioNodeCount: number;
  cacheBudgetMb: number;
  featureFamilies: string[];
}

export interface EngineGraphBuildOptions {
  /** Explicit current SDR video-preview contract; default/1 retains legacy wire semantics. */
  rec709PrimaryVersion?: 1 | 2;
}

function currentSdrVideoProfileEligible(project: EditProject, clips: TimelineClip[]): boolean {
  if (project.colorManagement?.mode === "aces2" || project.scene25d?.enabled) return false;
  const contents = clips.filter(clip => (clip.layer?.role ?? "content") === "content");
  return contents.length > 0 && contents.every(clip => {
    const asset = project.assets.find(candidate => candidate.id === clip.assetId);
    if (!asset || asset.kind !== "video" || asset.compositionId || (asset.color?.interpretation ?? "rec709") !== "rec709") return false;
    // Do not turn declared HDR/Log/other primaries into SDR through an output option.
    const metadata = asset.color;
    const allowed = (value: string | undefined, values: string[]) => value === undefined || values.includes(value.trim().toLowerCase());
    return allowed(metadata?.transfer, ["bt709"]) && allowed(metadata?.primaries, ["bt709"])
      && allowed(metadata?.matrix, ["bt709"]) && allowed(metadata?.range, ["tv", "pc", "limited", "full"]);
  });
}

function timebaseForFps(fps: number): { numerator: number; denominator: number } {
  const ntsc = [
    { fps: 24_000 / 1_001, numerator: 1_001, denominator: 24_000 },
    { fps: 30_000 / 1_001, numerator: 1_001, denominator: 30_000 },
    { fps: 60_000 / 1_001, numerator: 1_001, denominator: 60_000 },
  ].find((candidate) => Math.abs(candidate.fps - fps) < 0.001);
  if (ntsc) return { numerator: ntsc.numerator, denominator: ntsc.denominator };
  const rounded = Math.round(fps);
  if (!Number.isFinite(fps) || fps <= 0 || rounded <= 0) throw new Error("專案 FPS 無法轉為 rational timebase");
  return { numerator: 1, denominator: rounded };
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function frameAt(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Engine graph 時間不可為負數或非有限值");
  return Math.round(seconds * fps);
}

function frameRange(timelineStart: number, sourceStart: number, duration: number, fps: number): EngineFrameRange {
  const durationFrames = Math.round(duration * fps);
  if (durationFrames <= 0) throw new Error("Engine graph 節點長度必須至少一格");
  return {
    timelineStartFrame: frameAt(timelineStart, fps),
    sourceStartFrame: frameAt(sourceStart, fps),
    durationFrames,
  };
}

function appendNativeEffectNodes(clip: TimelineClip, clipId: string, nodes: EngineNode[], input: string): string {
  let tail = input;
  for (const instance of clip.creative?.nativeEffectInstances ?? []) {
    if (!instance.enabled) continue;
    if (isTransformMotionBlurInstance(instance)) {
      const motionBlur = `motion-blur:${clipId}:${safeId(instance.id)}`;
      nodes.push({ id: motionBlur, inputs: [tail], enabled: true, kind: "motion_blur", ...transformMotionBlurParameters(instance) });
      tail = motionBlur;
      continue;
    }
    const parameters = Object.fromEntries(Object.entries(instance.parameters).map(([key, value]) => {
      if (typeof value === "number") return [key, value];
      if (typeof value === "boolean") return [key, value ? 1 : 0];
      throw new Error(`原生效果 graph 目前只接受數值或布林參數：${instance.id}/${key}`);
    }));
    const effect = `effect:${clipId}:native:${safeId(instance.id)}`;
    nodes.push({
      id: effect,
      inputs: [tail],
      enabled: true,
      kind: "effect",
      pluginId: `${instance.pluginId}/${instance.capabilityId}@${instance.pluginVersion}#${instance.manifestSha256}`,
      abiVersion: 1,
      temporalRadius: 0,
      parameters,
    });
    tail = effect;
  }
  return tail;
}

function hasPhysicalWhiteBalance(clip: TimelineClip): boolean {
  const values = [clip.color.whiteBalanceRed ?? 0, clip.color.whiteBalanceGreen ?? 0, clip.color.whiteBalanceBlue ?? 0];
  if (!values.every(value => Number.isFinite(value) && value >= -4 && value <= 4)) throw new Error("白平衡 RGB 增益必須是 [-4,4] 內的有限 stops");
  return values.some(value => value !== 0);
}

function projectedGrade(clip: TimelineClip, currentRec709 = false): Record<string, number> {
  const { whiteBalanceRed, whiteBalanceGreen, whiteBalanceBlue, ...legacy } = clip.color;
  // Identity uses exactly the legacy wire shape/processor; nonzero is versioned fail-visible.
  return hasPhysicalWhiteBalance(clip) || currentRec709
    ? { ...legacy, whiteBalanceRed: whiteBalanceRed ?? 0, whiteBalanceGreen: whiteBalanceGreen ?? 0, whiteBalanceBlue: whiteBalanceBlue ?? 0 }
    : legacy;
}

function colorSpaces(project: EditProject, clip: TimelineClip, currentRec709 = false): { input: string; working: string; output: string; processor: string } {
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  const input = asset?.color?.interpretation ?? "rec709";
  const wb = hasPhysicalWhiteBalance(clip);
  if (project.colorManagement?.mode === "aces2") {
    if (input === "linear_rec709") return { input, working: "linear_rec709", output: "linear_rec709", processor: wb ? "editkin-linear-primary/v2" : "editkin-linear-primary/v1" };
    return { input, working: "linear_rec709", output: "linear_rec709", processor: wb ? "editkin-rec709-to-linear-rec709-primary/v2" : "editkin-srgb-to-linear-rec709-primary/v1" };
  }
  if (input === "linear_rec709") {
    return { input, working: "linear_rec709", output: "linear_rec709", processor: wb ? "editkin-linear-primary/v2" : "editkin-linear-primary/v1" };
  }
  return { input, working: "rec709", output: "rec709_sdr", processor: wb || currentRec709 ? "editkin-rec709-primary/v2" : "editkin-rec709-primary/v1" };
}

function requiresFloatWorkingFormat(project: EditProject): boolean {
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  return project.tracks.some((track) => track.kind === "video" && !track.muted
    && track.clips.some((clip) => assetById.get(clip.assetId)?.color?.interpretation === "linear_rec709"));
}

function clipNodes(project: EditProject, clip: TimelineClip, currentRec709 = false): { nodes: EngineNode[]; tail: string } {
  const clipId = safeId(clip.id);
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  const source = `source:${clipId}`;
  const transform = `transform:${clipId}`;
  const color = `color:${clipId}`;
  const timeline = frameRange(clip.timelineStart, clip.sourceStart, clip.duration, project.fps);
  const controller = clip.layer?.role === "controller";
  const scene25d = project.scene25d?.enabled === true;
  const sourceNode: EngineNode = controller
    ? { id: source, inputs: [], enabled: true, kind: "source", assetId: "editkin.generator.null", mediaKind: "generator", inputColorSpace: "rec709", alphaMode: "straight", timeline }
    : asset?.compositionId
    ? { id: source, inputs: [], enabled: true, kind: "precomposition", nestedGraphId: `composition:${safeId(asset.compositionId)}`, timeline }
    : { id: source, inputs: [], enabled: true, kind: "source", assetId: clip.assetId, mediaKind: asset?.kind === "image" ? "image" : "video", inputColorSpace: asset?.color?.interpretation ?? "rec709", alphaMode: asset?.alphaMode ?? "auto", timeline };
  const transformNode: EngineNode = scene25d
    ? {
      id: transform, inputs: [source], enabled: clip.layer?.enabled ?? true, kind: "transform3d",
      position: clip.transform3d?.position,
      rotationRadians: clip.transform3d?.rotationDegrees.map((value) => value * Math.PI / 180),
      scale: clip.transform3d?.scale,
      parent: clip.layer?.parentClipId ? `transform:${safeId(clip.layer.parentClipId)}` : undefined,
    }
    : {
      id: transform, inputs: [source], enabled: clip.layer?.enabled ?? true, kind: "transform2d",
      x: clip.transform.x, y: clip.transform.y, scaleX: clip.transform.scale, scaleY: clip.transform.scale,
      rotationRadians: clip.transform.rotation * Math.PI / 180, opacity: clip.transform.opacity,
      keyframes: clip.keyframes.map((keyframe) => ({
        frame: frameAt(keyframe.time, project.fps), x: keyframe.transform.x, y: keyframe.transform.y,
        scaleX: keyframe.transform.scale, scaleY: keyframe.transform.scale,
        rotationRadians: keyframe.transform.rotation * Math.PI / 180,
        opacity: keyframe.transform.opacity, easing: keyframe.easing,
      })),
      parent: clip.layer?.parentClipId ? `transform:${safeId(clip.layer.parentClipId)}` : undefined,
    };
  if (scene25d && !clip.transform3d) throw new Error(`2.5D 平面 ${clip.id} 缺少 transform3d`);
  const nodes: EngineNode[] = [sourceNode, transformNode];
  let tail = transform;
  if (controller) return { nodes, tail };
  const spaces = colorSpaces(project, clip, currentRec709);
  nodes.push({ id: color, inputs: [tail], enabled: true, kind: "color", processor: spaces.processor, inputSpace: spaces.input, workingSpace: spaces.working, outputSpace: spaces.output, grade: projectedGrade(clip, currentRec709) });
  tail = color;
  for (const effectId of clip.creative?.effectPresetIds ?? []) {
    const effect = `effect:${clipId}:${safeId(effectId)}`;
    nodes.push({ id: effect, inputs: [tail], enabled: true, kind: "effect", pluginId: `editkin.builtin.${effectId}`, abiVersion: 1, temporalRadius: 0, parameters: {} });
    tail = effect;
  }
  tail = appendNativeEffectNodes(clip, clipId, nodes, tail);
  for (const mask of clip.masks ?? []) {
    if (!mask.enabled || !mask.matteSequence?.frozen || mask.matteSequence.stale) continue;
    const maskNode = `mask:${clipId}:${safeId(mask.id)}`;
    nodes.push({
      id: maskNode,
      inputs: [tail],
      enabled: true,
      kind: "mask",
      matteId: mask.matteSequence.manifestUri,
      matteMode: mask.inverted ? "alpha_inverted" : "alpha",
      feather: mask.feather,
      expansion: mask.expansion,
    });
    tail = maskNode;
  }
  return { nodes, tail };
}

function adjustmentNodes(project: EditProject, clip: TimelineClip, input: string, currentRec709 = false): { nodes: EngineNode[]; tail: string } {
  const clipId = safeId(clip.id);
  const adjustment = `adjustment:${clipId}`;
  // An adjustment consumes the already-composited working buffer, never the clip's media asset.
  // Re-applying the source EOTF here would decode the same pixels twice.
  const spaces = project.colorManagement?.mode === "aces2"
    ? { input: "linear_rec709", working: "linear_rec709", output: "linear_rec709", processor: hasPhysicalWhiteBalance(clip) ? "editkin-linear-primary/v2" : "editkin-linear-primary/v1" }
    : colorSpaces(project, clip, currentRec709);
  const color = `color:${clipId}`;
  const nodes: EngineNode[] = [
    {
      id: adjustment, inputs: [input], enabled: clip.layer?.enabled ?? true, kind: "adjustment", affectedInputs: [input],
      timeline: frameRange(clip.timelineStart, 0, clip.duration, project.fps),
    },
    { id: color, inputs: [adjustment], enabled: true, kind: "color", processor: spaces.processor, inputSpace: spaces.input, workingSpace: spaces.working, outputSpace: spaces.output, grade: projectedGrade(clip, currentRec709) },
  ];
  let tail = color;
  for (const effectId of clip.creative?.effectPresetIds ?? []) {
    const effect = `effect:${clipId}:${safeId(effectId)}`;
    nodes.push({ id: effect, inputs: [tail], enabled: true, kind: "effect", pluginId: `editkin.builtin.${effectId}`, abiVersion: 1, temporalRadius: 0, parameters: {} });
    tail = effect;
  }
  tail = appendNativeEffectNodes(clip, clipId, nodes, tail);
  return { nodes, tail };
}

function captionNode(project: EditProject, index: number): EngineNode {
  const cue = project.captions[index];
  const style = project.captionStyle;
  return {
    id: `caption:${safeId(cue.id)}`, inputs: [], enabled: true, kind: "caption", cueId: cue.id, text: cue.text,
    timeline: frameRange(cue.start, 0, cue.duration, project.fps),
    fontFamily: style.fontFamily, fontSize: style.fontSize, textColor: style.color,
    outlineColor: style.outlineColor, outlineWidth: style.outlineWidth,
    backgroundColor: style.backgroundColor, alignment: style.alignment, marginVertical: style.marginV,
    bold: style.bold, italic: style.italic, shadow: style.shadow, letterSpacing: style.letterSpacing,
    translation: cue.translation?.text,
  };
}

export interface EngineMotionGraphicTrackingSample {
  timelineFrame: number;
  x: number;
  y: number;
  confidence: number;
  status: "tracked" | "held" | "lost" | "manual";
  rotationRadians: number;
  scale: number;
  destinationQuad?: [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];
}

export interface EngineMotionGraphicTracking {
  trackId: string;
  samples: EngineMotionGraphicTrackingSample[];
}

function motionGraphicBoxHeight(project: EditProject, graphic: MotionGraphic): number {
  return (Math.ceil(graphic.fontSize * 1.25) + Math.ceil(graphic.fontSize * .36) * 2) / project.height;
}

function safeGraphicOrigin(project: EditProject, graphic: MotionGraphic, x: number, y: number, rotationRadians = 0, scale = 1): { x: number; y: number } {
  const margin = .02;
  if (!Number.isFinite(rotationRadians) || Math.abs(rotationRadians) > Math.PI * 2 || !Number.isFinite(scale) || scale < .25 || scale > 4) throw new Error(`動態圖卡 ${graphic.id} 的追蹤旋轉／縮放超出安全範圍`);
  const width = graphic.width; const height = motionGraphicBoxHeight(project, graphic);
  const cosine = Math.abs(Math.cos(rotationRadians)); const sine = Math.abs(Math.sin(rotationRadians));
  const boundsWidth = scale * (cosine * width + sine * height);
  const boundsHeight = scale * (sine * width + cosine * height);
  if (boundsWidth > 1 - margin * 2 || boundsHeight > 1 - margin * 2) throw new Error(`動態圖卡 ${graphic.id} 的追蹤姿態超出安全區可容納範圍`);
  const centerX = Math.min(1 - margin - boundsWidth / 2, Math.max(margin + boundsWidth / 2, x + width / 2));
  const centerY = Math.min(1 - margin - boundsHeight / 2, Math.max(margin + boundsHeight / 2, y + height / 2));
  return { x: centerX - width / 2, y: centerY - height / 2 };
}

function safeDestinationQuad(graphic: MotionGraphic, quad: MotionTrackPoseQuad): MotionTrackPoseQuad {
  const margin = .02;
  if (quad.some((corner) => !Number.isFinite(corner.x) || !Number.isFinite(corner.y) || corner.x < margin || corner.x > 1 - margin || corner.y < margin || corner.y > 1 - margin)) throw new Error(`動態圖卡 ${graphic.id} 的平面四角超出 2% 安全區`);
  const cross = quad.map((corner, index) => {
    const next = quad[(index + 1) % 4]; const after = quad[(index + 2) % 4];
    return (next.x - corner.x) * (after.y - next.y) - (next.y - corner.y) * (after.x - next.x);
  });
  const sign = Math.sign(cross[0]);
  const area = Math.abs(quad.reduce((sum, corner, index) => { const next = quad[(index + 1) % 4]; return sum + corner.x * next.y - next.x * corner.y; }, 0)) * .5;
  const edges = quad.map((corner, index) => Math.hypot(quad[(index + 1) % 4].x - corner.x, quad[(index + 1) % 4].y - corner.y));
  if (!sign || cross.some((value) => Math.sign(value) !== sign || Math.abs(value) < 1e-6) || area < 1e-4 || edges.some((length) => length < .01)) throw new Error(`動態圖卡 ${graphic.id} 的平面四角退化或自相交`);
  return quad.map((corner) => ({ ...corner })) as MotionTrackPoseQuad;
}

type MotionTrackPoseQuad = [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];

/** Projects clip-local tracker observations onto exact project timeline frames. */
export function motionGraphicTracking(project: EditProject, graphic: MotionGraphic): EngineMotionGraphicTracking | undefined {
  if (!graphic.trackId) return undefined;
  const track = project.motionTracks.find((candidate) => candidate.id === graphic.trackId);
  if (!track || !track.points.length) throw new Error(`動態圖卡 ${graphic.id} 缺少可用追蹤樣本`);
  const clip = findClip(project, track.clipId);
  if (graphic.timelineStart < clip.timelineStart || graphic.timelineStart + graphic.duration > clip.timelineStart + clip.duration + 1e-6) throw new Error(`動態圖卡 ${graphic.id} 超出追蹤片段範圍`);
  const timeline = frameRange(graphic.timelineStart, 0, graphic.duration, project.fps);
  if (timeline.durationFrames > 18_000) throw new Error(`動態圖卡 ${graphic.id} 的原生追蹤樣本超過 18,000 格上限`);
  const surface = graphic.trackingMode === "surface";
  if (surface && graphic.animation !== "fade") throw new Error(`動態圖卡 ${graphic.id} 的平面貼合目前只支援淡入淡出`);
  const timebase = timebaseForFps(project.fps);
  const samples: EngineMotionGraphicTrackingSample[] = [];
  for (let localFrame = 0; localFrame < timeline.durationFrames; localFrame += 1) {
    const timelineFrame = timeline.timelineStartFrame + localFrame;
    const playhead = timelineFrame * timebase.numerator / timebase.denominator;
    const tracked = motionTrackPoseAt(track, playhead - clip.timelineStart);
    const rotationRadians = (tracked?.rotationDegrees ?? 0) * Math.PI / 180;
    const scale = tracked?.scale ?? 1;
    const destinationQuad = surface && tracked
      ? safeDestinationQuad(graphic, tracked.quad ?? (() => { throw new Error(`動態圖卡 ${graphic.id} 缺少平面四角`); })())
      : undefined;
    const origin = tracked
      ? safeGraphicOrigin(project, graphic, tracked.rect.x + tracked.rect.width + graphic.offsetX, tracked.rect.y + graphic.offsetY, rotationRadians, scale)
      : safeGraphicOrigin(project, graphic, graphic.x, graphic.y);
    samples.push({ timelineFrame, x: origin.x, y: origin.y, confidence: tracked?.confidence ?? 0, status: tracked?.status ?? "lost", rotationRadians, scale, destinationQuad });
  }
  return { trackId: track.id, samples };
}

function motionGraphicNode(project: EditProject, index: number): EngineNode {
  const graphic = project.motionGraphics[index];
  if (graphic.schema !== "hao.motion-composition/v1") throw new Error(`原生 GPU graph 尚未支援 ${graphic.schema}：${graphic.id}；禁止降級成 v1 動畫`);
  return {
    id: `motion-graphic:${safeId(graphic.id)}`, inputs: [], enabled: true, kind: "motion_graphic",
    graphicId: graphic.id, graphicKind: graphic.kind, text: graphic.text,
    timeline: frameRange(graphic.timelineStart, 0, graphic.duration, project.fps),
    x: graphic.x, y: graphic.y, width: graphic.width, fontSize: graphic.fontSize,
    fontFamily: graphic.fontFamily ?? "Noto Sans TC", fontWeight: graphic.fontWeight ?? 700,
    letterSpacing: graphic.letterSpacing ?? 0, outlineWidth: graphic.outlineWidth ?? (graphic.kind === "card" ? 4 : 2),
    shadowDepth: graphic.shadowDepth ?? 2, cornerRadius: graphic.cornerRadius ?? 18,
    textColor: graphic.textColor, backgroundColor: graphic.backgroundColor, accentColor: graphic.accentColor,
    visualStyle: graphic.visualStyle ?? "solid_panel",
    animation: graphic.animation, trackingMode: graphic.trackingMode ?? "anchor", offsetX: graphic.offsetX, offsetY: graphic.offsetY,
    tracking: motionGraphicTracking(project, graphic),
  };
}

function appendComposite(nodes: EngineNode[], current: string, upper: string, index: number, blendMode = "normal", opacity = 1, matteInput?: string, matteMode?: string): string {
  const id = `composite:${index}`;
  nodes.push({ id, inputs: [current, upper], enabled: true, kind: "composite", blendMode, opacity, matteInput, matteMode });
  return id;
}

function buildAudioGraph(project: EditProject): EngineRenderGraph["audio"] | undefined {
  const audioAssets = new Set(project.assets.filter((asset) => asset.kind === "audio" || asset.kind === "video").map((asset) => asset.id));
  const clips = project.tracks.filter((track) => track.kind === "audio" || track.kind === "video")
    .flatMap((track) => track.muted ? [] : track.clips)
    .filter((clip) => (clip.layer?.role ?? "content") === "content" && audioAssets.has(clip.assetId));
  if (clips.length === 0) return undefined;
  const nodes: EngineAudioNode[] = [];
  const gains: string[] = [];
  for (const clip of clips) {
    const id = safeId(clip.id);
    const source = `audio-source:${id}`;
    const gain = `audio-gain:${id}`;
    nodes.push({ id: source, inputs: [], operation: { kind: "source", asset_id: clip.assetId }, automation: [] });
    nodes.push({ id: gain, inputs: [source], operation: { kind: "gain", gain_db: clip.volume <= 0 ? -144 : 20 * Math.log10(clip.volume) }, automation: [] });
    gains.push(gain);
  }
  nodes.push({ id: "audio:master-bus", inputs: gains, operation: { kind: "bus" }, automation: [] });
  nodes.push({ id: "audio:output", inputs: ["audio:master-bus"], operation: { kind: "output" }, automation: [] });
  return { sampleRate: 48_000, channels: 2, masterNode: "audio:output", nodes };
}

function appendScene25dResources(project: EditProject, nodes: EngineNode[]): void {
  const scene = project.scene25d;
  if (!scene?.enabled) return;
  nodes.push(scene25dCameraNode(project, frameAt), ...scene25dLightNodes(project, frameAt));
}

function appendParticleSimulation(project: EditProject, nodes: EngineNode[], current: string, compositeIndex: number): { tail: string; compositeIndex: number } {
  const simulation = project.particleSimulation;
  if (!simulation?.enabled) return { tail: current, compositeIndex };
  let tail = current;
  let nextIndex = compositeIndex;
  for (const emitter of particleSimulationEmitters(simulation)) {
    const particleNode = emitter.id === "primary" ? "vfx:particles" : `vfx:particles:${safeId(emitter.id)}`;
    nodes.push({
      id: particleNode, inputs: [], enabled: true, kind: "particle_emitter",
      timeline: frameRange(emitter.timeline?.start ?? 0, 0, emitter.timeline?.duration ?? projectDuration(project), project.fps),
      seed: emitter.seed, ratePerSecond: emitter.ratePerSecond,
      lifetimeSeconds: emitter.lifetimeSeconds,
      initialVelocity: [emitter.initialVelocity[0], emitter.initialVelocity[1], 0],
      gravity: [emitter.gravity[0], emitter.gravity[1], 0],
      maxParticles: emitter.maxParticles, emitterPosition: emitter.emitterPosition,
      radiusPixels: emitter.radiusPixels, color: emitter.color,
    });
    nextIndex += 1;
    tail = appendComposite(nodes, tail, particleNode, nextIndex, "normal", 1);
  }
  return { tail, compositeIndex: nextIndex };
}

export function buildEngineRenderGraph(project: EditProject, options: EngineGraphBuildOptions = {}): EngineRenderGraph {
  if (options.rec709PrimaryVersion !== undefined && ![1, 2].includes(options.rec709PrimaryVersion)) throw new Error("Unsupported Rec.709 primary processor version");
  const visibleClips = project.tracks.filter((track) => track.kind === "video" && !track.muted).flatMap((track) => track.clips);
  // Never turn an invalidated authored matte into an unmasked executable graph.
  // Check before role-specific branches can omit masks (adjustment/controller).
  for (const clip of visibleClips) {
    if (clip.layer?.enabled === false) continue;
    const staleMask = clip.masks?.find(mask => mask.enabled && mask.matteSequence?.stale);
    if (staleMask) throw new Error(`片段 ${clip.id} 的遮罩 ${staleMask.id} 的 Auto Roto Matte 已過期；請重新分析或停用遮罩，禁止輸出缺少遮罩的 EngineGraph。`);
  }
  const nodes: EngineNode[] = [];
  const currentRec709 = options.rec709PrimaryVersion === 2 && currentSdrVideoProfileEligible(project, visibleClips);
  const contentTails = new Map<string, string>();
  for (const clip of visibleClips.filter((candidate) => candidate.layer?.role !== "adjustment")) {
    const built = clipNodes(project, clip, currentRec709);
    nodes.push(...built.nodes);
    if ((clip.layer?.role ?? "content") === "content") contentTails.set(clip.id, built.tail);
  }
  let compositeTail: string | undefined;
  let compositeIndex = 0;
  const deferredParticleAdjustments: TimelineClip[] = [];
  for (const clip of visibleClips) {
    if (clip.layer?.role === "adjustment") {
      if (project.particleSimulation?.enabled === true) {
        deferredParticleAdjustments.push(clip);
        continue;
      }
      if (!compositeTail) continue;
      const built = adjustmentNodes(project, clip, compositeTail, currentRec709);
      nodes.push(...built.nodes);
      compositeTail = built.tail;
      continue;
    }
    if (clip.layer?.role === "controller") continue;
    const tail = contentTails.get(clip.id)!;
    if (!compositeTail) compositeTail = tail;
    else {
      const matteInput = clip.layer?.trackMatte ? contentTails.get(clip.layer.trackMatte.sourceClipId) : undefined;
      if (clip.layer?.trackMatte && !matteInput) throw new Error(`Track Matte 缺少 graph source：${clip.layer.trackMatte.sourceClipId}`);
      // Transform2D owns clip opacity. Composite opacity is a separate group/operator value;
      // multiplying the clip opacity here again would square every upper layer's alpha.
      compositeTail = appendComposite(nodes, compositeTail, tail, ++compositeIndex, clip.layer?.blendMode ?? "normal", 1, matteInput, clip.layer?.trackMatte?.mode);
    }
  }
  if (!compositeTail) {
    nodes.push({ id: "source:transparent", inputs: [], enabled: true, kind: "source", assetId: "editkin.generator.transparent", mediaKind: "generator", inputColorSpace: "rec709", alphaMode: "straight" });
    compositeTail = "source:transparent";
  }
  appendScene25dResources(project, nodes);
  if (project.scene25d?.enabled && (project.captions.length > 0 || project.motionGraphics.length > 0)) {
    throw new Error("2.5D v1 尚未接受字幕或動態圖卡混合進場景");
  }
  const particle = appendParticleSimulation(project, nodes, compositeTail, compositeIndex);
  compositeTail = particle.tail;
  compositeIndex = particle.compositeIndex;
  for (const clip of deferredParticleAdjustments) {
    const built = adjustmentNodes(project, clip, compositeTail, currentRec709);
    nodes.push(...built.nodes);
    compositeTail = built.tail;
  }
  for (let index = 0; index < project.captions.length; index += 1) {
    const node = captionNode(project, index);
    nodes.push(node);
    compositeTail = appendComposite(nodes, compositeTail, node.id, ++compositeIndex);
  }
  for (let index = 0; index < project.motionGraphics.length; index += 1) {
    const node = motionGraphicNode(project, index);
    nodes.push(node);
    compositeTail = appendComposite(nodes, compositeTail, node.id, ++compositeIndex);
  }
  const depthOfFieldNode = scene25dDepthOfFieldNode(project, compositeTail, frameAt);
  if (depthOfFieldNode) {
    nodes.push(depthOfFieldNode);
    compositeTail = depthOfFieldNode.id;
  }
  if (project.colorManagement?.mode === "aces2") {
    const processors = {
      rec709_sdr: "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1",
      rec2100_hlg_1000: "editkin-ocio-aces2-linear-rec709-to-rec2100-hlg-1000/v1",
      rec2100_pq_1000: "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1",
    } as const;
    const processor = processors[project.colorManagement.outputTransform as keyof typeof processors];
    if (!processor) throw new Error(`原生 EngineGraph 尚未提供 ${project.colorManagement.outputTransform} 的 ACES2 顯示處理器`);
    nodes.push({
      id: "display:aces2", inputs: [compositeTail], enabled: true, kind: "color", processor,
      inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: project.colorManagement.outputTransform,
      grade: { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 },
    });
    compositeTail = "display:aces2";
  }
  const workingFormat: EnginePixelFormat = requiresFloatWorkingFormat(project) || project.colorManagement?.mode === "aces2" ? "rgba32_float" : "rgba16_float";
  nodes.push({ id: "output:main", inputs: [compositeTail], enabled: true, kind: "output", format: workingFormat });
  return {
    schema: "editkin.engine-graph/v1", graphId: `project:${safeId(project.id)}:r${project.revision}`,
    width: project.width, height: project.height, timebase: timebaseForFps(project.fps), workingFormat, cacheBudgetMb: 1_024,
    nodes, outputNode: "output:main", audio: project.scene25d?.enabled ? undefined : buildAudioGraph(project),
  };
}
