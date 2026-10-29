import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { readBoundedFile } from "../shared/boundedFile";
import { openFileJobControlV1, RENDER_CANCEL_FILE } from "../service/renderJobControl";

/**
 * One registry for Editkin's long operations (W2-4; AREA_C §4.1 "every long operation is a job").
 *
 * Render is the first producer; material preparation and batch join later by submitting their own `kind` with a
 * `run` function, a result builder and an error classifier. Nothing here knows what a render is.
 *
 * Each job is one folder under the registry root:
 * - `job.json`: the owner process's latest state, replaced atomically. The owner is the only writer.
 * - `cancel.request`: written by any other process that asks the job to stop. The owner watches it with the same
 *   file control the desktop export host uses (openFileJobControlV1), so a restarted MCP server can stop a render
 *   the previous server process is still running.
 *
 * Any process can read a job, so a restarted MCP server reports a job that finished in the previous one. A job whose
 * owner process is gone reads as `failed` with error code INTERRUPTED. That is derived on every read and never
 * written, so it can never contradict an owner that is in fact still alive and later finishes.
 */
export const JOB_STATES = ["queued", "running", "cancelling", "succeeded", "failed", "cancelled"] as const;
export type JobStateName = typeof JOB_STATES[number];
export const JOB_TERMINAL_STATES: ReadonlySet<JobStateName> = new Set(["succeeded", "failed", "cancelled"]);

/**
 * The state machine. A running job is stopped through `cancelling` (the work must first release its processes and
 * temporary files); `cancelling` may still end `succeeded` when the work had already finished, or `failed` when it
 * broke while stopping. Terminal states never change.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStateName, readonly JobStateName[]>> = Object.freeze({
  queued: ["running", "cancelled", "failed"],
  running: ["cancelling", "succeeded", "failed"],
  cancelling: ["cancelled", "succeeded", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
});

export function canTransitionJob(from: JobStateName, to: JobStateName): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export const JOB_ID_PATTERN = /^job-[a-f0-9]{24}$/;
export const JOB_KIND_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
export const JOB_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,47}$/;
/** A job's persisted result; callers build compact results, this is the hard cap. */
export const JOB_RESULT_MAX_BYTES = 1_200;
export const JOB_ERROR_MESSAGE_MAX_CHARS = 400;
export const JOB_FILE = "job.json";
const JOB_FILE_MAX_BYTES = 16 * 1024;
const LABEL_MAX_ENTRIES = 4;
const LABEL_VALUE_MAX_CHARS = 512;

export const JOB_CANCELLED_MESSAGE = "工作已停止，沒有留下半成品。";
export const JOB_INTERRUPTED_MESSAGE = "負責這個工作的 Editkin 程序已經停止，工作沒有完成；請重新送出。";

/** A refusal or failure with a stable machine-readable code (OUTPUT_EXISTS, JOB_NOT_FOUND, INTERRUPTED…). */
export class JobError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JobError";
    if (!JOB_ERROR_CODE_PATTERN.test(code)) throw new Error(`Invalid job error code: ${code}`);
  }
}

export class JobTransitionError extends Error {
  constructor(readonly from: JobStateName, readonly to: JobStateName) {
    super(`Job state cannot change from ${from} to ${to}`);
    this.name = "JobTransitionError";
  }
}

const progressSchema = z.object({
  /** The producer's own stage id (render: prepare, frames, audio, encode, verify…). */
  stage: z.string().min(1).max(32),
  /** 0..1 of the current stage, only when it was measured. */
  fraction: z.number().min(0).max(1).optional(),
  /** Remaining seconds of the current stage from its measured speed, only when there is enough evidence. */
  etaSeconds: z.number().int().min(0).max(30 * 24 * 3600).optional(),
  /** Coarse position across the producer's plain steps (render: 1..4). */
  step: z.number().int().min(1).max(64).optional(),
  steps: z.number().int().min(1).max(64).optional(),
  part: z.number().int().min(1).max(100_000).optional(),
  parts: z.number().int().min(1).max(100_000).optional(),
}).strict();
export type JobProgress = z.infer<typeof progressSchema>;

const errorSchema = z.object({ code: z.string().regex(JOB_ERROR_CODE_PATTERN), message: z.string().max(JOB_ERROR_MESSAGE_MAX_CHARS) }).strict();
export type JobFailure = z.infer<typeof errorSchema>;

