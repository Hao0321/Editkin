import type { EditProject, FloatingVideoFrame, TimelineClip } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { assertFloatingVideoFrame, floatingFrameCornerRadiusPixels, floatingFrameFeatherPixels,
  floatingFrameLayout, floatingFrameMatteShadow } from "../motion/floatingVideoFrame";
import { timebaseForFps, type EngineFrameRange } from "./engineGraph";

export interface NativeFloatingVideoFrameSpec {
  readonly schema: "editkin.native-floating-video-frame/v1";
  readonly frame: Extract<FloatingVideoFrame, { schema: "editkin.floating-video-frame/v2" }>;
  readonly source: Readonly<{ width: number; height: number; displayAspectRatio: number }>;
  readonly timeline: Readonly<EngineFrameRange>;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly timebase: Readonly<{ numerator: number; denominator: number }>;
}
export interface PreparedNativeFloatingVideoFrames {
  readonly schema: "editkin.prepared-native-floating-video-frames/v1";
  readonly clipIds: readonly string[];
}
export interface NativeFloatingVideoFrameSample {
  readonly outerRect: readonly [number, number, number, number];
  readonly contentRect: readonly [number, number, number, number];
  readonly quad: readonly (readonly [number, number])[];
  readonly opacity: number;
  readonly radius: number;
  readonly feather: number;
  readonly border: number;
  readonly shadow: readonly [number, number, number, number];
}
const owners = new WeakMap<PreparedNativeFloatingVideoFrames,
  { signature: string; specs: ReadonlyMap<string, NativeFloatingVideoFrameSpec> }>();
