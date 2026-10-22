import * as z from "zod/v4";
import { autoReframeRequestSchemaV1, type AutoReframeProgressV1, type AutoReframeReplyV1 } from "./autoReframeEditV1";
import { desktopBatchInputSchemaV1, desktopBatchHostInputSchemaV1, type DesktopBatchProgressV1, type DesktopBatchTaskResultV1 } from "./desktopBatchTaskContractV1";
import type { MediaAsset } from "../domain/types";

/** Renderer request: no executable, source/output path, job-file path, or runtime override. */
const autoReframeRequest = z.strictObject({ schema: z.literal("editkin.engine-task/v1"),
  kind: z.literal("auto_reframe_v1"), project: z.unknown(), input: autoReframeRequestSchemaV1 });
const desktopBatchRequest = z.strictObject({ schema: z.literal("editkin.engine-task/v1"),
  kind: z.literal("desktop_batch_item_v1"), input: desktopBatchInputSchemaV1 });
/** Motion Library GUI render-before-dispatch (PHASE3_GUI): the renderer names an item, its params and the project frame; never a path. */
export const motionLibraryRenderInputSchemaV1 = z.strictObject({ operationId: z.string().regex(/^[a-z0-9-]{8,64}$/),
  itemId: z.string().regex(/^[TXB](?:0[1-9]|[1-7][0-9]|80)$/), params: z.record(z.string(), z.unknown()),
  width: z.number().int().min(16).max(7680), height: z.number().int().min(16).max(7680), fps: z.number().finite().gt(0).max(240) });
export type MotionLibraryRenderInputV1 = z.infer<typeof motionLibraryRenderInputSchemaV1>;
const motionLibraryRenderRequest = z.strictObject({ schema: z.literal("editkin.engine-task/v1"),
  kind: z.literal("motion_library_render_v1"), input: motionLibraryRenderInputSchemaV1 });
export type MotionLibraryRenderEngineTaskRequestV1 = z.infer<typeof motionLibraryRenderRequest>;
/** The native host chooses the cache root (the project's media cache); the renderer cannot. */
const motionLibraryHostInput = z.strictObject({ cacheRoot: z.string().min(1).max(32768) });
export const engineTaskRequestSchemaV1 = z.discriminatedUnion("kind", [autoReframeRequest, desktopBatchRequest, motionLibraryRenderRequest]);
export type EngineTaskRequestV1 = z.infer<typeof engineTaskRequestSchemaV1>;
export type AutoReframeEngineTaskRequestV1 = z.infer<typeof autoReframeRequest>;
/** Only the native host adds these files after allocating a fresh owned job directory. */
const jobFiles = z.strictObject({ progressPath: z.string().min(1).max(32768), cancelPath: z.string().min(1).max(32768) });
export const engineTaskServiceRequestSchemaV1 = z.discriminatedUnion("kind", [autoReframeRequest.extend({ job: jobFiles.optional() }),
  desktopBatchRequest.extend({ job: jobFiles, hostInput: desktopBatchHostInputSchemaV1 }),
  motionLibraryRenderRequest.extend({ job: jobFiles.optional(), hostInput: motionLibraryHostInput.optional() })]);
export interface AutoReframeEngineTaskReplyV1 {
  schema: "editkin.engine-task-reply/v1"; kind: "auto_reframe_v1"; operationId: string; result: AutoReframeReplyV1;
}
export interface AutoReframeEngineTaskProgressV1 {
  schema: "editkin.engine-task-progress/v1"; kind: "auto_reframe_v1"; operationId: string; progress: AutoReframeProgressV1;
}
export interface DesktopBatchEngineTaskReplyV1 {
  schema: "editkin.engine-task-reply/v1"; kind: "desktop_batch_item_v1"; operationId: string; result: DesktopBatchTaskResultV1;
}
export interface DesktopBatchEngineTaskProgressV1 {
  schema: "editkin.engine-task-progress/v1"; kind: "desktop_batch_item_v1"; operationId: string; progress: DesktopBatchProgressV1;
}
export const MOTION_LIBRARY_RENDER_STAGES_V1 = Object.freeze(["cache", "generate", "encode", "verify", "done"] as const);
export interface MotionLibraryRenderResultV1 {
  schema: "editkin.motion-library-render-reply/v1"; request: MotionLibraryRenderInputV1;
  itemId: string; kind: "text" | "transition" | "background"; itemRevision: number; engineVersion: string; cacheKey: string; cacheHit: boolean;
  /** The fully resolved params (the field stores exactly these). */
  params: Record<string, unknown>; width: number; height: number; fps: string; frameCount: number; durationSeconds: number;
  /** Project asset records of the rendered cache files (the clip, or the matte and optional overlay). */
  assets: { clip?: MediaAsset; matte?: MediaAsset; overlay?: MediaAsset };
}
export interface MotionLibraryRenderEngineTaskReplyV1 {
  schema: "editkin.engine-task-reply/v1"; kind: "motion_library_render_v1"; operationId: string; result: MotionLibraryRenderResultV1;
}
export interface MotionLibraryRenderEngineTaskProgressV1 {
  schema: "editkin.engine-task-progress/v1"; kind: "motion_library_render_v1"; operationId: string;
  progress: { stage: typeof MOTION_LIBRARY_RENDER_STAGES_V1[number]; completed: number; total: number };
}
export type EngineTaskReplyV1 = AutoReframeEngineTaskReplyV1 | DesktopBatchEngineTaskReplyV1 | MotionLibraryRenderEngineTaskReplyV1;
export type EngineTaskProgressV1 = AutoReframeEngineTaskProgressV1 | DesktopBatchEngineTaskProgressV1 | MotionLibraryRenderEngineTaskProgressV1;