const recordSchema = z.object({
  schema: z.literal("editkin.job/v1"),
  jobId: z.string().regex(JOB_ID_PATTERN),
  kind: z.string().regex(JOB_KIND_PATTERN),
  state: z.enum(JOB_STATES),
  /** Which workspace (or other owner scope) submitted it; `list` shows only the caller's scope. */
  scope: z.string().max(1024).optional(),
  /** A few short request facts for display (render: projectPath, outputPath). */
  label: z.record(z.string(), z.string().max(LABEL_VALUE_MAX_CHARS)).optional(),
  /** An attached job's id in its own system (material preparation, autopilot batch); their own tools take it. */
  ownerJobId: z.string().min(1).max(128).optional(),
  owner: z.object({ pid: z.number().int().positive(), instance: z.string().uuid() }).strict(),
  createdAt: z.string(),
  updatedAt: z.string(),
  heartbeatAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  cancelRequested: z.boolean().optional(),
  progress: progressSchema.optional(),
  result: z.unknown().optional(),
  error: errorSchema.optional(),
}).strict();
export type JobRecord = z.infer<typeof recordSchema>;

/** What a caller sees of a job: never the owner's process details. */
export interface JobView {
  jobId: string;
  kind: string;
  state: JobStateName;
  label?: Record<string, string>;
  /** For an attached job: its id in its own system (get_material_preparation_job, get_autopilot_batch_job…). */
  ownerJobId?: string;
  progress?: JobProgress;
  cancelRequested?: boolean;
  result?: unknown;
  error?: JobFailure;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedSeconds?: number;
  /** Suggested wait before asking again; absent once the job has ended. */
  pollAfterMs?: number;
}

export interface JobContext {
  jobId: string;
  /** Aborted when the job is cancelled (from this process or through `cancel.request`). */
  signal: AbortSignal;
  /** Latest progress; persisted at most every `progressWriteMs` (the final state always lands). */
  progress(update: JobProgress): void;
}

export interface JobSubmission<T = unknown> {
  kind: string;
  scope?: string;
  label?: Record<string, string>;
  run(context: JobContext): Promise<T>;
  /** Builds the persisted result from the work's value; it is capped to JOB_RESULT_MAX_BYTES either way. */
  result?(value: T): unknown;
  /** Turns a failure into a stable code and a short message. Default: JobError's code, else JOB_FAILED. */
  classifyError?(error: unknown): JobFailure;
}

export interface JobRegistryOptions {
  now?: () => number;
  /** Is the process that owns a job still running? Default: a signal-0 probe of its pid. */
  isProcessAlive?: (pid: number) => boolean;
  /** How often a running job's owner refreshes `heartbeatAt`. */
  heartbeatMs?: number;
  /** A job whose heartbeat is older than this reads as interrupted even if its pid looks alive (pid reuse). */
  staleAfterMs?: number;
  progressWriteMs?: number;
  cancelPollMs?: number;
  /** Jobs of one kind that run at the same time; later ones wait as `queued` (default 1). */
  concurrency?: Readonly<Record<string, number>>;
  /** Finished jobs kept on disk, newest first; older job folders are removed when the registry first submits. */
  retain?: number;
}

/**
 * A job another job system runs and owns (W2-5: material preparation, autopilot batch). The registry only mirrors it so
 * `job` can list, read and stop every long operation; the owner keeps its ids, tools, persistence and resume rules.
 */
export interface JobAttachment {
  kind: string;
  scope?: string;
  label?: Record<string, string>;
  /** The owner's own job id (its legacy tools take it). */
  ownerJobId: string;
  /** Stops the job through the owner's own mechanism, in the owner's process. */
  cancel(): unknown;
}
export type AttachedJobOutcome =
  | { state: "succeeded"; result?: unknown }
  | { state: "failed"; error: JobFailure }
  | { state: "cancelled"; error?: JobFailure };
export interface AttachedJob {
  readonly jobId: string;
  progress(update: JobProgress): void;
  /** The owner began stopping the job through its own tool. */
  cancelRequested(): void;
  /** The owner's job ended; later calls are ignored. */
  finish(outcome: AttachedJobOutcome): Promise<void>;
}
/** Where an owner job system mirrors its jobs (the MCP process passes the shared registry with its workspace scope). */
export interface JobTracker { attach(attachment: JobAttachment): Promise<AttachedJob> }

