/** Offscreen whole-composition receipt admission, separate from transport.
 * Browser-safe receipt consumer for the existing whole-engine PNG route.
 * This is not a producer, a surface/present receipt adapter, or GUI evidence.
 * RuntimeExpectation must come from the backend's selected current executable
 * identity and metadata, independently of the receipt being checked.
 */
import type { EngineNode, EngineRenderGraph, EngineFrameRange } from "../render/engineGraph";
import type { GpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import type {
  GpuEngineGraphCoverage, GpuEngineVideoPreviewLoadResult, GpuEngineVideoResourcePlan,
  GpuEngineVideoDecodeSchedule, GpuEngineVideoVisualGraph, GpuEngineVideoControllerReceipt,
  GpuEngineVideoCaptionReceipt, GpuEngineVideoMotionGraphicReceipt,
} from "./gpuTypes";
import type { GpuVideoStagedFrame } from "./gpuFrameTypes";
import { canonicalJson } from "../shared/canonicalJson";
import {
  expectedEngineVideoTopology, expectedEngineVideoCaptions, expectedEngineVideoMotionGraphics,
} from "./residentGpuPreviewExpectations";
import {
  controllerReceiptMatches, engineVisualMatches,
} from "./residentGpuPreviewValidation";
import {
  captionActiveAt, captionReceiptMatches, motionGraphicExpectedSample, motionGraphicReceiptMatches,
} from "./residentGpuPreviewReceipts";
import {
  engineVideoDecodeCadence, engineVideoDecodeScheduleMatches, engineVideoResourcePlanMatches,
} from "./residentGpuPreviewResources";
import {
  assertNativeFloatingLoadReceipt, assertNativeFloatingFrameReceipt, assertNativeVideoTargetIdentity,
  nativeFloatRuntimeMatches, type NativeFloatingMaterialReceipt,
} from "../render/nativeFloatingVideoFrameReceipt";
import {
  prepareNativeMotionPaintReceiptExpectations, assertNativeMotionPaintLoadReceipt,
  assertNativeMotionPaintFrameReceipt, type PreparedNativeMotionPaintReceiptExpectations,
  type NativeMotionPaintWorkMetrics,
} from "../motion/nativeMotionPaintReceipt";
import { assertResidentSceneLinearWhiteBalanceReceipt } from "../render/residentSceneLinearWhiteBalance";

type Row = Record<string, unknown>;
type StagedVideoFrame = NonNullable<GpuVideoStagedFrame["receipt"]["frame"]>;
const DISPLAY = "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
const CONFIG_SHA = "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a";
const LUT_SHA = "0808837eb979b6f59e79db411f6bd861469456a89bf399ffe652a99bf0c454b3";
const allowedKinds = new Set(["source", "color", "transform2d", "composite", "output",
  "caption", "motion_graphic", "native_motion_paint", "floating_video_frame_2d"]);

export interface OffscreenRuntimeExpectation {
  readonly generation: number;
  readonly executableSha256: string;
  readonly executableBytes: number;
  /** Backend-selected full metadata; do not fill this from ready itself. */
  readonly nativeRuntimeMetadata: Readonly<Record<string, unknown>>;
}
export interface OffscreenRenderTargetDescription extends Row {
  backend: "Dx12"; offscreen: true; nativeWindow: false; nativeSwapChain: false;
  width: number; height: number; bound: false; visible: false; presentCount: 0;
  renderTargetContract: "editkin.resident-offscreen-render-target/v1";
  surfaceFormat: "Bgra8UnormSrgb"; requestedColorSpace: "srgb";
  hdrTransportConfigured: false; pixelContract: "legacy-sdr-video/v1";
}
export interface OffscreenEngineVideoLoadReceipt extends GpuEngineVideoPreviewLoadResult {
  videoTargetIdentity: Row;
  nativeMotionPaintColorBindings?: readonly Row[];
}
export interface OffscreenCompositionLayerReceipt extends Row {
  layerIndex: number; sourceNodeId: string; assetId: string; active: true;
  sourceFrame: number; sourceTimeSeconds: number; frame: StagedVideoFrame;
  visualGraph: GpuEngineVideoVisualGraph;
  transformNodeId: string; parentTransformNodeId: string | null;
  parentLayerIndex: number | null; parentControllerIndex: number | null; parentDepth: number;
}
/** The actual verify-frame producer has no `surface`/`visualGraphApplied`
 * properties. These fields are independently typed, never cast as PresentedFrame. */
export interface OffscreenCompositionFrameReceipt extends Row {
  sessionId: string; generation: number; active: true; endOfStream: false; timelineFrame: number;
  sourceFrame: number; sourceTimeSeconds: number; frame: StagedVideoFrame;
  layerFrames: StagedVideoFrame[]; layers: OffscreenCompositionLayerReceipt[];
  controllers: GpuEngineVideoControllerReceipt[]; visualGraph: GpuEngineVideoVisualGraph;
  visualLayers: GpuEngineVideoVisualGraph[];
  activeCaptions: GpuEngineVideoCaptionReceipt[]; activeMotionGraphics: GpuEngineVideoMotionGraphicReceipt[];
  activeFloatingVideoFrames: NativeFloatingMaterialReceipt[];
  verificationReadback: true; offscreen: true; nativeSurfacePresented: false; outputReadbackCopies: 1;
  renderTarget: OffscreenRenderTargetDescription; videoTargetIdentity: Row;
  outputWritten: true; outputHash: string;
  sceneLinearExecution: true; workingColorSpace: "linear_rec709"; workingFormat: "rgba16_float";
  displayTransform: typeof DISPLAY; outputSpace: "rec709_sdr";
  lutSha256: typeof LUT_SHA; lutPayloadSha256: null; configSha256: typeof CONFIG_SHA;
  ocioVersion: "2.5.2"; acesVersion: "2.0";
  compositeExecutionMode: "scene-linear-rgba16f-ping-pong/v1";
  compositeLayerCount: number; compositeFullFramePassCount: number; compositeMaximumLayersPerPass: 1;
  displayPaintLayerCount: number;
  displayPaintExecutionMode: "none" | "display-linear-rec709-source-over/v1";
  displayPaintCompositionBoundary: "none" | "after_aces2_before_output_encoding";
  displayPaintOutputEncodingCount: 0 | 1;
  engineGraph: GpuEngineGraphCoverage; resourcePlan: GpuEngineVideoResourcePlan;
  decodeSchedule: GpuEngineVideoDecodeSchedule;
}
export interface OffscreenCompositionFrameResult {
  readonly schema: "editkin.engine-video-png-preview/v1";
  /** Exact generated PNG copied on the owner FIFO, independent of cache reuse. */
  readonly pngBytes: readonly number[];
  readonly pngSha256: string;
  readonly receipt: OffscreenCompositionFrameReceipt;
}
export interface PreparedOffscreenCompositionPreview {
  readonly schema: "editkin.offscreen-composition-preview-expectations/v1";
  readonly sessionId: string; readonly width: number; readonly height: number;
}
export interface ValidatedOffscreenCompositionFrame {
  readonly sessionId: string; readonly timelineFrame: number; readonly generation: number;
  readonly width: number; readonly height: number;
  readonly videoTargetIdentity: Readonly<Row>;
  /** Native visible-pixel FNV64; this is not a PNG SHA256 or an art verdict. */
  readonly outputHash: string;
  readonly motionGraphicIds: readonly string[]; readonly captionIds: readonly string[];
  readonly paintWork: NativeMotionPaintWorkMetrics;
  readonly receipt: OffscreenCompositionFrameReceipt;
}
interface Owner {
  preview: GpuEngineVideoPreviewGraph; runtime: OffscreenRuntimeExpectation;
  paints: PreparedNativeMotionPaintReceiptExpectations; loaded: boolean; failed: boolean;
  validating?: boolean;
  target?: string; coverage?: string; resourcePlan?: string; decodeSchedule?: string;
}
const owners = new WeakMap<PreparedOffscreenCompositionPreview, Owner>();
function fail(label: string): never { throw new Error(`Offscreen whole-composition preview receipt mismatch: ${label}`); }
function check(value: unknown, label: string): asserts value { if (!value) fail(label); }
function object(value: unknown, label: string): Row {
  check(value && typeof value === "object" && !Array.isArray(value), label); return value as Row;
}
function rows(value: unknown, label: string): unknown[] { check(Array.isArray(value), label); return value; }
function exact(a: unknown, b: unknown, label: string): void { check(canonicalJson(a) === canonicalJson(b), label); }
function nonnegative(value: unknown, label: string): number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, label); return value;
}
function near(a: unknown, b: number, tolerance: number, label: string): void {
  check(typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= tolerance, label);
}
function ownerFor(value: PreparedOffscreenCompositionPreview): Owner {
  const owner = owners.get(value); check(owner && !owner.failed, "foreign/retired owner"); return owner;
}
function range(node: EngineNode): EngineFrameRange {
  const t = object(node.timeline, "authored source timeline");
  nonnegative(t.timelineStartFrame, "timeline start"); nonnegative(t.sourceStartFrame, "source start");
  check(nonnegative(t.durationFrames, "duration") > 0, "duration"); return t as unknown as EngineFrameRange;
}
function active(node: EngineNode, frame: number): boolean {
  const t = range(node); return frame >= t.timelineStartFrame && frame < t.timelineStartFrame + t.durationFrames;
}
function coverage(graph: EngineRenderGraph, raw: unknown): void {
  const c = object(raw, "coverage"); exact(c.graphSchema, graph.schema, "coverage schema");
  exact(c.graphId, graph.graphId, "coverage graph identity"); exact(c.directExecution, true, "direct execution");
  exact(rows(c.blockedNodeIds, "blocked nodes"), [], "blocked nodes"); exact(rows(c.ignoredNodeIds, "ignored nodes"), [], "ignored nodes");
  const executed = rows(c.executedNodeIds, "executed nodes");
  check(executed.every(id => typeof id === "string") && new Set(executed).size === executed.length, "executed node uniqueness");
  exact([...executed].sort(), graph.nodes.map(node => node.id).sort(), "complete exact node coverage");
}
function actualTarget(owner: Owner, raw: unknown): string {
  const graph = owner.preview.graph, identity = assertNativeVideoTargetIdentity(raw, owner.runtime.generation, true,
    { width: graph.width, height: graph.height });
  exact(identity.executableSha256, owner.runtime.executableSha256, "selected executable SHA256");
  exact(identity.executableBytes, owner.runtime.executableBytes, "selected executable bytes");
  return canonicalJson(identity);
}
function targetDescription(owner: Owner, raw: unknown): void {
  const target = object(raw, "target description"), graph = owner.preview.graph;
  for (const [key, value] of Object.entries({ backend: "Dx12", offscreen: true, nativeWindow: false, nativeSwapChain: false,
    bound: false, visible: false, presentCount: 0, cpuPixelReadbacks: 0, width: graph.width, height: graph.height,
    residentRenderTarget: true, renderTargetContract: "editkin.resident-offscreen-render-target/v1",
    surfaceFormat: "Bgra8UnormSrgb", requestedColorSpace: "srgb", pixelContract: "legacy-sdr-video/v1",
    hdrTransportConfigured: false, dxgiColorSpaceConfiguration: "none", physicalDisplayHdrVisibility: "not_applicable" })) {
    exact(target[key], value, `target ${key}`);
  }
}
function unsupportedWork(raw: Row, load: boolean): void {
  check(raw.scene25d == null && raw.depthOfField == null && raw.vfxSimulation == null, "unsupported scene/depth/VFX receipt");
  if (load) {
    for (const key of ["matteCount", "precompositionCount", "adjustmentCount", "particleCount", "particleTexturesResident"]) exact(raw[key], 0, `load ${key}`);
    exact(raw.adjustments, [], "load adjustments");
    const effects = object(raw.gpuEffects, "load effect resolver");
    exact(effects.runtime, "editkin.gpu-effect-graph/v1", "effect resolver runtime"); exact(effects.resolved, true, "effects resolved");
    exact(effects.count, 0, "effect count"); exact(effects.programs, [], "effect programs");
    return;
  }
  for (const key of ["depthExecutionMode", "depthFormat", "depthOfFieldExecutionMode", "depthOfFieldDepthSource",
    "effectExecutionMode", "temporalExecutionMode", "matteExecutionMode", "adjustmentExecutionMode"]) exact(raw[key], "none", key);
  for (const key of ["depthTestedLayerCount", "depthPassCount", "depthOfFieldPassCount", "shaderOperationCount", "builtInEffectCount",
    "temporalLayerCount", "temporalSampleTextureCount", "mattePassCount", "adjustmentPassCount"]) exact(raw[key], 0, key);
  check(raw.temporalSampling == null && raw.activeParticles == null, "unexpected temporal/particle work");
  exact(raw.activeParticleEmitters, [], "particle emitters"); exact(raw.activeAdjustments, [], "active adjustments");
}
function structures(owner: Owner, raw: Row): void {
  const graph = owner.preview.graph, expected = expectedEngineVideoTopology(graph);
  coverage(graph, raw.engineGraph);
  check(engineVideoResourcePlanMatches(object(raw.resourcePlan, "resource plan") as unknown as GpuEngineVideoResourcePlan,
    graph, expected.layers.length, expectedEngineVideoCaptions(graph).length + expectedEngineVideoMotionGraphics(graph).length + owner.paints.nativePaintCount,
    0, 0, 0), "declared resource plan");
  check(engineVideoDecodeScheduleMatches(object(raw.decodeSchedule, "decode schedule") as unknown as GpuEngineVideoDecodeSchedule,
    expected.layers), "decode schedule");
}
/** Pure, conservative selector for the new fixed-frame route. Returning true
 * admits only this validator's flat graph scope; it is not runtime readiness. */
