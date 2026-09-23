import type { EditProject, EditorialProfileId, MediaAsset } from "../domain/types";
import type { RecoveryReadResult } from "../application/recoveryFiles";
import type { CreativeLibrarySummary } from "../application/creativeLibrary";
import type { EditorCommand } from "../domain/commands";
import type { PluginRegistrySummary } from "./pluginTypes";
import type { EditkinWorkflowProfile } from "../plugins/skillPack";
import type { NativeAudioPreviewStartResult, NativeAudioPreviewStatus } from "./nativeAudioTypes";
import type {
  AgentSetupResult, AutomaticCaptionDesktopRequest, AutomaticCaptionDesktopResult, AutoRotoDesktopRequest,
  AutoRotoDesktopResult, BatchAutoEditSession, MobileRemoteCommand, MobileRemoteResult,
  MobileRemoteSnapshot, MobileRemoteStartOptions, MobileRemoteStatus, MotionTrackDesktopRequest, MotionTrackDesktopResult, NativeEffectPreviewResult,
  OpenProjectResult, PickBatchAutoEditResult, PickedMedia, PrepareMediaResult, RemoteAgentLaunchResult, RemoteAgentLaunchStatus, RenderOpenExrSequenceResult,
  RenderProjectResult, SaveProjectResult, SceneDetectionDesktopRequest, SceneDetectionDesktopResult,
  SmartCutDesktopRequest, SmartCutDesktopResult, UpdateCheckResult,
} from "./mediaTypes";
import type {
  GpuCompositionResult, GpuCompositorStatus,
  GpuResidentEngineStatus,
} from "./gpuTypes";
import type { AgentConnectionsResult } from "../application/remoteOnboarding";

import type { GpuPreviewApi, GpuPreviewOwner } from "./gpuPreviewApiTypes";

