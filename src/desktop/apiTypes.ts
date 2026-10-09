// Agent integration: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. Existing GPL license retained; see AGENT-NOTICE.md.
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
import type { StoryContext, StoryDraft, StoryModel } from "../application/localStoryDraft";
import type { MaterialPreparationJob } from "../application/materialPreparationJobs";
import type { MaterialIntelligencePacket, MaterialKeyframe } from "../application/materialIntelligence";
import type { AutomaticCaptionReadiness } from "../application/automaticCaptions";
import type { AgentSettingsRequest, AgentProviderReply } from "../application/agentProviders";

export interface DesktopMaterialReview {
  job: MaterialPreparationJob;
  packet?: {
    materialId: string;
    source: MaterialIntelligencePacket["source"];
    keyframes: MaterialKeyframe[];
    scene: MaterialIntelligencePacket["analysis"]["scene"];
    transcript: Pick<MaterialIntelligencePacket["analysis"]["transcript"], "state" | "cueCount"> & {
      cues?: MaterialIntelligencePacket["analysis"]["transcript"]["cues"];
      reason?: string;
    };
  };
}

export interface AgentAcpSnapshot {
  provenance?: typeof import("../shared/agentProvenance.json");
  historyAvailable?: boolean;
  libraryBinding?: string;
  archiveError?: string;
  connected: boolean;
  busy: boolean;
  providerReconnectRequired?: boolean;
  sourcePreparation?: { status: "PREPARING" | "CREATING" | "COMPLETED" | "CANCELLING" | "CANCELLED" | "FAILED" | "INTERRUPTED" | "UNCERTAIN";
    preparationId?: string; runId?: string; progress?: { phase: "hashing" | "checking" | "copying" | "verifying" | "ready";
      sourceIndex: number; sourceCount: number; bytesDone: number; bytesTotal: number }; updatedAt?: string; error?: string };
  sessionId?: string;
  title?: string;
  usage?: { used: number; size: number };
  workspace?: string;
  projectPath?: string;
  mcpToolCount?: number;
  skills: string[];
  loadSession: boolean;
  listSession: boolean;
  commands: Array<{ name: string; description: string; hint?: string }>;
  pendingPermissionIds: number[];
  configOptions: Array<{ id: string; name: string; category?: string; type: "select"; currentValue: string;
    options: Array<{ value: string; name: string; description?: string }> }>;
    seq: number;
    historyTruncated: boolean;
  events: Array<{ seq: number; entryId?: number; kind: "user" | "message" | "thought" | "plan" | "tool" | "permission" | "turn" | "error" | "system";
      text?: string; truncated?: boolean; messageId?: string; toolCallId?: string; toolName?: string; toolKind?: string; requestedAction?: string; outcome?: string; status?: string; projectChanged?: boolean; requestId?: number;
      details?: Array<{ type: "text"; text: string } | { type: "diff"; path: string; oldText?: string; newText: string } | { type: "terminal"; terminalId: string }>;
      locations?: Array<{ path: string; line?: number }>;
    entries?: Array<{ content: string; status: string }>;
    options?: Array<{ optionId: string; name: string; kind: string }> }>;
}

import type { GpuPreviewApi, GpuPreviewOwner } from "./gpuPreviewApiTypes";

export interface HaoDesktopApi extends GpuPreviewApi {
  agentLibrary?: (request: import("../application/agentLibrary").AgentLibraryRequest) => Promise<import("../application/agentLibrary").AgentLibraryReply>;
  openCodeAgentProvider: (request: AgentSettingsRequest) => Promise<AgentProviderReply>;
  startOpenCodeAgent: (projectPath?: string, resumeSessionId?: string, resumeModel?: string) => Promise<AgentAcpSnapshot>;
  promptOpenCodeAgent: (projectPath: string | undefined, text: string, displayText?: string, attachments?: Array<{ name: string; mimeType: string; text?: string; data?: string }>) => Promise<AgentAcpSnapshot>;
  listOpenCodeAgentSessions: () => Promise<Array<{ sessionId: string; title?: string; updatedAt?: string }>>;
  newOpenCodeAgentSession: () => Promise<AgentAcpSnapshot>;
  loadOpenCodeAgentSession: (sessionId: string, model: string) => Promise<AgentAcpSnapshot>;
  statusOpenCodeAgent: (afterSeq: number) => Promise<AgentAcpSnapshot>;
  permissionOpenCodeAgent: (requestId: number, optionId?: string) => Promise<AgentAcpSnapshot>;
  cancelOpenCodeAgent: () => Promise<AgentAcpSnapshot>;
  closeOpenCodeAgent: () => Promise<AgentAcpSnapshot>;
  setOpenCodeAgentConfig: (configId: string, value: string) => Promise<AgentAcpSnapshot>;
  reloadProjectFromPath: (path: string) => Promise<OpenProjectResult>;
  getLocalStoryOrigin: () => Promise<string>;
  saveLocalStoryOrigin: (origin: string) => Promise<string>;
  listLocalStoryModels: () => Promise<StoryModel[]>;
  generateLocalStory: (jobId: string, source: StoryModel["source"], model: string, brief: string, project: EditProject, context: StoryContext) => Promise<StoryDraft>;
  cancelLocalStory: (jobId: string) => Promise<boolean>;
  startMaterialReview: (project: EditProject, clipId: string, includeTranscript: boolean, resumeJobId?: string) => Promise<{ job: MaterialPreparationJob; coalesced: boolean }>;
  getMaterialReview: (jobId: string) => Promise<DesktopMaterialReview>;
  getMaterialReviewFrame: (jobId: string, frameId: string) => Promise<{ frameId: string; sha256: string; dataUrl: string }>;
  verifyMaterialReviewSource: (project: EditProject, clipId: string, jobId: string) => Promise<{ sha256: string; verifiedAt: string }>;
  cancelMaterialReview: (jobId: string) => Promise<MaterialPreparationJob>;
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
  createAgentWorkingProject: (project: EditProject) => Promise<{ path: string; project: EditProject }>;
  renderProject: (project: EditProject) => Promise<RenderProjectResult>;
  renderAlphaMaster?: (project: EditProject) => Promise<RenderProjectResult>;
  renderOpenExrSequence?: (project: EditProject) => Promise<RenderOpenExrSequenceResult>;
  renderNativeEffectPreview?: (project: EditProject, clipId: string) => Promise<NativeEffectPreviewResult>;
  previewUrls: (assets: MediaAsset[]) => Promise<Record<string, string>>;
  prepareMedia: (asset: MediaAsset) => Promise<PrepareMediaResult>;
  smartCutMedia: (request: SmartCutDesktopRequest) => Promise<SmartCutDesktopResult>;
  automaticCaptionStatus: () => Promise<AutomaticCaptionReadiness>;
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