const MAX_FLOATING_FRAMES = 36_000;
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}
function signature(project: EditProject): string {
  // The resident route resolves the legacy auto selector on its execution clone.
  // Both forms denote the same declared SDR boundary; all other source bytes,
  // identities, geometry, ownership, grade and clocks retain literal equality.
  const normalized = structuredClone(project);
  for (const asset of normalized.assets) {
    if (asset.kind === "video" && asset.color?.interpretation === "auto") asset.color.interpretation = "rec709";
  }
  const value = canonicalJson(normalized);
  if (new TextEncoder().encode(value).byteLength > 1_048_576) throw new Error("Native floating authored owner exceeds bounded signature size");
  return value;
}
function exactFrame(seconds: number, fps: number, label: string): number {
  const value = seconds * fps, frame = Math.round(value);
  if (!Number.isFinite(value) || !Number.isSafeInteger(frame) || frame < 0 || Math.abs(value - frame) > 1e-6) {
    throw new Error(`Native floating ${label} must be an exact nonnegative project frame`);
  }
  return frame;
}
function supportedProject(project: EditProject): void {
  if (!Number.isSafeInteger(project.width) || !Number.isSafeInteger(project.height)
    || project.width < 64 || project.height < 64 || project.width > 8192 || project.height > 8192
    || project.width * project.height > 8_294_400
    || project.colorManagement?.mode !== "aces2" || project.colorManagement.outputTransform !== "rec709_sdr"
    || project.colorManagement.configId !== "studio-config-v4.0.0_aces-v2.0_ocio-v2.5"
    || project.scene3d?.enabled || project.scene25d?.enabled || project.particleSimulation?.enabled
    || project.compositions.length || project.tracks.some(track => track.clips.some(clip =>
      clip.layer?.trackMatte || clip.layer?.role === "adjustment" || clip.layout || clip.transform3d || clip.masks?.some(mask => mask.enabled)
      || clip.chromaKey?.enabled || (clip.expressions && Object.keys(clip.expressions).length)
      || clip.creative?.nativeEffectInstances?.some(instance => instance.enabled)
      || clip.creative?.effectPresetIds?.length || clip.creative?.lookPresetId
      || clip.creative?.transitionIn || clip.creative?.transitionOut))
    || project.motionGraphics.some(graphic => graphic.visualStyle !== "native_paint" || !graphic.paintV1)) {
    throw new Error("Native floating requires the explicit flat ACES2 SDR graph without nested, depth, matte, temporal or unknown mixed execution");
  }
}
function specFor(project: EditProject, clip: TimelineClip): NativeFloatingVideoFrameSpec {
  const frame = clip.floatingFrame;
  if (!frame || frame.schema !== "editkin.floating-video-frame/v2") throw new Error("Native floating requires literal floating-video-frame/v2; legacy remains on its existing route");
  assertFloatingVideoFrame(frame);
  const asset = project.assets.find(item => item.id === clip.assetId);
  if (!asset || asset.kind !== "video" || asset.compositionId
    || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height)
    || asset.width! < 2 || asset.height! < 2 || asset.width! > 16_384 || asset.height! > 16_384
    || ![undefined, "auto", "rec709"].includes(asset.color?.interpretation)
    || (asset.color?.transfer !== undefined && asset.color.transfer.trim().toLowerCase() !== "bt709")
    || (asset.color?.primaries !== undefined && asset.color.primaries.trim().toLowerCase() !== "bt709")
    || (asset.color?.matrix !== undefined && asset.color.matrix.trim().toLowerCase() !== "bt709")
    || (asset.color?.range !== undefined && !["tv", "pc", "limited", "full"].includes(asset.color.range.trim().toLowerCase()))) {
    throw new Error("Native floating source must retain actual coded dimensions and its declared SDR Rec.709 metadata");
  }
  const displayAspectRatio = asset.displayAspectRatio ?? asset.width! / asset.height!;
  if (!Number.isFinite(displayAspectRatio) || displayAspectRatio <= 0) throw new Error("Native floating source DAR must be finite and positive");
  if (Math.abs(displayAspectRatio - asset.width! / asset.height!) > 1e-6) {
    throw new Error("Native floating execution does not yet admit rotated or non-square-pixel sources; decoded orientation must be qualified first");
  }
  const timeline = { timelineStartFrame: exactFrame(clip.timelineStart, project.fps, "timelineStart"),
    sourceStartFrame: exactFrame(clip.sourceStart, project.fps, "sourceStart"),
    durationFrames: exactFrame(clip.duration, project.fps, "duration") };
  if (timeline.durationFrames < 1 || timeline.durationFrames > MAX_FLOATING_FRAMES
    || !Number.isSafeInteger(timeline.timelineStartFrame + timeline.durationFrames)
    || !Number.isSafeInteger(timeline.sourceStartFrame + timeline.durationFrames)) throw new Error("Native floating timeline exceeds bounded integer execution");
  const spec: NativeFloatingVideoFrameSpec = { schema: "editkin.native-floating-video-frame/v1",
    frame: structuredClone(frame), source: { width: asset.width!, height: asset.height!, displayAspectRatio },
    timeline, canvasWidth: project.width, canvasHeight: project.height, timebase: timebaseForFps(project.fps) };
  // floatingFrameLayout validates the entire analytic projection envelope,
  // phase bounds and finite clock at once; admission never samples a frame subset.
  sampleNativeFloatingVideoFrame(spec, timeline.timelineStartFrame);
  freeze(spec); return spec;
}
export function prepareNativeFloatingVideoFrames(project: EditProject): PreparedNativeFloatingVideoFrames {
  supportedProject(project);
  const specs = new Map<string, NativeFloatingVideoFrameSpec>();
  for (const track of project.tracks) for (const clip of track.clips) {
    if (!clip.floatingFrame) continue;
    if (track.kind !== "video" || track.muted || (clip.layer?.role ?? "content") !== "content"
      || clip.layer?.enabled === false || specs.has(clip.id)) throw new Error("Native floating requires unique enabled content video owners");
    specs.set(clip.id, specFor(project, clip));
  }
  if (!specs.size || specs.size > 8) throw new Error("Native floating preparation requires one to eight actual floating owners");
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.layer?.parentClipId && specs.has(clip.layer.parentClipId)) {
      throw new Error("Native floating media cannot be an affine parent until inherited media-phase opacity is separated");
    }
  }
  const handle: PreparedNativeFloatingVideoFrames = Object.freeze({ schema: "editkin.prepared-native-floating-video-frames/v1",
    clipIds: Object.freeze([...specs.keys()]) });
  owners.set(handle, { signature: signature(project), specs }); return handle;
}
export function nativeFloatingVideoFrameSpec(project: EditProject, handle: PreparedNativeFloatingVideoFrames, clipId: string): NativeFloatingVideoFrameSpec {
  const owner = owners.get(handle);
  if (!owner || owner.signature !== signature(project)) throw new Error("Native floating preparation is stale or not factory-owned");
  const spec = owner.specs.get(clipId);
  if (!spec) throw new Error("Native floating owner is missing from actual preparation");
  return spec;
}
export function sampleNativeFloatingVideoFrame(spec: NativeFloatingVideoFrameSpec, timelineFrame: number): NativeFloatingVideoFrameSample {
  if (!Number.isSafeInteger(timelineFrame) || timelineFrame < 0) throw new Error("Native floating sample requires an exact project frame");
  const localFrame = timelineFrame - spec.timeline.timelineStartFrame;
  const layout = floatingFrameLayout(spec.frame, spec.canvasWidth, spec.canvasHeight,
    { width: spec.source.displayAspectRatio, height: 1, durationFrames: spec.timeline.durationFrames,
      fps: spec.timebase.denominator / spec.timebase.numerator, localFrame });
  const geometry = layout.geometry;
  const shadow = floatingFrameMatteShadow(spec.canvasWidth, spec.canvasHeight);
  return { outerRect: [geometry.left, geometry.top, geometry.outerWidth, geometry.outerHeight],
    contentRect: [geometry.left + geometry.border + layout.sourceContentRect.left,
      geometry.top + geometry.border + layout.sourceContentRect.top, layout.sourceContentRect.width, layout.sourceContentRect.height],
    quad: geometry.quad, opacity: layout.opacity,
    radius: floatingFrameCornerRadiusPixels(spec.frame, spec.canvasWidth, spec.canvasHeight, geometry.border),
    feather: floatingFrameFeatherPixels(spec.canvasWidth, spec.canvasHeight), border: geometry.border,
    shadow: [shadow.x, shadow.y, shadow.blur, shadow.opacity] };
}
