import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EditProject } from "../domain/types";
import type { EngineRenderGraph, NativeCompiledGraph } from "./engineGraph";

export interface NativeSegment {
  kind: "gap" | "clip";
  startFrame: number;
  durationFrames: number;
  clipId?: string;
  assetId?: string;
  sourceFrame?: number;
}

export interface NativePlan {
  engine: string;
  fps: number;
  durationFrames: number;
  layers: Array<{ trackId: string; segments: NativeSegment[] }>;
  captions: Array<{ id: string; text: string; startFrame: number; durationFrames: number }>;
}

export interface SmartCutRequest {
  fps: number;
  duration: number;
  silences: Array<{ start: number; end: number }>;
  options: { padding: number; minSilence: number; minKeep: number };
}

export interface NativeSmartCutPlan {
  engine: string;
  fps: number;
  sourceFrames: number;
  ranges: Array<{ startFrame: number; endFrame: number }>;
  removedFrames: number;
  cutCount: number;
}

export interface NativeMotionTrackRequest {
  rawPath: string;
  width: number;
  height: number;
  frameCount: number;
  analysisFps: number;
  initialFrame: number;
  initialRect: { x: number; y: number; width: number; height: number };
  searchRadius: number;
  confidenceThreshold: number;
  maxHoldFrames: number;
  maxRotationStep?: number;
}

export interface NativeMotionTrackPlan {
  engine: string;
  analysisFps: number;
  width: number;
  height: number;
  points: Array<{
    frame: number;
    time: number;
    rect: { x: number; y: number; width: number; height: number };
    confidence: number;
    status: "tracked" | "held" | "lost" | "manual";
    activity: number;
    rotationDegrees: number;
    scale: number;
    quad: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    planarDiagnostics?: { matches: number; inliers: number; reprojectionErrorPx: number; appearanceCorrelation: number; globalSearch: boolean; regionSupported: boolean };
  }>;
  lostRatio: number;
}

export interface NativeAutoRotoRequest {
  rawPath: string;
  outputDir: string;
  width: number;
  height: number;
  frameCount: number;
  analysisFps: number;
  initialFrame: number;
  initialRect: { x: number; y: number; width: number; height: number };
  temporalStability: number;
  feather: number;
  edgeShift: number;
  contrast: number;
  corrections?: Array<{ id: string; frame: number; mode: "foreground" | "background"; radius: number; points: Array<{ x: number; y: number }> }>;
  onnxPack?: NativeOnnxRotoPackRequest;
  regionMemoryPolicy?: "fixed_baseline" | "guarded_experimental";
}

export interface NativeOnnxRotoPackRequest {
  trustedRoot: string;
  manifestPath: string;
  allowIntegrationFixture?: boolean;
}