export function offscreenCompositionPreviewGraphSupported(graph: EngineRenderGraph): boolean {
  try {
    if (graph.schema !== "editkin.engine-graph/v1" || graph.workingFormat !== "rgba16_float"
      || !Number.isSafeInteger(graph.width) || !Number.isSafeInteger(graph.height) || graph.width < 2 || graph.height < 2
      || graph.width > 8192 || graph.height > 8192 || graph.width * graph.height > 8_294_400) return false;
    const { numerator, denominator } = graph.timebase;
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 1 || denominator < 1
      || numerator > 1_000_000 || denominator > 1_000_000 || denominator / numerator < 2 || denominator / numerator > 240) return false;
    if (!graph.nodes.length || graph.nodes.length > 4096 || new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length
      || graph.nodes.some(node => node.enabled !== true || !allowedKinds.has(node.kind) || node.matteInput != null || node.matteMode != null)) return false;
    const displays = graph.nodes.filter(node => node.kind === "color" && String(node.processor).startsWith("editkin-ocio-"));
    if (displays.length !== 1 || displays[0].processor !== DISPLAY || displays[0].inputSpace !== "linear_rec709"
      || displays[0].workingSpace !== "ACEScct" || displays[0].outputSpace !== "rec709_sdr") return false;
    const topology = expectedEngineVideoTopology(graph);
    if (!topology.layers.length || topology.layers.length > 8
      || graph.nodes.filter(node => node.kind === "source" && node.mediaKind === "video").length !== topology.layers.length
      || graph.nodes.filter(node => node.kind === "source" && node.mediaKind === "generator").length !== topology.controllers.length
      || graph.nodes.filter(node => node.kind === "source").length !== topology.layers.length + topology.controllers.length) return false;
    for (const layer of topology.layers) range(layer.source);
    for (const controller of topology.controllers) range(controller.source);
    return topology.layers.every((layer, index) => !layer.motionBlur && !layer.shaderEffectExpected && layer.effectKind === 0
      && layer.matteLayerIndex === undefined && !layer.precompositionNodeIds.length && !layer.nestedGraphIds.length
      && engineVideoDecodeCadence(layer, index, topology.layers.length).divisor === 1);
  } catch { return false; }
}
/** This profile deliberately refuses effect/temporal/matte/nesting/particles/
 * adjustment/scene/depth/HDR rather than accepting incomplete receipts. */
