import type { EngineNode, EngineRenderGraph } from "../render/engineGraph";
import type { NativeMotionPaintTrack } from "./nativeMotionPaint";

export interface PreparedNativeMotionPaintReceiptExpectations {
  readonly schema: "editkin.native-motion-paint-receipt-expectations/v1";
  readonly nativePaintCount: number;
  readonly graphicIds: readonly string[];
}
export interface NativeMotionPaintWorkMetrics {
  readonly nativePaintCount: number;
  readonly cpuPixelCopies: number;
  readonly cpuUploadBytes: number;
  readonly rasterCount: number;
  readonly textureUploadCount: number;
  readonly totalTextureUploadCount: number;
  readonly activeGraphicIds: readonly string[];
}
type ColorIntent = "scene_linear_rec709" | "display_rec709_sdr";
type CompositionBoundary = "before_aces2" | "after_aces2_before_output_encoding";
type Expected = { nodeId: string; graphicId: string; track: NativeMotionPaintTrack; signatureSha: string;
  colorIntent: ColorIntent; compositionBoundary: CompositionBoundary; overlayOrder: number;
  cachedFrame: number | undefined; uploads: number };
type Owner = { width: number; height: number; nodes: Expected[]; loaded: boolean };
const owners = new WeakMap<PreparedNativeMotionPaintReceiptExpectations, Owner>();
function fail(reason: string): never { throw new Error(`Native Motion paint receipt 不一致：${reason}`); }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : fail("不是物件");
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sameF32 = (left: unknown, right: number): boolean => typeof left === "number" && Number.isFinite(left)
  && Object.is(Math.fround(left), Math.fround(right));
const poseFields = ["x", "y", "scale", "opacity"] as const;
function validAuthoredPose(value: unknown, maxScale: number): boolean {
  const pose = record(value);
  return Object.keys(pose).length === poseFields.length && poseFields.every(field => Object.hasOwn(pose, field)
    && typeof pose[field] === "number" && Number.isFinite(pose[field]) && Number.isFinite(Math.fround(pose[field] as number)))
    && Math.abs(pose.x as number) <= 1_000_000 && Math.abs(pose.y as number) <= 1_000_000
    && (pose.scale as number) >= .01 && (pose.scale as number) <= maxScale
    && (pose.opacity as number) >= 0 && (pose.opacity as number) <= 1;
}
/** Only samples of the same privately cloned track are comparable. V1 keeps
 * path/reveal topology, paint, clips, stroke and shadow fixed in its scene;
 * every stable layer's four authored pose fields must match at f32 bit precision. */
function samePoseContent(node: Expected, frame: number): boolean {
  if (node.cachedFrame === undefined || !activeAt(node, node.cachedFrame)) return false;
  const offset = node.track.timeline.timelineStartFrame;
  const cached = node.track.frames[node.cachedFrame - offset], current = node.track.frames[frame - offset];
  return cached.length === current.length && current.every((pose, index) =>
    poseFields.every(field => sameF32(pose[field], cached[index][field])));
}

function authoredColorIntent(track: NativeMotionPaintTrack): ColorIntent {
  const wire = record(track), common = ["schema", "scene", "timeline", "frames", "sourceSignature"];
  if (wire.schema === "editkin.native-motion-paint-track/v1" && Object.keys(wire).length === common.length
    && common.every(key => Object.hasOwn(wire, key))) return "scene_linear_rec709";
  if (wire.schema === "editkin.native-motion-paint-track/v2" && Object.keys(wire).length === common.length + 1
    && common.every(key => Object.hasOwn(wire, key)) && wire.colorIntent === "display_rec709_sdr") return "display_rec709_sdr";
  return fail("invalid authored color intent/schema");
}
const ACES_SDR = "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
const ACES_PROCESSORS = new Set([ACES_SDR,
  "editkin-ocio-aces2-linear-rec709-to-rec2100-hlg-1000/v1", "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1"]);
type OrderedNative = { nodeId: string; graphicId: string; track: NativeMotionPaintTrack;
  colorIntent: ColorIntent; compositionBoundary: CompositionBoundary; overlayOrder: number };

/** The scene schema never gains display intent through receipt metadata. New
 * display paint is only the final direct source-over suffix after one SDR ACES
 * boundary; the graph, not the native receipt, establishes that ordering. */
