import type { EditProject, EditorialProfileId, MediaAsset, MediaDerivatives, OpticalAlphaRefinementAggregate } from "../domain/types";
import type { ProductAutoRotoRouteReceipt } from "../application/autoRotoProductContract";

export interface PickedMedia {
  asset: MediaAsset;
  previewUrl: string;
}

export interface OpenProjectResult {
  canceled: boolean;
  path?: string;
  project?: EditProject;
  runtimeUrls?: Record<string, string>;
}

export interface SaveProjectResult {
  canceled: boolean;
  path?: string;
  project?: EditProject;
}

export interface RenderProjectResult {
  artifactIdentity?: import("../render/renderArtifactIdentity").RenderArtifactIdentity;
  canceled: boolean;
  outputPath?: string;
  duration?: number;
  encoder?: "h264_nvenc" | "h264_videotoolbox" | "libx264" | "hevc_nvenc" | "hevc_videotoolbox" | "libx265" | "prores_ks";
  planner?: string;
  ffmpegVersion?: string;
  alphaDelivery?: import("../render/ffmpegContracts").HighBitDepthAlphaDeliveryReceipt;
}

export interface RenderOpenExrSequenceResult {
  canceled: boolean;
  outputDirectory?: string;
  manifestPath?: string;
  receipt?: {
    schema: "editkin.openexr-sequence/v1";
    status: "GREEN";
    frameCount: number;
    startFrame: number;
    lastFrame: number;
    sequenceSha256: string;
    renderMilliseconds: { total: number; average: number; p95: number };
  };
}

export interface NativeEffectPreviewResult {
  schema: "editkin.native-effect-preview/v1";
  status: "GREEN";
  mode: "cached-cpu-native-sequence/v1";
  clipId: string;
  cacheKey: string;
  cacheHit: boolean;
  path: string;
  previewUrl: string;
  sha256: string;
  sourceStart: 0;
  duration: number;
  width: number;
  height: number;
  fps: number;
  audioSourceRetained: boolean;
  effectReceipt: unknown;
}

export interface AgentSetupResult {
  canceled: boolean;
  target?: "codex" | "claude";
  workspace?: string;
  status?: "installed" | "already_configured" | "command_copied" | "failed";
  message?: string;
  apiKeyRequired?: false;
  usesCurrentSession?: boolean;
  health?: "connected" | "configured" | "manual_step" | "failed";
  runtimeVerified?: boolean;
  runtimeToolCount?: number;
  autopilotPlanSchema?: string;
  liveInvocationBinding?: string;
  verification?: string;
  starterPrompt?: string;
  clientRestartRequired?: boolean;
  repairSteps?: string[];
}

export interface RemoteAgentLaunchResult {
  schema: "editkin.remote-agent-launch-result/v1";
  truthLabel: "WINDOWS_INTERNAL_AGENT_LAUNCH_CANDIDATE_NOT_REAL_PHONE_OR_MAC_VERIFIED";
  target: "codex" | "claude";
  jobId: string;
  consentRevision: "editkin.remote-agent-consent/v2";
  status: "provider_confirmation_required" | "desktop_approval_required" | "route_partial_verified"
    | "no_verified_progress" | "failed" | "canceled" | "timed_out" | "cleanup_unconfirmed";
  message: string;
  providerId: string | null;
  proposalRevision: string | null;
  proposalDigest: string | null;
  resumedExistingState: boolean;
  stateCreatedThisRun: boolean;
  manualFallbackAvailable: true;
  receiptPath: string;
  outputTruncated: boolean;
  realPhoneReconnectVerified: false;
  macVerified: false;
}

interface RemoteAgentLaunchStatusBase {
  schema: "editkin.remote-agent-launch-status/v1";
  truthLabel: "WINDOWS_INTERNAL_AGENT_LAUNCH_CANDIDATE_NOT_REAL_PHONE_OR_MAC_VERIFIED";
  cancelRequested: boolean;
}

export type RemoteAgentLaunchStatus = RemoteAgentLaunchStatusBase & ({
  phase: "idle";
  jobId: null;
  target: null;
  consentRevision: null;
  startedAtMs: null;
  endedAtMs: null;
  result: null;
} | {
  phase: "running";
  jobId: string;
  target: "codex" | "claude";
  consentRevision: "editkin.remote-agent-consent/v2";
  startedAtMs: number;
  endedAtMs: null;
  result: null;
} | {
  phase: "terminal";
  jobId: string;
  target: "codex" | "claude";
  consentRevision: "editkin.remote-agent-consent/v2";
  startedAtMs: number;
  endedAtMs: number;
  result: RemoteAgentLaunchResult;
} | {
  phase: "interrupted";
  jobId: string;
  target: "codex" | "claude";
  consentRevision: "editkin.remote-agent-consent/v2";
  startedAtMs: number;
  endedAtMs: number | null;
  result: null;
});