export async function prepareOffscreenCompositionPreview(input: {
  preview: GpuEngineVideoPreviewGraph; sessionId: string; runtime: OffscreenRuntimeExpectation; ready: unknown;
}): Promise<PreparedOffscreenCompositionPreview> {
  check(/^[A-Za-z0-9_.:-]{1,128}$/.test(input.sessionId), "owner-managed engine video session");
  const preview = structuredClone(input.preview), runtime = structuredClone(input.runtime), graph = preview.graph;
  check(offscreenCompositionPreviewGraphSupported(graph), "fixed-frame flat graph scope");
  check(graph.schema === "editkin.engine-graph/v1" && graph.workingFormat === "rgba16_float", "execution graph format");
  check(Number.isSafeInteger(graph.width) && Number.isSafeInteger(graph.height) && graph.width > 0 && graph.height > 0
    && graph.width <= 8192 && graph.height <= 8192 && graph.width * graph.height <= 8_294_400, "offscreen canvas bounds");
  const { numerator, denominator } = graph.timebase;
  check(Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && numerator > 0 && denominator > 0
    && numerator <= 1_000_000 && denominator <= 1_000_000 && denominator / numerator >= 2 && denominator / numerator <= 240, "rational frame clock");
  nonnegative(preview.timelineFrame, "load timeline frame");
  check(graph.nodes.length > 0 && graph.nodes.length <= 4096 && new Set(graph.nodes.map(node => node.id)).size === graph.nodes.length
    && graph.nodes.every(node => node.enabled === true && allowedKinds.has(node.kind) && node.matteInput == null && node.matteMode == null), "unsupported/disabled/duplicate graph family");
  check(graph.nodes.filter(node => node.kind === "color" && String(node.processor).startsWith("editkin-ocio-")).length === 1, "one ACES boundary");
  const display = graph.nodes.find(node => node.kind === "color" && node.processor === DISPLAY);
  check(display && display.inputSpace === "linear_rec709" && display.workingSpace === "ACEScct" && display.outputSpace === "rec709_sdr", "ACES2 SDR boundary");
  const identityGrade: Row = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0,
    pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0, whiteBalanceRed: 0, whiteBalanceGreen: 0, whiteBalanceBlue: 0 };
  check(display.grade === undefined || Object.entries(object(display.grade, "display grade")).every(([key, value]) =>
    Object.hasOwn(identityGrade, key) && identityGrade[key] === value), "identity display grade");
  const expected = expectedEngineVideoTopology(graph);
  check(expected.layers.length > 0 && expected.layers.length <= 8, "supported exact video topology");
  check(graph.nodes.filter(node => node.kind === "source" && node.mediaKind === "video").length === expected.layers.length
    && graph.nodes.filter(node => node.kind === "source" && node.mediaKind === "generator").length === expected.controllers.length
    && graph.nodes.filter(node => node.kind === "source").length === expected.layers.length + expected.controllers.length, "source ownership");
  check(expected.layers.every((layer, index) => !layer.motionBlur && !layer.shaderEffectExpected && layer.effectKind === 0
    && layer.matteLayerIndex === undefined && layer.precompositionNodeIds.length === 0 && layer.nestedGraphIds.length === 0
    && engineVideoDecodeCadence(layer, index, expected.layers.length).divisor === 1), "unsupported source work/adaptive cadence");
  for (const node of [...expected.layers.map(layer => layer.source), ...expected.controllers.map(controller => controller.source)]) range(node);
  const ready = object(input.ready, "ready runtime");
  exact(ready.event, "ready", "ready event"); exact(ready.engine, "editkin-wgpu-resident-engine/v1", "ready engine");
  check(nonnegative(runtime.generation, "runtime generation") > 0 && /^[a-f0-9]{64}$/.test(runtime.executableSha256)
    && nonnegative(runtime.executableBytes, "runtime executable bytes") > 0, "backend selected runtime identity");
  exact(ready.generation, runtime.generation, "ready generation"); exact(ready.nativeRuntimeMetadata, runtime.nativeRuntimeMetadata, "selected runtime metadata");
  exact(ready.videoInteropProtocol, "media-foundation-d3d11-d3d12-wgpu/v1", "video interop");
  exact(ready.offscreenVideoProtocol, "editkin.resident-offscreen-video-target/v1", "offscreen admission");
  if (expected.layers.some(layer => layer.floatingFrame)) check(nativeFloatRuntimeMatches(ready), "floating runtime admission");
  const paints = await prepareNativeMotionPaintReceiptExpectations(graph);
  const handle = Object.freeze({ schema: "editkin.offscreen-composition-preview-expectations/v1" as const,
    sessionId: input.sessionId, width: graph.width, height: graph.height });
  owners.set(handle, { preview, runtime, paints, loaded: false, failed: false }); return handle;
}
export function validateOffscreenCompositionTarget(expected: PreparedOffscreenCompositionPreview, raw: unknown): void {
  const owner = ownerFor(expected);
  try {
    check(!owner.loaded && owner.target === undefined, "target bind generation");
    const target = object(raw, "bound target"); targetDescription(owner, target);
    owner.target = actualTarget(owner, target.videoTargetIdentity);
  } catch (error) { owner.failed = true; throw error; }
}
export function validateOffscreenCompositionLoad(expected: PreparedOffscreenCompositionPreview, raw: unknown): void {
  const owner = ownerFor(expected), graph = owner.preview.graph, expectedTopology = expectedEngineVideoTopology(graph);
  try {
    check(!owner.loaded, "load owner state");
    const load = object(raw, "load"); exact(load.sessionId, expected.sessionId, "load session"); exact(load.generation, owner.runtime.generation, "load generation");
    exact(load.resident, true, "resident load"); exact(load.executor, "media-foundation-d3d11-d3d12-wgpu/v1", "load executor");
    exact(load.displayTransform, "aces2_rec709_sdr", "load display transform");
    // Tauri's atomic owned loader validates bind against the selected file and
    // ready metadata, then requires full bind/load target equality. The browser
    // receives the actual load identity, not invented bind-description flags.
    const loadedTarget = actualTarget(owner, load.videoTargetIdentity);
    if (owner.target !== undefined) exact(loadedTarget, owner.target, "unchanged load target");
    structures(owner, load); unsupportedWork(load, true);
    const layers = rows(load.layers, "load layers"), visuals = rows(load.visualLayers, "load visuals");
    exact(load.layerCount, expectedTopology.layers.length, "load layer count"); exact(layers.length, expectedTopology.layers.length, "load layers"); exact(visuals.length, layers.length, "load visuals");
    const parentCount = [...expectedTopology.layers, ...expectedTopology.controllers].filter(node => node.parentLayerIndex !== undefined || node.parentControllerIndex !== undefined).length;
    exact(load.parentCount, parentCount, "parent count"); exact(load.controllerCount, expectedTopology.controllers.length, "controller count");
    const controllers = rows(load.controllers, "load controllers"); exact(controllers.length, expectedTopology.controllers.length, "controllers");
    controllers.forEach((rawController, index) => check(controllerReceiptMatches(rawController as GpuEngineVideoControllerReceipt,
      expectedTopology.controllers[index], expectedTopology.layers, expectedTopology.controllers, graph, owner.preview.timelineFrame), "load controller sample"));
    const groupIds = new Map<string, number>(), idGroups = new Map<number, string>();
    const groupKeys = expectedTopology.layers.map(layer => `${owner.preview.assetBindings[layer.assetId]}\u0000full:${layer.sourceNodeId}`);
    const groups = groupKeys.reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map<string, number>());
    layers.forEach((rawLayer, index) => {
      const layer = object(rawLayer, "load layer"), authored = expectedTopology.layers[index], decoder = object(layer.decoder, "load decoder");
      exact(layer.sourceNodeId, authored.sourceNodeId, "load source"); exact(layer.assetId, authored.assetId, "load asset");
      exact(layer.transformNodeId, authored.transformNodeId, "load transform"); exact(layer.parentTransformNodeId ?? undefined, authored.parentTransformNodeId, "load parent transform");
      exact(layer.parentLayerIndex ?? undefined, authored.parentLayerIndex, "load parent layer"); exact(layer.parentControllerIndex ?? undefined, authored.parentControllerIndex, "load parent controller"); exact(layer.parentDepth, authored.parentDepth, "load parent depth");
      exact(layer.blendMode, authored.blendMode, "load blend"); near(layer.compositeOpacity, authored.compositeOpacity, 0.000001, "load composite opacity");
      check(layer.motionBlur == null && layer.matteLayerIndex == null && layer.matteMode == null, "load unsupported source work");
      exact(layer.precompositionNodeIds, [], "load precomposition"); exact(layer.nestedGraphIds, [], "load nested graphs");
      exact(layer.decodeCadenceDivisor, 1, "full rate decoder"); exact(layer.decodeCadencePhase, 0, "decode phase");
      exact(decoder.resident, true, "resident decoder"); exact(decoder.decodePathCpuPixelCopies, 0, "decoder CPU copies");
      exact(decoder.gpuResidentStaging, true, "resident staging"); exact(decoder.stagingCpuPixelReadback, false, "staging readback");
      const dims = owner.preview.decoderDimensions[authored.assetId]; check(dims, "bound decoder dimensions");
      exact(decoder.width, dims.width, "coded decoder width"); exact(decoder.height, dims.height, "coded decoder height");
      if (layers.length > 1) {
        const key = groupKeys[index], count = groups.get(key)!; const id = nonnegative(decoder.decoderInstanceId, "decoder instance");
        exact(decoder.decodeDispatchMode, "parallel-com-apartment/v1", "parallel decoder"); exact(decoder.sourceCacheSchema, "editkin.shared-source-frame-cache/v1", "decoder source cache");
        exact(layer.sharedDecoderLayerCount, count, "shared layer count"); exact(decoder.residentFrameRingSize, count * 3, "decoder ring size");
        check((!groupIds.has(key) || groupIds.get(key) === id) && (!idGroups.has(id) || idGroups.get(id) === key), "decoder group ownership");
        groupIds.set(key, id); idGroups.set(id, key);
      } else { exact(decoder.residentFrameRingSize, 3, "single decoder ring"); check(decoder.decodeDispatchMode == null, "single direct decoder"); }
      check(engineVisualMatches(layer.visualGraph as GpuEngineVideoVisualGraph, authored, expectedTopology.layers,
        expectedTopology.controllers, graph, owner.preview.timelineFrame), "load sampled visual");
      exact(visuals[index], layer.visualGraph, "load visual projection identity");
    });
    const captions = expectedEngineVideoCaptions(graph), graphics = expectedEngineVideoMotionGraphics(graph);
    exact(load.captionCount, captions.length, "caption count"); exact(load.captionTextureUploads, captions.length, "caption resident uploads");
    const captionRows = rows(load.captions, "captions"); exact(captionRows.length, captions.length, "caption rows");
    captionRows.forEach((value, index) => check(captionReceiptMatches(value as GpuEngineVideoCaptionReceipt, captions[index]), "caption identity"));
    exact(load.motionGraphicCount, graphics.length, "motion graphic count"); exact(load.motionGraphicTextureUploads, graphics.length, "motion resident uploads");
    const graphicRows = rows(load.motionGraphics, "motion graphics"); exact(graphicRows.length, graphics.length, "motion rows");
    graphicRows.forEach((value, index) => check(motionGraphicReceiptMatches(value as GpuEngineVideoMotionGraphicReceipt, graphics[index], graph), "motion identity"));
    activeTypography(owner, load, owner.preview.timelineFrame);
    assertNativeFloatingLoadReceipt(graph, load);
    // Paint commits its private cache state. Make it the last potentially failing check.
    assertNativeMotionPaintLoadReceipt(owner.paints, owner.preview.timelineFrame, load);
    owner.coverage = canonicalJson(load.engineGraph); owner.resourcePlan = canonicalJson(load.resourcePlan);
    owner.decodeSchedule = canonicalJson(load.decodeSchedule); owner.target = loadedTarget; owner.loaded = true;
  } catch (error) { owner.failed = true; throw error; }
}
function activeTypography(owner: Owner, raw: Row, timelineFrame: number): { captionIds: string[]; graphicIds: string[] } {
  const graph = owner.preview.graph, captions = expectedEngineVideoCaptions(graph), graphics = expectedEngineVideoMotionGraphics(graph);
  const activeCaptions = captions.filter(node => captionActiveAt(node, timelineFrame));
  const activeGraphics = graphics.filter(node => motionGraphicExpectedSample(node, graph, timelineFrame) !== undefined);
  exact(raw.captionTextureUploads, captions.length, "caption uploads"); exact(raw.motionGraphicTextureUploads, graphics.length, "motion uploads");
  const observedCaptions = rows(raw.activeCaptions, "active captions"), observedGraphics = rows(raw.activeMotionGraphics, "active graphics");
  exact(observedCaptions.length, activeCaptions.length, "active caption count"); exact(observedGraphics.length, activeGraphics.length, "active motion count");
  observedCaptions.forEach((value, index) => check(captionReceiptMatches(value as GpuEngineVideoCaptionReceipt, activeCaptions[index]), "active caption owner"));
  observedGraphics.forEach((value, index) => check(motionGraphicReceiptMatches(value as GpuEngineVideoMotionGraphicReceipt, activeGraphics[index], graph, timelineFrame), "active motion sample"));
  return { captionIds: activeCaptions.map(node => String(node.cueId)), graphicIds: activeGraphics.map(node => String(node.graphicId)) };
}
export function retireOffscreenCompositionPreview(expected: PreparedOffscreenCompositionPreview): void {
  const owner = owners.get(expected); if (owner) owner.failed = true;
}
/** PNG envelope schema/SHA/byte bounds/IHDR/decode belong to the image holder.
 * This validator receives {receipt} and proves engine/clock/owner composition;
 * returned size is actual admitted target size, not a fabricated PNG decode. */