export interface NativeAutoRotoReceipt {
  schema: "editkin.auto-roto-matte/v1";
  engine: "editkin-native-color-temporal-roto/v1" | "editkin-native-onnx-assisted-roto/v1" | "editkin-sam21-video-memory-roto/v1";
  width: number;
  height: number;
  analysisFps: number;
  initialFrame: number;
  sequencePath: string;
  frames: Array<{ frame: number; time: number; alphaPath: string; confidence: number; foregroundRatio: number; boundaryChatter: number; previewSha256?: string; alphaFrameSha256?: string }>;
  sequenceSha256?: string;
  sequenceBytes?: number;
  meanBoundaryChatter: number;
  correctionStrokesApplied: number;
  correctedFrames: number[];
  regionMemoryRouting?: {
    schema: "editkin.region-memory-routing/v1";
    requested: "fixed_baseline" | "guarded_experimental";
    executed: "fixed_baseline" | "guarded_experimental" | "onnx_bypass";
    candidateAttempted: boolean;
    deterministicFallback: boolean;
    fallbackReason?: string;
  };
  alphaRefinement?: {
    schema: "editkin.optical-alpha-refinement-aggregate/v1";
    engine: "editkin-self-authored-optical-alpha-refiner/v1";
    appliedFrames: number;
    radius: number;
    backgroundThreshold: number;
    foregroundThreshold: number;
    coarseWeight: number;
    temporalStability: number;
    temporalGate: number;
    changedPixels: number;
    fractionalPixels: number;
    solvedPixels: number;
    meanSolveConfidence: number;
  };
  onnxModel?: {
    schema: "editkin.auto-roto-onnx-pack/v1";
    id: string;
    version: string;
    qualityTier: "production" | "integration_fixture";
    modelSha256: string;
    runtimeSha256: string;
    runtimeVersion: string;
    runtimeVersionSha256: string;
    licenseSha256: string;
    inputName: string;
    outputName: string;
    tensorElements: number;
    inferenceCalls: number;
  };
  sam2Model?: {
    schema: "editkin.auto-roto-video-pack/v1" | "editkin.auto-roto-video-pack/v2";
    id: string;
    version: string;
    qualityTier: "production" | "research_candidate";
    manifestSha256: string;
    hostSha256: string;
    pythonSha256: string;
    sourceMarkerSha256: string;
    configSha256: string;
    checkpointSha256: string;
    licenseSha256: string;
    runtimeReceiptSha256: string;
    sourceCommit: string;
    precision: "float16";
    selfContained: boolean;
    receiptSha256?: string;
    signatureSha256?: string;
    inventorySha256?: string;
    publisherKeyId?: string;
    runtime: {
      python: string;
      torch: string;
      cudaRuntime: string | null;
      gpu: string;
      modelLoadMs: number;
      stateInitializationMs: number;
      propagationP95Ms: number;
      propagationMeanMs: number;
      peakAllocatedBytes: number;
      peakReservedBytes: number;
      elapsedMs: number;
    };
  };
  frozen: true;
}

function run(executable: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("hao-core 執行逾時")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `hao-core exit ${code}`));
    });
  });
}

export async function nativeCoreAvailable(executable?: string): Promise<boolean> {
  if (!executable) return false;
  try { await access(executable); return true; } catch { return false; }
}

export async function createNativePlan(project: EditProject, executable: string): Promise<NativePlan> {
  const workspace = await mkdtemp(join(tmpdir(), "hao-core-plan-"));
  const input = join(workspace, "project.editkin.json");
  try {
    await writeFile(input, JSON.stringify(project), "utf8");
    return JSON.parse(await run(executable, ["plan", input])) as NativePlan;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function createNativeSmartCutPlan(request: SmartCutRequest, executable: string): Promise<NativeSmartCutPlan> {
  const workspace = await mkdtemp(join(tmpdir(), "hao-core-smart-cut-"));
  const input = join(workspace, "analysis.json");
  try {
    await writeFile(input, JSON.stringify(request), "utf8");
    return JSON.parse(await run(executable, ["smart-cut", input], 120_000)) as NativeSmartCutPlan;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function createNativeMotionTrackPlan(request: NativeMotionTrackRequest, executable: string, timeoutMs = 30 * 60_000): Promise<NativeMotionTrackPlan> {
  const workspace = await mkdtemp(join(tmpdir(), "hao-core-motion-track-"));
  const input = join(workspace, "request.json");
  try {
    await writeFile(input, JSON.stringify(request), "utf8");
    return JSON.parse(await run(executable, ["motion-track", input], timeoutMs)) as NativeMotionTrackPlan;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function createNativeAutoRoto(request: NativeAutoRotoRequest, executable: string, timeoutMs = 30 * 60_000): Promise<NativeAutoRotoReceipt> {
  const workspace = await mkdtemp(join(tmpdir(), "hao-core-auto-roto-"));
  const input = join(workspace, "request.json");
  try {
    await writeFile(input, JSON.stringify(request), "utf8");
    return JSON.parse(await run(executable, ["auto-roto", input], timeoutMs)) as NativeAutoRotoReceipt;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function compileNativeEngineGraph(graph: EngineRenderGraph, executable: string): Promise<NativeCompiledGraph> {
  const workspace = await mkdtemp(join(tmpdir(), "hao-core-engine-"));
  const input = join(workspace, "engine-graph.json");
  try {
    await writeFile(input, JSON.stringify(graph), "utf8");
    return JSON.parse(await run(executable, ["engine-compile", input], 120_000)) as NativeCompiledGraph;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