export type BatchAutoEditJobStatus = "queued" | "running" | "completed" | "failed";

export interface BatchAutoEditJob {
  id: string;
  sourcePath: string;
  sourceName: string;
  status: BatchAutoEditJobStatus;
  projectPath?: string;
  outputPath?: string;
  receiptPath?: string;
  warnings: string[];
  error?: string;
}

export interface BatchAutoEditSession {
  schemaVersion: 1;
  id: string;
  editorialProfile: EditorialProfileId;
  outputRoot: string;
  createdAt: string;
  updatedAt: string;
  jobs: BatchAutoEditJob[];
}

export interface PickBatchAutoEditResult {
  canceled: boolean;
  session?: BatchAutoEditSession;
}

export interface PrepareMediaResult {
  assetId: string;
  derivatives: MediaDerivatives;
  runtimeUrls: Record<string, string>;
  cacheHit: boolean;
}

export interface SmartCutDesktopRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  sourceSha256?: string;
  options?: { thresholdDb?: number; minSilence?: number; padding?: number; minKeep?: number };
}

export interface SmartCutDesktopResult {
  engine: string;
  fps: number;
  sourceFrames: number;
  ranges: Array<{ startFrame: number; endFrame: number }>;
  removedFrames: number;
  cutCount: number;
  silenceCount: number;
  thresholdDb: number;
  analyzedSeconds: number;
  cacheHit: boolean;
}

export interface AutomaticCaptionDesktopRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  sourceSha256?: string;
  language?: string;
  translationTarget?: "en";
}

export interface AutomaticCaptionDesktopResult {
  cues: Array<{ start: number; end: number; text: string; translation?: { text: string; language: "en" } }>;
  engine: string;
  modelId: string;
  modelSha256: string;
  language: string;
  translationTarget?: "en";
  analyzedSeconds: number;
  elapsedMs: number;
  modelDownloaded: boolean;
  cacheHit: boolean;
  acceleration: "gpu" | "cpu";
}

export interface SceneDetectionDesktopRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  sourceSha256?: string;
  threshold?: number;
  minSceneDuration?: number;
}

export interface SceneDetectionDesktopResult {
  cuts: Array<{ time: number; score: number; frame: number }>;
  engine: "ffmpeg-scdet-8";
  threshold: number;
  minSceneDuration: number;
  analyzedSeconds: number;
  elapsedMs: number;
  cacheHit: boolean;
}

export interface MotionTrackDesktopRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  sourceWidth: number;
  sourceHeight: number;
  initialTime: number;
  initialRect: { x: number; y: number; width: number; height: number };
  sourceSha256?: string;
}

export interface MotionTrackDesktopResult {
  engine: string;
  analysisFps: number;
  width: number;
  height: number;
  points: Array<{ frame: number; time: number; rect: { x: number; y: number; width: number; height: number }; confidence: number; status: "tracked" | "held" | "lost" | "manual"; activity?: number }>;
  lostRatio: number;
  analyzedSeconds: number;
  elapsedMs: number;
  cacheHit: boolean;
}

export interface AutoRotoDesktopRequest extends MotionTrackDesktopRequest {
  temporalStability?: number;
  feather?: number;
  edgeShift?: number;
  contrast?: number;
  corrections?: Array<{ id: string; frame: number; mode: "foreground" | "background"; radius: number; points: Array<{ x: number; y: number }> }>;
}

export type AutoRotoRouteReceiptDesktop = ProductAutoRotoRouteReceipt;

export interface AutoRotoDesktopResult {
  schema: "editkin.auto-roto-matte/v1";
  engine: "editkin-native-color-temporal-roto/v1";
  width: number;
  height: number;
  analysisFps: number;
  initialFrame: number;
  sequencePath: string;
  sequenceSha256: string;
  sequenceBytes: number;
  meanBoundaryChatter: number;
  correctionStrokesApplied: number;
  correctedFrames: number[];
  frozen: true;
  manifestPath: string;
  frames: Array<{ frame: number; time: number; alphaPath: string; previewUrl?: string; confidence: number; foregroundRatio: number; boundaryChatter: number; previewSha256: string; alphaFrameSha256: string }>;
  regionMemoryRouting: {
    schema: "editkin.region-memory-routing/v1";
    requested: "fixed_baseline";
    executed: "fixed_baseline";
    candidateAttempted: false;
    deterministicFallback: false;
  };
  alphaRefinement: OpticalAlphaRefinementAggregate;
  analyzedSeconds: number;
  elapsedMs: number;
  cacheHit: boolean;
  qualityState: "diagnostic";
  routeReceipt: AutoRotoRouteReceiptDesktop;
}