interface LocalJob {
  record: JobRecord;
  /** Exactly one of submission (the registry runs the work) or attachment (another system runs it). */
  submission?: JobSubmission;
  attachment?: JobAttachment;
  abort: AbortController;
  writing: Promise<void>;
  lastProgressWriteAt: number;
  progressTimer?: ReturnType<typeof setTimeout>;
  settled: Promise<JobView>;
  settle(view: JobView): void;
}

function defaultIsProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/**
 * Caps any JSON-able value to `maxBytes`: long strings and arrays are shortened first, then (for an object) the
 * leading fields that still fit are kept under `truncated: true`. Never throws on plain JSON values.
 */
export function capJobPayload(value: unknown, maxBytes = JOB_RESULT_MAX_BYTES): unknown {
  if (value === undefined) return undefined;
  if (byteLength(value) <= maxBytes) return value;
  const shrink = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return item.length > 160 ? `${item.slice(0, 157)}…` : item;
    if (Array.isArray(item)) return depth >= 4 ? `[${item.length} items]` : item.slice(0, 6).map(entry => shrink(entry, depth + 1));
    if (item && typeof item === "object") {
      if (depth >= 4) return "[object]";
      return Object.fromEntries(Object.entries(item).slice(0, 24).map(([key, entry]) => [key, shrink(entry, depth + 1)]));
    }
    return item;
  };
  const shrunk = shrink(value, 0);
  if (byteLength(shrunk) <= maxBytes) return shrunk;
  const kept: Record<string, unknown> = { truncated: true };
  if (shrunk && typeof shrunk === "object" && !Array.isArray(shrunk)) {
    for (const [key, entry] of Object.entries(shrunk)) if (byteLength({ ...kept, [key]: entry }) <= maxBytes) kept[key] = entry;
  }
  return kept;
}

function failureOf(error: unknown): JobFailure {
  const code = error instanceof JobError ? error.code : "JOB_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: message.slice(0, JOB_ERROR_MESSAGE_MAX_CHARS) || code };
}

function safeFailure(failure: JobFailure): JobFailure {
  const code = JOB_ERROR_CODE_PATTERN.test(failure.code) ? failure.code : "JOB_FAILED";
  return { code, message: String(failure.message ?? "").slice(0, JOB_ERROR_MESSAGE_MAX_CHARS) || code };
}

function capLabel(label: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!label) return undefined;
  const entries = Object.entries(label).filter(([, value]) => typeof value === "string").slice(0, LABEL_MAX_ENTRIES)
    .map(([key, value]) => [key.slice(0, 32), value.slice(0, LABEL_VALUE_MAX_CHARS)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function newJobId(): string {
  return `job-${randomBytes(12).toString("hex")}`;
}

export function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) throw new JobError("JOB_ID_INVALID", "jobId 格式不正確");
}

/** An owner's on-disk state, or (for a process that is gone) the derived interrupted view; see the module comment. */
export function reconcileJobRecord(record: JobRecord, input: { now: number; instance?: string; isProcessAlive: (pid: number) => boolean; staleAfterMs: number }): JobRecord {
  if (JOB_TERMINAL_STATES.has(record.state) || record.owner.instance === input.instance) return record;
  const heartbeat = Date.parse(record.heartbeatAt);
  const stale = !Number.isFinite(heartbeat) || input.now - heartbeat > input.staleAfterMs;
  if (input.isProcessAlive(record.owner.pid) && !stale) return record;
  return { ...record, state: "failed", error: { code: "INTERRUPTED", message: JOB_INTERRUPTED_MESSAGE } };
}

export class JobRegistry {
  readonly root: string;
  private readonly instance = randomUUID();
  private readonly jobs = new Map<string, LocalJob>();
  private readonly queue: LocalJob[] = [];
  private readonly running = new Map<string, number>();
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private closed = false;
  private pruned = false;

