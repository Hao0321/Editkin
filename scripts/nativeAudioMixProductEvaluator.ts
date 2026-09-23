const timelineStartSeconds = 0.333333333333;
const sampleRate = 48_000;
const channels = 2;

export interface NativeMixReceipt {
  schema?: string;
  status?: string;
  manifestSha256?: string;
  decoderExecutor?: string;
  mixExecutor?: string;
  nativeGraphExecution?: boolean;
  sourceCount?: number;
  voiceClipCount?: number;
  musicClipCount?: number;
  graph?: {
    nodeCount?: number;
    nodeKinds?: string[];
    featureExecution?: Record<string, boolean>;
  };
  signal?: {
    outputBytes?: number;
    outputSha256?: string;
    preLimitPeak?: number;
    postLimitPeak?: number;
    limiterGain?: number;
  };
}

export interface SignalOracle {
  commandSucceeded: boolean;
  receipt: NativeMixReceipt;
  outputBytes: number;
  outputSha256: string;
  outputPeak: number;
  fadeRatio: number;
  duckingRatio: number;
  voiceBeforePlacement: number;
  voiceAfterPlacement: number;
}

export interface GateMeasurement {
  platform: string;
  appReady: boolean;
  apiSurface: { start: boolean; status: boolean; stop: boolean; saveRecovery: boolean; integrationSmoke: boolean };
  uiJourney: {
    projectLoaded: boolean;
    playControlFound: boolean;
    clickDispatched: boolean;
    enteredNativeMode: boolean;
    nativeBadgeVisible: boolean;
    compatibleFallbackVisible: boolean;
    sampleMasterFrame: number;
    timelineSeconds: number;
    stoppedFromUi: boolean;
  };
  processAliveAfterNegativeControls: boolean;
  projectUnchanged: boolean;
  start: Record<string, any>;
  progress: Record<string, any>;
  stop: Record<string, any>;
  statusAfterStop: Record<string, any>;
  invalidStartRejected: boolean;
  noAudioRejected: boolean;
  cacheEntriesAfterStop: string[];
  signalOracle: SignalOracle;
}

export interface Assessment { decision: "GREEN" | "BLOCK"; failures: string[] }

export const requiredFeatureIds = [
  "timelinePlacement",
  "clipGain",
  "musicFadeAutomation",
  "voiceBus",
  "musicBus",
  "sidechainDucking",
  "masterLimiter",
] as const;

export function hasPrivatePathSurface(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasPrivatePathSurface);
  return Object.entries(value).some(([key, nested]) => (
    ["path", "manifestPath", "managedPaths", "sessionRoot", "privatePaths"].includes(key)
    || hasPrivatePathSurface(nested)
  ));
}

export function assessMixReceipt(receipt: NativeMixReceipt, failures: string[], prefix: string): void {
  if (receipt.schema !== "editkin.native-audio-preview-mix-receipt/v1" || receipt.status !== "GREEN") {
    failures.push(`${prefix}_RECEIPT_INVALID`);
  }
  if (receipt.decoderExecutor !== "ffmpeg-source-decode/v1") failures.push(`${prefix}_DECODER_BOUNDARY_INVALID`);
  if (receipt.mixExecutor !== "hao-core-native-dag/v1" || receipt.nativeGraphExecution !== true) {
    failures.push(`${prefix}_EXECUTOR_INVALID`);
  }
  if (receipt.sourceCount !== 2 || receipt.voiceClipCount !== 1 || receipt.musicClipCount !== 1) {
    failures.push(`${prefix}_ROLE_COUNTS_INVALID`);
  }
  const features = receipt.graph?.featureExecution ?? {};
  for (const feature of requiredFeatureIds) {
    if (features[feature] !== true) failures.push(`${prefix}_FEATURE_${feature}`);
  }
  const nodeKinds = new Set(receipt.graph?.nodeKinds ?? []);
  for (const kind of ["source", "gain", "bus", "ducker", "limiter", "output"]) {
    if (!nodeKinds.has(kind)) failures.push(`${prefix}_NODE_${kind.toUpperCase()}_MISSING`);
  }
  if (!(receipt.graph?.nodeCount && receipt.graph.nodeCount >= 9)) failures.push(`${prefix}_GRAPH_TOO_SMALL`);
  if (!(receipt.signal?.outputBytes && receipt.signal.outputBytes > 0)
    || !/^[a-f0-9]{64}$/.test(receipt.signal?.outputSha256 ?? "")) failures.push(`${prefix}_OUTPUT_IDENTITY_INVALID`);
  if (!Number.isFinite(receipt.signal?.postLimitPeak)
    || (receipt.signal?.postLimitPeak ?? 2) > 10 ** (-3 / 20) + 1e-4
    || (receipt.signal?.postLimitPeak ?? 0) <= 0) failures.push(`${prefix}_LIMITER_EVIDENCE_INVALID`);
}