function assertAuthoredColorBoundary(graph: EngineRenderGraph, reachable: readonly EngineNode[], natives: readonly OrderedNative[]): void {
  const displayPaints = natives.filter(node => node.colorIntent === "display_rec709_sdr");
  if (!displayPaints.length) return; // Existing scene-only graph admission stays unchanged.
  if (new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length) fail("display graph node identity");
  const byId = new Map(reachable.map(node => [node.id, node]));
  const output = byId.get(graph.outputNode);
  if (!output || output.kind !== "output" || output.enabled !== true || output.inputs.length !== 1) fail("display output boundary");
  const displayNodes = reachable.filter(node => node.kind === "color" && ACES_PROCESSORS.has(String(node.processor)));
  if (displayNodes.length !== 1) fail("display paint needs one ACES2 SDR boundary");
  const display = displayNodes[0];
  if (display.processor !== ACES_SDR || display.enabled !== true || display.inputs.length !== 1
    || display.inputSpace !== "linear_rec709" || display.workingSpace !== "ACEScct" || display.outputSpace !== "rec709_sdr") {
    fail("display paint ACES2 SDR identity");
  }
  const identityGrade: Record<string, number> = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0,
    temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0,
    whiteBalanceRed: 0, whiteBalanceGreen: 0, whiteBalanceBlue: 0 };
  if (display.grade !== undefined && Object.entries(record(display.grade)).some(([key, value]) =>
    !Object.hasOwn(identityGrade, key) || value !== identityGrade[key])) fail("display paint graded ACES boundary");
  const forbidden = new Set(["transform3d", "camera", "light", "depth", "depth_of_field", "matte"]);
  if (reachable.some(node => forbidden.has(node.kind) || node.matteInput != null || node.matteMode != null)) fail("display paint 3D/depth/matte boundary");

  const suffix: string[] = [], nativeById = new Map(natives.map(node => [node.nodeId, node]));
  let tail = output.inputs[0];
  while (tail !== display.id) {
    const composite = byId.get(tail);
    if (!composite || composite.kind !== "composite" || composite.enabled !== true || composite.inputs.length !== 2
      || composite.blendMode !== "normal" || composite.opacity !== 1 || composite.matteInput != null || composite.matteMode != null) {
      fail("display paint must be final normal opacity-1 composite suffix");
    }
    const paint = nativeById.get(composite.inputs[1]);
    if (!paint || paint.colorIntent !== "display_rec709_sdr" || suffix.includes(paint.nodeId)) fail("display paint suffix source/order");
    suffix.push(paint.nodeId); tail = composite.inputs[0];
  }
  suffix.reverse();
  if (suffix.length !== displayPaints.length || suffix.some((id, index) => id !== displayPaints[index].nodeId)) fail("display paint suffix order/reachability");
  const before = new Set<string>();
  const collect = (id: string): void => {
    if (before.has(id)) return;
    const node = byId.get(id);
    if (!node) fail("missing display prefix node");
    before.add(id); for (const input of node.inputs) collect(input);
  };
  collect(display.inputs[0]);
  if (natives.some(node => (node.colorIntent === "display_rec709_sdr") === before.has(node.nodeId))) fail("scene/display authored domain order");
  // A native source cannot be consumed on another path, even if a receipt
  // reports the same signature and a seemingly valid ordinal.
  if (natives.some(node => reachable.reduce((count, candidate) => count + candidate.inputs.filter(id => id === node.nodeId).length, 0) !== 1)) {
    fail("display graph shared native source");
  }
}
function orderedNativeNodes(graph: EngineRenderGraph) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const seen = new Set<string>(), active = new Set<string>();
  const result: OrderedNative[] = [], reachable: EngineNode[] = [];
  let overlayOrder = 0;
  function visit(id: string) {
    if (active.has(id)) fail("cyclic graph");
    if (seen.has(id)) return;
    const node = byId.get(id);
    if (!node) fail("missing node");
    active.add(id);
    for (const input of node.inputs) visit(input);
    active.delete(id); seen.add(id); reachable.push(node);
    if (node.kind === "motion_graphic") { overlayOrder++; return; }
    if (node.kind !== "native_motion_paint") return;
    const track = node.track as NativeMotionPaintTrack | undefined;
    if (node.enabled !== true || node.inputs.length || typeof node.graphicId !== "string" || !node.graphicId
      || !track
      || track.scene.width !== graph.width || track.scene.height !== graph.height
      || typeof track.sourceSignature !== "string" || !track.sourceSignature.trim()
      || new TextEncoder().encode(track.sourceSignature).length > 65_536
      || !integer(track.timeline.timelineStartFrame) || !integer(track.timeline.durationFrames) || track.timeline.durationFrames < 1
      || track.timeline.sourceStartFrame !== 0 || track.frames.length !== track.timeline.durationFrames
      || !track.scene.layers.length || track.frames.some(poses => poses.length !== track.scene.layers.length
        || poses.some(pose => !validAuthoredPose(pose, track.scene.max_scale ?? 1)))) fail("invalid authored track");
    const colorIntent = authoredColorIntent(track);
    result.push({ nodeId: node.id, graphicId: node.graphicId, track: structuredClone(track), colorIntent,
      compositionBoundary: colorIntent === "display_rec709_sdr" ? "after_aces2_before_output_encoding" : "before_aces2",
      overlayOrder: overlayOrder++ });
  }
  visit(graph.outputNode);
  if (result.length > 4 || result.length !== graph.nodes.filter(node => node.kind === "native_motion_paint").length
    || new Set(result.map(node => node.graphicId)).size !== result.length) fail("native node reachability/identity");
  assertAuthoredColorBoundary(graph, reachable, result);
  return result;
}