  constructor(root: string, private readonly options: JobRegistryOptions = {}) {
    this.root = resolve(root);
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
  private jobDirectory(jobId: string): string { assertJobId(jobId); return join(this.root, jobId); }
  private concurrency(kind: string): number { return Math.max(1, Math.floor(this.options.concurrency?.[kind] ?? 1)); }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink()) throw new JobError("JOB_ROOT_INVALID", "工作狀態資料夾不可為連結");
  }

  private transition(local: LocalJob, to: JobStateName): void {
    const from = local.record.state;
    if (!canTransitionJob(from, to)) throw new JobTransitionError(from, to);
    local.record.state = to;
  }

  private persist(local: LocalJob, final = false): Promise<void> {
    const record = local.record;
    record.updatedAt = this.iso();
    const path = join(this.jobDirectory(record.jobId), JOB_FILE);
    const text = `${JSON.stringify(recordSchema.parse(record))}\n`;
    const write = async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, { flag: "wx" });
      try {
        // A reader holding job.json open can make the replace fail for a moment on Windows.
        for (let attempt = 0; ; attempt += 1) {
          try { await rename(temporary, path); break; }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (attempt >= (final ? 40 : 5) || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
            await new Promise(done => setTimeout(done, 25));
          }
        }
      } finally { await rm(temporary, { force: true }); }
    };
    // Progress writes are best effort; this process keeps the authoritative state in memory either way.
    local.writing = local.writing.then(write, write).catch(() => undefined);
    return local.writing;
  }

  private view(record: JobRecord): JobView {
    const started = record.startedAt ? Date.parse(record.startedAt) : undefined;
    const ended = record.finishedAt ? Date.parse(record.finishedAt) : this.now();
    const terminal = JOB_TERMINAL_STATES.has(record.state);
    const pollAfterMs = terminal ? undefined : record.state === "queued" ? 10_000 : record.state === "cancelling" ? 2_000 : 5_000;
    return {
      jobId: record.jobId,
      kind: record.kind,
      state: record.state,
      ...(record.label ? { label: { ...record.label } } : {}),
      ...(record.ownerJobId ? { ownerJobId: record.ownerJobId } : {}),
      ...(record.progress && !terminal ? { progress: { ...record.progress } } : {}),
      ...(record.cancelRequested ? { cancelRequested: true } : {}),
      ...(record.result !== undefined ? { result: structuredClone(record.result) } : {}),
      ...(record.error ? { error: { ...record.error } } : {}),
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(started !== undefined && Number.isFinite(started) ? { elapsedSeconds: Math.max(0, Math.round((ended - started) / 100) / 10) } : {}),
      ...(pollAfterMs ? { pollAfterMs } : {}),
    };
  }

  private async readRecord(jobId: string): Promise<JobRecord> {
    const path = join(this.jobDirectory(jobId), JOB_FILE);
    let bytes: Buffer;
    try { bytes = await readBoundedFile(path, JOB_FILE_MAX_BYTES, { messages: { notRegular: "工作狀態檔不合法", tooLarge: "工作狀態檔不合法" } }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new JobError("JOB_NOT_FOUND", `找不到工作 ${jobId}`);
      throw error;
    }
    const record = recordSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (record.jobId !== jobId) throw new JobError("JOB_RECORD_INVALID", "工作狀態檔與 jobId 不一致");
    return record;
  }

  private reconcile(record: JobRecord): JobRecord {
    return reconcileJobRecord(record, { now: this.now(), instance: this.instance, isProcessAlive: this.isProcessAlive,
      staleAfterMs: this.options.staleAfterMs ?? 30 * 60_000 });
  }

  /** Queues one job and starts it when its kind has a free slot. Resolves once `job.json` exists. */
  async submit<T>(submission: JobSubmission<T>): Promise<JobView> {
    if (this.closed) throw new JobError("JOB_REGISTRY_CLOSED", "工作服務正在停止，沒有開始新的工作");
    if (!JOB_KIND_PATTERN.test(submission.kind)) throw new JobError("JOB_KIND_INVALID", "工作種類不合法");
    await this.ensureRoot();
    if (!this.pruned) { this.pruned = true; await this.prune().catch(() => undefined); }
    const now = this.iso();
    const label = capLabel(submission.label);
    const record: JobRecord = {
      schema: "editkin.job/v1", jobId: newJobId(), kind: submission.kind, state: "queued",
      ...(submission.scope ? { scope: submission.scope.slice(0, 1024) } : {}), ...(label ? { label } : {}),
      owner: { pid: process.pid, instance: this.instance }, createdAt: now, updatedAt: now, heartbeatAt: now,
    };
    await mkdir(this.jobDirectory(record.jobId));
    let settle!: (view: JobView) => void;
    const settled = new Promise<JobView>(done => { settle = done; });
    const local: LocalJob = { record, submission: submission as JobSubmission, abort: new AbortController(), writing: Promise.resolve(),
      lastProgressWriteAt: 0, settled, settle };
    this.jobs.set(record.jobId, local);
    await this.persist(local);
    if (!existsSync(join(this.jobDirectory(record.jobId), JOB_FILE))) {
      this.jobs.delete(record.jobId);
      await rm(this.jobDirectory(record.jobId), { recursive: true, force: true });
      throw new JobError("JOB_STATE_UNWRITABLE", "工作狀態無法寫入，沒有開始這個工作");
    }
    this.queue.push(local);
    this.pump();
    return this.view(record);
  }

  private pump(): void {
    for (let index = 0; index < this.queue.length;) {
      const local = this.queue[index];
      const kind = local.record.kind;
      if ((this.running.get(kind) ?? 0) >= this.concurrency(kind)) { index += 1; continue; }
      this.queue.splice(index, 1);
      this.running.set(kind, (this.running.get(kind) ?? 0) + 1);
      void this.execute(local);
    }
  }

  private progress(local: LocalJob, update: JobProgress): void {
    if (local.record.state !== "running") return;
    const parsed = progressSchema.safeParse(update);
    if (!parsed.success) return;
    local.record.progress = parsed.data;
    if (local.progressTimer) return;
    const wait = (this.options.progressWriteMs ?? 500) - (this.now() - local.lastProgressWriteAt);
    const write = () => { local.progressTimer = undefined; local.lastProgressWriteAt = this.now(); void this.persist(local); };
    if (wait <= 0) write();
    else { local.progressTimer = setTimeout(write, wait); local.progressTimer.unref?.(); }
  }

  private requestLocalCancel(local: LocalJob): void {
    if (local.record.state !== "running") return;
    local.record.cancelRequested = true;
    this.transition(local, "cancelling");
    local.abort.abort(new JobError("CANCELLED", JOB_CANCELLED_MESSAGE));
    void this.persist(local);
    // An attached job stops through its owner's own cancel; the owner reports the end with finish().
    const attachment = local.attachment;
    if (attachment) void Promise.resolve().then(() => attachment.cancel()).catch(() => undefined);
  }

  private async finish(local: LocalJob): Promise<void> {
    if (local.progressTimer) { clearTimeout(local.progressTimer); local.progressTimer = undefined; }
    local.record.finishedAt = this.iso();
    await this.persist(local, true);
    local.settle(this.view(local.record));
  }

  private async execute(local: LocalJob): Promise<void> {
    const { record } = local, submission = local.submission!;
    const cancelPath = join(this.jobDirectory(record.jobId), RENDER_CANCEL_FILE);
    if (existsSync(cancelPath)) {
      // Another process asked this queued job to stop before it began.
      record.cancelRequested = true;
      this.transition(local, "cancelled");
      record.error = { code: "CANCELLED", message: JOB_CANCELLED_MESSAGE };
      await this.finish(local);
      this.release(record.kind);
      return;
    }
    this.transition(local, "running");
    record.startedAt = this.iso();
    record.heartbeatAt = record.startedAt;
    void this.persist(local);
    const control = openFileJobControlV1<never>({ cancelPath }, { pollMs: this.options.cancelPollMs ?? 250, cancelMessage: JOB_CANCELLED_MESSAGE });
    const remoteCancel = () => this.requestLocalCancel(local);
    control.signal?.addEventListener("abort", remoteCancel, { once: true });
    const heartbeat = setInterval(() => { record.heartbeatAt = this.iso(); void this.persist(local); }, this.options.heartbeatMs ?? 10_000);
    heartbeat.unref?.();
    try {
      const value = await submission.run({ jobId: record.jobId, signal: local.abort.signal, progress: update => this.progress(local, update) });
      record.result = capJobPayload(submission.result ? submission.result(value) : value);
      this.transition(local, "succeeded");
    } catch (error) {
      delete record.result;
      if (record.cancelRequested && record.state === "cancelling") {
        this.transition(local, "cancelled");
        record.error = { code: "CANCELLED", message: JOB_CANCELLED_MESSAGE };
      } else {
        let failure: JobFailure;
        try { failure = submission.classifyError ? submission.classifyError(error) : failureOf(error); }
        catch { failure = failureOf(error); }
        this.transition(local, "failed");
        record.error = safeFailure(failure);
      }
    } finally {
      clearInterval(heartbeat);
      control.signal?.removeEventListener("abort", remoteCancel);
      await control.dispose();
    }
    await this.finish(local);
    this.release(record.kind);
  }

  /**
   * Registers a job another job system runs (see JobAttachment). It starts `running`; a stop asked here, or through
   * `cancel.request` from another process, reaches the owner's own cancel, and the owner reports progress and the end.
   */
  async attach(attachment: JobAttachment): Promise<AttachedJob> {
    if (this.closed) throw new JobError("JOB_REGISTRY_CLOSED", "工作服務正在停止，沒有登記新的工作");
    if (!JOB_KIND_PATTERN.test(attachment.kind)) throw new JobError("JOB_KIND_INVALID", "工作種類不合法");
    await this.ensureRoot();
    if (!this.pruned) { this.pruned = true; await this.prune().catch(() => undefined); }
    const now = this.iso();
    const label = capLabel(attachment.label);
    const record: JobRecord = {
      schema: "editkin.job/v1", jobId: newJobId(), kind: attachment.kind, state: "queued",
      ...(attachment.scope ? { scope: attachment.scope.slice(0, 1024) } : {}), ...(label ? { label } : {}),
      ownerJobId: attachment.ownerJobId.slice(0, 128), owner: { pid: process.pid, instance: this.instance },
      createdAt: now, updatedAt: now, heartbeatAt: now,
    };
    const directory = this.jobDirectory(record.jobId);
    await mkdir(directory);
    let settle!: (view: JobView) => void;
    const settled = new Promise<JobView>(done => { settle = done; });
    const local: LocalJob = { record, attachment, abort: new AbortController(), writing: Promise.resolve(), lastProgressWriteAt: 0, settled, settle };
    this.jobs.set(record.jobId, local);
    this.transition(local, "running");
    record.startedAt = now;
    await this.persist(local);
    if (!existsSync(join(directory, JOB_FILE))) {
      this.jobs.delete(record.jobId);
      await rm(directory, { recursive: true, force: true });
      throw new JobError("JOB_STATE_UNWRITABLE", "工作狀態無法寫入，沒有登記這個工作");
    }
    const control = openFileJobControlV1<never>({ cancelPath: join(directory, RENDER_CANCEL_FILE) }, { pollMs: this.options.cancelPollMs ?? 250, cancelMessage: JOB_CANCELLED_MESSAGE });
    const remoteCancel = () => this.requestLocalCancel(local);
    control.signal?.addEventListener("abort", remoteCancel, { once: true });
    const heartbeat = setInterval(() => { record.heartbeatAt = this.iso(); void this.persist(local); }, this.options.heartbeatMs ?? 10_000);
    heartbeat.unref?.();
    let finished = false;
    return {
      jobId: record.jobId,
      progress: update => this.progress(local, update),
      cancelRequested: () => {
        if (record.state !== "running") return;
        record.cancelRequested = true;
        this.transition(local, "cancelling");
        void this.persist(local);
      },
      finish: async outcome => {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        control.signal?.removeEventListener("abort", remoteCancel);
        await control.dispose();
        if (outcome.state === "succeeded") {
          record.result = capJobPayload(outcome.result);
          this.transition(local, "succeeded");
        } else if (outcome.state === "cancelled") {
          if (record.state === "running") this.transition(local, "cancelling");
          record.cancelRequested = true;
          this.transition(local, "cancelled");
          record.error = safeFailure(outcome.error ?? { code: "CANCELLED", message: JOB_CANCELLED_MESSAGE });
        } else {
          this.transition(local, "failed");
          record.error = safeFailure(outcome.error);
        }
        await this.finish(local);
      },
    };
  }

  private release(kind: string): void {
    this.running.set(kind, Math.max(0, (this.running.get(kind) ?? 1) - 1));
    if (!this.closed) this.pump();
  }

  /** The job as this process knows it, or as its owner last wrote it (interrupted when that owner is gone). */
  async status(jobId: string): Promise<JobView> {
    assertJobId(jobId);
    const local = this.jobs.get(jobId);
    if (local) return this.view(local.record);
    return this.view(this.reconcile(await this.readRecord(jobId)));
  }

  /**
   * Stops a job: a queued job ends `cancelled` at once; a running job becomes `cancelling` and ends `cancelled` after
   * its work has released everything. A job another live process owns gets `cancel.request`; its owner stops it.
   */
  async cancel(jobId: string): Promise<JobView> {
    assertJobId(jobId);
    const local = this.jobs.get(jobId);
    if (local) {
      if (local.record.state === "queued") {
        const index = this.queue.indexOf(local);
        if (index >= 0) this.queue.splice(index, 1);
        local.record.cancelRequested = true;
        this.transition(local, "cancelled");
        local.record.error = { code: "CANCELLED", message: JOB_CANCELLED_MESSAGE };
        await this.finish(local);
      } else if (local.record.state === "running") {
        // Answer at once: `cancelling` lands on disk in the background, the work stops on its signal.
        this.requestLocalCancel(local);
      }
      return this.view(local.record);
    }
    const record = this.reconcile(await this.readRecord(jobId));
    if (JOB_TERMINAL_STATES.has(record.state)) return this.view(record);
    await writeFile(join(this.jobDirectory(jobId), RENDER_CANCEL_FILE), "cancel\n", { flag: "w" });
    return this.view({ ...record, cancelRequested: true });
  }

  /** Resolves with the final view of a job this process runs (or the current view of any other job). */
  async wait(jobId: string): Promise<JobView> {
    assertJobId(jobId);
    const local = this.jobs.get(jobId);
    return local ? local.settled : this.status(jobId);
  }

  /** Newest first; only jobs of `scope` when one is given. Unreadable job folders are skipped. */
  async list(input: { scope?: string; kind?: string; limit?: number } = {}): Promise<JobView[]> {
    const names = await readdir(this.root).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
      throw error;
    });
    const records: JobRecord[] = [];
    for (const name of names.filter(item => JOB_ID_PATTERN.test(item))) {
      const local = this.jobs.get(name);
      const record = local ? local.record : await this.readRecord(name).then(found => this.reconcile(found), () => undefined);
      if (!record || (input.scope !== undefined && record.scope !== input.scope) || (input.kind && record.kind !== input.kind)) continue;
      records.push(record);
    }
    records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return records.slice(0, Math.max(1, input.limit ?? 10)).map(record => this.view(record));
  }

  /** Removes the oldest finished job folders beyond `retain`; running and queued jobs are never touched. */
  private async prune(): Promise<void> {
    const retain = Math.max(1, this.options.retain ?? 64);
    const names = (await readdir(this.root)).filter(name => JOB_ID_PATTERN.test(name) && !this.jobs.has(name));
    if (names.length <= retain) return;
    const finished: JobRecord[] = [];
    for (const name of names) {
      const record = await this.readRecord(name).then(found => this.reconcile(found), () => undefined);
      if (record && JOB_TERMINAL_STATES.has(record.state)) finished.push(record);
    }
    finished.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const record of finished.slice(retain)) {
      const directory = this.jobDirectory(record.jobId);
      const stats = await lstat(directory).catch(() => undefined);
      if (stats?.isDirectory() && !stats.isSymbolicLink()) await rm(directory, { recursive: true, force: true });
    }
  }

  /** Stops accepting work; with `cancel`, stops queued and running jobs of this process and waits for them. */
  async close(input: { cancel?: boolean } = {}): Promise<void> {
    this.closed = true;
    if (input.cancel) {
      for (const local of [...this.queue]) await this.cancel(local.record.jobId);
      for (const local of this.jobs.values()) if (local.record.state === "running") this.requestLocalCancel(local);
    }
    await Promise.all([...this.jobs.values()].filter(local => !JOB_TERMINAL_STATES.has(local.record.state)).map(local => local.settled));
    await Promise.all([...this.jobs.values()].map(local => local.writing));
  }
}
