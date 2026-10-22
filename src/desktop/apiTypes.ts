import type { EditProject, EditorialProfileId, MediaAsset } from "../domain/types";
import type { ProjectFileIdentityV1 } from "../domain/projectFileIdentityV1";
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
import type { TemplateShortJobStatus, TemplateShortPrepareResult, TemplateShortSavedVideo, TemplateShortStartRequest } from "./templateShortTypes";

import type { GpuPreviewApi, GpuPreviewOwner } from "./gpuPreviewApiTypes";
import type { ColorLutApiV1 } from "./colorLutApiV1";
import type { EngineTaskApiV1, DesktopBatchTaskOptionsV1 } from "./engineTaskHostV1";

export interface HaoDesktopApi extends GpuPreviewApi, Partial<ColorLutApiV1>, Partial<EngineTaskApiV1> {
  generateClipMediaDerivative?: (request: import("../application/clipMediaDerivatives").ClipMediaDerivativeRequest) => Promise<Awaited<ReturnType<typeof import("../application/clipMediaDerivatives").generateClipMediaDerivative>> & { previewUrl: string }>;
  setInterfaceScale?: (scale: number) => Promise<void>;
  readMesh3dFont?: (weight: number) => Promise<Uint8Array>;
  readBundledFontFace?: (faceId: string) => Promise<Uint8Array>;
  /** Motion Library render before dispatch: the engine task reply plus webview URLs of the rendered cache files. */
  renderMotionLibraryV1?: (input: import("../application/engineTaskContractV1").MotionLibraryRenderInputV1,
    options?: import("./engineTaskHostV1").MotionLibraryRenderTaskOptionsV1) => Promise<import("../application/engineTaskContractV1").MotionLibraryRenderResultV1 & { previewUrls: Record<string, string> }>;
  createGpuPreviewOwner?: () => Promise<GpuPreviewOwner>;
  isDesktop: true;
  pickMedia: () => Promise<PickedMedia[]>;
  importMediaPaths: (paths: string[]) => Promise<PickedMedia[]>;
  pickBatchMedia: (editorialProfile: EditorialProfileId) => Promise<PickBatchAutoEditResult>;
  getBatchSession: () => Promise<{ session?: BatchAutoEditSession }>;
  runBatchAutoEditItem: (sessionId: string, jobId: string, options?: DesktopBatchTaskOptionsV1) => Promise<{ session: BatchAutoEditSession }>;
  openBatchProject: (sessionId: string, jobId: string) => Promise<OpenProjectResult>;
  listCreativeLibrary: () => Promise<CreativeLibrarySummary>;
  listOriginalSfxCandidates?: () => Promise<import("../domain/originalSfxCandidateContractV1").OriginalSfxCandidateSummaryV1>;
  /** Existing verified host import; absolute source stays host-selected. No new native command. */
  resolveOriginalSfxCandidate?: (assetId: string) => Promise<PickedMedia & { absolutePath: string }>;
  importCreativeAsset: (assetId: string) => Promise<PickedMedia>;
  previewCreativeAsset: (assetId: string, mode?: "poster" | "media") => Promise<string>;
  readColorAsset: (relativePath: string) => Promise<string>;
  listInstalledPlugins: () => Promise<PluginRegistrySummary>;
  getWorkflowProfile: () => Promise<{ configured: boolean; path?: string; profile: EditkinWorkflowProfile }>;
  saveWorkflowProfile: (profile: EditkinWorkflowProfile) => Promise<{ configured: true; path: string; profile: EditkinWorkflowProfile }>;
  openPluginFolder: () => Promise<{ path: string; opened: boolean }>;
  compilePluginTool: (pluginId: string, capabilityId: string, targetClipId: string, parameters?: Record<string, unknown>) => Promise<EditorCommand[]>;
  openProject: () => Promise<OpenProjectResult>;
  saveProject: (project: EditProject, currentPath?: string, saveAs?: boolean, expectedFileIdentity?: Readonly<ProjectFileIdentityV1>) => Promise<SaveProjectResult>;
  /** With a job ID the export reports progress (renderJobProgress) and can be stopped (cancelRenderJob). */
  renderProject: (project: EditProject, options?: DesktopRenderOptions) => Promise<DesktopRenderResult>;
  renderAlphaMaster?: (project: EditProject, options?: DesktopRenderOptions) => Promise<DesktopRenderResult>;
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
  saveRecovery: (project: EditProject, projectPath: string | undefined, cleanUpdatedAt: string, baseFileIdentity?: Readonly<ProjectFileIdentityV1>) => Promise<void>;
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
  /** In-app template Shorts (M1 wave 4): the easy flow's 「直的短影音」 path. */
  templateShortPrepare?: (sourcePath: string) => Promise<TemplateShortPrepareResult>;
  /** Only the 「是，這是我自己拍的素材」 click calls this: it writes the one-time defaults file when it does not exist yet. */
  templateShortConfirmRights?: (sourcePath: string, brandMark?: string) => Promise<{ written: boolean; exists?: boolean }>;
  templateShortStart?: (request: TemplateShortStartRequest) => Promise<{ jobId: string }>;
  templateShortStatus?: (jobId: string) => Promise<TemplateShortJobStatus>;
  templateShortCancel?: (jobId: string) => Promise<{ jobId: string; canceled: boolean }>;
  /** Copies the delivered mp4 into the system Videos folder; never replaces a file. */
  templateShortSaveVideo?: (jobId: string, fileName: string) => Promise<TemplateShortSavedVideo>;
  /** The new Short project (never the open one), for 「我想自己細調」. */
  templateShortOpenProject?: (jobId: string) => Promise<OpenProjectResult>;
  /** Opens the folder with the file selected (Windows Explorer /select). */
  revealInFolder?: (path: string) => Promise<void>;
  /** The export job's host state: `known` once the location was chosen, and the renderer's latest snapshot. */
  renderJobProgress?: (jobId: string) => Promise<RenderJobReport>;
  /** 「停止輸出」: asks the renderer to stop; the export call then returns `canceled` with `stoppedByUser`. */
  cancelRenderJob?: (jobId: string) => Promise<{ jobId: string; known: boolean; cancelRequested: boolean }>;
  /** Version and build ID for Settings (the build's embedded release identity). */
  appBuildInfo?: () => Promise<AppBuildInfo>;
  /** Ask before the window closes while this is true (unsaved work or a running export). */
  setCloseGuard?: (armed: boolean) => Promise<void>;
  /** The page shows the close question (a page that never answers cannot trap the window). */
  acknowledgeCloseRequest?: () => Promise<void>;
  /** The creator chose to close: the next close goes through. */
  closeWindowConfirmed?: () => Promise<void>;
  /** Called when the creator closes the window while the guard is armed; returns an unsubscribe. */
  onCloseRequested?: (handler: () => void) => () => void;
  /** The open project file's size and time, and its revision once the time changed. */
  inspectProjectFile?: (path: string, knownModifiedMs?: number) => Promise<ProjectFileInspection>;
  /** Opens a known project path without a file dialog (recent list, reload, last saved file). */
  openProjectPath?: (path: string) => Promise<OpenProjectResult>;
  /** For each path, false when that local file no longer exists. */
  checkMediaPaths?: (paths: string[]) => Promise<boolean[]>;
  /** 「重新找檔案」: picks a file and returns its SHA-256 for the byte-identical relink. */
  pickRelinkMedia?: () => Promise<{ canceled: true } | { canceled: false; path: string; sha256: string; bytes: number }>;
  /** Moves the crash-recovery copy into recovery/kept instead of deleting it. */
  keepRecoveryAside?: () => Promise<{ kept: boolean; path?: string }>;
}

export interface DesktopRenderOptions { jobId?: string }

export interface DesktopRenderResult extends RenderProjectResult {
  /** The creator pressed 「停止輸出」 (as opposed to closing the save dialog). */
  stoppedByUser?: boolean;
  /** The finished file for the in-app player. */
  outputUrl?: string;
}

export interface RenderJobReport {
  jobId: string;
  known: boolean;
  outputPath?: string;
  cancelRequested?: boolean;
  elapsedMs?: number;
  /** The renderer's snapshot (editkin.render-progress/v1) or null before its first write. */
  progress?: unknown;
}

export interface AppBuildInfo {
  version: string;
  productVersion: string;
  buildId: string;
  buildIdFull: string;
  edition: "official" | "community";
}

export interface ProjectFileInspection {
  fileIdentity?: ProjectFileIdentityV1;
  exists: boolean;
  modifiedMs?: number;
  bytes?: number;
  unchanged?: boolean;
  readable?: boolean;
  revision?: number | null;
  updatedAt?: string | null;
  projectId?: string | null;
}

declare global {
  interface Window {
    haoDesktop?: HaoDesktopApi;
  }
}