/** Expected bytes come from the same execution graph, not a caller-provided
 * receipt. No new font authority or alternate motion evaluator is created. */
export async function prepareNativeMotionPaintReceiptExpectations(graph: EngineRenderGraph): Promise<PreparedNativeMotionPaintReceiptExpectations> {
  const nodes = await Promise.all(orderedNativeNodes(graph).map(async node => ({ ...node,
    signatureSha: [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(node.track.sourceSignature)))].map(value => value.toString(16).padStart(2, "0")).join(""),
    cachedFrame: undefined, uploads: 0,
  })));
  const expected = Object.freeze({ schema: "editkin.native-motion-paint-receipt-expectations/v1" as const,
    nativePaintCount: nodes.length, graphicIds: Object.freeze(nodes.map(node => node.graphicId)) });
  owners.set(expected, { width: graph.width, height: graph.height, nodes, loaded: false });
  return expected;
}
function ownerFor(expected: PreparedNativeMotionPaintReceiptExpectations): Owner {
  return owners.get(expected) ?? fail("copied or foreign expectations");
}
function activeAt(node: Expected, frame: number): boolean {
  const range = node.track.timeline;
  return frame >= range.timelineStartFrame && frame < range.timelineStartFrame + range.durationFrames;
}
function assertColorBinding(node: Expected, receipt: Record<string, unknown>): void {
  if (receipt.nodeId !== node.nodeId || receipt.graphicId !== node.graphicId || receipt.sourceSignatureSha256 !== node.signatureSha
    || receipt.colorIntent !== node.colorIntent || receipt.compositionBoundary !== node.compositionBoundary || receipt.overlayOrder !== node.overlayOrder) {
    fail(`authored color/boundary/order identity binding ${node.graphicId}`);
  }
}
function validateActive(owner: Owner, frame: number, raw: unknown, initial: boolean): { nodes: Expected[]; copies: number } {
  const active = owner.nodes.filter(node => activeAt(node, frame));
  const receipts = raw === undefined && !owner.nodes.length ? [] : raw;
  if (!Array.isArray(receipts) || receipts.length !== active.length) fail("active nodes missing/extra");
  let copies = 0;
  for (let index = 0; index < active.length; index++) {
    const node = active[index], receipt = record(receipts[index]), range = node.track.timeline;
    const cacheHit = !initial && node.cachedFrame === frame;
    const poseContentCacheHit = !initial && !cacheHit && samePoseContent(node, frame);
    const reuseReason = cacheHit ? "same_frame" : poseContentCacheHit ? "exact_pose_content" : "none";
    const reused = cacheHit || poseContentCacheHit;
    const work = reused ? 0 : 1, uploads = initial ? 1 : node.uploads + work;
    const timeline = record(receipt.timeline);
    assertColorBinding(node, receipt);
    if (receipt.nodeId !== node.nodeId || receipt.graphicId !== node.graphicId
      || receipt.executor !== "editkin.resident-native-motion-paint/v1"
      || receipt.sourceSignatureSha256 !== node.signatureSha
      || receipt.timelineFrame !== frame || receipt.localFrame !== frame - range.timelineStartFrame
      || timeline.timelineStartFrame !== range.timelineStartFrame || timeline.sourceStartFrame !== 0 || timeline.durationFrames !== range.durationFrames
      || receipt.layerCount !== node.track.scene.layers.length
      || receipt.workingColorSpace !== "linear_rec709" || receipt.workingFormat !== "rgba16float" || receipt.alphaMode !== "premultiplied"
      || receipt.cacheHit !== cacheHit || receipt.poseContentCacheHit !== poseContentCacheHit || receipt.reuseReason !== reuseReason
      || receipt.rasterCount !== uploads || receipt.textureUploadCount !== uploads
      || receipt.frameRasterCount !== work || receipt.frameTextureUploadCount !== work
      || receipt.frameCpuUploadBytes !== work * owner.width * owner.height * 8
      || typeof receipt.rasterMilliseconds !== "number" || !Number.isFinite(receipt.rasterMilliseconds) || receipt.rasterMilliseconds < 0
      || typeof receipt.uploadMilliseconds !== "number" || !Number.isFinite(receipt.uploadMilliseconds) || receipt.uploadMilliseconds < 0
      || (reused && (receipt.rasterMilliseconds !== 0 || receipt.uploadMilliseconds !== 0))) fail(`node/frame/upload identity ${node.graphicId}`);
    const poses = receipt.poses;
    const expectedPoses = node.track.frames[frame - range.timelineStartFrame];
    if (!Array.isArray(poses) || poses.length !== expectedPoses.length || poses.some((pose, i) => {
      const sampled = record(pose), authored = expectedPoses[i];
      return Object.keys(sampled).length !== poseFields.length
        || poseFields.some(field => !Object.hasOwn(sampled, field) || !sameF32(sampled[field], authored[field]));
    })) fail(`exact poses ${node.graphicId}`);
    copies += work;
  }
  return { nodes: active, copies };
}
function metrics(owner: Owner, active: Expected[], copies: number): NativeMotionPaintWorkMetrics {
  return Object.freeze({ nativePaintCount: owner.nodes.length, cpuPixelCopies: copies,
    cpuUploadBytes: copies * owner.width * owner.height * 8, rasterCount: copies, textureUploadCount: copies,
    totalTextureUploadCount: owner.nodes.reduce((sum, node) => sum + node.uploads, 0),
    activeGraphicIds: Object.freeze(active.map(node => node.graphicId)) });
}