export function assessNativeAudioMixProduct(measurement: GateMeasurement): Assessment {
  const failures: string[] = [];
  const stage = measurement.start?.stage ?? {};
  const started = measurement.start?.playback ?? {};
  const progress = measurement.progress?.playback ?? {};
  if (measurement.platform !== "win32") failures.push("WINDOWS_PRODUCT_REQUIRED");
  if (!measurement.appReady) failures.push("TAURI_APP_NOT_READY");
  if (!measurement.apiSurface.start || !measurement.apiSurface.status || !measurement.apiSurface.stop || !measurement.apiSurface.saveRecovery || !measurement.apiSurface.integrationSmoke) failures.push("DESKTOP_API_MISSING");
  if (!measurement.uiJourney.projectLoaded) failures.push("UI_FIXTURE_PROJECT_NOT_LOADED");
  if (!measurement.uiJourney.playControlFound || !measurement.uiJourney.clickDispatched) failures.push("UI_PLAY_CONTROL_NOT_EXERCISED");
  if (!measurement.uiJourney.enteredNativeMode || !measurement.uiJourney.nativeBadgeVisible) failures.push("UI_NATIVE_AUDIO_ROUTE_NOT_REACHED");
  if (measurement.uiJourney.compatibleFallbackVisible) failures.push("UI_FELL_BACK_TO_COMPATIBLE_AUDIO");
  if (!(measurement.uiJourney.sampleMasterFrame > 0) || !(measurement.uiJourney.timelineSeconds > 0)) failures.push("UI_NATIVE_SAMPLE_CLOCK_DID_NOT_ADVANCE");
  if (!measurement.uiJourney.stoppedFromUi) failures.push("UI_STOP_DID_NOT_TERMINATE_SESSION");
  if (measurement.start?.native !== true) failures.push("NATIVE_SESSION_NOT_STARTED");
  if (stage.schema !== "editkin.native-audio-preview-stage/v2" || stage.status !== "GREEN") failures.push("STAGE_RECEIPT_INVALID");
  if (hasPrivatePathSurface(stage)) failures.push("MANAGED_PATH_EXPOSED");
  if (stage.projectId !== "slice44-native-audio" || stage.projectRevision !== 44 || stage.projectUpdatedAt !== "2026-08-28T00:00:00.000Z") failures.push("PROJECT_BINDING_INVALID");
  if (Math.abs((stage.timelineStartSeconds ?? -1) - timelineStartSeconds) > 1e-9) failures.push("STAGE_TIMELINE_INVALID");
  if (stage.sampleRate !== sampleRate || stage.channels !== channels || !(stage.durationSeconds >= 4)) failures.push("STAGE_FORMAT_INVALID");
  if (stage.clipCount !== 2 || stage.voiceClipCount !== 1 || stage.musicClipCount !== 1) failures.push("EDITGRAPH_AUDIO_ROLES_NOT_STAGED");
  if (stage.decoderExecutor !== "ffmpeg-source-decode/v1" || stage.decodeMode !== "independent-source-pcm") failures.push("FFMPEG_DECODER_BOUNDARY_INVALID");
  if (stage.mixExecutor !== "hao-core-native-dag/v1" || stage.nativeGraphExecution !== true) failures.push("NATIVE_MIX_STAGE_CLAIM_INVALID");
  if (!/^[a-f0-9]{64}$/.test(stage.manifestSha256 ?? "") || stage.sourcePcm?.length !== 2) failures.push("STAGE_SOURCE_IDENTITY_INVALID");
  if (started.schema !== "editkin.native-audio-preview-event/v1" || started.event !== "started" || started.backend !== "WASAPI shared event-driven") failures.push("WASAPI_START_RECEIPT_INVALID");
  if (Math.abs((started.timelineStartSeconds ?? -1) - timelineStartSeconds) > 1e-6) failures.push("NATIVE_START_TOLERANCE_INVALID");
  const playbackMix = started.nativeMix ?? {};
  assessMixReceipt(playbackMix, failures, "PRODUCT_MIX");
  if (playbackMix.manifestSha256 !== stage.manifestSha256) failures.push("PRODUCT_MANIFEST_BINDING_INVALID");
  if (progress.event !== "progress" || progress.backend !== "WASAPI shared event-driven") failures.push("NATIVE_PROGRESS_MISSING");
  if (!(progress.timelineSeconds > timelineStartSeconds) || !(progress.sampleMasterFrame > 0)
    || !(progress.presentedFrame > 0) || !(progress.callbackCount > 0) || !(progress.clockQpc100ns > 0)) failures.push("NATIVE_SAMPLE_MASTER_CLOCK_DID_NOT_ADVANCE");
  if (measurement.stop?.active !== false || measurement.stop?.stopped !== true || measurement.statusAfterStop?.active !== false) failures.push("STOP_DID_NOT_TERMINATE_SESSION");
  if (!measurement.invalidStartRejected) failures.push("INVALID_START_NOT_REJECTED");
  if (!measurement.noAudioRejected) failures.push("NO_AUDIO_NOT_REJECTED_FOR_FALLBACK");
  if (!measurement.processAliveAfterNegativeControls) failures.push("NEGATIVE_CONTROL_CRASHED_PRODUCT");
  if (!measurement.projectUnchanged) failures.push("PROJECT_JSON_MUTATED");
  if (measurement.cacheEntriesAfterStop.length !== 0) failures.push("MANAGED_MIX_CACHE_NOT_CLEANED");

  assessSignalOracle(measurement.signalOracle, failures);
  return { decision: failures.length ? "BLOCK" : "GREEN", failures };
}

