// Long-media WP-A contracts (LV-01..LV-08; design LONG_MEDIA_DESIGN_20261015 §(c) C1-C3/C5 and §(f)).
// Published for WP-B (bounded streaming), WP-C (original-stream copy) and WP-D (UX, fixtures, evaluators).
// Frozen once published: changes are additive only (a new optional member or a new code), never a rename.
// Nothing in this file is reachable from a SHORT (< 30 min) render.
import type { EditProject } from "../domain/types";
import type { DiskSpaceProbe } from "./renderDiskSpace";
import type { RenderPlan } from "./planner";
import type { GpuEngineVideoPreviewGraph } from "./gpuCompositorAdmission";
import type { RenderOptions, RenderResult, VideoEncoder } from "./ffmpegTypes";
import type { ResidentProjectDependencies, ResidentProjectOptions, ResidentSceneLinearVideoProjectResult } from "./residentSceneLinearVideoProject";
import type { NativeEffectRenderReceipt } from "../plugins/nativeEffectTypes";

export const LONG_RENDER_CONTRACTS_SCHEMA_V1 = "editkin.long-render-contracts/v1" as const;

export type LongRenderClassV1 = "short" | "long";

/** Every LONG route. Resident v2, scene-linear chunks and the FFmpeg single graph are WP-A; v3 and both chunked routes are WP-B providers. */
export const LONG_RENDER_ROUTES_V1 = ["resident-stream-v2", "resident-stream-v3", "scene-linear-chunked", "ffmpeg-single-graph", "ffmpeg-chunked"] as const;
export type LongRenderRouteV1 = typeof LONG_RENDER_ROUTES_V1[number];

/**
 * Stable refusal codes. A LONG render never degrades silently: every unsupported case is one of these.
 * The design's LONG_RENDER_PROXY_REFUSED is FORMAL_RENDER_PROXY_REFUSED (longRenderFormalOriginalsV1), which
 * decision Q-L1 applies to every render.
 */
export const LONG_RENDER_REFUSAL_CODES_V1 = [
  "LONG_RENDER_PREPASS_STAGING", "LONG_RENDER_NATIVE_EFFECT_STAGING", "LONG_RENDER_FIXED_MASK_STAGING", "LONG_RENDER_FLOATING_FRAMES",
  "LONG_RENDER_ROUTE_NOT_AVAILABLE", "LONG_RENDER_AUDIO_CLIPS_REQUIRE_V3", "LONG_RENDER_SOURCE_SHORT", "LONG_RENDER_SOURCE_UNMEASURED",
  "LONG_RENDER_WORK_ROOT_SYSTEM_TEMP", "LONG_RENDER_WORK_ROOT_REPARSE", "LONG_RENDER_WORK_ROOT_UNAVAILABLE", "LONG_RENDER_VOLUME_UNKNOWN",
  "LONG_RENDER_SPACE_SHORT", "LONG_RENDER_STAGING_LIMIT", "LONG_RENDER_OUTPUT_QA", "LONG_RENDER_CHUNK_FIELD_UNSUPPORTED",
  "LONG_RENDER_POLICY_INVALID", "LONG_RENDER_CLOCK_RANGE",
] as const;
export type LongRenderRefusalCodeV1 = typeof LONG_RENDER_REFUSAL_CODES_V1[number];