export function assertNativeMotionPaintLoadReceipt(expected: PreparedNativeMotionPaintReceiptExpectations,
  frame: number, raw: unknown): NativeMotionPaintWorkMetrics {
  const owner = ownerFor(expected), load = record(raw), count = owner.nodes.length;
  if (!integer(frame) || owner.loaded) fail("load generation/frame");
  if (count && (load.nativeMotionPaintCount !== count || load.nativeMotionPaintResidentTextureCount !== count
    || load.nativeMotionPaintTextureUploads !== count || load.nativeMotionPaintInitialRasterCount !== count
    || load.nativeMotionPaintInitialCpuUploadBytes !== count * owner.width * owner.height * 8)) fail("all initial resources/uploads");
  const bindings = load.nativeMotionPaintColorBindings;
  if ((count || bindings !== undefined) && (!Array.isArray(bindings) || bindings.length !== count)) fail("all native color bindings missing/extra");
  for (const [index, node] of owner.nodes.entries()) {
    const binding = record((bindings as unknown[])[index]);
    if (Object.keys(binding).length !== 6) fail("native color binding shape");
    assertColorBinding(node, binding);
  }
  const active = validateActive(owner, frame, load.activeNativeMotionPaints, true).nodes;
  for (const node of owner.nodes) { node.cachedFrame = activeAt(node, frame) ? frame : undefined; node.uploads = 1; }
  owner.loaded = true;
  return metrics(owner, active, count);
}

export function assertNativeMotionPaintFrameReceipt(expected: PreparedNativeMotionPaintReceiptExpectations,
  frame: number, raw: unknown): NativeMotionPaintWorkMetrics {
  const owner = ownerFor(expected), receipt = record(raw), count = owner.nodes.length;
  if (!integer(frame) || !owner.loaded) fail("unloaded generation/frame");
  const { nodes: active, copies } = validateActive(owner, frame, receipt.activeNativeMotionPaints, false);
  const total = owner.nodes.reduce((sum, node) => sum + node.uploads, 0) + copies;
  if (count && (receipt.nativeMotionPaintResidentTextureCount !== count || receipt.nativeMotionPaintTextureUploads !== total
    || receipt.decodedVideoCpuPixelCopies !== 0 || receipt.productPathCpuPixelCopies !== copies
    || receipt.nativePaintCpuUploadBytes !== copies * owner.width * owner.height * 8)) fail("frame aggregate/decoded copies");
  if (!count && (receipt.productPathCpuPixelCopies !== 0 || (receipt.decodedVideoCpuPixelCopies !== undefined && receipt.decodedVideoCpuPixelCopies !== 0)
    || (receipt.nativePaintCpuUploadBytes !== undefined && receipt.nativePaintCpuUploadBytes !== 0))) fail("unexpected pixel copies");
  // Commit only after all per-node and aggregate checks pass. Inactive updates
  // invalidate the content cache, matching the resident texture lifetime.
  for (const node of owner.nodes) {
    if (!active.includes(node)) { node.cachedFrame = undefined; continue; }
    if (node.cachedFrame !== frame && !samePoseContent(node, frame)) node.uploads++;
    node.cachedFrame = frame;
  }
  return metrics(owner, active, copies);
}
