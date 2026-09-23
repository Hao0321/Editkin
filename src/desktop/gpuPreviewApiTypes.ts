import type { GpuCompositionResult, GpuEnginePreviewLoadResult, GpuEngineVideoPreviewLoadResult } from "./gpuTypes";
import type { GpuEngineVideoPresentedFrame, GpuVideoPresentedFrame, GpuVideoPreviewFrame, GpuVideoStagedFrame } from "./gpuFrameTypes";
import type { GpuNativePreviewSurface, GpuNativePreviewSurfaceRequest } from "./nativePreviewTypes";

export interface NativeGpuPlaybackEvent {
  schema: "editkin.native-preview-playback/v1";
  owner: string;
  generation: number;
  sessionId: string;
  state: "playing" | "stopped" | "superseded" | "ended" | "failed";
  timelineFrame: number;
  timelineSeconds: number;
  presentedFrames: number;
  droppedFrames: number;
  sequence: number;
  reason?: string | null;
  clock: "native-audio" | "native-monotonic";
}

export interface GpuPreviewApi {
  startGpuPreviewPlayback?: (sessionId: string, range: { startFrame: number; endFrame: number; audioGeneration?: number; audioOwnerId?:number }, onEvent?: (event: NativeGpuPlaybackEvent) => void | Promise<void>) => Promise<NativeGpuPlaybackEvent>;
  stopGpuPreviewPlayback?: (generation: number) => Promise<{ stopped: boolean }>;
  inspectGpuPreviewPlayback?: (generation: number, diagnostic?: boolean) => Promise<NativeGpuPlaybackEvent & { frameReceipt?: GpuEngineVideoPresentedFrame["receipt"] }>;
  loadGpuPreviewSession?: (sessionId: string, graph: import("../render/gpuCompositor").GpuRenderGraph) => Promise<{ sessionId: string; resident: true; layers: number; generation: number }>;
  loadGpuEnginePreviewSession?: (sessionId: string, graph: import("../render/engineGraph").EngineRenderGraph, assetBindings: Record<string, string>, timelineFrame: number) => Promise<GpuEnginePreviewLoadResult>;
  updateGpuEnginePreviewFrame?: (sessionId: string, timelineFrame: number) => Promise<{ sessionId: string; timelineFrame: number; updated: true; layers: number }>;
  loadGpuEngineVideoPreviewSession?: (sessionId: string, graph: import("../render/engineGraph").EngineRenderGraph, assetBindings: Record<string, string>, timelineFrame: number) => Promise<GpuEngineVideoPreviewLoadResult>;
  presentGpuEngineVideoPreviewFrame?: (sessionId: string, timelineFrame: number, toleranceSeconds: number) => Promise<GpuEngineVideoPresentedFrame>;
  releaseGpuEngineVideoPreviewSession?: (sessionId: string) => Promise<{ sessionId: string; released: boolean; fences: { retiredFenceCount: number; retiredSubmissionSequences: number[]; pendingFenceCount: number } }>;
  updateGpuPreviewProperties?: (sessionId: string, params: import("../render/gpuCompositor").GpuLayerPropertyBuffer[]) => Promise<{ sessionId: string; updated: true; layers: number }>;
  renderGpuPreviewFrame?: (sessionId: string) => Promise<GpuCompositionResult>;
  releaseGpuPreviewSession?: (sessionId: string) => Promise<{ sessionId: string; released: boolean }>;
  openGpuVideoPreviewSession?: (sessionId: string, inputPath: string) => Promise<{ sessionId: string; generation: number; backend: "Dx12"; decoder: { resident: true; width: number; height: number; decodePathCpuPixelCopies: 0; gpuProcessingPassesPerFrame: 2; residentFrameRingSize: 3; gpuResidentStaging: true; stagingCpuPixelReadback: false; stagingFenceRing: true; frameRate: [number, number]; sourceTimestampOriginSeconds: number } }>;
  decodeGpuVideoPreviewFrame?: (sessionId: string) => Promise<GpuVideoPreviewFrame>;
  decodeGpuVideoPreviewAtTime?: (sessionId: string, timeSeconds: number, toleranceSeconds: number) => Promise<GpuVideoPreviewFrame>;
  stageGpuVideoPreviewAtTime?: (sessionId: string, timeSeconds: number, toleranceSeconds: number) => Promise<GpuVideoStagedFrame>;
  bindGpuPreviewSurface?: (bounds: GpuNativePreviewSurfaceRequest) => Promise<GpuNativePreviewSurface>;
  presentGpuVideoPreviewAtTime?: (sessionId: string, timeSeconds: number, toleranceSeconds: number) => Promise<GpuVideoPresentedFrame>;
  hideGpuPreviewSurface?: () => Promise<{ hidden: true; presentCount: number }>;
  releaseGpuPreviewSurface?: () => Promise<{ released: boolean }>;
  seekGpuVideoPreviewSession?: (sessionId: string, timeSeconds: number) => Promise<{ sessionId: string; generation: number; seek: { seeked: true; timeSeconds: number; position100ns: number } }>;
  releaseGpuVideoPreviewSession?: (sessionId: string) => Promise<{ sessionId: string; released: boolean; fences: { retiredFenceCount: number; retiredSubmissionSequences: number[]; pendingFenceCount: number } }>;
  recoverGpuDevice?: () => Promise<{ recovered: true; generation: number; residentSessions: 0; residentVideoSessions: 0; residentEngineVideoSessions: 0 }>;
}
export interface GpuPreviewOwner {
  sessions: { image: string; video: string; engineVideo: string };
  desktop: GpuPreviewApi;
  release(): Promise<void>;
}
