import { randomUUID } from "node:crypto";
import { appendFile, copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import type { EditorCommand } from "../domain/commandTypes";
import type { AestheticReviewPolicy, EditProject, EditorialProfileId } from "../domain/types";
import { REFERENCE_MOTION_DESIGN_THEMES, type ReferenceMotionDesignSystem, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { drawTemplateShortSpotCheck } from "../motion/templateFamilyCertification";
import type { EditkinSkillSelectionReceipt } from "../plugins/skillPack";
import type { MediaProbe } from "../render/ffmpegContracts";
import { canonicalJson } from "../shared/canonicalJson";
import { readAutopilotBatchState, type AutopilotBatchItemState, type AutopilotBatchManifest, type AutopilotBatchRuntime,
  type executeAutopilotBatch } from "./autopilotBatchExecution";
import type { DesignRequest } from "./autopilotDesignContract";
import { autopilotOutcomeSchema, truncateAutopilotOutcomeNote } from "./autopilotEvidence";
import { autopilotPlanSourceFromIdentity, sha256Canonical, type LiveAutopilotIdentity } from "./autopilotInvocationIdentity";
import { AUTOPILOT_CONTEXT_PROTOCOL, inferenceRouterSha256, recommendInferenceRoute, renderInferenceRouterMarkdown } from "./inferencePolicy";
import type { MaterialIntelligencePacket, MaterialKeyframe, MaterialSemanticsInput, MaterialSemanticsReceipt, PrepareMaterialRequest } from "./materialIntelligence";
import type { MediaBootstrapRequest } from "./mediaBootstrap";
import { templateBeatTexts, templateFamilyBeatTable } from "./referenceMotionBeatTables";
import { TEMPLATE_SHORT_BRIEF_SCHEMA, TEMPLATE_SHORT_COPY_LIMITS, TEMPLATE_SHORT_LOOK_SCHEMA, TEMPLATE_SHORT_SLOTS, TEMPLATE_SHORT_START_SCHEMA,
  TemplateShortBlockError, assertBriefNumbers, assertGlyphs, assertSeenCoverage, parseTemplateShortBrief, parseTemplateShortStart, resolveTemplateShortWindow,
  templateShortLookSchema, templateShortTopic, type TemplateShortBlockCode, type TemplateShortBrief, type TemplateShortCopy, type TemplateShortFamily,
  type TemplateShortGenre, type TemplateShortLook } from "./templateShortBrief";
import { TEMPLATE_SHORT_GENRES, selectTemplateShortFamily, toTemplateInput, type TemplateShortSelection } from "./templateShortCatalog";
import { assertTemplateBeatCoverage, composeTemplateShortPlan, deriveEditorial, templateShortDesignRequest, type TemplateShortComposeInputs,
  type TemplateShortPacket } from "./templateShortPlan";
import { analyzeCompiledTemplate, readTemplateShortRenderExpectations, renderedShortProbeChecks, templateShortRenderExpectations, templateShortStatus,
  type TemplateShortQaFinding, type TemplateShortQaPacket, type TemplateShortRenderExpectations, type TemplateShortRunStatus } from "./templateShortQa";
import { resolveTemplateShortSourceRights, type TemplateShortDefaults } from "./templateShortWorkspace";

/**
 * M1 one-tool Short orchestrator (design §4, §10, §11; Hao 2026-10-09: one Editkin tool runs plan → audit → apply →
 * render → checks in one process, and the in-app one-click is an official path).
 *
 * start: validate → run folder + short-run.json → project → neutral bootstrap → prepare (keyframes) → serve frames
 * (look.json). make: brief pre-checks (nothing written) → semantics → identity/route/skill → template compile with its
 * own beats → beat check → plan-time QA → design brief → compose + self-check → sealed attempt-N/plan.v4.json → disk
 * precheck → the unchanged batch engine (audit → applying → apply → reconcile → render → verify → hard link) →
 * render-time checks → status, INDEX.jsonl and the M115 current.mp4.
 *
 * Guarantees: this module never writes the project. Its only project writers are the injected create/bootstrap and the
 * audited apply inside executeAutopilotBatch; audit stays the independent acceptance authority (it recompiles template,
 * design and material evidence), the HMAC receipt never leaves the process, and a sealed plan is never rewritten.
 * Hao's ruling: an art FLAG still delivers the mp4 as NEEDS_FIX with the seconds to fix; a technical failure never
 * delivers.
 *
 * Inference task class: the design's in-app "creator_one_click" is not an inferenceTaskClassSchema value. Both paths seal
 * quality_critical / quality: the strictest existing class, which already demands audit_then_apply plus a second
 * semantic pass (exactly what this flow does). A new class would change the v4 plan contract that Video Autopilot reads
 * without a VA change. The in-app distinction is carried by provider "other", copy author "creator" (M10) and an honest
 * model receipt: no model ran, so no router-preferred model id is borrowed.
 */
export const TEMPLATE_SHORT_RUN_SCHEMA = "editkin.template-short-run/v1" as const;
export const TEMPLATE_SHORT_RESULT_SCHEMA = "editkin.template-short-result/v1" as const;
export const TEMPLATE_SHORT_QA_SCHEMA = "editkin.template-short-qa/v1" as const;
export const TEMPLATE_SHORT_ROOT = "videos/_AUTOPILOT/editkin-short";
export const TEMPLATE_SHORT_FORMAT = { width: 1080, height: 1920, fps: 30 } as const;
/** Image bytes one start response may carry (agentContextBudget MATERIAL_KEYFRAME_MAX_RESPONSE_BYTES). */
export const TEMPLATE_SHORT_IMAGE_BYTES = 1_000_000;
export const TEMPLATE_SHORT_MAX_KEYFRAMES = 4;
export const TEMPLATE_SHORT_RESULT_MAX_BYTES = 20 * 1024;
export const TEMPLATE_SHORT_START_TEXT_MAX_BYTES = 8 * 1024;
const DELIVERED = new Set<string>(["NEEDS_FIX", "REVIEW_REQUIRED", "SPOT_CHECK_DUE", "READY"]);

export type TemplateShortMode = "mcp" | "in_app";
export type TemplateShortProvider = "claude_code" | "codex" | "other";
export type TemplateShortState = "AWAITING_BRIEF" | "RUNNING" | "INTERRUPTED" | TemplateShortBlockCode | TemplateShortRunStatus;

/** Everything the run touches outside its own folder, injected (design §12 step 2.3). */
export interface TemplateShortDeps {
  /** Absolute canonical workspace root; every stored path is relative to it. */
  root: string;
  now(): Date;
  randomHex(bytes: number): string;
  readDefaults(): Promise<{ defaults: TemplateShortDefaults; sha256: string }>;
  /** A workspace media path → canonical absolute and workspace-relative paths (links cannot borrow a scope). */
  resolveSource(path: string): Promise<{ absolute: string; relative: string }>;
  probe(absolutePath: string): Promise<MediaProbe>;
  readReviewPolicy(): Promise<{ policy: AestheticReviewPolicy }>;
  createProject(projectPath: string, name: string, width: number, height: number, fps: number, profile: EditorialProfileId): Promise<EditProject>;
  prepareBootstrap(input: MediaBootstrapRequest & { projectPath: string }): Promise<{ commands: EditorCommand[]; binding: { source: { sha256: string; bytes: number } } }>;
  applyBootstrap(projectPath: string, commands: EditorCommand[], expectedRevision: number): Promise<EditProject>;
  readProject(projectPath: string): Promise<EditProject>;
  fileSha256(absolutePath: string): Promise<string>;
  speechModelReady(): Promise<boolean>;
  prepareMaterial(request: PrepareMaterialRequest): Promise<{ packet: MaterialIntelligencePacket; cacheHit: boolean }>;
  readMaterial(materialId: string): Promise<MaterialIntelligencePacket>;
  readKeyframe(materialId: string, frameId: string): Promise<{ frame: MaterialKeyframe; data: Buffer }>;
  recordSemantics(input: MaterialSemanticsInput): Promise<MaterialSemanticsReceipt>;
  readFactSources(facts: ReadonlyArray<{ ref: string }>): Promise<Array<{ ref: string; content: string }>>;
  readIdentity(): Promise<LiveAutopilotIdentity>;
  resolveSkill(context: { format: "shorts"; domain: string; semanticRoles: string[] }): Promise<EditkinSkillSelectionReceipt>;
  compileTemplate(projectPath: string, input: ReferenceMotionTemplateInput): Promise<TemplateShortPacket & TemplateShortQaPacket>;
  compileDesign(request: DesignRequest, policy: AestheticReviewPolicy): Promise<{ sourceSha256: string; context: unknown;
    recipes: ReadonlyArray<{ beatId: string; recipe: { route: { primary_family: string } } }> }>;
  designIdentity(brief: unknown, project: EditProject): { projectSha256: string; sourceSha256: string; briefSha256: string };
  /** Loads the written batch manifest (workspace-relative) and its runtime: the unchanged audit/apply/render boundary. */
  prepareBatch(batchPath: string, options: { verifyRender: (item: AutopilotBatchManifest["items"][number], candidate: string,
    base: { project: EditProject; probe: MediaProbe }) => Promise<void>; renderTimeoutMs: number }): Promise<{ manifest: AutopilotBatchManifest; statePath: string;
    runtime: AutopilotBatchRuntime }>;
  executeBatch: typeof executeAutopilotBatch;
  readback(projectPath: string, instanceId: string): Promise<{ instanceStatus: string; summary: unknown }>;
  freeBytes(path: string): Promise<number>;
  tempDirectory(): string;
  /** Exclusive run lease across processes; the returned function releases it. */
  lock(path: string): Promise<() => Promise<void>>;
  writeLearningEvent(projectPath: string, event: Record<string, unknown>): Promise<string>;
  readExecutionAttribution(projectPath: string, planSha256: string): Promise<Record<string, unknown>>;
  /** Wave 3 (design §6.2): the pixel gate R1–R5 inside verifyRender (analyzeRenderedShort in production). It receives the
   * render expectations sealed with the attempt and the folder for contact sheets. Absent: only the probe part of R1 runs. */
  analyzeRendered?(input: { candidate: string; candidateSha256: string; project: EditProject; probe: MediaProbe; durationFrames: number;
    analytic: { flags: readonly TemplateShortQaFinding[] }; expectations?: TemplateShortRenderExpectations; sheetsDir: string }): Promise<{
    technical: { pass: boolean; checks: Array<{ id: string; pass: boolean; detail: string }> }; flags: TemplateShortQaFinding[]; sheets?: string[];
    report?: Record<string, unknown> }>;
}

// ---- Durable state -------------------------------------------------------------------------------------------------
type RunPhase = "created" | "bootstrapped" | "awaiting_brief" | "brief_accepted" | "composed" | "executing" | "done";
const PHASES: readonly RunPhase[] = ["created", "bootstrapped", "awaiting_brief", "brief_accepted", "composed", "executing", "done"];
interface AttemptRecord {
  n: number;
  phase: "brief_accepted" | "composed" | "executing" | "done";
  startedAt: string;
  family: TemplateShortFamily;
  designSystem: ReferenceMotionDesignSystem;
  statusCeiling: TemplateShortSelection["statusCeiling"];
  certifiedAt?: string;
  status?: TemplateShortState;
  block?: { code: TemplateShortBlockCode; detail: string; field?: string; projectUnchanged: boolean };
  frameObservedNumbers?: boolean;
  semanticReceiptSha256?: string;
  instanceId?: string;
  beats?: Array<{ id: string; range: [number, number] }>;
  analytic?: { blocks: TemplateShortQaFinding[]; flags: TemplateShortQaFinding[] };
  /** What the compiled template will draw (attempt-N/render-expectations.json), sealed for the render-time pixel gate. */
  renderExpectations?: { path: string; sha256: string; bands: number };
  /** "applied" when the pixel gate measured the delivered candidate; the contact sheets it wrote (workspace-relative). */
  pixelGate?: "applied" | "unmeasured";
  sheets?: string[];
  planSha256?: string;
  planBytes?: number;
  commandCount?: number;
  batch?: { phase?: string; error?: string; executionReceiptFile?: string };
  technical?: { pass: boolean; checks: Array<{ id: string; pass: boolean; detail: string }>; candidateSha256?: string };
  renderedFlags?: TemplateShortQaFinding[];
  output?: { path: string; sha256: string; bytes: number; frames: number };
  readback?: { instanceStatus: string };
  spotCheck?: { drawn: boolean; reason: string };
  current?: { path: string; linked: boolean; error?: string };
  va?: { skillSha256: string; workflowContractSha256: string; workflowContractRevision: number };
  timingsMs: Record<string, number>;
  fixSeconds?: number[];
  finishedAt?: string;
}
export interface TemplateShortRunRecord {
  schema: typeof TEMPLATE_SHORT_RUN_SCHEMA;
  shortId: string;
  runDir: string;
  phase: RunPhase;
  mode: TemplateShortMode;
  provider: TemplateShortProvider;
  createdAt: string;
  updatedAt: string;
  genre: TemplateShortGenre;
  speech: "auto" | "none";
  source: { path: string; sha256?: string; bytes?: number; durationSeconds: number; hasAudio: boolean; colorTransfer?: string; videoKey: string };
  window: { sourceStartFrame: number; durationFrames: number; fps: number; clampedToMaximum: boolean };
  defaultsSha256: string;
  rightsScope: string;
  project?: { path: string; id: string; bootstrapSha256: string; assetId: string; clipId: string };
  material?: { materialId: string; keyframes: Array<{ id: string; time: number; sha256: string; bytes: number }>;
    transcript: { state: "ready" | "not_applicable" | "blocked" | "unmeasured"; cueCount: number; language?: string } };
  framePages: number;
  attempts: AttemptRecord[];
  status: TemplateShortState;
  lastError?: { code: string; detail: string; field?: string };
  review?: { eventFile: string; accepted: boolean; severeError: boolean; recordedAt: string; evidenceSha256: string };
}

const runDirOf = (shortId: string) => `${TEMPLATE_SHORT_ROOT}/${shortId.slice(3)}`;
const abs = (deps: Pick<TemplateShortDeps, "root">, relative: string) => resolve(deps.root, relative);
const statePathOf = (deps: Pick<TemplateShortDeps, "root">, shortId: string) => abs(deps, `${runDirOf(shortId)}/short-run.json`);

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}
async function writeJsonExclusive(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
async function exists(path: string) {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function readState(deps: Pick<TemplateShortDeps, "root">, shortId: string): Promise<TemplateShortRunRecord> {
  let text: string;
  try { text = await readFile(statePathOf(deps, shortId), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TemplateShortBlockError("BLOCK_BRIEF", `找不到短片 ${shortId}；請先呼叫 start_template_short`, "shortId");
    throw error;
  }
  if (text.length > 512 * 1024) throw new TemplateShortBlockError("BLOCK_BRIEF", "short-run.json 超出有界大小", "shortId");
  const state = JSON.parse(text) as TemplateShortRunRecord;
  if (state.schema !== TEMPLATE_SHORT_RUN_SCHEMA || state.shortId !== shortId || state.runDir !== runDirOf(shortId)) {
    throw new TemplateShortBlockError("BLOCK_BRIEF", `short-run.json 不屬於 ${shortId}`, "shortId");
  }
  return state;
}
async function saveState(deps: Pick<TemplateShortDeps, "root" | "now">, state: TemplateShortRunRecord, phase?: RunPhase) {
  if (phase && PHASES.indexOf(phase) > PHASES.indexOf(state.phase)) state.phase = phase; // phases only move forward
  state.updatedAt = deps.now().toISOString();
  await writeJsonAtomic(statePathOf(deps, state.shortId), state);
}
function blockOf(error: unknown, fallback: TemplateShortBlockCode): TemplateShortBlockError {
  if (error instanceof TemplateShortBlockError) return error;
  return new TemplateShortBlockError(fallback, (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z]:\\[^\s"'，。]+/g, "[local-path]").slice(0, 600));
}

/** Source file stem → lowercase ASCII slug (IMG_4022.MOV → img-4022), at most 24 characters. */
export function templateShortSlug(sourcePath: string): string {
  const stem = parsePath(sourcePath.replace(/\\/g, "/")).name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return stem.slice(0, 24).replace(/-+$/g, "") || "clip";
}
const yyyymmdd = (date: Date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;

// ---- Disk precheck (ROADMAP 1.12) -----------------------------------------------------------------------------------
/** Conservative bytes a ≤15 s 1080×1920 render needs: the renderer's temp work (ASS motion layers, native audio, filter
 * scripts) on the temp drive, and the encode, its temporary output and the verified candidate on the output drive. */
export function templateShortDiskNeed(durationFrames: number, fps: number) {
  const seconds = durationFrames / fps, output = Math.ceil(seconds * 100e6 / 8);
  return { tempBytes: 1024 ** 3 + durationFrames * 2 * 1024 ** 2, outputBytes: 3 * output + 256 * 1024 ** 2 };
}
async function assertDisk(deps: TemplateShortDeps, runAbsolute: string, durationFrames: number, fps: number) {
  const need = templateShortDiskNeed(durationFrames, fps), temp = deps.tempDirectory();
  const rootOf = (path: string) => parsePath(resolve(path)).root.toLowerCase();
  const drives = new Map<string, { path: string; need: number; what: string[] }>();
  for (const [path, bytes, what] of [[temp, need.tempBytes, "輸出暫存"], [runAbsolute, need.outputBytes, "成片"]] as const) {
    const row = drives.get(rootOf(path)) ?? { path, need: 0, what: [] };
    row.need += bytes; row.what.push(what); drives.set(rootOf(path), row);
  }
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  for (const [drive, row] of drives) {
    const free = await deps.freeBytes(row.path);
    if (free < row.need) {
      throw new TemplateShortBlockError("BLOCK_DISK", `${drive.toUpperCase()} 只剩 ${gb(free)} GB，${row.what.join("與")}需要約 ${gb(row.need)} GB；清出空間後用 resume 繼續（專案未修改）`);
    }
  }
  return need;
}
/** Render deadline scaled to length (ROADMAP 1.11): 90 s per output second, at least 10 minutes, at most an hour. */
export const templateShortRenderTimeoutMs = (durationFrames: number, fps: number) => Math.min(60 * 60_000, Math.max(10 * 60_000, Math.ceil(durationFrames / fps * 90_000)));

// ---- Jobs (one live job per shortId in this process) ----------------------------------------------------------------
interface Job { jobId: string; shortId: string; startedAt: string; finishedAt?: string; result?: TemplateShortResult; error?: string; done: Promise<void> }
export class TemplateShortJobs {
  private readonly jobs = new Map<string, Job>();
  live(shortId: string) { const job = this.jobs.get(shortId); return job && !job.finishedAt ? job : undefined; }
  get(shortId: string) { return this.jobs.get(shortId); }
  start(shortId: string, work: () => Promise<TemplateShortResult>, now: () => Date): Job {
    if (this.live(shortId)) throw new TemplateShortBlockError("BLOCK_BRIEF", `${shortId} 已有進行中的工作；請用 get_template_short 查詢`, "shortId");
    const job: Job = { jobId: randomUUID(), shortId, startedAt: now().toISOString(), done: Promise.resolve() };
    // Deferred until the initiating call returns; failures stay job state, never unhandled rejections.
    job.done = Promise.resolve().then(work).then(result => { job.result = result; },
      error => { job.error = error instanceof Error ? error.message : String(error); }).finally(() => { job.finishedAt = now().toISOString(); });
    this.jobs.set(shortId, job);
    if (this.jobs.size > 64) for (const [key, old] of this.jobs) { if (old.finishedAt && this.jobs.size > 64) this.jobs.delete(key); }
    return job;
  }
}
export const templateShortJobs = new TemplateShortJobs();

// ---- Results (≤20 KB, design §11) -------------------------------------------------------------------------------------
export interface TemplateShortResult {
  schema: typeof TEMPLATE_SHORT_RESULT_SCHEMA;
  status: TemplateShortState;
  shortId: string;
  [key: string]: unknown;
}
function boundResult(result: TemplateShortResult): TemplateShortResult {
  const size = () => Buffer.byteLength(JSON.stringify(result), "utf8");
  if (size() <= TEMPLATE_SHORT_RESULT_MAX_BYTES) return result;
  const qa = result.qa as { checks?: unknown[] } | undefined;
  if (qa?.checks) qa.checks = qa.checks.slice(0, 8);
  if (size() > TEMPLATE_SHORT_RESULT_MAX_BYTES) delete result.va;
  if (size() > TEMPLATE_SHORT_RESULT_MAX_BYTES) throw new Error("Template short result exceeds 20 KB");
  return result;
}
function stateResult(state: TemplateShortRunRecord, overrides: { status?: TemplateShortState; detail?: string } = {}): TemplateShortResult {
  const attempt = state.attempts.at(-1);
  const status = overrides.status ?? state.status;
  const findings = [...(attempt?.analytic?.flags ?? []), ...(attempt?.renderedFlags ?? [])];
  const checks = [...(attempt?.technical?.checks ?? []).map(check => ({ id: check.id, pass: check.pass, detail: check.detail.slice(0, 300) })),
    ...findings.map(flag => ({ id: flag.id, pass: false, severity: flag.severity, ...(flag.role ? { role: flag.role } : {}),
      ...(flag.seconds ? { seconds: flag.seconds } : {}), detail: flag.detail.slice(0, 300) }))].slice(0, 20);
  const delivered = DELIVERED.has(status), detail = overrides.detail ?? (!delivered && status !== "RUNNING" ? attempt?.batch?.error : undefined);
  return boundResult({
    schema: TEMPLATE_SHORT_RESULT_SCHEMA, status, shortId: state.shortId, phase: state.phase,
    ...(state.project ? { projectPath: state.project.path } : {}),
    ...(attempt ? { attempt: attempt.n, family: attempt.family, designSystem: attempt.designSystem,
      certification: attempt.certifiedAt ? `certified:${attempt.certifiedAt}` : "uncertified" } : {}),
    ...(attempt?.block ? { block: attempt.block } : state.lastError && !attempt ? { block: state.lastError } : {}),
    ...(detail ? { detail: detail.slice(0, 600) } : {}),
    ...(attempt?.output && delivered ? { output: attempt.output } : {}),
    ...(attempt?.current ? { current: attempt.current } : {}),
    ...(attempt?.fixSeconds?.length ? { fixSeconds: attempt.fixSeconds } : {}),
    ...(attempt?.beats ? { beats: attempt.beats } : {}),
    ...(attempt && (attempt.analytic || attempt.technical) ? { qa: { pass: !findings.length && (attempt.technical?.pass ?? true),
      report: attempt.technical ? `${state.runDir}/qa/QA.json` : undefined,
      rendered: attempt.pixelGate === "applied" ? "R1–R5 pixel gate (stall, jump, first frame, text column)" : "probe checks only (pixel gate unmeasured)",
      ...(attempt.sheets?.length ? { sheets: attempt.sheets.slice(0, 8) } : {}), checks } } : {}),
    ...(attempt?.planSha256 ? { receipts: { planSha256: attempt.planSha256, ...(attempt.batch?.executionReceiptFile ? { executionReceiptFile: attempt.batch.executionReceiptFile } : {}),
      ...(attempt.semanticReceiptSha256 ? { semanticReceiptSha256: attempt.semanticReceiptSha256 } : {}) } } : {}),
    ...(attempt?.spotCheck ? { spotCheck: attempt.spotCheck } : {}),
    ...(attempt?.va ? { va: { ...attempt.va, recordedAs: attempt.batch?.executionReceiptFile ? ["execution-receipt/v1"] : [],
      ...(delivered && attempt.output && attempt.planSha256 ? { outcomeDraft: templateShortOutcomeDraft({ receipts: { planSha256: attempt.planSha256 }, output: attempt.output }) } : {}) } } : {}),
    ...(state.review ? { review: state.review } : {}),
    ...(attempt ? { timingsMs: attempt.timingsMs } : {}),
    next: nextStep(state, status),
  });
}
function nextStep(state: TemplateShortRunRecord, status: TemplateShortState): string {
  if (status === "AWAITING_BRIEF") return "看過每張畫面後呼叫 make_template_short（seen 逐張寫下看到什麼）";
  if (status === "RUNNING") return "每 10 秒以內最多查一次 get_template_short";
  if (status === "INTERRUPTED" || status === "RENDER_FAILED_PROJECT_APPLIED" || status === "BLOCK_DISK") return "排除原因後呼叫 make_template_short {schema, shortId, resume:true}";
  if (status === "BLOCK_AUDIT") return "修正後以同一 shortId 再呼叫 make_template_short（會建立新的 attempt，已封存的計畫不改寫）";
  if (typeof status === "string" && status.startsWith("BLOCK_")) return "修正標出的欄位後，以同一 shortId 再呼叫 make_template_short";
  if (status === "NEEDS_FIX") return "成片已交付；請修正標出的秒數（模板美術由 Claude 修），或照常使用";
  if (DELIVERED.has(status)) return state.review ? "已記錄審查" : "看成片後呼叫 record_template_short_review";
  return "get_template_short";
}

// ---- Call 1: start --------------------------------------------------------------------------------------------------
export interface TemplateShortStartResponse { text: Record<string, unknown>; images: Array<{ id: string; data: Buffer; mimeType: "image/jpeg" }> }

export async function startTemplateShort(raw: unknown, deps: TemplateShortDeps,
  options: { mode: TemplateShortMode; provider: TemplateShortProvider }): Promise<TemplateShortStartResponse> {
  const started = Date.now(), request = parseTemplateShortStart(raw);
  if (request.shortId !== undefined) return serveTemplateShortFrames(request.shortId, request.framePage!, deps);
  const genre = request.genre!, speech = request.speech ?? "auto", source = request.source!;
  // S1: defaults, path, rights and window. Nothing is created before all of them pass.
  const defaults = await deps.readDefaults();
  let resolved: { absolute: string; relative: string };
  try { resolved = await deps.resolveSource(source.path); }
  catch (error) { throw new TemplateShortBlockError("BLOCK_START", `請先把素材放進工作資料夾：${error instanceof Error ? error.message : String(error)}`.slice(0, 400), "source.path"); }
  const rights = resolveTemplateShortSourceRights(defaults.defaults, resolved.relative);
  let probe: MediaProbe;
  try { probe = await deps.probe(resolved.absolute); }
  catch (error) { throw blockOf(error, "BLOCK_START"); }
  if (!probe.hasVideo) throw new TemplateShortBlockError("BLOCK_START", "這個檔案沒有影像，模板短片需要一段影片", "source.path");
  const fps = TEMPLATE_SHORT_FORMAT.fps, window = resolveTemplateShortWindow(source, probe.duration, fps);
  // S2: run folder and the exclusive state file.
  const now = deps.now(), slug = templateShortSlug(resolved.relative);
  let shortId = "", runDir = "";
  for (let attempt = 0; attempt < 8 && !runDir; attempt++) {
    const candidate = `ts-${yyyymmdd(now)}-${slug}-${deps.randomHex(3)}`;
    try { await mkdir(abs(deps, TEMPLATE_SHORT_ROOT), { recursive: true }); await mkdir(abs(deps, runDirOf(candidate))); shortId = candidate; runDir = runDirOf(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!runDir) throw new TemplateShortBlockError("BLOCK_START", "無法建立唯一的短片資料夾");
  const videoKey = `${slug}-${sha256Canonical(process.platform === "win32" ? resolved.relative.toLowerCase() : resolved.relative).slice(0, 6)}`;
  const state: TemplateShortRunRecord = { schema: TEMPLATE_SHORT_RUN_SCHEMA, shortId, runDir, phase: "created", mode: options.mode, provider: options.provider,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), genre, speech,
    source: { path: resolved.relative, durationSeconds: probe.duration, hasAudio: probe.hasAudio, ...(probe.colorTransfer ? { colorTransfer: probe.colorTransfer } : {}), videoKey },
    window: { sourceStartFrame: window.sourceStartFrame, durationFrames: window.durationFrames, fps, clampedToMaximum: window.clampedToMaximum },
    defaultsSha256: defaults.sha256, rightsScope: rights.scope, framePages: 0, attempts: [], status: "AWAITING_BRIEF" };
  await writeJsonExclusive(statePathOf(deps, shortId), state);
  try {
    // S3–S4: project and one atomic neutral bootstrap.
    const projectPath = `${runDir}/short.editkin.json`, genreRow = TEMPLATE_SHORT_GENRES[genre];
    const created = await deps.createProject(projectPath, `Shorts 模板 ${slug}`, TEMPLATE_SHORT_FORMAT.width, TEMPLATE_SHORT_FORMAT.height, fps, genreRow.profile);
    const assetId = `source-${slug}`, clipId = `clip-${slug}`;
    const prepared = await deps.prepareBootstrap({ projectPath, sourcePath: resolved.relative, assetId, clipId, trackId: "video-main",
      timelineStartFrame: 0, sourceStartFrame: window.sourceStartFrame, durationFrames: window.durationFrames, sourceColorInterpretation: "auto", rights: rights.declaration });
    const bootstrapped = await deps.applyBootstrap(projectPath, prepared.commands, created.revision);
    state.project = { path: projectPath, id: bootstrapped.id, bootstrapSha256: await deps.fileSha256(abs(deps, projectPath)), assetId, clipId };
    state.source.sha256 = prepared.binding.source.sha256; state.source.bytes = prepared.binding.source.bytes;
    await saveState(deps, state, "bootstrapped");
    // S5: prepare (≤60 s clips are synchronous). A transcript only when the clip has audio and the speech model is already installed.
    const asset = bootstrapped.assets.find(row => row.id === assetId), clip = bootstrapped.tracks.flatMap(track => track.clips).find(row => row.id === clipId);
    if (!asset || !clip) throw new Error("bootstrap did not create the source clip");
    const includeTranscript = speech === "auto" && probe.hasAudio && await deps.speechModelReady();
    const { packet } = await deps.prepareMaterial({ assetId, clipId, sourcePath: resolved.absolute, sourceStart: clip.sourceStart, duration: clip.duration,
      fps: bootstrapped.fps, kind: "video", sourceSha256: asset.derivatives?.sourceSha256, language: "auto", includeTranscript,
      maxKeyframes: TEMPLATE_SHORT_MAX_KEYFRAMES, color: asset.color, colorManagement: bootstrapped.colorManagement });
    const transcript = packet.analysis.transcript;
    state.material = { materialId: packet.materialId, keyframes: packet.keyframes.map(frame => ({ id: frame.id, time: frame.time, sha256: frame.sha256, bytes: frame.bytes })),
      transcript: { state: includeTranscript ? transcript.state : "unmeasured", cueCount: transcript.cueCount, ...(transcript.language ? { language: transcript.language } : {}) } };
    if (!packet.keyframes.length) throw new TemplateShortBlockError("BLOCK_START", "素材沒有可提供的關鍵畫面");
    await saveState(deps, state);
    // S6–S7: serve the first page of frames.
    const page = await servePage(state, 1, deps);
    return startResponse(state, page, packet, Date.now() - started);
  } catch (error) {
    const block = blockOf(error, "BLOCK_START");
    state.status = block.code; state.lastError = { code: block.code, detail: block.detail, ...(block.field ? { field: block.field } : {}) };
    await saveState(deps, state);
    throw block;
  }
}

async function readLook(deps: Pick<TemplateShortDeps, "root">, state: TemplateShortRunRecord): Promise<TemplateShortLook | undefined> {
  try { return templateShortLookSchema.parse(JSON.parse(await readFile(abs(deps, `${state.runDir}/look.json`), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function servePage(state: TemplateShortRunRecord, page: number, deps: TemplateShortDeps) {
  if (!state.material) throw new TemplateShortBlockError("BLOCK_START", "素材尚未準備完成");
  const look = await readLook(deps, state) ?? { schema: TEMPLATE_SHORT_LOOK_SCHEMA, shortId: state.shortId, materialId: state.material.materialId, frames: [] };
  if (page !== state.framePages + 1) throw new TemplateShortBlockError("BLOCK_START", `下一頁是 framePage ${state.framePages + 1}`, "framePage");
  const served = new Set(look.frames.map(frame => frame.id));
  const pending = [...state.material.keyframes].sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3))).filter(frame => !served.has(frame.id));
  if (!pending.length) throw new TemplateShortBlockError("BLOCK_START", "所有畫面都已提供；請呼叫 make_template_short", "framePage");
  const images: TemplateShortStartResponse["images"] = [];
  let total = 0;
  for (const frame of pending) {
    const { frame: current, data } = await deps.readKeyframe(state.material.materialId, frame.id);
    if (current.sha256 !== frame.sha256) throw new TemplateShortBlockError("BLOCK_START", `${frame.id} 的畫面已變更，請重新開始`);
    if (total + data.length > TEMPLATE_SHORT_IMAGE_BYTES) {
      if (!images.length) throw new TemplateShortBlockError("BLOCK_START", `${frame.id} 單張就超過 ${TEMPLATE_SHORT_IMAGE_BYTES} bytes`);
      break;
    }
    total += data.length; images.push({ id: frame.id, data, mimeType: "image/jpeg" });
    look.frames.push({ id: frame.id, time: frame.time, sha256: frame.sha256, servedAt: deps.now().toISOString(), page });
  }
  await writeJsonAtomic(abs(deps, `${state.runDir}/look.json`), templateShortLookSchema.parse(look));
  state.framePages = page; state.status = "AWAITING_BRIEF";
  await saveState(deps, state, "awaiting_brief");
  return { images, imageBytes: total, pending: pending.slice(images.length).map(frame => frame.id) };
}
function startResponse(state: TemplateShortRunRecord, page: Awaited<ReturnType<typeof servePage>>, packet: MaterialIntelligencePacket | undefined,
  elapsedMs: number): TemplateShortStartResponse {
  const theme = TEMPLATE_SHORT_GENRES[state.genre], fps = state.window.fps;
  const slots = (family: TemplateShortFamily) => Object.fromEntries(Object.entries(TEMPLATE_SHORT_SLOTS[family]).map(([field, slot]) => [field, {
    max: field === "points" ? `${TEMPLATE_SHORT_COPY_LIMITS.minPoints}–${TEMPLATE_SHORT_COPY_LIMITS.maxPoints} 項，label ≤${TEMPLATE_SHORT_COPY_LIMITS.pointLabel}、detail ≤${TEMPLATE_SHORT_COPY_LIMITS.pointDetail}`
      : TEMPLATE_SHORT_COPY_LIMITS[field as Exclude<keyof typeof TEMPLATE_SHORT_COPY_LIMITS, "minPoints" | "maxPoints" | "pointLabel" | "pointDetail">],
    ...("required" in slot ? { required: true } : {}) }]));
  const families = (["strike_reframe", "context_stack"] as const).map(family => {
    const selection = selectionPreview(family, state.genre);
    return { family, when: family === "strike_reframe" ? "copy.hook（原本以為→其實是）" : "copy.points（2–4 個重點）", designSystem: selection.designSystem,
      certification: selection.certification ? `certified:${selection.certification.certifiedAt}` : "uncertified", statusCeiling: selection.statusCeiling, slots: slots(family) };
  });
  const cues = (packet?.analysis.transcript.cues ?? []).slice(0, 20).map(cue => ({ start: cue.start, end: cue.end, text: cue.text.slice(0, 80) }));
  const served = page.images.map(image => ({ id: image.id, time: state.material!.keyframes.find(frame => frame.id === image.id)?.time }));
  const text: Record<string, unknown> = {
    status: "AWAITING_BRIEF", shortId: state.shortId,
    window: { in: state.window.sourceStartFrame / fps, out: (state.window.sourceStartFrame + state.window.durationFrames) / fps, seconds: state.window.durationFrames / fps,
      frames: state.window.durationFrames, ...(state.window.clampedToMaximum ? { note: "沒有指定出點，只用前 15 秒" } : {}) },
    source: { path: state.source.path, hasAudio: state.source.hasAudio },
    frames: served, imageBytes: page.imageBytes, framesPending: page.pending,
    transcript: { state: state.material?.transcript.state, cueCount: state.material?.transcript.cueCount, cues },
    genre: state.genre, theme: { designSystem: theme.designSystem, name: REFERENCE_MOTION_DESIGN_THEMES[theme.designSystem].name },
    families,
    next: page.pending.length
      ? { tool: "start_template_short", arguments: { schema: TEMPLATE_SHORT_START_SCHEMA, shortId: state.shortId, framePage: state.framePages + 1 } }
      : { tool: "make_template_short", arguments: { schema: TEMPLATE_SHORT_BRIEF_SCHEMA, shortId: state.shortId,
        seen: state.material!.keyframes.map(frame => ({ kf: frame.id, note: "<看到什麼，≤48 字>" })), copy: { payoff: "<其實是…>", hook: "<原本以為…>" } } },
    rule: "每張提供的畫面都要在 seen 寫一次；數字要有逐字稿或 facts 來源（M10）。",
    elapsedMs,
  };
  // ≤8 KB of text: cues are the only variable-length part.
  while (Buffer.byteLength(JSON.stringify(text), "utf8") > TEMPLATE_SHORT_START_TEXT_MAX_BYTES && cues.length) cues.pop();
  return { text, images: page.images };
}
function selectionPreview(family: TemplateShortFamily, genre: TemplateShortGenre): TemplateShortSelection {
  const copy: TemplateShortCopy = family === "strike_reframe" ? { hook: "原", payoff: "答" } : { payoff: "答", points: [{ label: "一" }, { label: "二" }] };
  return selectTemplateShortFamily({ copy, family }, genre);
}

/** Continuation `{schema, shortId, framePage}`: serves the next frames under the image cap and creates nothing. */
export async function serveTemplateShortFrames(shortId: string, framePage: number, deps: TemplateShortDeps): Promise<TemplateShortStartResponse> {
  const release = await runLock(deps, shortId);
  try {
    const state = await readState(deps, shortId);
    if (PHASES.indexOf(state.phase) >= PHASES.indexOf("brief_accepted")) throw new TemplateShortBlockError("BLOCK_START", "這支短片已經在製作，不再提供新畫面", "framePage");
    const page = await servePage(state, framePage, deps);
    return startResponse(state, page, state.material ? await deps.readMaterial(state.material.materialId) : undefined, 0);
  } finally { await release(); }
}
async function runLock(deps: TemplateShortDeps, shortId: string) {
  try { return await deps.lock(statePathOf(deps, shortId)); }
  catch { throw new TemplateShortBlockError("BLOCK_BRIEF", `${shortId} 正在另一個工作中處理；請用 get_template_short 查詢`, "shortId"); }
}

// ---- Call 2: make ---------------------------------------------------------------------------------------------------
interface AcceptedBrief {
  brief: TemplateShortBrief & { seen: NonNullable<TemplateShortBrief["seen"]>; copy: TemplateShortCopy };
  selection: TemplateShortSelection;
  topic: string;
  frameObservedNumbers: boolean;
  facts: Array<{ ref: string; content: string }>;
}
/** M1: every brief check runs before anything is written. Throws TemplateShortBlockError. */
async function acceptBrief(brief: TemplateShortBrief, state: TemplateShortRunRecord, deps: TemplateShortDeps): Promise<AcceptedBrief> {
  if (!state.project || !state.material || PHASES.indexOf(state.phase) < PHASES.indexOf("awaiting_brief")) {
    throw new TemplateShortBlockError("BLOCK_BRIEF", "這支短片還沒準備好畫面；請先完成 start_template_short", "shortId");
  }
  const seen = brief.seen!, copy = brief.copy!;
  const selection = selectTemplateShortFamily({ copy, family: brief.family }, state.genre);
  assertGlyphs(copy); // the brand mark's glyphs were checked when the defaults file was parsed
  const look = await readLook(deps, state);
  if (!look) throw new TemplateShortBlockError("BLOCK_UNVIEWED_FRAME", "還沒有提供任何畫面；先呼叫 start_template_short", "seen");
  const material = await deps.readMaterial(state.material.materialId);
  assertSeenCoverage(seen, look, material.keyframes, state.shortId);
  const unserved = material.keyframes.filter(frame => !look.frames.some(row => row.id === frame.id)).map(frame => frame.id);
  if (unserved.length) {
    throw new TemplateShortBlockError("BLOCK_UNVIEWED_FRAME", `還有 ${unserved.join("、")} 沒看；先呼叫 start_template_short {shortId, framePage: ${state.framePages + 1}}`, "seen");
  }
  const facts = brief.facts ? await deps.readFactSources(brief.facts) : [];
  const numbers = assertBriefNumbers(copy, { copyAuthor: state.mode === "in_app" ? "creator" : "agent",
    transcript: material.analysis.transcript.cues.map(cue => cue.text), facts, seen: seen.map(row => row.note) });
  return { brief: { ...brief, seen, copy }, selection, topic: templateShortTopic({ topic: brief.topic, copy, seen }), frameObservedNumbers: numbers.reviewRequired, facts };
}

export interface TemplateShortMakeOptions { mode: TemplateShortMode; provider: TemplateShortProvider; jobs?: TemplateShortJobs; wait?: boolean }
/** Call 2. Pre-checks run synchronously (a BLOCK returns at once, nothing written); the rest runs as a job. */
export async function makeTemplateShort(raw: unknown, deps: TemplateShortDeps, options: TemplateShortMakeOptions): Promise<TemplateShortResult> {
  const brief = parseTemplateShortBrief(raw), jobs = options.jobs ?? templateShortJobs;
  if (jobs.live(brief.shortId)) throw new TemplateShortBlockError("BLOCK_BRIEF", `${brief.shortId} 已有進行中的工作；請用 get_template_short 查詢`, "shortId");
  if (brief.resume) return resumeTemplateShort(brief.shortId, deps, options);
  const state = await readState(deps, brief.shortId);
  const applied = state.attempts.find(attempt => attempt.phase === "executing" || attempt.phase === "done");
  if (applied) {
    throw new TemplateShortBlockError("BLOCK_BRIEF", applied.phase === "done" ? "這支短片已經套用並輸出；要改文案請重新 start_template_short 建立新的一支"
      : "上一個 attempt 已在套用／輸出階段；請用 resume:true 續跑，或重新 start_template_short", "shortId");
  }
  let accepted: AcceptedBrief;
  try { accepted = await acceptBrief(brief, state, deps); }
  catch (error) {
    // Nothing is written by the checks; the reason is kept for get_template_short when the run is not leased elsewhere.
    const block = blockOf(error, "BLOCK_BRIEF");
    const release = await deps.lock(statePathOf(deps, brief.shortId)).catch(() => undefined);
    if (release) {
      try { const current = await readState(deps, brief.shortId); current.lastError = { code: block.code, detail: block.detail, ...(block.field ? { field: block.field } : {}) }; await saveState(deps, current); }
      finally { await release(); }
    }
    throw block;
  }
  const work = async () => {
    const release = await runLock(deps, brief.shortId);
    try { return await runAttempt(await readState(deps, brief.shortId), accepted, deps); }
    finally { await release(); }
  };
  if (options.wait) return work();
  const job = jobs.start(brief.shortId, work, () => deps.now());
  return { schema: TEMPLATE_SHORT_RESULT_SCHEMA, status: "RUNNING", shortId: brief.shortId, jobId: job.jobId, pollAfterMs: 10_000, next: "get_template_short" };
}

async function step<T>(code: TemplateShortBlockCode, timings: Record<string, number>, name: string, run: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  try { return await run(); }
  catch (error) { throw blockOf(error, code); }
  finally { timings[name] = (timings[name] ?? 0) + Date.now() - started; }
}

/** The next attempt number: after every recorded attempt and every attempt folder on disk (a crash between creating the
 * folder and recording it must not make a later attempt collide with its sealed files). */
async function nextAttemptNumber(state: TemplateShortRunRecord, deps: Pick<TemplateShortDeps, "root">) {
  const onDisk = await readdir(abs(deps, state.runDir)).then(names => names.flatMap(name => /^attempt-(\d+)$/.exec(name) ? [Number(/^attempt-(\d+)$/.exec(name)![1])] : []), () => []);
  return Math.max(0, ...state.attempts.map(attempt => attempt.n), ...onDisk) + 1;
}
async function runAttempt(state: TemplateShortRunRecord, accepted: AcceptedBrief, deps: TemplateShortDeps): Promise<TemplateShortResult> {
  const { brief, selection } = accepted, copy = brief.copy, project0 = state.project!, material0 = state.material!;
  const n = await nextAttemptNumber(state, deps), attemptDir = `${state.runDir}/attempt-${n}`;
  const attempt: AttemptRecord = { n, phase: "brief_accepted", startedAt: deps.now().toISOString(), family: selection.family, designSystem: selection.designSystem,
    statusCeiling: selection.statusCeiling, ...(selection.certification ? { certifiedAt: selection.certification.certifiedAt } : {}),
    frameObservedNumbers: accepted.frameObservedNumbers, timingsMs: {} };
  state.attempts.push(attempt); state.status = "RUNNING"; delete state.lastError;
  await writeJsonExclusive(abs(deps, `${attemptDir}/brief.json`), JSON.parse(canonicalJson(brief)));
  await saveState(deps, state, "brief_accepted");
  const timings = attempt.timingsMs;
  try {
    // The project must still be exactly the bootstrap: any edit is the creator's and is never overwritten.
    const projectAbsolute = abs(deps, project0.path);
    if (await deps.fileSha256(projectAbsolute) !== project0.bootstrapSha256) throw new TemplateShortBlockError("BLOCK_TEMPLATE", "專案在製作前已被修改；請重新 start_template_short");
    const project = await deps.readProject(project0.path), policy = (await deps.readReviewPolicy()).policy;
    if (!project.aestheticSystem) throw new TemplateShortBlockError("BLOCK_TEMPLATE", "專案沒有美感設定");
    const table = templateFamilyBeatTable(selection.family);
    if (!table) throw new TemplateShortBlockError("BLOCK_TEMPLATE_BEATS", `${selection.family} 還沒有段落表`);
    // M2: one semantic segment per seen line, bounded at the midpoints between keyframe times.
    const packet = await deps.readMaterial(material0.materialId), clip = project.tracks.flatMap(track => track.clips).find(row => row.id === project0.clipId)!;
    const receipt = await step("BLOCK_BRIEF", timings, "semantics", () => deps.recordSemantics(semanticsInput(state, accepted, packet, clip.duration)));
    attempt.semanticReceiptSha256 = receipt.semanticReceiptSha256;
    // M3: identity, route and skill.
    const identity = await step("BLOCK_COMPOSE", timings, "identity", () => deps.readIdentity());
    attempt.va = { skillSha256: identity.skill.sha256, workflowContractSha256: identity.workflow.sha256, workflowContractRevision: identity.workflow.revision };
    const skill = await step("BLOCK_COMPOSE", timings, "skill", () => deps.resolveSkill({ format: "shorts", domain: project.aestheticSystem!.domain, semanticRoles: [...table.skillRoles] }));
    // M5: compile; the packet carries the template's own beats. The brand mark comes from the defaults file, never the brief.
    const brandMark = (await deps.readDefaults()).defaults.brandMark;
    const input = toTemplateInput(selection.family, copy, { clipId: project0.clipId, durationFrames: state.window.durationFrames, designSystem: selection.designSystem,
      shortId: state.shortId, semanticRef: `material:${material0.materialId}:semantic:${receipt.semanticReceiptSha256}`,
      factRefs: brief.facts?.map(fact => fact.ref), ...(brandMark ? { brandMark } : {}), ...(brief.focus ? { focus: brief.focus } : {}) });
    const compiled = await step("BLOCK_TEMPLATE", timings, "compile", () => deps.compileTemplate(project0.path, input));
    const beats = compiled.beats ?? [];
    attempt.instanceId = compiled.instance.id;
    attempt.beats = beats.map(beat => ({ id: beat.id, range: [beat.startFrame, beat.endFrame] }));
    // M6–M7: beat coverage, then the analytic QA (BLOCK stops, FLAG travels with the run).
    await step("BLOCK_TEMPLATE_BEATS", timings, "beats", () => assertTemplateBeatCoverage(compiled, beats));
    const analytic = analyzeCompiledTemplate(compiled, beats, project);
    attempt.analytic = analytic;
    if (analytic.blocks.length) {
      const first = analytic.blocks[0];
      throw new TemplateShortBlockError("BLOCK_TEMPLATE_QA", `${first.id}${first.role ? `（${first.role}）` : ""}：${first.detail}`, first.role);
    }
    // What the template will draw on every frame, sealed beside the plan for the render-time pixel gate (a resumed render
    // reads the same file; the compiled packet itself never leaves this process).
    const expectations = await step("BLOCK_TEMPLATE_QA", timings, "expectations", () => templateShortRenderExpectations(compiled, project));
    const expectationsPath = `${attemptDir}/render-expectations.json`;
    await writeJsonExclusive(abs(deps, expectationsPath), expectations);
    attempt.renderExpectations = { path: expectationsPath, sha256: await deps.fileSha256(abs(deps, expectationsPath)), bands: expectations.bands.length };
    // M8: design brief over the template beats; M9: compose and self-check.
    const texts = await step("BLOCK_TEMPLATE_BEATS", timings, "beatTexts", () => templateBeatTexts(selection.family, copy, beats));
    const request = await step("BLOCK_COMPOSE", timings, "designRequest", () => templateShortDesignRequest({ domain: project.aestheticSystem!.domain,
      styleFamily: project.aestheticSystem!.primaryFamily, topic: accepted.topic, durationFrames: state.window.durationFrames, fps: project.fps, beats, texts,
      templateInput: compiled.instance.input }));
    const design = await step("BLOCK_COMPOSE", timings, "design", () => deps.compileDesign(request, policy));
    const markdown = renderInferenceRouterMarkdown("quality_critical", "quality");
    const composeInputs: TemplateShortComposeInputs = {
      project, source: autopilotPlanSourceFromIdentity(identity),
      route: { ...recommendInferenceRoute("quality_critical", "quality"), taskClass: "quality_critical", priority: "quality" },
      router: { protocol: AUTOPILOT_CONTEXT_PROTOCOL, markdown, markdownRouterSha256: inferenceRouterSha256(markdown) },
      skill, brief: { request, context: design.context, recipes: design.recipes }, identity: deps.designIdentity(design, project), packet: compiled,
      semantics: [{ materialId: material0.materialId, sourceSha256: packet.source.sourceSha256, assetId: project0.assetId, clipId: project0.clipId,
        semanticReceiptSha256: receipt.semanticReceiptSha256 }],
      editorial: deriveEditorial({ family: selection.family, copy, topic: accepted.topic, shortId: state.shortId, assetId: project0.assetId,
        themeName: REFERENCE_MOTION_DESIGN_THEMES[selection.designSystem].name, probe: { hasAudio: packet.source.hasAudio, colorTransfer: packet.source.color?.transfer ?? state.source.colorTransfer },
        speech: speechState(state, packet), beats: texts.map(({ id, summary, application }) => ({ id, summary, application })), useReasons: { ...table.useReasons } }),
      policy, provider: state.provider, ...modelReceipt(state),
    };
    const composed = await step("BLOCK_COMPOSE", timings, "compose", () => composeTemplateShortPlan(composeInputs));
    await writeJsonExclusive(abs(deps, `${attemptDir}/plan.v4.json`), composed.plan); // a sealed plan is never rewritten
    attempt.planSha256 = composed.planSha256; attempt.planBytes = composed.bytes; attempt.commandCount = composed.commandCount; attempt.phase = "composed";
    await saveState(deps, state, "composed");
  } catch (error) {
    return finishBlocked(state, attempt, blockOf(error, "BLOCK_COMPOSE"), deps);
  }
  return executeAttempt(state, attempt, deps);
}
function semanticsInput(state: TemplateShortRunRecord, accepted: AcceptedBrief, packet: MaterialIntelligencePacket, duration: number): MaterialSemanticsInput {
  const time = new Map(packet.keyframes.map(frame => [frame.id, frame.time]));
  const rows = [...accepted.brief.seen].sort((a, b) => time.get(a.kf)! - time.get(b.kf)!);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const cjk = rows.some(row => /\p{Script=Han}/u.test(row.note));
  return {
    materialId: packet.materialId, sourceSha256: packet.source.sourceSha256, overallTopic: accepted.topic, contentType: state.genre,
    language: packet.analysis.transcript.language ?? (cjk ? "zh-Hant" : "und"), people: [], locations: [],
    segments: rows.map((row, index) => ({
      start: index === 0 ? 0 : round((time.get(rows[index - 1].kf)! + time.get(row.kf)!) / 2),
      end: index === rows.length - 1 ? round(duration) : round((time.get(row.kf)! + time.get(rows[index + 1].kf)!) / 2),
      summary: state.mode === "in_app" ? `創作者描述：${row.note}` : row.note,
      subjects: [], actions: [], objects: [], importance: 0.7, evidenceFrameIds: [row.kf], transcriptCueIndexes: [],
    })),
  };
}
function speechState(state: TemplateShortRunRecord, packet: MaterialIntelligencePacket): "present" | "absent" | "unmeasured" {
  if (!packet.source.hasAudio) return "absent";
  if (state.material?.transcript.state !== "ready") return "unmeasured";
  return packet.analysis.transcript.cueCount > 0 ? "present" : "absent";
}
/** Honest model receipt: Codex follows the router's preferred model (the r53 runs); other MCP clients cannot name theirs,
 * and the in-app creator flow runs no model at all. */
function modelReceipt(state: TemplateShortRunRecord): Pick<TemplateShortComposeInputs, "model"> {
  if (state.mode === "in_app") return { model: { modelId: "editkin-template-composer", modelTier: "unknown", reasoningEffort: "none" } };
  if (state.provider === "codex") return {};
  return { model: { modelId: "unreported", modelTier: "unknown", reasoningEffort: "unknown" } };
}

async function finishBlocked(state: TemplateShortRunRecord, attempt: AttemptRecord, block: TemplateShortBlockError, deps: TemplateShortDeps): Promise<TemplateShortResult> {
  const projectUnchanged = state.project ? await deps.fileSha256(abs(deps, state.project.path)).then(sha => sha === state.project!.bootstrapSha256, () => false) : true;
  attempt.status = block.code; attempt.block = { code: block.code, detail: block.detail, ...(block.field ? { field: block.field } : {}), projectUnchanged };
  attempt.finishedAt = deps.now().toISOString(); state.status = block.code;
  await saveState(deps, state);
  return stateResult(state);
}

// ---- M10–M11: the unchanged batch engine, then status, index and current.mp4 ----------------------------------------------
async function executeAttempt(state: TemplateShortRunRecord, attempt: AttemptRecord, deps: TemplateShortDeps): Promise<TemplateShortResult> {
  const runAbsolute = abs(deps, state.runDir), attemptDir = `${state.runDir}/attempt-${attempt.n}`, timings = attempt.timingsMs;
  try { await assertDisk(deps, runAbsolute, state.window.durationFrames, state.window.fps); }
  catch (error) {
    const block = blockOf(error, "BLOCK_DISK");
    attempt.status = block.code; attempt.block = { code: block.code, detail: block.detail, projectUnchanged: attempt.phase !== "executing" };
    state.status = block.code; await saveState(deps, state);
    return stateResult(state);
  }
  const batchPath = `${attemptDir}/batch.json`;
  if (!await exists(abs(deps, batchPath))) {
    await writeJsonExclusive(abs(deps, batchPath), { schema: "editkin.autopilot-batch/v1", batchId: `${state.shortId}-attempt-${attempt.n}`, expectedDeliverableCount: 1,
      items: [{ id: "short", projectPath: state.project!.path, planPath: `${attemptDir}/plan.v4.json`, outputPath: `${state.runDir}/output.mp4` }] });
  }
  attempt.phase = "executing"; state.status = "RUNNING";
  await saveState(deps, state, "executing");
  const verify = { technical: undefined as AttemptRecord["technical"], flags: [] as TemplateShortQaFinding[] };
  const journal = abs(deps, `${batchPath}.state.json`);
  let prepared: Awaited<ReturnType<TemplateShortDeps["prepareBatch"]>>;
  try { prepared = await deps.prepareBatch(batchPath, {
    renderTimeoutMs: templateShortRenderTimeoutMs(state.window.durationFrames, state.window.fps),
    verifyRender: async (_item, candidate, base) => {
      const started = Date.now();
      try {
        const candidateSha256 = await deps.fileSha256(candidate);
        const probeChecks = renderedShortProbeChecks(base.probe, { width: TEMPLATE_SHORT_FORMAT.width, height: TEMPLATE_SHORT_FORMAT.height,
          durationFrames: state.window.durationFrames, fps: state.window.fps });
        // The expectations sealed at compose time, verified against their recorded SHA before the gate trusts them.
        let expectations: TemplateShortRenderExpectations | undefined;
        if (attempt.renderExpectations) {
          const path = abs(deps, attempt.renderExpectations.path);
          if (await deps.fileSha256(path) !== attempt.renderExpectations.sha256) throw new Error("render-expectations.json 與封存時的 SHA 不符；不信任改過的檢查依據");
          expectations = await readTemplateShortRenderExpectations(path);
        }
        const rendered = probeChecks.pass && deps.analyzeRendered ? await deps.analyzeRendered({ candidate, candidateSha256, project: base.project, probe: base.probe,
          durationFrames: state.window.durationFrames, analytic: { flags: attempt.analytic?.flags ?? [] }, ...(expectations ? { expectations } : {}),
          sheetsDir: join(runAbsolute, "qa", "scan") }) : undefined;
        const technical = { pass: probeChecks.pass && (rendered?.technical.pass ?? true), checks: [...probeChecks.checks, ...(rendered?.technical.checks ?? [])], candidateSha256 };
        verify.technical = technical; verify.flags = rendered?.flags ?? [];
        attempt.pixelGate = rendered && expectations ? "applied" : "unmeasured";
        attempt.sheets = (rendered?.sheets ?? []).map(name => `${state.runDir}/qa/scan/${name}`);
        await writeJsonAtomic(join(runAbsolute, "qa", "QA.json"), { schema: TEMPLATE_SHORT_QA_SCHEMA, shortId: state.shortId, attempt: attempt.n, candidateSha256,
          analytic: attempt.analytic, technical, renderedFlags: verify.flags, sheets: attempt.sheets,
          pixelGate: rendered && expectations ? { status: "applied", expectations: attempt.renderExpectations, ...rendered.report }
            : { status: "unmeasured", reason: !deps.analyzeRendered ? "no pixel gate in this runtime" : !expectations ? "no sealed render expectations" : "probe checks failed first" } });
        // Hao 2026-10-09: a technical failure never delivers; an art flag does (NEEDS_FIX).
        if (!technical.pass) throw new Error(`R1 技術檢查失敗：${technical.checks.filter(check => !check.pass).map(check => `${check.id} ${check.detail}`).join("；")}`);
      } finally { timings.qa = (timings.qa ?? 0) + Date.now() - started; }
    },
  }); }
  catch (error) {
    // The batch could not even be loaded: the journal (if any) still decides what happened before.
    attempt.batch = { error: (error instanceof Error ? error.message : String(error)).slice(0, 600) };
    return settle(state, attempt, await readJournalItem(journal), verify, deps);
  }
  const runtime = timed(prepared.runtime, timings);
  const started = Date.now();
  try { await deps.executeBatch(prepared.manifest, prepared.statePath, runtime, { through: "render" }); }
  catch (error) {
    // Engine-level refusals (paths, lock, changed manifest) leave the journal as it was.
    attempt.batch = { error: (error instanceof Error ? error.message : String(error)).slice(0, 600) };
  } finally { timings.execute = (timings.execute ?? 0) + Date.now() - started; }
  const progress = await readAutopilotBatchState(prepared.statePath, prepared.manifest).then(row => row?.items[0], () => readJournalItem(journal));
  return settle(state, attempt, progress, verify, deps);
}
/** The engine's item journal read without its manifest check (diagnosis only; the engine re-verifies on every run). */
async function readJournalItem(path: string): Promise<AutopilotBatchItemState | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")).items?.[0] as AutopilotBatchItemState | undefined; }
  catch { return undefined; }
}
/** Per-step timings without touching what flows between steps (the audit receipt reaches apply by identity). */
function timed(runtime: AutopilotBatchRuntime, timings: Record<string, number>): AutopilotBatchRuntime {
  const wrap = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) => async (...args: A) => {
    const started = Date.now();
    try { return await fn(...args); } finally { timings[name] = (timings[name] ?? 0) + Date.now() - started; }
  };
  return { ...runtime, audit: wrap("audit", runtime.audit.bind(runtime)), apply: wrap("apply", runtime.apply.bind(runtime)),
    render: wrap("render", runtime.render.bind(runtime)) };
}

async function settle(state: TemplateShortRunRecord, attempt: AttemptRecord, progress: AutopilotBatchItemState | undefined,
  verify: { technical: AttemptRecord["technical"]; flags: TemplateShortQaFinding[] }, deps: TemplateShortDeps): Promise<TemplateShortResult> {
  const receiptFile = (progress?.executionReceipt as { receiptFile?: unknown } | undefined)?.receiptFile;
  attempt.batch = { ...attempt.batch, ...(progress ? { phase: progress.phase } : {}), ...(progress?.error ? { error: progress.error.slice(0, 600) } : {}),
    ...(typeof receiptFile === "string" ? { executionReceiptFile: receiptFile } : {}) };
  if (verify.technical) attempt.technical = verify.technical;
  if (verify.flags.length) attempt.renderedFlags = verify.flags;
  if (!progress || progress.phase !== "review_required" || progress.error) {
    const phase = progress?.phase ?? "queued", detail = attempt.batch.error ?? "批次沒有完成";
    const status: TemplateShortState = phase === "queued" ? "BLOCK_AUDIT" : phase === "applying" ? "INTERRUPTED" : "RENDER_FAILED_PROJECT_APPLIED";
    attempt.status = status;
    if (status === "BLOCK_AUDIT") {
      const projectUnchanged = await deps.fileSha256(abs(deps, state.project!.path)).then(sha => sha === state.project!.bootstrapSha256, () => false);
      attempt.block = { code: "BLOCK_AUDIT", detail: detail.slice(0, 600), projectUnchanged };
      attempt.phase = "composed"; // nothing was applied: a corrected make may seal a new attempt
    }
    state.status = status; attempt.finishedAt = deps.now().toISOString();
    await saveState(deps, state);
    return stateResult(state, { detail });
  }
  // Promoted (the engine hard-linked the verified candidate to output.mp4).
  const outputRelative = `${state.runDir}/output.mp4`, outputAbsolute = abs(deps, outputRelative);
  const outputSha256 = progress.outputSha256!, bytes = (await stat(outputAbsolute)).size;
  attempt.output = { path: outputRelative, sha256: outputSha256, bytes, frames: state.window.durationFrames };
  try { attempt.readback = { instanceStatus: (await deps.readback(state.project!.path, attempt.instanceId!)).instanceStatus }; }
  catch (error) { attempt.readback = { instanceStatus: `UNREADABLE: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}` }; }
  const flags = [...(attempt.analytic?.flags ?? []), ...(attempt.renderedFlags ?? [])];
  const index = await readIndex(deps);
  const spotCheck = attempt.statusCeiling === "READY"
    ? drawTemplateShortSpotCheck({ family: attempt.family, designSystem: attempt.designSystem, outputSha256, priorRuns: index })
    : { drawn: false, reason: "not_drawn" as const };
  attempt.spotCheck = spotCheck;
  const verdict = templateShortStatus({ blocks: [], technical: { pass: attempt.technical?.pass ?? true }, flags, statusCeiling: attempt.statusCeiling,
    policyMode: (await deps.readReviewPolicy()).policy.mode, frameObservedNumbers: attempt.frameObservedNumbers ?? false, spotCheckDrawn: spotCheck.drawn });
  // A promoted output already passed the technical gate inside verifyRender; an instance that did not read back CURRENT is a review item.
  const status: TemplateShortState = verdict.status === "READY" && attempt.readback.instanceStatus !== "CURRENT" ? "REVIEW_REQUIRED" : verdict.status;
  attempt.status = status; attempt.fixSeconds = verdict.fixSeconds;
  if (DELIVERED.has(status)) attempt.current = await linkCurrent(state, attempt, outputAbsolute, deps);
  attempt.phase = "done"; attempt.finishedAt = deps.now().toISOString(); state.status = status;
  await appendFile(abs(deps, `${TEMPLATE_SHORT_ROOT}/INDEX.jsonl`), `${JSON.stringify({ shortId: state.shortId, attempt: attempt.n, at: attempt.finishedAt,
    family: attempt.family, designSystem: attempt.designSystem, status, planSha256: attempt.planSha256, executionReceiptFile: attempt.batch.executionReceiptFile,
    outputSha256, source: state.source.path, ...(attempt.va ? { va: { skillSha256: attempt.va.skillSha256, workflowContractSha256: attempt.va.workflowContractSha256,
      revision: attempt.va.workflowContractRevision } } : {}) })}\n`, "utf8");
  await saveState(deps, state, "done");
  return stateResult(state);
}
async function readIndex(deps: Pick<TemplateShortDeps, "root">): Promise<Array<{ family: string; designSystem: string }>> {
  try {
    return (await readFile(abs(deps, `${TEMPLATE_SHORT_ROOT}/INDEX.jsonl`), "utf8")).split("\n").filter(Boolean).flatMap(line => {
      try { const row = JSON.parse(line); return typeof row.family === "string" && typeof row.designSystem === "string" ? [row] : []; } catch { return []; }
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
/** M115 storage rule: one current deliverable per source video, atomically replaced (hard link on the same volume, never a
 * vN/FINAL copy); each version is a metadata line in .autocut-history.jsonl. A failed link never touches the output. */
async function linkCurrent(state: TemplateShortRunRecord, attempt: AttemptRecord, outputAbsolute: string, deps: TemplateShortDeps): Promise<NonNullable<AttemptRecord["current"]>> {
  const job = `${TEMPLATE_SHORT_ROOT}/_videos/${state.source.videoKey}`, current = `${job}/_out/current.mp4`;
  const temporary = abs(deps, `${job}/_out/.current-${randomUUID()}.mp4`);
  try {
    await mkdir(dirname(temporary), { recursive: true });
    try { await link(outputAbsolute, temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; await copyFile(outputAbsolute, temporary); }
    await rename(temporary, abs(deps, current));
    await appendFile(abs(deps, `${job}/.autocut-history.jsonl`), `${JSON.stringify({ at: deps.now().toISOString(), shortId: state.shortId, attempt: attempt.n,
      status: attempt.status, outputSha256: attempt.output!.sha256, planSha256: attempt.planSha256, run: state.runDir })}\n`, "utf8");
    return { path: current, linked: true };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return { path: current, linked: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

// ---- Resume and status --------------------------------------------------------------------------------------------------
/** `make {shortId, resume:true}`: continues the last sealed attempt through the same batch journal. The engine reconciles an
 * interrupted apply from the committed receipt (or re-audits only when the project is provably unchanged) and re-renders a
 * failed render to a new candidate; it never re-applies blindly. */
export async function resumeTemplateShort(shortId: string, deps: TemplateShortDeps, options: TemplateShortMakeOptions): Promise<TemplateShortResult> {
  const jobs = options.jobs ?? templateShortJobs;
  const state = await readState(deps, shortId), attempt = state.attempts.at(-1);
  if (!attempt) throw new TemplateShortBlockError("BLOCK_BRIEF", "還沒有可續跑的 attempt；請呼叫 make_template_short 並附上 brief", "shortId");
  if (attempt.phase === "done") return stateResult(state);
  if (attempt.phase === "brief_accepted" || (attempt.phase === "composed" && attempt.status && attempt.status !== "BLOCK_DISK" && attempt.status !== "RUNNING")) {
    throw new TemplateShortBlockError("BLOCK_BRIEF", "上一個 attempt 在套用前就停止了；修正後以同一 shortId 再呼叫 make_template_short", "shortId");
  }
  const work = async () => {
    const release = await runLock(deps, shortId);
    try {
      const current = await readState(deps, shortId), last = current.attempts.at(-1)!;
      delete last.status; delete last.block; delete last.finishedAt;
      return await executeAttempt(current, last, deps);
    } finally { await release(); }
  };
  if (options.wait) return work();
  const job = jobs.start(shortId, work, () => deps.now());
  return { schema: TEMPLATE_SHORT_RESULT_SCHEMA, status: "RUNNING", shortId, jobId: job.jobId, pollAfterMs: 10_000, next: "get_template_short" };
}

/** Call 3: the live job, or the durable state. With no live job, an attempt left executing reads INTERRUPTED. */
export async function readTemplateShortState(shortId: string, deps: TemplateShortDeps, jobs: TemplateShortJobs = templateShortJobs): Promise<TemplateShortResult> {
  const job = jobs.get(shortId), state = await readState(deps, shortId);
  if (job && !job.finishedAt) return { ...stateResult(state, { status: "RUNNING" }), jobId: job.jobId };
  const attempt = state.attempts.at(-1);
  const unfinished = attempt && !attempt.finishedAt && (attempt.phase === "executing" || (attempt.phase !== "done" && !attempt.status));
  if (attempt && unfinished) {
    // Another process (an in-app child) may hold the run lease: that is RUNNING, not an interruption.
    const release = await deps.lock(statePathOf(deps, shortId)).catch(() => undefined);
    if (!release) return stateResult(state, { status: "RUNNING", detail: "另一個 Editkin 程序正在處理這支短片" });
    await release();
    const before = attempt.phase === "brief_accepted" || attempt.phase === "composed";
    const phase = (await readJournalItem(abs(deps, `${state.runDir}/attempt-${attempt.n}/batch.json.state.json`)))?.phase ?? (before ? "before_execution" : "queued");
    return stateResult(state, { status: "INTERRUPTED", detail: `${job?.error ? `${job.error}；` : ""}上次在 ${phase} 階段中斷；`
      + (attempt.phase === "brief_accepted" ? "計畫尚未封存，請以同一 shortId 再呼叫 make_template_short" : "請以 resume:true 續跑（核對已提交的套用，不會盲目重套）") });
  }
  return job?.error ? stateResult(state, { detail: job.error }) : stateResult(state);
}

// ---- Call 4: record the review (VA learning event; design §8) --------------------------------------------------------------
/** The note is cut by the product's one outcome-note rule (≤1,000 UTF-16 units at a grapheme boundary, with the visible
 * truncation marker; ROADMAP 1.13) before the outcome schema sees it. */
export async function recordTemplateShortReview(input: { shortId: string; accepted: boolean; severeError: boolean; note: string; evidencePath: string },
  deps: TemplateShortDeps): Promise<TemplateShortResult> {
  const state = await readState(deps, input.shortId), attempt = state.attempts.at(-1);
  if (!attempt?.output || !attempt.planSha256 || !DELIVERED.has(String(attempt.status))) {
    throw new TemplateShortBlockError("BLOCK_BRIEF", "還沒有交付的成片可以審查", "shortId");
  }
  const policy = (await deps.readReviewPolicy()).policy;
  if (policy.mode !== "agent_reference_comparison") throw new TemplateShortBlockError("BLOCK_BRIEF", "創作者政策是人工審片：請由創作者在 Editkin 內記錄，agent 不能代簽", "shortId");
  const evidence = input.evidencePath.replace(/\\/g, "/");
  if (!evidence.startsWith(`${state.runDir}/review/`) || evidence.split("/").some(part => part === ".." || part === ".")) {
    throw new TemplateShortBlockError("BLOCK_BRIEF", `審查證據必須是 ${state.runDir}/review/ 裡的檔案`, "evidencePath");
  }
  const evidenceAbsolute = abs(deps, evidence);
  const info = await stat(evidenceAbsolute).catch(() => undefined);
  if (!info?.isFile() || info.size === 0 || info.size > 256 * 1024) throw new TemplateShortBlockError("BLOCK_BRIEF", "審查證據檔不存在、是空的或超過 256 KB", "evidencePath");
  const evidenceSha256 = await deps.fileSha256(evidenceAbsolute);
  const outcome = autopilotOutcomeSchema.parse({ schema: "hao.video-autopilot.learning-event/v1", planSha256: attempt.planSha256, checkpoint: "agent_review",
    platform: "archive", artifactId: attempt.output.sha256, selectedMemoryRuleIds: [], metrics: {},
    review: { accepted: input.accepted, severeError: input.severeError, note: truncateAutopilotOutcomeNote(input.note), reviewer: "agent", evidenceSha256 } });
  const attribution = await deps.readExecutionAttribution(state.project!.path, attempt.planSha256);
  const eventFile = await deps.writeLearningEvent(state.project!.path, { ...outcome, attribution });
  state.review = { eventFile, accepted: input.accepted, severeError: input.severeError, recordedAt: deps.now().toISOString(), evidenceSha256 };
  await saveState(deps, state);
  return stateResult(state);
}

/** The VA final-step shape of a delivered run (outcomeDraft); the review part is added by record_template_short_review
 * after an actual look at the output, never by the mechanical checks. */
export function templateShortOutcomeDraft(result: { receipts?: { planSha256?: string }; output?: { sha256?: string } }) {
  if (!result.receipts?.planSha256 || !result.output?.sha256) return undefined;
  return { schema: "hao.video-autopilot.learning-event/v1" as const, planSha256: result.receipts.planSha256, checkpoint: "agent_review" as const,
    platform: "archive" as const, artifactId: result.output.sha256, selectedMemoryRuleIds: [] as string[], metrics: {}, review: "pending: record_template_short_review" };
}
