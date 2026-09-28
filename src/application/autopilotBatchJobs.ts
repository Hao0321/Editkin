import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  executeAutopilotBatch, type AutopilotBatchManifest, type AutopilotBatchRuntime,
} from "./autopilotBatchExecution";

export type AutopilotBatchJobStatus = "RUNNING" | "CANCEL_REQUESTED" | "STOPPED" | "PARTIAL" | "REVIEW_REQUIRED" | "FAILED";

interface Job {
  jobId: string;
  statePath: string;
  status: AutopilotBatchJobStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: Awaited<ReturnType<typeof executeAutopilotBatch>>;
  stopRequested: boolean;
}

/** MCP-process-local execution ownership. The batch journal, not this registry, is the restart authority. */
export class AutopilotBatchJobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly activePaths = new Map<string, string>();

  start(manifest: AutopilotBatchManifest, statePath: string, runtime: AutopilotBatchRuntime,
    options: { itemId?: string; through?: "apply" | "render" } = {}) {
    const resolvedStatePath = resolve(statePath);
    const canonicalStatePath = process.platform === "win32" ? resolvedStatePath.toLowerCase() : resolvedStatePath;
    if (this.activePaths.has(canonicalStatePath)) throw new Error("此批次已有進行中的工作；請查詢原工作狀態");
    if (this.activePaths.size >= 4) throw new Error("進行中的自動剪輯批次已達上限，請稍後再試");
    const job: Job = {
      jobId: randomUUID(), statePath: resolvedStatePath, status: "RUNNING",
      startedAt: new Date().toISOString(), stopRequested: false,
    };
    this.jobs.set(job.jobId, job);
    this.activePaths.set(canonicalStatePath, job.jobId);
    // Defer all batch work until the initiating MCP call can return. Failures are
    // retained as job status, never left as unhandled background rejections.
    void Promise.resolve().then(async () => {
      try {
        job.result = await executeAutopilotBatch(manifest, resolvedStatePath, runtime, {
          ...options, shouldStop: () => job.stopRequested,
        });
        job.status = job.result.stopped ? "STOPPED" : job.result.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "PARTIAL";
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = "FAILED";
      } finally {
        job.finishedAt = new Date().toISOString();
        this.activePaths.delete(canonicalStatePath);
        this.prune();
      }
    });
    return this.snapshot(job);
  }

  get(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("找不到此 MCP 行程的工作；重啟後請用 get_autopilot_batch_status 讀取可續跑的批次紀錄");
    return this.snapshot(job);
  }

  cancel(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("找不到此 MCP 行程的工作；請用 get_autopilot_batch_status 檢查持久紀錄");
    if (job.finishedAt) return this.snapshot(job);
    job.stopRequested = true;
    job.status = "CANCEL_REQUESTED";
    return this.snapshot(job);
  }

  private snapshot(job: Job) {
    return {
      jobId: job.jobId, statePath: job.statePath, status: job.status,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      ...(job.error ? { error: job.error } : {}),
      ...(job.result ? { result: job.result } : {}),
    };
  }

  private prune() {
    const finished = [...this.jobs.values()].filter(job => job.finishedAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - 128))) this.jobs.delete(job.jobId);
  }
}