export interface UpdateCheckResult {
  status: "unconfigured" | "checking" | "downloading" | "current" | "available" | "ready" | "busy" | "error";
  version?: string;
  cacheHit?: boolean;
  message: string;
}

export interface MobileRemoteSnapshot {
  projectName: string;
  resolution: string;
  fps: number;
  trackCount: number;
  playhead: number;
  playheadLabel: string;
  status: string;
  previewId?: string;
  previewPath?: string;
  previewKind?: "video" | "audio" | "image";
}

export interface MobileRemoteResult {
  active: boolean;
  url: string;
  token: string;
  copied: boolean;
  transport: "lan" | "https-tunnel" | "cloud-relay";
  warning?: string;
}

interface MobileRemoteNetworkSummaryBase {
  transport: "lan" | "https-tunnel" | "cloud-relay";
  configured: boolean;
  pendingDesktopApproval: boolean;
  candidateRevision?: string;
  configurationId?: string;
  originHost?: string;
  providerId: string;
  costResponsibility: "none" | "end-user";
  requiresExternalTrafficConsent: boolean;
  previewSupport: "preview-available" | "commands-and-status-only";
  quality: {
    status: "local" | "unverified" | "partial" | "verified";
    latencyP50Ms?: number;
    jitterMs?: number;
    reconnectVerified: boolean;
    observedAt?: string;
  };
}

export interface MobileRemoteNetworkSummaryV1 extends MobileRemoteNetworkSummaryBase {
  schema: "editkin.remote-network-summary/v1";
}

export const MOBILE_REMOTE_SETUP_PHASE = {
  RESEARCH_READY: "RESEARCH_READY",
  EXACT_PROVIDER_PROPOSAL: "EXACT_PROVIDER_PROPOSAL",
  EXPIRED: "EXPIRED",
  RENEWAL_RECONCILIATION_REQUIRED: "RENEWAL_RECONCILIATION_REQUIRED",
  LEGACY_PENDING_BLOCKED: "LEGACY_PENDING_BLOCKED",
  ENV_CONFIGURED_READ_ONLY: "ENV_CONFIGURED_READ_ONLY",
  STATE_RECONCILIATION_REQUIRED: "STATE_RECONCILIATION_REQUIRED",
  AWAITING_DESKTOP_APPROVAL: "AWAITING_DESKTOP_APPROVAL",
  CONFIGURED_UNVERIFIED: "CONFIGURED_UNVERIFIED",
  ROUTE_PARTIAL_VERIFIED: "ROUTE_PARTIAL_VERIFIED",
  CONNECTED: "CONNECTED",
} as const;

export type MobileRemoteSetupPhase = typeof MOBILE_REMOTE_SETUP_PHASE[keyof typeof MOBILE_REMOTE_SETUP_PHASE];

export type MobileRemoteTruthLabel =
  | "READY_TO_RESEARCH"
  | "PROPOSAL_READY_NOT_APPROVED"
  | "PROPOSAL_EXPIRED_NOT_APPROVED"
  | "RENEWAL_RECOVERY_REQUIRED_NO_AUTOMATIC_REPLAY"
  | "LEGACY_PENDING_REQUIRES_MIGRATION_OR_DISCARD"
  | "ENV_CONFIGURED_OUTSIDE_EDITKIN"
  | "STATE_CONFLICT_REQUIRES_MANUAL_RECONCILIATION"
  | "DESKTOP_APPROVAL_REQUIRED_NOT_CONNECTED"
  | "CONFIGURED_NOT_VERIFIED"
  | "ROUTE_PARTIAL_NOT_REAL_PHONE_RECONNECT_VERIFIED"
  | "CONNECTED";

export type RemoteProviderProposalPricing = {
  kind: "public-list-price" | "estimate";
  amountMicros: number;
  currency: string;
  billingUnit: "per-month" | "per-gigabyte" | "per-hour" | "one-time";
  summary: string;
} | {
  kind: "unknown";
  amountMicros: null;
  currency: null;
  billingUnit: "unknown";
  summary: string;
};