export function assessSignalOracle(oracle: SignalOracle, failures: string[]): void {
  if (!oracle.commandSucceeded) failures.push("OFFLINE_NATIVE_MIX_COMMAND_FAILED");
  assessMixReceipt(oracle.receipt, failures, "ORACLE_MIX");
  if (oracle.outputBytes !== oracle.receipt.signal?.outputBytes || oracle.outputSha256 !== oracle.receipt.signal?.outputSha256) failures.push("ORACLE_OUTPUT_IDENTITY_MISMATCH");
  if (!(oracle.outputPeak > 0 && oracle.outputPeak <= 10 ** (-3 / 20) + 1e-4)) failures.push("ORACLE_MASTER_LIMITER_FAILED");
  if (!(oracle.fadeRatio > 2.5)) failures.push("ORACLE_MUSIC_FADE_NOT_OBSERVED");
  if (!(oracle.duckingRatio < 0.8)) failures.push("ORACLE_DUCKING_NOT_OBSERVED");
  if (!(oracle.voiceBeforePlacement < 0.01 && oracle.voiceAfterPlacement > 0.08)) failures.push("ORACLE_TIMELINE_OR_GAIN_NOT_OBSERVED");
}

export function goldenMixReceipt(): NativeMixReceipt {
  return {
    schema: "editkin.native-audio-preview-mix-receipt/v1",
    status: "GREEN",
    manifestSha256: "a".repeat(64),
    decoderExecutor: "ffmpeg-source-decode/v1",
    mixExecutor: "hao-core-native-dag/v1",
    nativeGraphExecution: true,
    sourceCount: 2,
    voiceClipCount: 1,
    musicClipCount: 1,
    graph: {
      nodeCount: 10,
      nodeKinds: ["source", "gain", "bus", "ducker", "limiter", "output"],
      featureExecution: Object.fromEntries(requiredFeatureIds.map((id) => [id, true])),
    },
    signal: { outputBytes: 768_000, outputSha256: "b".repeat(64), preLimitPeak: 0.9, postLimitPeak: 0.707, limiterGain: 0.78 },
  };
}

