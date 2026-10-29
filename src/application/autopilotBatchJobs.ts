import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { withBatchExecutionOwnerV1 } from "./batchExecutionOwnerV1";
import {
  executeAutopilotBatch, snapshotAutopilotBatchManifest, type AutopilotBatchManifest, type AutopilotBatchRuntime,
  type AutopilotBatchExecutionOptions, type AutopilotBatchProgress,
} from "./autopilotBatchExecution";
import type { AttachedJob, AttachedJobOutcome, JobProgress, JobTracker } from "./jobRegistry";

export type AutopilotBatchJobStatus = "RUNNING" | "CANCEL_REQUESTED" | "STOPPED" | "PARTIAL" | "REVIEW_REQUIRED" | "FAILED";

interface Job {
  jobId: string;
  statePath: string;
  status: AutopilotBatchJobStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: Awaited<ReturnType<typeof executeAutopilotBatch>>;
  progress?: AutopilotBatchProgress;
  done?: Promise<void>;
  stopRequested: boolean;
  renderAbort: AbortController;
  /** The same job in the shared job registry (`job` tool), when the MCP process attached one; never required. */
  tracked?: Promise<AttachedJob | undefined>;
}

/** The shared registry's view of batch progress: the awaited stage, the active item and finished items. */
export function batchJobProgress(progress: AutopilotBatchProgress): JobProgress {
  const finished = progress.completed + progress.failed, active = progress.items.findIndex(item => item.id === progress.activeItemId);
  return { stage: progress.stage, ...(progress.expected > 0 ? { fraction: Math.min(1, finished / progress.expected) } : {}),
    ...(active >= 0 ? { part: active + 1, parts: progress.items.length } : {}) };
}
export function batchJobOutcome(job: { status: AutopilotBatchJobStatus; error?: string; result?: { status: string; completed: number; expected: number } }): AttachedJobOutcome {
  if (job.status === "STOPPED") return { state: "cancelled" };
  if (job.status === "FAILED" || !job.result) return { state: "failed", error: { code: "BATCH_FAILED", message: (job.error ?? "批次工作失敗").slice(0, 400) } };
  return { state: "succeeded", result: { status: job.result.status, completed: job.result.completed, expected: job.result.expected, next: "get_autopilot_batch_job" } };
}

