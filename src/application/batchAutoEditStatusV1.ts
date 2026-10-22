import { lstat, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ProjectFileIdentityV1 } from "../domain/projectFileIdentityV1";
import type { EditProject } from "../domain/types";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { batchArtifactPaths, type BatchAutoEditRequest } from "./batchAutoEdit";
import { batchFileSha256 } from "./editorialBatchResume";
import { openBatchAutoEditResumeV1, renderBatchAutoEditResumeV1 } from "./batchAutoEditResumeV1";

export interface BatchAutoEditInspectionV1 {
  schema: "editkin.batch-auto-edit-inspection/v1";
  jobId: string; sessionId?: string; sourceName: string;
  status: "queued" | "completed" | "failed"; verifiedCompleted: boolean;
  projectPath?: string; outputPath?: string; receiptPath?: string; project?: EditProject; fileIdentity?: ProjectFileIdentityV1;
  warnings: string[]; error?: string;
}

/** Read-only entry inspection. The existing execution/origin receipts remain the authority. */
export async function inspectBatchAutoEditItemV1(request: BatchAutoEditRequest): Promise<BatchAutoEditInspectionV1> {
  const base = { schema: "editkin.batch-auto-edit-inspection/v1" as const, jobId: request.jobId,
    sessionId: request.sessionId, sourceName: basename(request.sourcePath), verifiedCompleted: false };
  try {
    const paths = batchArtifactPaths(request);
    const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    for (const path of [request.sourcePath, request.outputRoot]) {
      assertLocalMediaPath(path);
      if (!same(await realpath(path), resolve(path))) throw new Error("BATCH_STATUS_LINK_REFUSED");
    }
    const source = await lstat(request.sourcePath);
    if (!source.isFile() || source.isSymbolicLink()) throw new Error("BATCH_STATUS_SOURCE_NOT_REGULAR");
    const sourceSha256 = await batchFileSha256(request.sourcePath);
    const context = await openBatchAutoEditResumeV1(request, paths, sourceSha256, {}, async () => {
      throw new Error("BATCH_STATUS_NEEDS_RECONCILE: 請續跑核對已提交工作；狀態查詢不寫入收據");
    });
    if (context.execution.phase === "queued") return { ...base, status: "queued", warnings: context.warnings };
    if (!context.project) throw new Error("BATCH_STATUS_COMMIT_NOT_VERIFIED");
    const committed = { ...base, projectPath: paths.projectPath, receiptPath: paths.receiptPath,
      project: context.project, fileIdentity: context.fileIdentity, warnings: context.warnings };
    if (context.execution.phase !== "completed") return { ...committed, status: "failed", error: "批次尚未完成，可續跑已提交的剪輯" };
    // Completed-mode verification reads the canonical project/output hashes. These ports must never run here.
    await renderBatchAutoEditResumeV1(context, async () => { throw new Error("BATCH_STATUS_RENDER_FORBIDDEN"); }, undefined, async () => {
      if (await batchFileSha256(request.sourcePath) !== sourceSha256) throw new Error("BATCH_STATUS_SOURCE_CHANGED");
    });
    if (await batchFileSha256(request.sourcePath) !== sourceSha256) throw new Error("BATCH_STATUS_SOURCE_CHANGED");
    return { ...committed, status: "completed", verifiedCompleted: true, outputPath: paths.outputPath };
  } catch (error) {
    return { ...base, status: "failed", warnings: [], error: error instanceof Error ? error.message : String(error) };
  }
}