export class LongRenderRefusalV1 extends Error {
  readonly code: LongRenderRefusalCodeV1;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: LongRenderRefusalCodeV1, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "LongRenderRefusalV1";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isLongRenderRefusalV1(error: unknown, code?: LongRenderRefusalCodeV1): error is LongRenderRefusalV1 {
  return error instanceof LongRenderRefusalV1 && (code === undefined || error.code === code);
}

/** Versioned, adjustable policy (values in longRenderPolicyV1.ts). Byte and time members are safe integers. */
export interface LongRenderPolicyV1 {
  schema: "editkin.long-render-policy/v1";
  /** A render is LONG at this plan duration or more (decision Q-L2: 30 minutes). */
  minLongSeconds: number;
  /** Owned staging (work files, never the encoded output) may never exceed this. */
  stagingCapBytes: number;
  /** min(0.4 * physical RAM, 8 GiB) unless overridden (Q007). */
  ramBudgetBytes: number;
  outputReserveBytes: number;
  workReserveBytes: number;
  systemReserveBytes: number;
  /** Full re-measure cadence; a full measure also runs whenever 64 MiB more were written (whichever first). */
  measureIntervalMs: number;
  measureBytes: number;
  /** Cheap free-space/writer polling between full measures; detects 64 MiB of writes by anyone. */
  fastPollMs: number;
  stopLatencyMs: number;
  releaseMs: number;
  frameQueueFrames: number;
  frameQueueBytes: number;
  maxOwnedChildren: number;
  residentStreamV2MaxAudioClips: number;
  maxFloatingFramesPerClip: number;
  diskEstimateMargin: number;
}
export type LongRenderPolicyOverrideV1 = Partial<Omit<LongRenderPolicyV1, "schema">>;

/** Optional RenderOptions.longRender (tests and MCP only; the desktop never sets it). */
export interface LongRenderOptionsV1 {
  /** Classify as LONG regardless of duration (a short fixture may exercise the LONG machinery). "short" is never accepted. */
  forceClass?: "long";
  policy?: LongRenderPolicyOverrideV1;
  /** Replaces the volume probe of the guard and work-root policy (tests: unknown volume, foreign writer). */
  probe?: DiskSpaceProbe;
  /** Where crash-recovery pointers are written; default EDITKIN_LONG_RENDER_JOURNAL_ROOT or `<os temp>/editkin-long-render-journals`. */
  journalRegistryRoot?: string;
  /** Test seam: called once the guard is running and before any route work (e.g. to start a foreign writer). */
  onRunStarted?: (run: LongRenderRunBaseV1) => void | Promise<void>;
}

export interface RationalRateV1 { numerator: number; denominator: number }

export interface LongRenderFactsV1 {
  durationSeconds: number;
  /** Frames per second as an exact ratio (e.g. 30000/1001). */
  frameRate: RationalRateV1;
  frameCount: number;
  audioClipCount: number;
  /** Decoder inputs the FFmpeg composite opens at once (video segments + mattes + masks). */
  videoInputCount: number;
  ramEstimateBytes: number;
  /** What the legacy (SHORT) route of this project would stage: full PNG sequence and AAC bed, or zero. */
  legacyStagingEstimateBytes: number;
  prepassStagingBytes: number;
  nativeEffectStagingBytes: number;
  fixedMaskStagingBytes: number;
  maxFloatingFramesPerClip: number;
  finalOutputEstimateBytes: number;
  sceneLinear: boolean;
  residentCandidate: boolean;
  alphaDelivery: boolean;
}

export interface LongRenderClassificationV1 {
  schema: "editkin.long-render-classification/v1";
  class: LongRenderClassV1;
  durationSeconds: number;
  reason: "duration-at-least-threshold" | "forced-long" | "duration-below-threshold" | "duration-unavailable";
  minLongSeconds: number;
}

/** Up-front output identity (C1): recorded before rendering and re-checked on the `.part`. */
export interface LongOutputIdentityPlanV1 {
  schema: "editkin.long-output-identity-plan/v1";
  container: "mp4" | "mov";
  width: number;
  height: number;
  frameRate: RationalRateV1;
  expectedFrames: number;
  durationSeconds: number;
  pixelFormat: string;
  colorPrimaries: string;
  colorTransfer: string;
  colorMatrix: string;
  encoder: VideoEncoder;
  encoderArgs: readonly string[];
  audio: { codec: "aac" | "pcm_s24le"; sampleRate: 48000; channels: 2; expectedSamples: number };
}

/** One journaled path. `dev`/`ino` are decimal strings (bigint stat), captured when the path is known to exist. */
export interface LongRenderJournalRecordV1 {
  schema: "editkin.long-render-journal/v1";
  action: "open" | "create" | "remove" | "leftover";
  runId: string;
  path: string;
  kind: "journal" | "run-work-dir" | "output-staging-dir" | "part" | "file" | "dir";
  dev?: string;
  ino?: string;
  pid: number;
  host: string;
  at: string;
  reason?: string;
}

export interface LongRenderOwnerJournalHandleV1 {
  readonly runId: string;
  readonly path: string;
  /** Records an existing owned path (identity captured now). Owned directories are later removed as a whole, links refused. */
  recordCreated(path: string, kind: LongRenderJournalRecordV1["kind"]): Promise<void>;
  recordRemoved(path: string, reason: string): Promise<void>;
  /** Live (created, not yet removed) records, newest first. */
  live(): readonly LongRenderJournalRecordV1[];
}

export interface LongGuardReceiptV1 {
  schema: "editkin.long-render-guard/v2";
  volumes: Array<{ key: string; root: string; roles: string[]; reserveBytes: number; minFreeBytes: number; peakWriteBytesPerSecond: number }>;
  fullMeasures: number;
  fastPolls: number;
  triggeredByBytes: number;
  peakStagingBytes: number;
  stagingCapBytes: number;
  peakBurstBytes: number;
  intervalMs: number;
  measureBytes: number;
  warnings: string[];
  stopReason?: string;
}

export interface LongRenderSpaceGuardHandleV1 {
  /** Writers may report cumulative bytes they wrote; 64 MiB more than at the last full measure triggers one. */
  observeWrittenBytes(source: string, cumulativeBytes: number): void;
  check(reason: string): Promise<void>;
  readonly receipt: LongGuardReceiptV1;
}

/** Everything a LONG route (WP-A or a WP-B provider) needs; created once per LONG render by ffmpeg.ts. */
export interface LongRenderRunContextV1 {
  readonly schema: "editkin.long-render-run/v1";
  readonly runId: string;
  readonly route: LongRenderRouteV1;
  readonly policy: LongRenderPolicyV1;
  readonly classification: LongRenderClassificationV1;
  readonly facts: LongRenderFactsV1;
  /** Measured work root (configured or beside the output; never the OS temp folder). */
  readonly workRoot: string;
  /** Owned per-run work directory inside workRoot; every route workspace is created inside it. */
  readonly runDirectory: string;
  /** Owned directory beside the requested output that holds `partPath` and any route temporary output. */
  readonly outputStagingDirectory: string;
  /** The encoded output before publication: `<outputStagingDirectory>/.<name>.<runId>.editkin-long.part.<ext>`. */
  readonly partPath: string;
  readonly requestedPath: string;
  readonly identity: LongOutputIdentityPlanV1;
  readonly journal: LongRenderOwnerJournalHandleV1;
  readonly guard: LongRenderSpaceGuardHandleV1;
  readonly signal: AbortSignal;
}

/** The run before its dispatch point: the route and identity plan are fixed only where the route is chosen. */
export type LongRenderRunBaseV1 = Omit<LongRenderRunContextV1, "route" | "identity"> & { readonly predictedRoute: LongRenderRouteV1 };

/** WP-B chunk hook (implemented in ffmpeg.ts as renderLongChunkIntermediateV1). */
export interface LongChunkIntermediateRequestV1 {
  /** Sub-project already shifted to chunk-local time (WP-B longSubProjectV1); FFmpeg-composite route only. */
  project: EditProject;
  /** Owned `.mkv` that must not exist yet, inside the run directory. */
  outputPath: string;
  options: RenderOptions;
  timeoutMs: number;
}

export interface LongChunkIntermediateResultV1 {
  schema: "editkin.long-chunk-intermediate/v1";
  outputPath: string;
  codec: "ffv1";
  container: "matroska";
  /** Final display-referred pixels after the output transform and ASS. Current V2 producer writes verified display tags; historical working-RGB chunks are refused. */
  pixelFormat: "yuv420p" | "yuv420p10le";
  width: number;
  height: number;
  frameRate: RationalRateV1;
  frameCount: number;
  durationSeconds: number;
  bytes: number;
  planner: string;
  nativeEffects?: NativeEffectRenderReceipt;
}

export type LongChunkIntermediateHookV1 = (request: LongChunkIntermediateRequestV1) => Promise<LongChunkIntermediateResultV1>;

/** Provider inputs at the route dispatch point inside renderResolvedProject (the project is already prepass-materialized). */
export interface LongRouteDispatchV1 {
  project: EditProject;
  /** Equals run.partPath: the provider writes (or publishes into) this file and never touches run.requestedPath. */
  outputPath: string;
  plan: RenderPlan;
  options: RenderOptions;
  encoder: VideoEncoder;
  timeoutMs: number;
  run: LongRenderRunContextV1;
  chunkHook: LongChunkIntermediateHookV1;
}

export type LongChunkedRouteProviderV1 = (input: LongRouteDispatchV1) => Promise<RenderResult>;

/** Resident v3 keeps v2's exact signature and adds the run context (guard V2, journal). */
export type LongResidentStreamProviderV1 = <TEncoder extends string>(project: EditProject, preview: GpuEngineVideoPreviewGraph,
  outputPath: string, plan: RenderPlan, options: ResidentProjectOptions, encoder: TEncoder, timeoutMs: number,
  dependencies: ResidentProjectDependencies<TEncoder>, run: LongRenderRunContextV1) => Promise<ResidentSceneLinearVideoProjectResult<TEncoder>>;

export interface LongRenderRouteProvidersV1 {
  residentStreamV3?: LongResidentStreamProviderV1;
  chunkedComposite?: LongChunkedRouteProviderV1;
  chunkedSceneLinear?: LongChunkedRouteProviderV1;
}

export interface LongPublishReceiptV1 {
  schema: "editkin.long-render-publish/v1";
  partPath: string;
  requestedPath: string;
  bytes: number;
  probe: { width: number; height: number; frameRate: string; frames: number; videoDurationSeconds: number; pixelFormat: string;
    colorPrimaries?: string; colorTransfer?: string; colorMatrix?: string; audioCodec?: string; audioSampleRate?: number; audioChannels?: number; audioSamples?: number };
  checks: Array<{ name: string; ok: boolean; expected: unknown; actual: unknown }>;
  committedAt: string;
}

export interface LongRenderReceiptV1 {
  schema: "editkin.long-render/v1";
  runId: string;
  route: LongRenderRouteV1;
  residentStreamVersion?: 2 | 3;
  classification: LongRenderClassificationV1;
  facts: LongRenderFactsV1;
  policy: LongRenderPolicyV1;
  workRoot: { path: string; source: "configured" | "beside-output" };
  identity: LongOutputIdentityPlanV1;
  sourceCoverage: Array<{ assetId: string; path: string; measuredVideoEndSeconds: number; requiredEndSeconds: number }>;
  guard: LongGuardReceiptV1;
  publish: LongPublishReceiptV1;
  cleanup: LongJournalCleanupReceiptV1;
  stageMs: Record<string, number>;
}

export interface LongJournalCleanupReceiptV1 {
  schema: "editkin.long-render-cleanup/v1";
  removed: string[];
  leftovers: Array<{ path: string; reason: string }>;
  elapsedMs: number;
  attempts: number;
}