/** MCP-process-local execution ownership. The batch journal, not this registry, is the restart authority. */
export class AutopilotBatchJobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly activePaths = new Map<string, string>();
  private readonly maxConcurrentJobs: number;
  private readonly maxRetainedJobs: number;
  private readonly ownerRoot?: string | (() => string);
  private readonly tracker?: JobTracker;

  constructor(options: { maxConcurrentJobs?: number; maxRetainedJobs?: number; ownerRoot?: string | (() => string); tracker?: JobTracker } = {}) {
    this.ownerRoot = options.ownerRoot;
    this.tracker = options.tracker;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 4;
    this.maxRetainedJobs = options.maxRetainedJobs ?? 128;
    if (!Number.isInteger(this.maxConcurrentJobs) || this.maxConcurrentJobs < 1 || this.maxConcurrentJobs > 4
      || !Number.isInteger(this.maxRetainedJobs) || this.maxRetainedJobs < 0 || this.maxRetainedJobs > 128) {
      throw new Error("自動剪輯資源上限須為 1–4 個執行中工作、0–128 個已結束工作");
    }
  }

  start(manifest: AutopilotBatchManifest, statePath: string, runtime: AutopilotBatchRuntime,
    options: Omit<AutopilotBatchExecutionOptions, "shouldStop"> = {}) {
    manifest = snapshotAutopilotBatchManifest(manifest);
    options = { ...options };
    if (options.itemId && !manifest.items.some(item => item.id === options.itemId)) throw new Error("未知批次項目");
    const resolvedStatePath = resolve(statePath);
    const canonicalStatePath = process.platform === "win32" ? resolvedStatePath.toLowerCase() : resolvedStatePath;
    if (this.activePaths.has(canonicalStatePath)) throw new Error("此批次已有進行中的工作；請查詢原工作狀態");
    if (this.activePaths.size >= this.maxConcurrentJobs) throw new Error("進行中的自動剪輯批次已達上限，請稍後再試");
    const job: Job = {
      jobId: randomUUID(), statePath: resolvedStatePath, status: "RUNNING",
      startedAt: new Date().toISOString(), stopRequested: false, renderAbort: new AbortController(),
    };
    this.jobs.set(job.jobId, job);
    this.activePaths.set(canonicalStatePath, job.jobId);
    // W2-5: mirrored as kind `batch`; best effort, it never changes admission, the journal or this job's tools.
    job.tracked = this.tracker?.attach({ kind: "batch", ownerJobId: job.jobId, cancel: () => this.cancel(job.jobId),
      label: { batch: basename(resolvedStatePath).slice(0, 128), ...(options.itemId ? { itemId: options.itemId.slice(0, 128) } : {}) } }).catch(() => undefined);
    // Defer all batch work until the initiating MCP call can return. Failures are
    // retained as job status, never left as unhandled background rejections.
    job.done = Promise.resolve().then(async () => {
      try {
        const execute = () => executeAutopilotBatch(manifest, resolvedStatePath, runtime, {
          ...options, shouldStop: () => job.stopRequested,
          signal: options.signal ? AbortSignal.any([job.renderAbort.signal, options.signal]) : job.renderAbort.signal,
          onProgress: progress => { job.progress = structuredClone(progress);
            void job.tracked?.then(tracked => tracked?.progress(batchJobProgress(progress))); return options.onProgress?.(progress); },
        });
        const ownerRoot = typeof this.ownerRoot === "function" ? this.ownerRoot() : this.ownerRoot;
        job.result = ownerRoot ? await withBatchExecutionOwnerV1(ownerRoot, resolvedStatePath, execute) : await execute();
        job.status = job.result.stopped ? "STOPPED" : job.result.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "PARTIAL";
      } catch (error) {
        job.error = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
        job.status = "FAILED";
      } finally {
        job.finishedAt = new Date().toISOString();
        this.activePaths.delete(canonicalStatePath);
        this.prune();
      }
      try { await (await job.tracked)?.finish(batchJobOutcome(job)); } catch { /* The registry mirror never changes the job. */ }
    });
    return this.snapshot(job);
  }

  /** Synchronous-return callers share the exact same admission/ownership as async job callers. */
  async run(manifest: AutopilotBatchManifest, statePath: string, runtime: AutopilotBatchRuntime,
    options: Omit<AutopilotBatchExecutionOptions, "shouldStop"> = {}) {
    const started = this.start(manifest, statePath, runtime, options);
    const job = this.jobs.get(started.jobId)!;
    await job.done;
    if (!job.result) throw new Error(job.error ?? "自動剪輯工作未產生結果");
    return structuredClone(job.result);
  }

  get(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("找不到此 MCP 行程的工作；重啟後請用 get_autopilot_batch_status 讀取可續跑的批次紀錄");
    return this.snapshot(job);
  }

  /**
   * Resolves with the job's snapshot once it is terminal (STOPPED, REVIEW_REQUIRED, PARTIAL or FAILED), or with the
   * current snapshot after timeoutMs. CANCEL_REQUESTED lasts until the in-flight apply/receipt or render transaction has
   * finished; every journal write is fsynced and every item takes OS project locks, so on a busy disk that can take
   * seconds. Waiting on the job itself, not a fixed poll budget, is what tells a caller the cancel has landed.
   */
  async wait(jobId: string, timeoutMs = 0) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("找不到此 MCP 行程的工作；請用 get_autopilot_batch_status 檢查持久紀錄");
    if (!job.finishedAt && timeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job.done, new Promise<void>(done => { timer = setTimeout(done, timeoutMs); })]).finally(() => clearTimeout(timer));
    }
    return this.snapshot(job);
  }

  cancel(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("找不到此 MCP 行程的工作；請用 get_autopilot_batch_status 檢查持久紀錄");
    if (job.finishedAt) return this.snapshot(job);
    job.stopRequested = true;
    job.renderAbort.abort(new Error("AUTOPILOT_BATCH_CANCELLED"));
    job.status = "CANCEL_REQUESTED";
    void job.tracked?.then(tracked => tracked?.cancelRequested());
    return this.snapshot(job);
  }

  /** No hidden pending queue: admission rejects work above the chosen resource ceiling. */
  getResourceUsage() {
    return {
      activeJobs: this.activePaths.size, queuedJobs: 0,
      retainedFinishedJobs: this.jobs.size - this.activePaths.size, totalJobs: this.jobs.size,
      retainedProgressItems: [...this.jobs.values()].reduce((sum, job) => sum + (job.progress?.items.length ?? 0), 0),
      retainedResultItems: [...this.jobs.values()].reduce((sum, job) => sum + (job.result?.items.length ?? 0), 0),
      maxConcurrentJobs: this.maxConcurrentJobs, maxRetainedJobs: this.maxRetainedJobs,
    };
  }

  private snapshot(job: Job) {
    return {
      jobId: job.jobId, statePath: job.statePath, status: job.status,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      ...(job.error ? { error: job.error } : {}),
      ...(job.progress ? { progress: structuredClone(job.progress) } : {}),
      ...(job.result ? { result: structuredClone(job.result) } : {}),
    };
  }

  private prune() {
    const finished = [...this.jobs.values()].filter(job => job.finishedAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - this.maxRetainedJobs))) this.jobs.delete(job.jobId);
  }
}
