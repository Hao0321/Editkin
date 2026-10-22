import * as z from "zod/v4";
import type { BatchAutoEditResult } from "./batchAutoEdit";
import type { BatchAutoEditSession } from "../desktop/mediaTypes";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const desktopBatchInputSchemaV1 = z.strictObject({ operationId: z.string().regex(/^[a-z0-9-]{8,64}$/), sessionId: id, jobId: id });
export type DesktopBatchInputV1 = z.infer<typeof desktopBatchInputSchemaV1>;
/** Host-selected source and output fields exist only on the service-side variant, never renderer IPC. */
export const desktopBatchHostInputSchemaV1 = z.strictObject({ jobId: id, sessionId: id.optional(), sourcePath: z.string().min(1).max(32768), outputRoot: z.string().min(1).max(32768),
  language: z.string().min(1).max(80), targetRatio: z.number().min(.01).max(1), addMusic: z.boolean(), editorialProfile: z.string().min(1).max(80) });
export interface DesktopBatchProgressV1 { stage: "queued" | "executing" | "prepare" | "analyze" | "apply" | "render" | "completed" | "failed"; completed: number; total: 1; jobId: string; sessionId: string; }
export interface DesktopBatchTaskResultV1 {
  schema: "editkin.desktop-batch-result/v1"; request: DesktopBatchInputV1; result: BatchAutoEditResult;
  /** Added only by native after persisting the existing batch session. Node never invents this authority. */
  session?: BatchAutoEditSession;
}
