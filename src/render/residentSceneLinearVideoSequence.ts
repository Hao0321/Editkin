import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { resolveGpuEffectGraphBindings } from "../plugins/registry";
import type { EngineRenderGraph } from "./engineGraph";
import { depthOfFieldGraphKeyframes, sampleDepthOfFieldNode } from "./depthOfFieldAnimation";
import { sampleScene25dCameraNode, scene25dCameraGraphKeyframes } from "./scene25dCameraAnimation";
import { sampleScene25dLightNode, scene25dLightGraphKeyframes } from "./scene25dLightAnimation";
import { INPUT, INPUT_V2, residentSceneLinearInputAtFrame, assertResidentSceneLinearWhiteBalanceReceipt } from "./residentSceneLinearWhiteBalance";
import { prepareNativeMotionPaintReceiptExpectations, assertNativeMotionPaintLoadReceipt,
  assertNativeMotionPaintFrameReceipt } from "../motion/nativeMotionPaintReceipt";
import { assertNativeFloatingLoadReceipt, assertNativeFloatingFrameReceipt, nativeFloatRuntimeMatches } from "./nativeFloatingVideoFrameReceipt";
import { assertBoundNativeVideoTargetIdentity, assertNativeVideoWorkerRuntime } from "./nativeVideoRuntimeReceipt";
import { canonicalJson } from "../shared/canonicalJson";
export { residentSceneLinearInputAtFrame, assertResidentSceneLinearWhiteBalanceReceipt } from "./residentSceneLinearWhiteBalance";

export interface ResidentSceneLinearVideoSequenceReceipt {
  schema: "editkin.resident-scene-linear-video-sequence/v1";
  status: "GREEN";
  executor: "media-foundation-d3d11-d3d12-wgpu/v1";
  frameCount: number;
  startFrame: number;
  filePattern: "frame-%08d.png";
  displayTransform: "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
  inputTransform: "editkin-srgb-to-linear-rec709-primary/v1" | "editkin-rec709-to-linear-rec709-primary/v2";
  inputTransforms?: Array<ResidentSceneLinearVideoSequenceReceipt["inputTransform"]>;
  workingColorSpace: "linear_rec709";
  workingFormat: "rgba16_float";
  ocioVersion: "2.5.2";
  acesVersion: "2.0";
  configSha256: string;
  productPathCpuPixelCopies: number;
  decodedVideoCpuPixelCopies: 0;
  nativePaintCount: number;
  nativePaintGraphicIds: readonly string[];
  nativePaintCpuUploadBytes: number;
  nativePaintRasterCount: number;
  nativePaintTextureUploadCount: number;
  nativePaintFramesWithActiveGraphics: number;
  verificationReadback: true;
  videoTargetIdentity?: Record<string, unknown>;
  offscreenOutput?: { nativeWindow: false; nativeSwapChain: false; outputReadbackCopiesPerFrame: 1 };
  firstFrameSha256: string;
  lastFrameSha256: string;
  resourcePlan: Record<string, unknown>;
  gpuEffectPrograms: Array<{ nodeId: string; pluginIdentity: string; programSha256: string; shaderOpCount: number }>;
  effectExecutionMode: "none" | "scene-linear-bounded-effect-stack/v1";
  shaderOperationCount: number;
  builtInEffectCount: number;
  temporalExecutionMode: "none" | "decoded-temporal-shutter-scene-linear/v1";
  temporalLayerCount: number;
  temporalFramesWithReceipt: number;
  temporalSampleCount: number;
  particleExecutionMode: "none" | "wgpu-resident-video-particle-overlay/v1";
  framesWithActiveParticles: number;
  totalParticleEmitterPasses: number;
  maximumActiveParticleEmitterCount: number;
  matteExecutionMode: "none" | "sampled-track-matte-scene-linear/v1";
  mattePassCount: number;
  depthExecutionMode: "none" | "scene-linear-depth32f-opaque-planes/v1";
  depthFormat: "none" | "depth32_float";
  depthTestedLayerCount: number;
  depthPassCount: number;
  depthReceiptFrames: number;
  compositeFullFramePassCount: number;
  depthOfFieldExecutionMode: "none" | "scene-linear-depth32f-gather-dof/v1";
  depthOfFieldDepthSource: "none" | "depth32_float";
  depthOfFieldPassCount: number;
  depthOfFieldReceiptFrames: number;
  depthOfField?: {
    contract: "camera_depth_of_field/v1"; nodeId: string; focusDistance: number; aperture: number; maxBlurRadius: number;
    executionMode: "scene-linear-depth32f-gather-dof/v1"; depthSource: "depth32_float"; executor: "wgpu-depth-aware-gather/v1"; passCount: 1;
    animationContract: "static/v1" | "timeline-keyframes/v1"; keyframeCount: number; sampledTimelineFrame: number;
  };
  depthOfFieldLast?: ResidentSceneLinearVideoSequenceReceipt["depthOfField"];
  depthOfFieldAnimatedFrameTransitions: number;
  scene25d?: {
    sceneContract: "single_camera_textured_planes/v1";
    planeCount: number;
    videoPlaneCount: number;
    parentedPlaneCount: number;
    cameraNodeId: string;
    ambientLightCount: number;
    directionalLightCount: number;
    depthMode: string;
    depthFormat: string;
    depthTestedPlaneCount: number;
    depthPassCount: number;
    geometryExecutor: string;
    pixelExecutor: string;
    cameraAnimationContract: "static/v1" | "timeline-keyframes/v1";
    cameraKeyframeCount: number;
    sampledTimelineFrame: number;
    cameraPosition: [number, number, number];
    cameraTarget: [number, number, number];
    cameraVerticalFovRadians: number;
    lightAnimationContract: "static/v1" | "timeline-keyframes/v1";
    ambientLightKeyframeCount: number;
    directionalLightKeyframeCount: number;
    sampledLightTimelineFrame: number;
    ambientLightColor: [number, number, number];
    ambientLightIntensity: number;
    directionalLightColor: [number, number, number];
    directionalLightIntensity: number;
    directionalLightDirection: [number, number, number];
  };
  scene25dLast?: ResidentSceneLinearVideoSequenceReceipt["scene25d"];
  sceneReceiptFrames?: number;
  cameraAnimatedFrameTransitions: number;
  lightAnimatedFrameTransitions: number;
}