export function validateOffscreenCompositionFrame(expected: PreparedOffscreenCompositionPreview, timelineFrame: number,
  input: { readonly receipt: unknown }): ValidatedOffscreenCompositionFrame {
  const owner = ownerFor(expected), graph = owner.preview.graph;
  try {
    check(!owner.validating, "concurrent receipt validation"); owner.validating = true;
    check(owner.loaded && owner.target !== undefined, "frame loaded owner"); nonnegative(timelineFrame, "requested frame");
    const result = object(input, "frame result"), receipt = object(result.receipt, "frame receipt");
    exact(receipt.sessionId, expected.sessionId, "frame session"); exact(receipt.generation, owner.runtime.generation, "frame generation");
    exact(receipt.timelineFrame, timelineFrame, "requested timeline frame"); exact(receipt.active, true, "active graph"); exact(receipt.endOfStream, false, "source not exhausted");
    exact(actualTarget(owner, receipt.videoTargetIdentity), owner.target, "unchanged frame target"); targetDescription(owner, receipt.renderTarget);
    exact(receipt.offscreen, true, "offscreen frame"); exact(receipt.nativeSurfacePresented, false, "no native presentation");
    exact(receipt.outputReadbackCopies, 1, "one whole-frame readback"); exact(receipt.verificationReadback, true, "actual verification readback");
    exact(receipt.outputWritten, true, "actual output written"); check(typeof receipt.outputHash === "string" && /^fnv1a64:[a-f0-9]{16}$/.test(receipt.outputHash), "native FNV64 output hash");
    structures(owner, receipt); exact(canonicalJson(receipt.engineGraph), owner.coverage, "unchanged graph coverage");
    exact(canonicalJson(receipt.resourcePlan), owner.resourcePlan, "unchanged resource plan"); exact(canonicalJson(receipt.decodeSchedule), owner.decodeSchedule, "unchanged decode schedule");
    unsupportedWork(receipt, false);
    const topology = expectedEngineVideoTopology(graph), authoredActive = topology.layers.filter(layer => active(layer.source, timelineFrame));
    check(authoredActive.length > 0, "current verify route requires an active video layer");
    const layers = rows(receipt.layers, "active layers"), frames = rows(receipt.layerFrames, "staged frames"), visuals = rows(receipt.visualLayers, "actual uniforms");
    exact(layers.length, authoredActive.length, "active source count"); exact(frames.length, layers.length, "frame/source count"); exact(visuals.length, layers.length, "uniform/source count");
    const tolerance = .5 * graph.timebase.numerator / graph.timebase.denominator;
    layers.forEach((rawLayer, index) => {
      const layer = object(rawLayer, "active source"), authored = authoredActive[index], t = range(authored.source);
      const sourceFrame = t.sourceStartFrame + timelineFrame - t.timelineStartFrame, seconds = sourceFrame * graph.timebase.numerator / graph.timebase.denominator;
      exact(layer.layerIndex, topology.layers.indexOf(authored), "source layer index"); exact(layer.sourceNodeId, authored.sourceNodeId, "source order"); exact(layer.assetId, authored.assetId, "source asset"); exact(layer.active, true, "source active");
      exact(layer.sourceFrame, sourceFrame, "source frame"); near(layer.sourceTimeSeconds, seconds, 1e-9, "source clock");
      exact(layer.transformNodeId, authored.transformNodeId, "transform owner"); exact(layer.parentTransformNodeId ?? undefined, authored.parentTransformNodeId, "parent transform owner");
      exact(layer.parentLayerIndex ?? undefined, authored.parentLayerIndex, "parent layer owner"); exact(layer.parentControllerIndex ?? undefined, authored.parentControllerIndex, "parent controller owner"); exact(layer.parentDepth, authored.parentDepth, "parent depth");
      check(layer.motionBlur == null && layer.matteLayerIndex == null && layer.matteMode == null, "unexpected source work"); exact(layer.precompositionNodeIds, [], "precomposition"); exact(layer.nestedGraphIds, [], "nested graphs");
      check(engineVisualMatches(layer.visualGraph as GpuEngineVideoVisualGraph, authored, topology.layers, topology.controllers, graph, timelineFrame, true), "exact sampled affine/grade/floating uniform"); exact(visuals[index], layer.visualGraph, "uniform projection identity");
      const frame = object(frames[index], "staged video frame"); exact(layer.frame, frame, "layer staged-frame identity");
      const dims = owner.preview.decoderDimensions[authored.assetId]; exact(frame.width, dims.width, "staged coded width"); exact(frame.height, dims.height, "staged coded height");
      exact(frame.decodePathCpuPixelCopies, 0, "decoded CPU copies"); exact(frame.stagingCpuPixelReadbacks, 0, "staging readbacks");
      exact(frame.nativeSurfacePresented, false, "staged no HWND presentation"); exact(frame.nativeSurfaceCpuPixelReadbacks, 0, "staged surface readbacks");
      exact(frame.verificationReadback, false, "staging is not final image"); exact(frame.outputWritten, false, "staging is not PNG producer");
      check(nonnegative(frame.gpuSubmissionSequence, "GPU submission") > 0, "actual GPU submission"); nonnegative(frame.frameRingSlot, "frame ring slot");
      near(frame.clockTargetSeconds, seconds, 1e-9, "staged clock target"); near(frame.clockToleranceSeconds, tolerance, 1e-12, "requested half-frame tolerance");
      exact(frame.clockWithinTolerance, true, "decode within frame clock");
      check(typeof frame.timestampSeconds === "number" && Number.isFinite(frame.timestampSeconds), "decoded timestamp");
      near(frame.clockDriftMilliseconds, (frame.timestampSeconds - seconds) * 1000, .00011, "actual 100ns clock drift");
      check(Math.abs((frame.timestampSeconds - seconds) * 1000) <= tolerance * 1000 + .00011, "bounded decoded drift");
      if (topology.layers.length > 1) exact(frame.decodeDispatchMode, "parallel-com-apartment/v1", "frame parallel decoder"); else check(frame.decodeDispatchMode == null, "frame direct decoder");
    });
    exact(receipt.frame, frames[0], "primary staged frame"); exact(receipt.visualGraph, visuals[0], "primary uniform");
    exact(receipt.sourceFrame, object(layers[0], "primary source").sourceFrame, "primary source frame"); exact(receipt.sourceTimeSeconds, object(layers[0], "primary source").sourceTimeSeconds, "primary source clock");
    const controllers = rows(receipt.controllers, "frame controllers"); exact(controllers.length, topology.controllers.length, "frame controller count");
    controllers.forEach((value, index) => check(controllerReceiptMatches(value as GpuEngineVideoControllerReceipt,
      topology.controllers[index], topology.layers, topology.controllers, graph, timelineFrame), "sampled controller clock/transform"));
    const typography = activeTypography(owner, receipt, timelineFrame);
    assertNativeFloatingFrameReceipt(graph, timelineFrame, receipt); assertResidentSceneLinearWhiteBalanceReceipt(graph, timelineFrame, receipt);
    for (const [key, value] of Object.entries({ sceneLinearExecution: true, workingColorSpace: "linear_rec709", workingFormat: "rgba16_float",
      displayTransform: DISPLAY, outputSpace: "rec709_sdr", lutSha256: LUT_SHA, lutPayloadSha256: null,
      ocioVersion: "2.5.2", acesVersion: "2.0", configSha256: CONFIG_SHA, decodedVideoCpuPixelCopies: 0 })) exact(receipt[key], value, key);
    const paintRows = rows(receipt.activeNativeMotionPaints ?? (owner.paints.nativePaintCount === 0 ? [] : undefined), "active paint rows");
    const displayPaintCount = paintRows.filter(value => object(value, "active paint").colorIntent === "display_rec709_sdr").length;
    const totalLayers = layers.length + typography.captionIds.length + typography.graphicIds.length + paintRows.length;
    exact(receipt.compositeExecutionMode, "scene-linear-rgba16f-ping-pong/v1", "flat whole composition"); exact(receipt.compositeLayerCount, totalLayers, "whole layer count");
    exact(receipt.compositeMaximumLayersPerPass, 1, "ordered source-over passes"); exact(receipt.compositeFullFramePassCount, totalLayers + 1 + Number(displayPaintCount > 0), "actual scene/display pass count");
    exact(receipt.displayPaintLayerCount, displayPaintCount, "display paint count"); exact(receipt.displayPaintExecutionMode, displayPaintCount ? "display-linear-rec709-source-over/v1" : "none", "display paint executor");
    exact(receipt.displayPaintCompositionBoundary, displayPaintCount ? "after_aces2_before_output_encoding" : "none", "display paint boundary"); exact(receipt.displayPaintOutputEncodingCount, Number(displayPaintCount > 0), "sole display-suffix output encoding");
    exact(receipt.adjustmentBaseLayerCount, totalLayers - displayPaintCount, "scene prefix layer count");
    // All non-paint checks precede the paint cache commit. A rejected frame
    // retires this owner, since native work may already have changed texture state.
    const paintWork = assertNativeMotionPaintFrameReceipt(owner.paints, timelineFrame, receipt);
    return Object.freeze({ sessionId: expected.sessionId, timelineFrame, generation: owner.runtime.generation,
      width: graph.width, height: graph.height, outputHash: receipt.outputHash,
      videoTargetIdentity: Object.freeze(structuredClone(object(receipt.videoTargetIdentity, "validated target"))),
      motionGraphicIds: Object.freeze([...typography.graphicIds, ...paintWork.activeGraphicIds]), captionIds: Object.freeze(typography.captionIds),
      paintWork, receipt: receipt as unknown as OffscreenCompositionFrameReceipt });
  } catch (error) { owner.failed = true; throw error; }
  finally { owner.validating = false; }
}