export function goldenMeasurement(): GateMeasurement {
  const nativeMix = goldenMixReceipt();
  const stage = {
    schema: "editkin.native-audio-preview-stage/v2", status: "GREEN", projectId: "slice44-native-audio",
    projectRevision: 44, projectUpdatedAt: "2026-08-28T00:00:00.000Z", timelineStartSeconds,
    durationSeconds: 5, sampleRate, channels, clipCount: 2, voiceClipCount: 1, musicClipCount: 1,
    decoderExecutor: "ffmpeg-source-decode/v1", decodeMode: "independent-source-pcm",
    mixExecutor: "hao-core-native-dag/v1", nativeGraphExecution: true, manifestSha256: "a".repeat(64),
    sourcePcm: [{ id: "voice", sha256: "c".repeat(64), bytes: 1 }, { id: "music", sha256: "d".repeat(64), bytes: 1 }],
  };
  const playback = { schema: "editkin.native-audio-preview-event/v1", event: "started", backend: "WASAPI shared event-driven", timelineStartSeconds, timelineSeconds: timelineStartSeconds, nativeMix };
  return {
    platform: "win32", appReady: true, apiSurface: { start: true, status: true, stop: true, saveRecovery: true, integrationSmoke: true },
    uiJourney: {
      projectLoaded: true, playControlFound: true, clickDispatched: true, enteredNativeMode: true,
      nativeBadgeVisible: true, compatibleFallbackVisible: false, sampleMasterFrame: 20_000,
      timelineSeconds: 0.75, stoppedFromUi: true,
    },
    processAliveAfterNegativeControls: true, projectUnchanged: true,
    start: { native: true, stage, playback },
    progress: { active: true, stage, playback: { ...playback, event: "progress", timelineSeconds: 0.75, sampleMasterFrame: 20_000, presentedFrame: 3_000, callbackCount: 8, clockQpc100ns: 1 } },
    stop: { active: false, stopped: true }, statusAfterStop: { active: false },
    invalidStartRejected: true, noAudioRejected: true, cacheEntriesAfterStop: [],
    signalOracle: { commandSucceeded: true, receipt: structuredClone(nativeMix), outputBytes: 768_000, outputSha256: "b".repeat(64), outputPeak: 0.707, fadeRatio: 5, duckingRatio: 0.5, voiceBeforePlacement: 0, voiceAfterPlacement: 0.25 },
  };
}

export function runEvaluatorSelfTest(): void {
  const golden = goldenMeasurement();
  const controls: Record<string, (candidate: GateMeasurement) => void> = {
    legacyFfmpegMix: (value) => { value.start.stage.mixExecutor = "ffmpeg-window-staging/v1"; value.start.stage.nativeGraphExecution = false; },
    exposedManifest: (value) => { value.start.stage.manifestPath = "C:/private/mix.json"; },
    staleProject: (value) => { value.start.stage.projectRevision = 43; },
    forgedPlaybackMix: (value) => { value.start.playback.nativeMix.nativeGraphExecution = false; },
    unboundManifest: (value) => { value.start.playback.nativeMix.manifestSha256 = "f".repeat(64); },
    missingVoiceBus: (value) => { value.start.playback.nativeMix.graph.featureExecution.voiceBus = false; },
    missingDuckerNode: (value) => { value.signalOracle.receipt.graph!.nodeKinds = ["source", "gain", "bus", "limiter", "output"]; },
    limiterOver: (value) => { value.signalOracle.outputPeak = 0.9; },
    fadeMissing: (value) => { value.signalOracle.fadeRatio = 1; },
    duckingMissing: (value) => { value.signalOracle.duckingRatio = 1; },
    timingMissing: (value) => { value.signalOracle.voiceBeforePlacement = 0.2; },
    frozenClock: (value) => { value.progress.playback.sampleMasterFrame = 0; },
    failedStop: (value) => { value.statusAfterStop.active = true; },
    invalidAccepted: (value) => { value.invalidStartRejected = false; },
    noAudioAccepted: (value) => { value.noAudioRejected = false; },
    projectMutation: (value) => { value.projectUnchanged = false; },
    cacheLeak: (value) => { value.cacheEntriesAfterStop = ["session/mix.json"]; },
    uiProjectMissing: (value) => { value.uiJourney.projectLoaded = false; },
    uiPlayBypassed: (value) => { value.uiJourney.clickDispatched = false; },
    uiLegacyStageRejected: (value) => { value.uiJourney.enteredNativeMode = false; value.uiJourney.nativeBadgeVisible = false; value.uiJourney.compatibleFallbackVisible = true; },
    uiClockFrozen: (value) => { value.uiJourney.sampleMasterFrame = 0; },
    uiStopFailed: (value) => { value.uiJourney.stoppedFromUi = false; },
  };
  const detected = Object.fromEntries(Object.entries(controls).map(([name, mutate]) => {
    const candidate = structuredClone(golden);
    mutate(candidate);
    return [name, assessNativeAudioMixProduct(candidate).failures];
  }));
  const positive = assessNativeAudioMixProduct(golden);
  const green = positive.decision === "GREEN" && Object.values(detected).every((failures) => failures.length > 0);
  process.stdout.write(`${JSON.stringify({ schema: "editkin.native-audio-mix-product-evaluator-selftest/v1", decision: green ? "GREEN" : "BLOCK", positive: positive.decision, detected })}\n`);
  if (!green) process.exitCode = 1;
}