interface SequenceRequest {
  executable: string;
  selectedNativeVideoRuntime?: import("../application/selectedNativeVideoRuntime").SelectedNativeVideoRuntimeIdentity;
  graph: EngineRenderGraph;
  assetBindings: Record<string, string>;
  startFrame: number;
  frameCount: number;
  outputDirectory: string;
  timeoutMs: number;
  fontRoot?: string;
  pluginRoots?: string[];
  signal?: AbortSignal;
}

type WorkerMessage = Record<string, unknown>;
interface PendingWorkerRequest {
  command: string;
  resolve(message: WorkerMessage): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Resident video sequence cancelled", { cause: signal.reason });
}

/** The same lifetime is used by production export and owned worker controls. */
export function createResidentSequenceWorker(input: {
  executable: string;
  args: readonly string[];
  deadlineAt: number;
  fontRoot?: string;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const remaining = () => input.deadlineAt - performance.now();
  if (!Number.isFinite(input.deadlineAt) || remaining() <= 0) throw new Error("Resident video sequence deadline exceeded before spawn");
  const child = spawn(input.executable, [...input.args], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(input.fontRoot ? { EDITKIN_FONT_ROOT: input.fontRoot } : {}) },
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<string, PendingWorkerRequest>();
  let sequence = 0;
  let stderr = "";
  let failure: Error | undefined;
  let exited = false;
  let hasClosed = false;
  let readySettled = false;
  let closing: Promise<void> | undefined;
  let readyResolve!: (message: WorkerMessage) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<WorkerMessage>((resolvePromise, reject) => { readyResolve = resolvePromise; readyReject = reject; });
  // A child can fail synchronously before its owner reaches await ready.
  void ready.catch(() => undefined);
  let closedResolve!: () => void;
  const closed = new Promise<void>(resolvePromise => { closedResolve = resolvePromise; });
  let readyTimer: ReturnType<typeof setTimeout>;
  let lifetimeTimer: ReturnType<typeof setTimeout>;
  const settleFailure = (error: Error, terminate = true) => {
    failure ??= error;
    clearTimeout(readyTimer);
    clearTimeout(lifetimeTimer);
    if (!readySettled) { readySettled = true; readyReject(failure); }
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure); }
    pending.clear();
    if (terminate && !hasClosed && !child.killed) child.kill();
  };
  const onAbort = () => settleFailure(abortError(input.signal!));
  child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-100_000); });
  child.once("error", error => settleFailure(error));
  child.stdin.on("error", error => settleFailure(error));
  child.once("exit", (code, signal) => {
    exited = true;
    settleFailure(new Error(`${basename(input.executable)} exited ${code ?? signal ?? "unknown"}: ${stderr.slice(-4_000)}`), false);
  });
  child.once("close", () => {
    hasClosed = true;
    settleFailure(new Error(`${basename(input.executable)} closed before request completed: ${stderr.slice(-4_000)}`), false);
    closedResolve();
  });
  lines.on("line", line => {
    let message: WorkerMessage;
    try { message = JSON.parse(line) as WorkerMessage; } catch { return; }
    if (failure) return;
    if (message.event === "ready") {
      if (!readySettled) { clearTimeout(readyTimer); readySettled = true; readyResolve(message); }
      return;
    }
    const id = typeof message.id === "string" ? message.id : "";
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(message.result as WorkerMessage);
    else entry.reject(new Error(`${entry.command} 失敗：${String(message.error ?? "unknown GPU error")}`));
  });
  readyTimer = setTimeout(() => settleFailure(new Error(`GPU compositor ready timeout: ${stderr.slice(-4_000)}`)), Math.min(remaining(), 60_000));
  lifetimeTimer = setTimeout(() => settleFailure(new Error("Resident video sequence deadline exceeded")), remaining());
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const request = (command: string, payload: WorkerMessage = {}): Promise<WorkerMessage> => {
    if (failure) return Promise.reject(failure);
    if (input.signal?.aborted) { onAbort(); return Promise.reject(failure!); }
    if (remaining() <= 0) { settleFailure(new Error("Resident video sequence deadline exceeded")); return Promise.reject(failure!); }
    return new Promise((resolvePromise, reject) => {
      const id = `resident-export-${++sequence}`;
      const timer = setTimeout(() => settleFailure(new Error(`${command} timeout: ${stderr.slice(-4_000)}`)), Math.min(remaining(), 60_000));
      pending.set(id, { command, resolve: resolvePromise, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`, error => { if (error) settleFailure(error); });
    });
  };
  const close = (loadedSessionId?: string): Promise<void> => closing ??= (async () => {
    const cleanupDeadlineAt = performance.now() + 5_000;
    // Leave a final second to observe close after terminating a stuck native RPC.
    const terminateTimer = setTimeout(() => settleFailure(new Error("Resident video cleanup deadline exceeded")), 4_000);
    try {
      if (!failure && !exited && !hasClosed) {
        if (loadedSessionId) await request("engine_video_release", { sessionId: loadedSessionId }).catch(() => undefined);
        if (!failure && !exited && !hasClosed) await request("surface_release").catch(() => undefined);
        if (!failure && !exited && !hasClosed) await request("shutdown").catch(() => undefined);
      }
    } finally {
      if (!child.stdin.destroyed) child.stdin.end();
      if (!hasClosed && !child.killed) child.kill();
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error(`Owned resident worker ${child.pid ?? "unknown"} did not close within cleanup budget`)), Math.max(0, cleanupDeadlineAt - performance.now()));
        })]);
      } finally {
        clearTimeout(terminateTimer);
        clearTimeout(closeTimer);
        clearTimeout(readyTimer);
        clearTimeout(lifetimeTimer);
        input.signal?.removeEventListener("abort", onAbort);
        lines.close();
      }
    }
  })();
  return { ready, request, close, closed, pid: child.pid };
}

const CONFIG_SHA256 = "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a";
const DISPLAY = "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
function frameName(frame: number): string {
  return `frame-${String(frame).padStart(8, "0")}.png`;
}

export function halfFrameToleranceSeconds(timebase: EngineRenderGraph["timebase"]): number {
  if (!Number.isFinite(timebase.numerator) || timebase.numerator <= 0
    || !Number.isFinite(timebase.denominator) || timebase.denominator <= 0) {
    throw new Error("正式 resident video sequence 的 timebase 無效");
  }
  return .5 * timebase.numerator / timebase.denominator;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sameF32(left: unknown, right: unknown): boolean {
  return typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.0001;
}

function depthOfFieldReceiptMatches(receipt: ResidentSceneLinearVideoSequenceReceipt["depthOfField"], graph: EngineRenderGraph, timelineFrame: number): boolean {
  const node = graph.nodes.find((candidate) => candidate.kind === "depth_of_field");
  if (!node) return receipt === undefined || receipt === null;
  const sample = sampleDepthOfFieldNode(node, timelineFrame);
  const keyframeCount = depthOfFieldGraphKeyframes(node).length;
  return receipt?.contract === "camera_depth_of_field/v1" && receipt.nodeId === node.id
    && sameF32(receipt.focusDistance, sample.focusDistance) && sameF32(receipt.aperture, sample.aperture) && sameF32(receipt.maxBlurRadius, sample.maxBlurRadius)
    && receipt.animationContract === (keyframeCount ? "timeline-keyframes/v1" : "static/v1")
    && receipt.keyframeCount === keyframeCount && receipt.sampledTimelineFrame === timelineFrame
    && receipt.executionMode === "scene-linear-depth32f-gather-dof/v1" && receipt.depthSource === "depth32_float"
    && receipt.executor === "wgpu-depth-aware-gather/v1" && receipt.passCount === 1;
}

function scene25dReceiptMatches(
  receipt: ResidentSceneLinearVideoSequenceReceipt["scene25d"],
  graph: EngineRenderGraph,
  timelineFrame: number,
  structural?: ResidentSceneLinearVideoSequenceReceipt["scene25d"],
): boolean {
  const camera = graph.nodes.find((node) => node.kind === "camera");
  if (!camera) return receipt === undefined || receipt === null;
  const sample = sampleScene25dCameraNode(camera, timelineFrame);
  const keyframeCount = scene25dCameraGraphKeyframes(camera).length;
  const ambient = graph.nodes.find((node) => node.kind === "light" && node.lightKind === "ambient");
  const directional = graph.nodes.find((node) => node.kind === "light" && node.lightKind === "directional");
  if (!ambient || !directional) return false;
  const ambientSample = sampleScene25dLightNode(ambient, timelineFrame);
  const directionalSample = sampleScene25dLightNode(directional, timelineFrame);
  const ambientKeyframeCount = scene25dLightGraphKeyframes(ambient).length;
  const directionalKeyframeCount = scene25dLightGraphKeyframes(directional).length;
  const lightKeyframeCount = ambientKeyframeCount + directionalKeyframeCount;
  const sameVector = (left: number[], right: number[]) => left.length === right.length && left.every((value, index) => sameF32(value, right[index]));
  return Boolean(receipt)
    && receipt!.cameraAnimationContract === (keyframeCount ? "timeline-keyframes/v1" : "static/v1")
    && receipt!.cameraKeyframeCount === keyframeCount && receipt!.sampledTimelineFrame === (keyframeCount ? timelineFrame : 0)
    && sameVector(receipt!.cameraPosition, sample.position) && sameVector(receipt!.cameraTarget, sample.target)
    && sameF32(receipt!.cameraVerticalFovRadians, sample.verticalFovRadians)
    && receipt!.ambientLightCount === 1 && receipt!.directionalLightCount === 1
    && receipt!.lightAnimationContract === (lightKeyframeCount ? "timeline-keyframes/v1" : "static/v1")
    && receipt!.ambientLightKeyframeCount === ambientKeyframeCount && receipt!.directionalLightKeyframeCount === directionalKeyframeCount
    && receipt!.sampledLightTimelineFrame === (lightKeyframeCount ? timelineFrame : 0)
    && sameVector(receipt!.ambientLightColor, ambientSample.color) && sameF32(receipt!.ambientLightIntensity, ambientSample.intensity)
    && sameVector(receipt!.directionalLightColor, directionalSample.color) && sameF32(receipt!.directionalLightIntensity, directionalSample.intensity)
    && sameVector(receipt!.directionalLightDirection, directionalSample.direction)
    && (!structural || receipt!.sceneContract === structural.sceneContract && receipt!.planeCount === structural.planeCount
      && receipt!.videoPlaneCount === structural.videoPlaneCount && receipt!.parentedPlaneCount === structural.parentedPlaneCount
      && receipt!.cameraNodeId === structural.cameraNodeId && receipt!.ambientLightCount === structural.ambientLightCount
      && receipt!.directionalLightCount === structural.directionalLightCount && receipt!.depthMode === structural.depthMode
      && receipt!.depthFormat === structural.depthFormat && receipt!.depthTestedPlaneCount === structural.depthTestedPlaneCount
      && receipt!.depthPassCount === structural.depthPassCount && receipt!.geometryExecutor === structural.geometryExecutor
      && receipt!.pixelExecutor === structural.pixelExecutor);
}

export async function renderResidentSceneLinearVideoSequence(input: SequenceRequest): Promise<ResidentSceneLinearVideoSequenceReceipt> {
  input.signal?.throwIfAborted();
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("正式 resident video sequence 的 timeout 無效");
  const deadlineAt = performance.now() + input.timeoutMs;
  const checkLifetime = () => {
    input.signal?.throwIfAborted();
    if (performance.now() >= deadlineAt) throw new Error("Resident video sequence deadline exceeded");
  };
  if (!Number.isSafeInteger(input.startFrame) || input.startFrame < 0
    || !Number.isSafeInteger(input.frameCount) || input.frameCount < 1) throw new Error("正式 resident video sequence 的影格範圍無效");
  residentSceneLinearInputAtFrame(input.graph, input.startFrame);
  const nativePaintExpected = await prepareNativeMotionPaintReceiptExpectations(input.graph);
  checkLifetime();
  const observedInputTransforms = new Set<ResidentSceneLinearVideoSequenceReceipt["inputTransform"]>();
  await mkdir(input.outputDirectory, { recursive: true });
  const graphPath = join(input.outputDirectory, "engine-graph.json");
  const bindingsPath = join(input.outputDirectory, "asset-bindings.json");
  const effectBindingsPath = join(input.outputDirectory, "effect-bindings.json");
  const effectBindings = await resolveGpuEffectGraphBindings(input.graph, input.pluginRoots);
  checkLifetime();
  await Promise.all([
    writeFile(graphPath, `${JSON.stringify(input.graph, null, 2)}\n`, "utf8"),
    writeFile(bindingsPath, `${JSON.stringify(input.assetBindings, null, 2)}\n`, "utf8"),
    writeFile(effectBindingsPath, `${JSON.stringify(effectBindings, null, 2)}\n`, "utf8"),
  ]);
  checkLifetime();
  const worker = createResidentSequenceWorker({ executable: input.executable, args: ["serve"], deadlineAt,
    fontRoot: input.fontRoot, signal: input.signal });
  const { request } = worker;
  const sessionId = `resident-export-${process.pid}-${Date.now()}`;
  let loaded = false;
  let productPathCpuPixelCopies = 0;
  let nativePaintCpuUploadBytes = 0;
  let nativePaintRasterCount = 0;
  let nativePaintTextureUploadCount = 0;
  let nativePaintFramesWithActiveGraphics = 0;
  let resourcePlan: Record<string, unknown> | undefined;
  let gpuEffectPrograms: ResidentSceneLinearVideoSequenceReceipt["gpuEffectPrograms"] = [];
  let effectExecutionMode: ResidentSceneLinearVideoSequenceReceipt["effectExecutionMode"] = "none";
  let shaderOperationCount = 0;
  let builtInEffectCount = 0;
  let temporalExecutionMode: ResidentSceneLinearVideoSequenceReceipt["temporalExecutionMode"] = "none";
  let temporalLayerCount = 0;
  let temporalFramesWithReceipt = 0;
  let temporalSampleCount = 0;
  let particleExecutionMode: ResidentSceneLinearVideoSequenceReceipt["particleExecutionMode"] = "none";
  let framesWithActiveParticles = 0;
  let totalParticleEmitterPasses = 0;
  let maximumActiveParticleEmitterCount = 0;
  let matteExecutionMode: ResidentSceneLinearVideoSequenceReceipt["matteExecutionMode"] = "none";
  let mattePassCount = 0;
  let depthExecutionMode: ResidentSceneLinearVideoSequenceReceipt["depthExecutionMode"] = "none";
  let depthFormat: ResidentSceneLinearVideoSequenceReceipt["depthFormat"] = "none";
  let depthTestedLayerCount = 0;
  let depthPassCount = 0;
  let depthReceiptFrames = 0;
  let compositeFullFramePassCount = 0;
  let depthOfFieldExecutionMode: ResidentSceneLinearVideoSequenceReceipt["depthOfFieldExecutionMode"] = "none";
  let depthOfFieldDepthSource: ResidentSceneLinearVideoSequenceReceipt["depthOfFieldDepthSource"] = "none";
  let depthOfFieldPassCount = 0;
  let depthOfFieldReceiptFrames = 0;
  let depthOfField: ResidentSceneLinearVideoSequenceReceipt["depthOfField"];
  let depthOfFieldLast: ResidentSceneLinearVideoSequenceReceipt["depthOfField"];
  let depthOfFieldAnimatedFrameTransitions = 0;
  let scene25d: ResidentSceneLinearVideoSequenceReceipt["scene25d"];
  let scene25dLast: ResidentSceneLinearVideoSequenceReceipt["scene25d"];
  let sceneReceiptFrames = 0;
  let cameraAnimatedFrameTransitions = 0;
  let lightAnimatedFrameTransitions = 0;
  const expectsScene25d = input.graph.nodes.some((node) => node.kind === "camera" || node.kind === "transform3d");
  const expectsDepthOfField = input.graph.nodes.some((node) => node.kind === "depth_of_field");
  try {
    const ready = await worker.ready;
    if (input.selectedNativeVideoRuntime) assertNativeVideoWorkerRuntime(ready, input.selectedNativeVideoRuntime);
    else if (input.graph.nodes.some(node => node.kind === "native_motion_paint" || node.kind === "floating_video_frame_2d")) {
      throw new Error("Native paint／浮框正式輸出缺少 current v4 所綁定的 selected renderer identity。");
    }
    if (ready.offscreenVideoProtocol !== "editkin.resident-offscreen-video-target/v1"
      || (input.graph.nodes.some(node => node.kind === "floating_video_frame_2d") && !nativeFloatRuntimeMatches(ready))) {
      throw new Error("正式 resident video sequence 缺少匹配的無視窗 runtime 能力；不可回退隱藏 HWND。");
    }
    const surface = await request("offscreen_bind", { width: input.graph.width, height: input.graph.height });
    const actualVideoTarget = assertBoundNativeVideoTargetIdentity(surface.videoTargetIdentity, ready.generation, true,
      { width: input.graph.width, height: input.graph.height }, input.selectedNativeVideoRuntime);
    if (surface.backend !== "Dx12" || surface.nativeSwapChain !== false || surface.nativeWindow !== false
      || surface.offscreen !== true || surface.bound !== false || surface.visible !== false || surface.presentCount !== 0
      || surface.renderTargetContract !== "editkin.resident-offscreen-render-target/v1" || surface.cpuPixelReadbacks !== 0) {
      throw new Error("正式 resident video sequence 沒有取得已核對的 DX12 無視窗輸出材質");
    }
    const load = await request("engine_video_load", {
      sessionId, graphPath, bindingsPath, effectBindingsPath, timelineFrame: input.startFrame,
    });
    loaded = true;
    assertBoundNativeVideoTargetIdentity(load.videoTargetIdentity, ready.generation, true,
      { width: input.graph.width, height: input.graph.height }, input.selectedNativeVideoRuntime);
    if (canonicalJson(load.videoTargetIdentity) !== canonicalJson(actualVideoTarget)) throw new Error("Resident video load target identity changed");
    assertNativeFloatingLoadReceipt(input.graph, load);
    const initialPaintWork = assertNativeMotionPaintLoadReceipt(nativePaintExpected, input.startFrame, load);
    productPathCpuPixelCopies += initialPaintWork.cpuPixelCopies;
    nativePaintCpuUploadBytes += initialPaintWork.cpuUploadBytes;
    nativePaintRasterCount += initialPaintWork.rasterCount;
    nativePaintTextureUploadCount = initialPaintWork.totalTextureUploadCount;
    resourcePlan = load.resourcePlan as Record<string, unknown> | undefined;
    const coverage = load.engineGraph as Record<string, unknown> | undefined;
    const gpuEffects = load.gpuEffects as { resolved?: boolean; programs?: ResidentSceneLinearVideoSequenceReceipt["gpuEffectPrograms"] } | undefined;
    scene25d = load.scene25d as ResidentSceneLinearVideoSequenceReceipt["scene25d"];
    depthOfField = load.depthOfField as ResidentSceneLinearVideoSequenceReceipt["depthOfField"];
    gpuEffectPrograms = gpuEffects?.programs ?? [];
    if (load.executor !== "media-foundation-d3d11-d3d12-wgpu/v1" || load.displayTransform !== "aces2_rec709_sdr"
      || resourcePlan?.workingBytesPerPixel !== 8 || coverage?.directExecution !== true
      || gpuEffects?.resolved !== true || gpuEffectPrograms.length !== Object.keys(effectBindings.bindings).length
      || (expectsScene25d && (!scene25dReceiptMatches(scene25d, input.graph, input.startFrame) || scene25d!.videoPlaneCount < 1 || scene25d!.videoPlaneCount !== scene25d!.planeCount
        || scene25d!.depthMode !== "per_pixel_opaque_plane_depth32float" || scene25d!.depthFormat !== "depth32_float"
        || scene25d!.depthTestedPlaneCount !== scene25d!.planeCount || scene25d!.depthPassCount !== 1
        || scene25d!.pixelExecutor !== "wgpu-projective-plane-depth-compositor/v1"))
      || (!expectsScene25d && scene25d !== undefined && scene25d !== null)
      || (expectsDepthOfField ? !depthOfFieldReceiptMatches(depthOfField, input.graph, input.startFrame)
        : depthOfField !== undefined && depthOfField !== null)
      || gpuEffectPrograms.some((program) => !/^[a-f0-9]{64}$/.test(program.programSha256) || program.shaderOpCount < 1 || program.shaderOpCount > 4)
      || (coverage?.blockedNodeIds as unknown[] | undefined)?.length || (coverage?.ignoredNodeIds as unknown[] | undefined)?.length) {
      const cameraNode = input.graph.nodes.find((node) => node.kind === "camera");
      throw new Error(`正式 resident video sequence 的 load／資源／graph receipt 不完整：${JSON.stringify({
        scene25d, expectedCamera: cameraNode ? sampleScene25dCameraNode(cameraNode, input.startFrame) : undefined,
        depthOfField, resourcePlan, coverage, gpuEffects,
      })}`);
    }
    for (let offset = 0; offset < input.frameCount; offset += 1) {
      checkLifetime();
      const timelineFrame = input.startFrame + offset;
      const outputPath = join(input.outputDirectory, frameName(timelineFrame));
      const receipt = await request("engine_video_verify_frame", {
        sessionId, timelineFrame, toleranceSeconds: halfFrameToleranceSeconds(input.graph.timebase), outputPath,
      });
      assertBoundNativeVideoTargetIdentity(receipt.videoTargetIdentity, ready.generation, true,
        { width: input.graph.width, height: input.graph.height }, input.selectedNativeVideoRuntime);
      if (canonicalJson(receipt.videoTargetIdentity) !== canonicalJson(actualVideoTarget)) throw new Error("Resident video frame target identity changed");
      const coverageReceipt = receipt.engineGraph as Record<string, unknown> | undefined;
      assertResidentSceneLinearWhiteBalanceReceipt(input.graph, timelineFrame, receipt);
      assertNativeFloatingFrameReceipt(input.graph, timelineFrame, receipt);
      const paintWork = assertNativeMotionPaintFrameReceipt(nativePaintExpected, timelineFrame, receipt);
      const decodedVideoCpuPixelCopies = receipt.decodedVideoCpuPixelCopies
        ?? (nativePaintExpected.nativePaintCount === 0 ? receipt.productPathCpuPixelCopies : undefined);
      observedInputTransforms.add(receipt.inputTransform as ResidentSceneLinearVideoSequenceReceipt["inputTransform"]);
      if (receipt.sceneLinearExecution !== true || receipt.workingColorSpace !== "linear_rec709" || receipt.workingFormat !== "rgba16_float"
        || receipt.offscreen !== true || receipt.nativeSurfacePresented !== false || receipt.outputReadbackCopies !== 1
        || (receipt.renderTarget as Record<string, unknown> | undefined)?.nativeWindow !== false
        || (receipt.renderTarget as Record<string, unknown> | undefined)?.nativeSwapChain !== false
        || receipt.displayTransform !== DISPLAY
        || receipt.ocioVersion !== "2.5.2" || receipt.acesVersion !== "2.0" || receipt.configSha256 !== CONFIG_SHA256
        || decodedVideoCpuPixelCopies !== 0 || receipt.productPathCpuPixelCopies !== paintWork.cpuPixelCopies
        || receipt.verificationReadback !== true || receipt.outputWritten !== true
        || coverageReceipt?.directExecution !== true || (coverageReceipt?.blockedNodeIds as unknown[] | undefined)?.length
        || (coverageReceipt?.ignoredNodeIds as unknown[] | undefined)?.length) {
        throw new Error(`正式 resident video sequence 第 ${timelineFrame} 格 receipt 不完整`);
      }
      productPathCpuPixelCopies += paintWork.cpuPixelCopies;
      nativePaintCpuUploadBytes += paintWork.cpuUploadBytes;
      nativePaintRasterCount += paintWork.rasterCount;
      nativePaintTextureUploadCount = paintWork.totalTextureUploadCount;
      if (paintWork.activeGraphicIds.length) nativePaintFramesWithActiveGraphics += 1;
      const nextEffectExecutionMode = receipt.effectExecutionMode as ResidentSceneLinearVideoSequenceReceipt["effectExecutionMode"];
      const nextMatteExecutionMode = receipt.matteExecutionMode as ResidentSceneLinearVideoSequenceReceipt["matteExecutionMode"];
      const nextShaderOperationCount = Number(receipt.shaderOperationCount);
      const nextBuiltInEffectCount = Number(receipt.builtInEffectCount);
      const nextTemporalExecutionMode = receipt.temporalExecutionMode as ResidentSceneLinearVideoSequenceReceipt["temporalExecutionMode"];
      const nextTemporalLayerCount = Number(receipt.temporalLayerCount);
      const nextTemporalSampleTextureCount = Number(receipt.temporalSampleTextureCount);
      const temporal = receipt.temporalSampling as { sampleCount?: number; productPathCpuPixelCopies?: number } | undefined;
      const activeParticles = (receipt.activeParticleEmitters ?? []) as Array<{ executor?: string; cpuPixelUploads?: number; cpuPixelReadbacks?: number }>;
      const frameScene25d = receipt.scene25d as ResidentSceneLinearVideoSequenceReceipt["scene25d"];
      const nextMattePassCount = Number(receipt.mattePassCount);
      const nextDepthExecutionMode = receipt.depthExecutionMode as ResidentSceneLinearVideoSequenceReceipt["depthExecutionMode"];
      const nextDepthFormat = receipt.depthFormat as ResidentSceneLinearVideoSequenceReceipt["depthFormat"];
      const nextDepthTestedLayerCount = Number(receipt.depthTestedLayerCount);
      const nextDepthPassCount = Number(receipt.depthPassCount);
      const nextCompositeFullFramePassCount = Number(receipt.compositeFullFramePassCount);
      const nextDepthOfFieldExecutionMode = receipt.depthOfFieldExecutionMode as ResidentSceneLinearVideoSequenceReceipt["depthOfFieldExecutionMode"];
      const nextDepthOfFieldDepthSource = receipt.depthOfFieldDepthSource as ResidentSceneLinearVideoSequenceReceipt["depthOfFieldDepthSource"];
      const nextDepthOfFieldPassCount = Number(receipt.depthOfFieldPassCount);
      const frameDepthOfField = receipt.depthOfField as ResidentSceneLinearVideoSequenceReceipt["depthOfField"];
      if (!["none", "scene-linear-bounded-effect-stack/v1"].includes(nextEffectExecutionMode)
        || !["none", "decoded-temporal-shutter-scene-linear/v1"].includes(nextTemporalExecutionMode)
        || !["none", "sampled-track-matte-scene-linear/v1"].includes(nextMatteExecutionMode)
        || !Number.isSafeInteger(nextShaderOperationCount) || nextShaderOperationCount < 0
        || !Number.isSafeInteger(nextBuiltInEffectCount) || nextBuiltInEffectCount < 0
        || !Number.isSafeInteger(nextTemporalLayerCount) || nextTemporalLayerCount < 0
        || !Number.isSafeInteger(nextTemporalSampleTextureCount) || nextTemporalSampleTextureCount < 0
        || (nextTemporalExecutionMode === "none" ? nextTemporalLayerCount !== 0 || nextTemporalSampleTextureCount !== 0 || Boolean(temporal)
          : nextTemporalLayerCount < 1 || nextTemporalSampleTextureCount < 2 || !temporal || temporal.productPathCpuPixelCopies !== 0)
        || activeParticles.some((particle) => particle.executor !== "wgpu-resident-video-particle-overlay/v1"
          || particle.cpuPixelUploads !== 0 || particle.cpuPixelReadbacks !== 0)
        || (expectsScene25d && !scene25dReceiptMatches(frameScene25d, input.graph, timelineFrame, scene25d))
        || (!expectsScene25d && frameScene25d !== undefined && frameScene25d !== null)
        || (expectsScene25d
          ? nextDepthExecutionMode !== "scene-linear-depth32f-opaque-planes/v1" || nextDepthFormat !== "depth32_float"
            || nextDepthTestedLayerCount !== scene25d!.planeCount || nextDepthPassCount !== 1
          : nextDepthExecutionMode !== "none" || nextDepthFormat !== "none" || nextDepthTestedLayerCount !== 0 || nextDepthPassCount !== 0)
        || !Number.isSafeInteger(nextCompositeFullFramePassCount) || nextCompositeFullFramePassCount < 1
        || !Number.isSafeInteger(Number(resourcePlan?.maximumFullFramePassesPerPresent))
        || nextCompositeFullFramePassCount > Number(resourcePlan?.maximumFullFramePassesPerPresent)
        || (expectsDepthOfField
          ? nextDepthOfFieldExecutionMode !== "scene-linear-depth32f-gather-dof/v1" || nextDepthOfFieldDepthSource !== "depth32_float"
            || nextDepthOfFieldPassCount !== 1 || !depthOfFieldReceiptMatches(frameDepthOfField, input.graph, timelineFrame)
          : nextDepthOfFieldExecutionMode !== "none" || nextDepthOfFieldDepthSource !== "none" || nextDepthOfFieldPassCount !== 0
            || frameDepthOfField !== undefined && frameDepthOfField !== null)
        || !Number.isSafeInteger(nextMattePassCount) || nextMattePassCount < 0) {
        throw new Error(`正式 resident video sequence 第 ${timelineFrame} 格 effect/temporal/particle/matte receipt 不完整`);
      }
      if (frameScene25d) {
        sceneReceiptFrames += 1;
        if (scene25dLast && (!scene25dLast.cameraPosition.every((value, index) => sameF32(value, frameScene25d.cameraPosition[index]))
          || !scene25dLast.cameraTarget.every((value, index) => sameF32(value, frameScene25d.cameraTarget[index]))
          || !sameF32(scene25dLast.cameraVerticalFovRadians, frameScene25d.cameraVerticalFovRadians))) cameraAnimatedFrameTransitions += 1;
        if (scene25dLast && (!scene25dLast.ambientLightColor.every((value, index) => sameF32(value, frameScene25d.ambientLightColor[index]))
          || !sameF32(scene25dLast.ambientLightIntensity, frameScene25d.ambientLightIntensity)
          || !scene25dLast.directionalLightColor.every((value, index) => sameF32(value, frameScene25d.directionalLightColor[index]))
          || !sameF32(scene25dLast.directionalLightIntensity, frameScene25d.directionalLightIntensity)
          || !scene25dLast.directionalLightDirection.every((value, index) => sameF32(value, frameScene25d.directionalLightDirection[index])))) {
          lightAnimatedFrameTransitions += 1;
        }
        scene25dLast = frameScene25d;
        if (offset === 0) scene25d = frameScene25d;
      }
      if (nextDepthExecutionMode !== "none") depthReceiptFrames += 1;
      if (nextDepthOfFieldExecutionMode !== "none") {
        depthOfFieldReceiptFrames += 1;
        if (depthOfFieldLast && frameDepthOfField && (!sameF32(depthOfFieldLast.focusDistance, frameDepthOfField.focusDistance)
          || !sameF32(depthOfFieldLast.aperture, frameDepthOfField.aperture) || !sameF32(depthOfFieldLast.maxBlurRadius, frameDepthOfField.maxBlurRadius))) {
          depthOfFieldAnimatedFrameTransitions += 1;
        }
        depthOfFieldLast = frameDepthOfField;
        if (offset === 0) depthOfField = frameDepthOfField;
      }
      if (offset === 0) {
        effectExecutionMode = nextEffectExecutionMode; shaderOperationCount = nextShaderOperationCount;
        builtInEffectCount = nextBuiltInEffectCount; temporalExecutionMode = nextTemporalExecutionMode;
        temporalLayerCount = nextTemporalLayerCount; matteExecutionMode = nextMatteExecutionMode; mattePassCount = nextMattePassCount;
        depthExecutionMode = nextDepthExecutionMode; depthFormat = nextDepthFormat;
        depthTestedLayerCount = nextDepthTestedLayerCount; depthPassCount = nextDepthPassCount;
        compositeFullFramePassCount = nextCompositeFullFramePassCount;
        depthOfFieldExecutionMode = nextDepthOfFieldExecutionMode; depthOfFieldDepthSource = nextDepthOfFieldDepthSource; depthOfFieldPassCount = nextDepthOfFieldPassCount;
      } else if (effectExecutionMode !== nextEffectExecutionMode || shaderOperationCount !== nextShaderOperationCount
        || builtInEffectCount !== nextBuiltInEffectCount || temporalExecutionMode !== nextTemporalExecutionMode
        || temporalLayerCount !== nextTemporalLayerCount || matteExecutionMode !== nextMatteExecutionMode || mattePassCount !== nextMattePassCount
        || depthExecutionMode !== nextDepthExecutionMode || depthFormat !== nextDepthFormat
        || depthTestedLayerCount !== nextDepthTestedLayerCount || depthPassCount !== nextDepthPassCount
        || depthOfFieldExecutionMode !== nextDepthOfFieldExecutionMode
        || depthOfFieldDepthSource !== nextDepthOfFieldDepthSource || depthOfFieldPassCount !== nextDepthOfFieldPassCount) {
        throw new Error(`正式 resident video sequence 的 effect/temporal/matte/depth receipt 跨影格漂移: ${JSON.stringify({
          timelineFrame,
          expected: { effectExecutionMode, shaderOperationCount, builtInEffectCount, temporalExecutionMode, temporalLayerCount,
            matteExecutionMode, mattePassCount, depthExecutionMode, depthFormat, depthTestedLayerCount, depthPassCount,
            depthOfFieldExecutionMode, depthOfFieldDepthSource, depthOfFieldPassCount },
          observed: { effectExecutionMode: nextEffectExecutionMode, shaderOperationCount: nextShaderOperationCount,
            builtInEffectCount: nextBuiltInEffectCount, temporalExecutionMode: nextTemporalExecutionMode,
            temporalLayerCount: nextTemporalLayerCount, matteExecutionMode: nextMatteExecutionMode, mattePassCount: nextMattePassCount,
            depthExecutionMode: nextDepthExecutionMode, depthFormat: nextDepthFormat, depthTestedLayerCount: nextDepthTestedLayerCount,
            depthPassCount: nextDepthPassCount,
            depthOfFieldExecutionMode: nextDepthOfFieldExecutionMode, depthOfFieldDepthSource: nextDepthOfFieldDepthSource,
            depthOfFieldPassCount: nextDepthOfFieldPassCount },
        })}`);
      }
      compositeFullFramePassCount = Math.max(compositeFullFramePassCount, nextCompositeFullFramePassCount);
      if (temporal) {
        const samples = Number(temporal.sampleCount);
        if (!Number.isSafeInteger(samples) || samples < 2 || samples > 8 || (temporalSampleCount !== 0 && temporalSampleCount !== samples)) {
          throw new Error(`正式 resident video sequence 第 ${timelineFrame} 格 temporal sample receipt 漂移`);
        }
        temporalSampleCount = samples;
        temporalFramesWithReceipt += 1;
      }
      if (activeParticles.length > 0) {
        particleExecutionMode = "wgpu-resident-video-particle-overlay/v1";
        framesWithActiveParticles += 1;
        totalParticleEmitterPasses += activeParticles.length;
        maximumActiveParticleEmitterCount = Math.max(maximumActiveParticleEmitterCount, activeParticles.length);
      }
    }
    const firstPath = join(input.outputDirectory, frameName(input.startFrame));
    const lastPath = join(input.outputDirectory, frameName(input.startFrame + input.frameCount - 1));
    const firstFrameSha256 = await sha256(firstPath);
    const lastFrameSha256 = await sha256(lastPath);
    checkLifetime();
    return {
      schema: "editkin.resident-scene-linear-video-sequence/v1", status: "GREEN",
      executor: "media-foundation-d3d11-d3d12-wgpu/v1", frameCount: input.frameCount, startFrame: input.startFrame,
      filePattern: "frame-%08d.png", displayTransform: DISPLAY, inputTransform: observedInputTransforms.has(INPUT_V2) ? INPUT_V2 : INPUT,
      ...(observedInputTransforms.has(INPUT_V2) ? { inputTransforms: [...observedInputTransforms].sort() } : {}),
      workingColorSpace: "linear_rec709", workingFormat: "rgba16_float", ocioVersion: "2.5.2", acesVersion: "2.0",
      configSha256: CONFIG_SHA256, productPathCpuPixelCopies, decodedVideoCpuPixelCopies: 0,
      nativePaintCount: nativePaintExpected.nativePaintCount, nativePaintGraphicIds: nativePaintExpected.graphicIds,
      nativePaintCpuUploadBytes, nativePaintRasterCount, nativePaintTextureUploadCount, nativePaintFramesWithActiveGraphics,
      verificationReadback: true, videoTargetIdentity: actualVideoTarget,
      offscreenOutput: { nativeWindow: false, nativeSwapChain: false, outputReadbackCopiesPerFrame: 1 },
      firstFrameSha256, lastFrameSha256, resourcePlan: resourcePlan!,
      gpuEffectPrograms, effectExecutionMode, shaderOperationCount, builtInEffectCount,
      temporalExecutionMode, temporalLayerCount, temporalFramesWithReceipt, temporalSampleCount,
      particleExecutionMode, framesWithActiveParticles, totalParticleEmitterPasses, maximumActiveParticleEmitterCount,
      matteExecutionMode, mattePassCount,
      depthExecutionMode, depthFormat, depthTestedLayerCount, depthPassCount, depthReceiptFrames,
      compositeFullFramePassCount, depthOfFieldExecutionMode, depthOfFieldDepthSource, depthOfFieldPassCount, depthOfFieldReceiptFrames,
      depthOfFieldAnimatedFrameTransitions,
      ...(depthOfField ? { depthOfField } : {}),
      ...(depthOfFieldLast ? { depthOfFieldLast } : {}),
      cameraAnimatedFrameTransitions,
      lightAnimatedFrameTransitions,
      ...(scene25d ? { scene25d, scene25dLast, sceneReceiptFrames } : {}),
    };
  } finally {
    await worker.close(loaded ? sessionId : undefined);
  }
}
