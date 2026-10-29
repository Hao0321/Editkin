import * as z from "zod/v4";
import { inspectBatchAutoEditItemV1 } from "../application/batchAutoEditStatusV1";
import type { BatchAutoEditSession } from "../desktop/mediaTypes";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const optionalPath = z.string().nullable().optional();
const sessionSchema = z.strictObject({ schemaVersion: z.literal(1), id,
  editorialProfile: z.enum(["auto", "gaming", "food", "travel", "podcast_on_camera", "podcast_no_face"]),
  outputRoot: z.string().min(1).max(32768), createdAt: z.string(), updatedAt: z.string(),
  jobs: z.array(z.strictObject({ id, sourcePath: z.string().min(1).max(32768), sourceName: z.string(),
    status: z.enum(["queued", "running", "completed", "failed"]), projectPath: optionalPath, outputPath: optionalPath,
    receiptPath: optionalPath, warnings: z.array(z.string()), error: z.string().nullable().optional() })).min(1),
}).superRefine((session, context) => {
  const seen = new Set<string>();
  for (const job of session.jobs) {
    if (seen.has(job.id)) context.addIssue({ code: "custom", message: "BATCH_SESSION_DUPLICATE_JOB" });
    seen.add(job.id);
  }
});

/** Native supplies its persisted picker identity; progress paths and completion claims grant no authority. */
export async function inspectDesktopBatchSessionV1(input: unknown): Promise<{ session: BatchAutoEditSession }> {
  const session = sessionSchema.parse(input);
  const jobs: BatchAutoEditSession["jobs"] = [];
  for (const job of session.jobs) {
    const checked = await inspectBatchAutoEditItemV1({ sessionId: session.id, jobId: job.id, sourcePath: job.sourcePath,
      outputRoot: session.outputRoot, language: "auto", targetRatio: 0.65, addMusic: true, editorialProfile: session.editorialProfile });
    const unverifiedComplete = job.status === "completed" && !checked.verifiedCompleted;
    const priorFailure = job.status === "failed" && checked.status === "queued";
    jobs.push({ id: job.id, sourcePath: job.sourcePath, sourceName: job.sourceName,
      status: unverifiedComplete || priorFailure ? "failed" : checked.status,
      projectPath: checked.projectPath, outputPath: checked.outputPath, receiptPath: checked.receiptPath,
      warnings: checked.warnings, error: checked.error ?? (unverifiedComplete ? "完成紀錄缺可核對的收據；保留原檔，請個別重試或人工檢查" : priorFailure ? job.error ?? "上次批次未完成，可重試" : undefined) });
  }
  return { session: { schemaVersion: session.schemaVersion, id: session.id, editorialProfile: session.editorialProfile,
    outputRoot: session.outputRoot, createdAt: session.createdAt, updatedAt: session.updatedAt, jobs } };
}
