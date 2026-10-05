import { easingProgress } from "../domain/editGraph";
import type { KeyframeEasing } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { expectedEngineVideoTopology, type ExpectedEngineVideoLayer, type ExpectedEngineVideoController } from "../desktop/residentGpuPreviewExpectations";
import type { EngineRenderGraph, EngineFrameRange } from "./engineGraph";
import { sampleNativeFloatingVideoFrame, type NativeFloatingVideoFrameSpec, type NativeFloatingVideoFrameSample } from "./nativeFloatingVideoFrame";

export const NATIVE_FLOATING_MATERIAL_CONTRACT = "editkin.native-floating-frame-material/v1";
export const NATIVE_VIDEO_TARGET_ADMISSION = Object.freeze({
  schema: "editkin.shared-video-target-admission/v1", requiredBackend: "Dx12", factory: "new_dx12_video",
  selection: "deferred-until-target-bind", offscreenProtocol: "editkin.resident-offscreen-video-target/v1",
});
const COLOR_BOUNDARY = "source_grade_then_srgb_material_then_single_aces2_then_display_paint";
const PIXEL_TOLERANCE = .002;
type ObjectValue = Record<string, unknown>;
export interface NativeFloatingMaterialReceipt {
  materialContract: typeof NATIVE_FLOATING_MATERIAL_CONTRACT;
  sourceNodeId: string; assetId: string; floatingNodeId: string;
  timelineFrame: number; localFrame: number;
  descriptor: NativeFloatingVideoFrameSpec;
  sample: NativeFloatingVideoFrameSample & { panelColor: readonly number[] };
  actualStagedVisualUniform: ObjectValue;
  radialBackdropSelected: boolean;
  colorBoundary: typeof COLOR_BOUNDARY;
}
function fail(label: string): never { throw new Error(`Native floating receipt mismatch: ${label}`); }
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  return value as ObjectValue;
}
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) fail(label); return value; }
function exact(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(label);
}
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(label);
  return value;
}
function near(actual: unknown, expected: number, tolerance: number, label: string): void {
  if (Math.abs(number(actual, label) - expected) > tolerance) fail(label);
}
function vector(actual: unknown, expected: readonly number[], tolerance: number, label: string): void {
  const values = array(actual, label); if (values.length !== expected.length) fail(label);
  values.forEach((value, index) => near(value, expected[index], tolerance, `${label}[${index}]`));
}
function range(layer: ExpectedEngineVideoLayer | ExpectedEngineVideoController): EngineFrameRange {
  const value = object(layer.source.timeline, "source timeline");
  for (const key of ["timelineStartFrame", "sourceStartFrame", "durationFrames"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < (key === "durationFrames" ? 1 : 0)) fail(`source ${key}`);
  }
  return value as unknown as EngineFrameRange;
}
function active(layer: ExpectedEngineVideoLayer, frame: number): boolean {
  const timeline = range(layer); return frame >= timeline.timelineStartFrame && frame < timeline.timelineStartFrame + timeline.durationFrames;
}
function topology(graph: EngineRenderGraph) {
  const nodes = graph.nodes.filter(node => node.kind === "floating_video_frame_2d");
  if (!nodes.length) return undefined;
  if (nodes.length > 8 || new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length || nodes.some(node => !node.enabled)) fail("graph node identity");
  const expected = expectedEngineVideoTopology(graph);
  if (!expected.layers.length) fail("unresolved graph topology");
  const owners = nodes.map(node => {
    const descriptor = object(node.spec, "graph descriptor") as unknown as NativeFloatingVideoFrameSpec;
    if (descriptor.schema !== "editkin.native-floating-video-frame/v1" || descriptor.frame?.schema !== "editkin.floating-video-frame/v2"
      || descriptor.frame.mediaFit !== "contain" || descriptor.canvasWidth !== graph.width || descriptor.canvasHeight !== graph.height) fail("graph floating contract");
    exact(descriptor.timebase, graph.timebase, "graph timebase");
    const layer = expected.layers.find(candidate => candidate.transform.inputs[0] === node.id);
    if (!layer || node.inputs.length !== 1 || layer.grade.id !== node.inputs[0] || layer.grade.inputs.length !== 1
      || layer.grade.inputs[0] !== layer.sourceNodeId || layer.source.mediaKind !== "video") fail("source/grade/float/transform ownership");
    exact(descriptor.timeline, layer.source.timeline, "graph source timeline");
    return { node, descriptor, layer };
  });
  if (new Set(owners.map(owner => owner.layer.sourceNodeId)).size !== owners.length) fail("duplicate floating source");
  owners.sort((left, right) => expected.layers.indexOf(left.layer) - expected.layers.indexOf(right.layer));
  return { ...expected, owners };
}
export function nativeFloatRuntimeMatches(ready: unknown): boolean {
  if (!ready || typeof ready !== "object" || Array.isArray(ready)) return false;
  const value = ready as ObjectValue;
  return value.event === "ready" && value.engine === "editkin-wgpu-resident-engine/v1"
    && Number.isSafeInteger(value.generation) && Number(value.generation) > 0
    && value.videoInteropProtocol === "media-foundation-d3d11-d3d12-wgpu/v1"
    && value.nativeFloatingVideoFrameContract === NATIVE_FLOATING_MATERIAL_CONTRACT
    && canonicalJson(value.videoTargetAdmission) === canonicalJson(NATIVE_VIDEO_TARGET_ADMISSION);
}
export function assertNativeVideoTargetIdentity(input: unknown, generation: unknown, requireBound = false,
  offscreenSize?: { width: number; height: number }): ObjectValue {
  const identity = object(input, "actual video target identity");
  exact(Object.keys(identity).sort(), ["schema", "generation", "backend", "adapter", "deviceType", "target", "executableSha256", "executableBytes"].sort(), "actual target identity fields");
  if (typeof identity.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(identity.executableSha256)
    || !Number.isSafeInteger(identity.executableBytes) || Number(identity.executableBytes) < 1) fail("actual worker executable identity");
  exact(identity.schema, "editkin.actual-video-target-identity/v1", "actual target schema");
  if (!Number.isSafeInteger(generation) || Number(generation) < 1) fail("actual target generation");
  exact(identity.generation, generation, "actual target generation"); exact(identity.backend, "Dx12", "actual video backend");
  for (const key of ["adapter", "deviceType"]) if (typeof identity[key] !== "string" || !(identity[key] as string).trim()) fail(`actual video ${key}`);
  if (identity.target === null) {
    if (requireBound || offscreenSize) fail("actual video target not bound");
    return identity;
  }
  const target = object(identity.target, "actual video target");
  exact(Object.keys(target).sort(), ["renderTargetContract", "offscreen", "width", "height", "nativeWindow", "nativeSwapChain"].sort(), "actual target fields");
  if (typeof target.offscreen !== "boolean") fail("actual target mode");
  exact(target.renderTargetContract, target.offscreen ? "editkin.resident-offscreen-render-target/v1" : "editkin.native-preview-surface/v1", "actual target contract");
  exact(target.nativeWindow, !target.offscreen, "actual target native window"); exact(target.nativeSwapChain, !target.offscreen, "actual target swapchain");
  for (const key of ["width", "height"]) if (!Number.isSafeInteger(target[key]) || Number(target[key]) < 1 || Number(target[key]) > 16384) fail(`actual target ${key}`);
  if (offscreenSize) {
    exact(target.offscreen, true, "formal target offscreen");
    exact(target.width, offscreenSize.width, "formal target width"); exact(target.height, offscreenSize.height, "formal target height");
  }
  return identity;
}
function assertSourceProfile(value: unknown, spec: NativeFloatingVideoFrameSpec): void {
  const profile = object(value, "actual source profile"), native = object(profile.actualNativeMediaType, "native media type");
  exact(Object.keys(profile).sort(), ["schema", "profile", "actualNativeMediaType", "negotiatedDimensions", "rotationMetadataStatus",
    "sampleAspectMetadataStatus", "effectiveRotationDegrees", "effectiveSampleAspectRatio", "missingGeometryPolicy",
    "nativeColorMetadataVerified", "decodedOrientationPixelsVerified", "declaredFirstProfileAccepted"].sort(), "source profile fields");
  exact(Object.keys(native).sort(), ["codedWidth", "codedHeight", "rotationDegrees", "sampleAspectRatio", "colorPrimaries", "transferFunction", "yuvMatrix", "nominalRange"].sort(), "native media type fields");
  exact(profile.schema, "editkin.native-floating-source-profile/v1", "source profile schema");
  exact(profile.profile, "unrotated-square-pixel-rec709-first-profile", "source first profile");
  exact(native.codedWidth, spec.source.width, "native coded width"); exact(native.codedHeight, spec.source.height, "native coded height");
  exact(profile.negotiatedDimensions, [spec.source.width, spec.source.height], "negotiated coded dimensions");
  if (native.rotationDegrees !== null && native.rotationDegrees !== 0) fail("native rotation");
  const sar = native.sampleAspectRatio === null ? [1, 1] : array(native.sampleAspectRatio, "native SAR");
  if (sar.length !== 2 || !sar.every(value => Number.isSafeInteger(value) && Number(value) > 0) || sar[0] !== sar[1]) fail("native square SAR");
  exact(profile.rotationMetadataStatus, native.rotationDegrees === null ? "not_declared" : "declared", "rotation observation status");
  exact(profile.sampleAspectMetadataStatus, native.sampleAspectRatio === null ? "not_declared" : "declared", "SAR observation status");
  exact(profile.effectiveRotationDegrees, 0, "effective rotation"); exact(profile.effectiveSampleAspectRatio, sar, "effective SAR");
  exact(profile.missingGeometryPolicy, "media_foundation_default_unrotated_square_pixels", "geometry fallback declaration");
  const allowed: Record<string, number[]> = { colorPrimaries: [0, 2], transferFunction: [0, 5], yuvMatrix: [0, 1], nominalRange: [0, 1, 2] };
  for (const [key, values] of Object.entries(allowed)) if (native[key] !== null && !values.includes(number(native[key], `native ${key}`))) fail(`native ${key}`);
  const verified = native.colorPrimaries === 2 && native.transferFunction === 5 && native.yuvMatrix === 1 && [1, 2].includes(Number(native.nominalRange));
  exact(profile.nativeColorMetadataVerified, verified, "honest native color observation");
  exact(profile.decodedOrientationPixelsVerified, false, "orientation pixel scope");
  exact(profile.declaredFirstProfileAccepted, true, "declared first profile admission");
}
export function assertNativeFloatingLoadReceipt(graph: EngineRenderGraph, receipt: unknown): void {
  const expected = topology(graph); if (!expected) return;
  const load = object(receipt, "load receipt");
  assertNativeVideoTargetIdentity(load.videoTargetIdentity, load.generation);
  const rows = array(load.layers, "load layers");
  if (rows.length !== expected.layers.length) fail("load layer count");
  expected.layers.forEach((layer, index) => {
    const row = object(rows[index], "load layer");
    exact(row.layerIndex, index, "load layer index"); exact(row.sourceNodeId, layer.sourceNodeId, "load source"); exact(row.assetId, layer.assetId, "load asset");
    const owner = expected.owners.find(item => item.layer === layer);
    if (owner) {
      exact(row.floatingVideoFrameNodeId, owner.node.id, "load floating node");
      exact(row.floatingVideoFrame, owner.descriptor, "load literal descriptor");
      assertSourceProfile(row.floatingSourceProfile, owner.descriptor);
    } else if (row.floatingVideoFrame != null || row.floatingVideoFrameNodeId != null) fail("unexpected load floating owner");
  });
}
interface Affine { x: number; y: number; scale: number; rotation: number; opacity: number }
function affineAt(layer: ExpectedEngineVideoLayer | ExpectedEngineVideoController, frame: number,
  expected: ReturnType<typeof expectedEngineVideoTopology>, seen = new Set<string>()): Affine {
  if (seen.has(layer.transformNodeId) || seen.size > 4 || layer.transform.kind !== "transform2d") fail("affine parent chain");
  const base = { x: number(layer.transform.x, "x"), y: number(layer.transform.y, "y"), scale: number(layer.transform.scaleX, "scale"),
    rotation: number(layer.transform.rotationRadians, "rotation"), opacity: number(layer.transform.opacity, "opacity") };
  near(layer.transform.scaleY, base.scale, 1e-9, "uniform affine scale");
  const points = [{ frame: 0, ...base, easing: "linear" }, ...((layer.transform.keyframes as ObjectValue[] | undefined) ?? []).map(point => ({
    frame: number(point.frame, "keyframe"), x: number(point.x, "keyframe x"), y: number(point.y, "keyframe y"),
    scale: number(point.scaleX, "keyframe scale"), rotation: number(point.rotationRadians, "keyframe rotation"),
    opacity: number(point.opacity, "keyframe opacity"), easing: String(point.easing),
  }))];
  const timeline = range(layer);
  // Native initial loading samples an inactive source at its own local zero;
  // active delivery still uses the requested integer project clock.
  const localFrame = frame >= timeline.timelineStartFrame && frame < timeline.timelineStartFrame + timeline.durationFrames
    ? frame - timeline.timelineStartFrame : 0;
  const nextIndex = points.findIndex(point => point.frame >= localFrame);
  let result: Affine;
  if (nextIndex <= 0) result = nextIndex < 0 ? points[points.length - 1] : points[0];
  else {
    const previous = points[nextIndex - 1], next = points[nextIndex];
    const ratio = previous.easing === "hold" || previous.frame === next.frame ? 0
      : easingProgress((localFrame - previous.frame) / (next.frame - previous.frame), previous.easing as KeyframeEasing);
    result = { x: previous.x + (next.x - previous.x) * ratio, y: previous.y + (next.y - previous.y) * ratio,
      scale: previous.scale + (next.scale - previous.scale) * ratio, rotation: previous.rotation + (next.rotation - previous.rotation) * ratio,
      opacity: previous.opacity + (next.opacity - previous.opacity) * ratio };
  }
  const parent = layer.parentLayerIndex !== undefined ? expected.layers[layer.parentLayerIndex]
    : layer.parentControllerIndex !== undefined ? expected.controllers[layer.parentControllerIndex] : undefined;
  if (layer.parentTransformNodeId && !parent) fail("missing affine parent");
  if (parent) {
    const parentAffine = affineAt(parent, frame, expected, new Set([...seen, layer.transformNodeId]));
    const cosine = Math.cos(parentAffine.rotation), sine = Math.sin(parentAffine.rotation);
    result = { x: parentAffine.x + parentAffine.scale * (result.x * cosine - result.y * sine),
      y: parentAffine.y + parentAffine.scale * (result.x * sine + result.y * cosine), scale: result.scale * parentAffine.scale,
      rotation: result.rotation + parentAffine.rotation, opacity: result.opacity * parentAffine.opacity };
  }
  if (result.scale <= .0001 || result.opacity < 0 || result.opacity > 1) fail("affine range");
  return result;
}
function panelColor(spec: NativeFloatingVideoFrameSpec): number[] {
  const rgb = spec.frame.style === "matte" ? [0x12, 0x15, 0x16] : spec.frame.style === "prism" ? [0x10, 0x1d, 0x32]
    : spec.frame.style === "graphite" ? [0x16, 0x18, 0x1d] : fail("panel style");
  return rgb.map(value => value / 255);
}
function assertVisual(graph: EngineRenderGraph, frame: number, layer: ExpectedEngineVideoLayer, visualValue: unknown, backdrop: boolean, allowInitialInactive = false): void {
  const expected = topology(graph)!; const owner = expected.owners.find(item => item.layer.sourceNodeId === layer.sourceNodeId);
  if (!owner || (!allowInitialInactive && !active(owner.layer, frame))) fail("inactive visual owner");
  const spec = owner.descriptor;
  const sampleFrame = active(owner.layer, frame) ? frame : spec.timeline.timelineStartFrame;
  const sample = sampleNativeFloatingVideoFrame(spec, sampleFrame), visual = object(visualValue, "visual uniform");
  const affine = affineAt(owner.layer, frame, expected);
  vector(visual.floatingPanel, sample.outerRect, PIXEL_TOLERANCE, "staged panel");
  vector(visual.floatingContent, sample.contentRect, PIXEL_TOLERANCE, "staged contain");
  vector(visual.floatingMask, [sample.radius, sample.feather, sample.border, backdrop ? 2 : 1], PIXEL_TOLERANCE, "staged mask");
  exact(array(visual.floatingMask, "staged mask")[3], backdrop ? 2 : 1, "literal floating mask selector");
  vector(visual.floatingShadow, sample.shadow, PIXEL_TOLERANCE, "staged shadow");
  const linear = panelColor(spec).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  vector(visual.floatingColor, [...linear, ["matte", "prism", "graphite"].indexOf(spec.frame.style)], 2e-6, "staged material color");
  exact(visual.projectiveEnabled, 1, "projective execution");
  for (const key of ["effectKind", "shaderOpCount", "matteMode", "motionSampleCount", "motionContractCode", "sceneDepthEnabled"] as const) exact(visual[key], 0, `unmixed ${key}`);
  exact(visual.inputTransfer, 2, "source inverse Rec709 boundary");
  near(visual.translateX, affine.x, PIXEL_TOLERANCE, "affine x"); near(visual.translateY, affine.y, PIXEL_TOLERANCE, "affine y");
  near(visual.scale, affine.scale, 2e-6, "affine scale"); near(visual.rotation, affine.rotation, 2e-6, "affine rotation");
  near(visual.opacity, affine.opacity * sample.opacity, 2e-6, "phase opacity");
  near(visual.sourceWidth, graph.width, 0, "material canvas width"); near(visual.sourceHeight, graph.height, 0, "material canvas height");
  const h = Array.from({ length: 8 }, (_, index) => number(visual[`projectiveH${index}`], "homography"));
  const sourceCorners = [[-graph.width / 2, -graph.height / 2], [graph.width / 2, -graph.height / 2],
    [-graph.width / 2, graph.height / 2], [graph.width / 2, graph.height / 2]];
  sample.quad.forEach((point, index) => {
    const x = (point[0] - .5) * graph.width, y = (point[1] - .5) * graph.height;
    const dx = affine.scale * (Math.cos(affine.rotation) * x - Math.sin(affine.rotation) * y) + affine.x;
    const dy = affine.scale * (Math.sin(affine.rotation) * x + Math.cos(affine.rotation) * y) + affine.y;
    const divisor = h[6] * dx + h[7] * dy + 1;
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-9) fail("homography denominator");
    near((h[0] * dx + h[1] * dy + h[2]) / divisor, sourceCorners[index][0], PIXEL_TOLERANCE, "homography source x");
    near((h[3] * dx + h[4] * dy + h[5]) / divisor, sourceCorners[index][1], PIXEL_TOLERANCE, "homography source y");
  });
}
/** Checks the pre-surface visualGraph (mask.w=1). Actual staged backdrop selection is checked separately. */
export function nativeFloatingVisualMatches(graph: EngineRenderGraph, frame: number, expected: ExpectedEngineVideoLayer, visual: unknown): boolean {
  try {
    if (!Number.isSafeInteger(frame) || frame < 0) return false;
    assertVisual(graph, frame, expected, visual, false, true); return true;
  } catch { return false; }
}
export function assertNativeFloatingFrameReceipt(graph: EngineRenderGraph, timelineFrame: number, receipt: unknown): void {
  const expected = topology(graph); if (!expected) return;
  if (!Number.isSafeInteger(timelineFrame) || timelineFrame < 0) fail("requested integer frame");
  const value = object(receipt, "frame receipt"); exact(value.timelineFrame, timelineFrame, "delivered frame");
  const activeLayers = expected.layers.filter(layer => active(layer, timelineFrame));
  const layers = array(value.layers, "active layer rows");
  if (layers.length !== activeLayers.length) fail("active layer count");
  activeLayers.forEach((layer, index) => {
    const row = object(layers[index], "active layer"); exact(row.sourceNodeId, layer.sourceNodeId, "active source order"); exact(row.assetId, layer.assetId, "active asset");
    exact(row.layerIndex, expected.layers.indexOf(layer), "active layer index");
    exact(row.active, true, "active layer flag");
    exact(row.sourceFrame, range(layer).sourceStartFrame + timelineFrame - range(layer).timelineStartFrame, "active source frame");
  });
  const owners = expected.owners.filter(owner => active(owner.layer, timelineFrame));
  if (owners.length) assertNativeVideoTargetIdentity(value.videoTargetIdentity, value.generation, true);
  const rows = array(value.activeFloatingVideoFrames, "active floating receipts");
  if (rows.length !== owners.length) fail("active floating count");
  const keys = new Set<string>();
  rows.forEach((rowValue, index) => {
    const row = object(rowValue, "floating frame"), owner = owners[index];
    if (keys.has(String(row.floatingNodeId))) fail("duplicate active owner"); keys.add(String(row.floatingNodeId));
    exact(row.materialContract, NATIVE_FLOATING_MATERIAL_CONTRACT, "material runtime contract");
    exact(row.sourceNodeId, owner.layer.sourceNodeId, "frame source"); exact(row.assetId, owner.layer.assetId, "frame asset");
    exact(row.floatingNodeId, owner.node.id, "frame floating node"); exact(row.descriptor, owner.descriptor, "frame literal descriptor");
    exact(row.timelineFrame, timelineFrame, "material frame"); exact(row.localFrame, timelineFrame - owner.descriptor.timeline.timelineStartFrame, "material local frame");
    exact(row.colorBoundary, COLOR_BOUNDARY, "color stage boundary");
    const sample = sampleNativeFloatingVideoFrame(owner.descriptor, timelineFrame), actual = object(row.sample, "sample");
    vector(actual.outerRect, sample.outerRect, PIXEL_TOLERANCE, "outer rect"); vector(actual.contentRect, sample.contentRect, PIXEL_TOLERANCE, "content rect");
    const quad = array(actual.quad, "quad"); if (quad.length !== 4) fail("quad count");
    quad.forEach((point, corner) => vector(point, sample.quad[corner], PIXEL_TOLERANCE / Math.max(graph.width, graph.height), "quad pixel tolerance"));
    for (const key of ["radius", "feather", "border"] as const) near(actual[key], sample[key], PIXEL_TOLERANCE, key);
    near(actual.opacity, sample.opacity, 2e-6, "sample opacity"); vector(actual.shadow, sample.shadow, PIXEL_TOLERANCE, "sample shadow");
    vector(actual.panelColor, panelColor(owner.descriptor), 2e-6, "sample sRGB material");
    const backdrop = activeLayers[0] === owner.layer; exact(row.radialBackdropSelected, backdrop, "single backdrop selection");
    assertVisual(graph, timelineFrame, owner.layer, row.actualStagedVisualUniform, backdrop);
  });
}