export interface RemoteProviderProposal {
  schema: "editkin.remote-provider-proposal/v2";
  phase: "EXACT_PROVIDER_PROPOSAL";
  truthLabel: "PROPOSAL_READY_NOT_APPROVED";
  workflowId: string;
  jobId: string;
  consentRevision: "editkin.remote-agent-consent/v2";
  proposalRevision: string;
  proposalDigest: string;
  connector: {
    connectorId: string;
    connectorRevision: string;
    manifestSha256: string;
    availability: "enabled" | "research-only-disabled" | "unsupported-temporary";
    attested: boolean;
    approvalEnabled: boolean;
    executionOwner: "native-typed-connector";
  };
  planDigest: string;
  transport: "https-tunnel";
  provider: {
    id: string;
    displayName: string;
    productName: string;
    region: string;
  };
  expectedEndpoint: {
    transport: "https-tunnel";
    publicOriginRequired: true;
    description: string;
  };
  pricing: RemoteProviderProposalPricing;
  freeTier: string;
  quota: string;
  permissions: [string, ...string[]];
  plannedMutations: [string, ...string[]];
  cancellationOrDeletionConsequences: string;
  sources: [{
    label: string;
    url: string;
    checkedAtMs: number;
  }, ...Array<{
    label: string;
    url: string;
    checkedAtMs: number;
  }>];
  uncertainties: string[];
  unsupportedPrerequisites: string[];
  costResponsibility: "end-user";
  externalMutationPerformed: false;
  autoDeploy: false;
  approvalAvailable: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

export const REMOTE_PROVIDER_ACTION_STATE = {
  APPROVED_NOT_STARTED: "APPROVED_NOT_STARTED",
  PROVIDER_AUTH_REQUIRED: "PROVIDER_AUTH_REQUIRED",
  PROVIDER_ACTION_RUNNING: "PROVIDER_ACTION_RUNNING",
  AWAITING_DESKTOP_APPROVAL: "AWAITING_DESKTOP_APPROVAL",
  FAILED_NO_MUTATION: "FAILED_NO_MUTATION",
  CANCELED_NO_MUTATION: "CANCELED_NO_MUTATION",
  PROVIDER_ACTION_RECONCILIATION_REQUIRED: "PROVIDER_ACTION_RECONCILIATION_REQUIRED",
} as const;

export type RemoteProviderActionState = typeof REMOTE_PROVIDER_ACTION_STATE[keyof typeof REMOTE_PROVIDER_ACTION_STATE];

export interface RemoteProviderActionSummary {
  schema: "editkin.remote-provider-action-summary/v1";
  actionId: string;
  proposalDigest: string;
  connectorId: string;
  connectorRevision: string;
  connectorManifestSha256: string;
  planDigest: string;
  state: RemoteProviderActionState;
  mutationTruth: "none" | "confirmed" | "unknown";
  providerOwnedLogin: true;
  secretsAcceptedByEditkin: false;
  resumeAvailable: boolean;
  cancelAvailable: boolean;
  reconcileAvailable: boolean;
}

export interface RemoteProviderConnectorList {
  schema: "editkin.remote-provider-connector-list/v1";
  status: "RESEARCH_ONLY_NO_EXTERNAL_ACTION";
  connectors: Array<{
    connectorId: string;
    connectorRevision: string;
    manifestSha256: string;
    providerId: string;
    providerDisplayName: string;
    productName: string;
    transport: "https-tunnel";
    availability: "enabled" | "research-only-disabled" | "unsupported-temporary";
    approvalAvailable: boolean;
    attested: boolean;
    executionOwner: "native-typed-connector";
    authMode: "provider-owned-browser" | "none";
    stableHttpsName: boolean;
    supportedPublicPorts: number[];
    limitations: string[];
    sourceUrls: string[];
  }>;
  externalMutationToolAvailable: false;
  nextAction: string;
}

export interface MobileRemoteNetworkSummaryV2 extends MobileRemoteNetworkSummaryBase {
  schema: "editkin.remote-network-summary/v2";
  setupPhase: MobileRemoteSetupPhase;
  truthLabel: MobileRemoteTruthLabel;
  proposedTransport?: "https-tunnel" | "cloud-relay";
  proposal?: RemoteProviderProposal;
  providerAction?: RemoteProviderActionSummary;
  resumeAvailable: boolean;
}

export type MobileRemoteNetworkSummary = MobileRemoteNetworkSummaryV1 | MobileRemoteNetworkSummaryV2;

export interface MobileRemoteStartOptions {
  externalTrafficConfirmed?: boolean;
  expectedCandidateRevision?: string;
  expectedConfigurationId?: string;
}

export interface MobileRemoteCommand {
  id: string;
  instruction: string;
  receivedAt: string;
}

export interface MobileRemoteDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeen: string;
  connected: boolean;
}

export interface MobileRemoteStatus {
  active: boolean;
  connectedCount: number;
  trustedCount?: number;
  devices: MobileRemoteDevice[];
  pairingExpiresAt?: string;
  url?: string;
  transport?: "lan" | "https-tunnel" | "cloud-relay";
  warning?: string;
}