export interface HaoDesktopApi extends GpuPreviewApi {
  createGpuPreviewOwner?: () => Promise<GpuPreviewOwner>;
  isDesktop: true;
  pickMedia: () => Promise<PickedMedia[]>;
  importMediaPaths: (paths: string[]) => Promise<PickedMedia[]>;
  pickBatchMedia: (editorialProfile: EditorialProfileId) => Promise<PickBatchAutoEditResult>;
  getBatchSession: () => Promise<{ session?: BatchAutoEditSession }>;
  runBatchAutoEditItem: (sessionId: string, jobId: string) => Promise<{ session: BatchAutoEditSession }>;
  openBatchProject: (sessionId: string, jobId: string) => Promise<OpenProjectResult>;
  listCreativeLibrary: () => Promise<CreativeLibrarySummary>;
  importCreativeAsset: (assetId: string) => Promise<PickedMedia>;
  previewCreativeAsset: (assetId: string, mode?: "poster" | "media") => Promise<string>;
  readColorAsset: (relativePath: string) => Promise<string>;
  listInstalledPlugins: () => Promise<PluginRegistrySummary>;
  getWorkflowProfile: () => Promise<{ configured: boolean; path?: string; profile: EditkinWorkflowProfile }>;
  saveWorkflowProfile: (profile: EditkinWorkflowProfile) => Promise<{ configured: true; path: string; profile: EditkinWorkflowProfile }>;
  openPluginFolder: () => Promise<{ path: string; opened: boolean }>;
  compilePluginTool: (pluginId: string, capabilityId: string, targetClipId: string, parameters?: Record<string, unknown>) => Promise<EditorCommand[]>;
  openProject: () => Promise<OpenProjectResult>;
  saveProject: (project: EditProject, currentPath?: string, saveAs?: boolean) => Promise<SaveProjectResult>;
  renderProject: (project: EditProject) => Promise<RenderProjectResult>;
  renderAlphaMaster?: (project: EditProject) => Promise<RenderProjectResult>;
  renderOpenExrSequence?: (project: EditProject) => Promise<RenderOpenExrSequenceResult>;
  renderNativeEffectPreview?: (project: EditProject, clipId: string) => Promise<NativeEffectPreviewResult>;
  previewUrls: (assets: MediaAsset[]) => Promise<Record<string, string>>;
  prepareMedia: (asset: MediaAsset) => Promise<PrepareMediaResult>;
  smartCutMedia: (request: SmartCutDesktopRequest) => Promise<SmartCutDesktopResult>;
  automaticCaptionMedia: (request: AutomaticCaptionDesktopRequest) => Promise<AutomaticCaptionDesktopResult>;
  detectScenes: (request: SceneDetectionDesktopRequest) => Promise<SceneDetectionDesktopResult>;
  analyzeMotionTrack: (request: MotionTrackDesktopRequest) => Promise<MotionTrackDesktopResult>;
  analyzeAutoRoto?: (request: AutoRotoDesktopRequest) => Promise<AutoRotoDesktopResult>;
  loadRecovery: () => Promise<RecoveryReadResult>;
  saveRecovery: (project: EditProject, projectPath: string | undefined, cleanUpdatedAt: string) => Promise<void>;
  clearRecovery: () => Promise<void>;
  integrationSmokeEnabled?: () => Promise<boolean>;
  checkForUpdates: (options?: { download?: boolean }) => Promise<UpdateCheckResult>;
  installUpdate: () => Promise<{ started: boolean; message: string }>;
  copyAgentSetup: (target: "codex" | "claude") => Promise<AgentSetupResult>;
  inspectAgentConnections?: () => Promise<AgentConnectionsResult>;
  launchRemoteSetupAgent?: (target: "codex" | "claude", jobId: string, consentRevision: string, scopeConfirmed: boolean) => Promise<RemoteAgentLaunchResult>;
  cancelRemoteSetupAgent?: (jobId: string) => Promise<{ jobId: string; running: boolean; cancelRequested: boolean; matchedActiveJob: boolean }>;
  getRemoteSetupAgentStatus?: () => Promise<RemoteAgentLaunchStatus>;
  getMobileRemoteNetworkSummary?: () => Promise<import("./mediaTypes").MobileRemoteNetworkSummary>;
  listRemoteProviderConnectors?: () => Promise<import("./mediaTypes").RemoteProviderConnectorList>;
  startMobileRemote?: (snapshot: MobileRemoteSnapshot, options?: MobileRemoteStartOptions) => Promise<MobileRemoteResult>;
  updateMobileSnapshot?: (snapshot: MobileRemoteSnapshot) => Promise<void>;
  pollMobileCommands?: () => Promise<MobileRemoteCommand[]>;
  getMobileRemoteStatus?: () => Promise<MobileRemoteStatus>;
  revokeMobileDevice?: (deviceId: string) => Promise<{ revoked: boolean; deviceId: string }>;
  stopMobileRemote?: () => Promise<{ active: boolean; stopped: boolean }>;
  nativeAudioPreviewPushEvents?: boolean;
  residentAudio?: import("./residentAudioTypes").ResidentAudioApi;
  startNativeAudioPreview?: (project: EditProject, timelineStartSeconds: number, onStatus?: (status: NativeAudioPreviewStatus) => void) => Promise<NativeAudioPreviewStartResult>;
  nativeAudioPreviewStatus?: () => Promise<NativeAudioPreviewStatus>;
  stopNativeAudioPreview?: (expectedGeneration?: number) => Promise<{ active: boolean; stopped: boolean; superseded?: boolean; previous?: NativeAudioPreviewStatus }>;
  gpuCompositorStatus?: () => Promise<GpuCompositorStatus>;
  renderGpuComposition?: (graph: import("../render/gpuCompositor").GpuRenderGraph) => Promise<GpuCompositionResult>;
  gpuEngineStatus?: () => Promise<GpuResidentEngineStatus>;
}

declare global {
  interface Window {
    haoDesktop?: HaoDesktopApi;
  }
}
