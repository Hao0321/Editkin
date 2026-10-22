import { lstat, readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "../shared/canonicalJson";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { parseProject } from "../application/projectCodec";
import { engineTaskServiceRequestSchemaV1, type EngineTaskProgressV1, type EngineTaskReplyV1 } from "../application/engineTaskContractV1";
import type { AutoReframeTaskRuntimeV1 } from "../application/autoReframeTaskV1";
import { openFileJobControlV1 } from "./renderJobControl";
import { runBatchAutoEditItem, type BatchAutoEditRequest } from "../application/batchAutoEdit";
import type { DesktopBatchProgressV1 } from "../application/desktopBatchTaskContractV1";

export const ENGINE_TASK_KINDS_V1 = Object.freeze(["auto_reframe_v1", "desktop_batch_item_v1", "motion_library_render_v1"] as const);
export const ENGINE_TASK_CANCELLED_V1 = "ENGINE_TASK_CANCELLED";
export interface EngineTaskRuntimeV1 { assetBase?: string; cacheRoot?: string; ffmpeg?: string; ffprobe?: string; modelRoot?: string;
  nativeCore?: string; creativePackRoot?: string; personalMusicRoot?: string; fontRoot?: string; colorRoot?: string; }
export interface EngineTaskControlsV1 {
  signal?: AbortSignal; onProgress?(progress: EngineTaskProgressV1): void;
  resolveReviewedMatte?: AutoReframeTaskRuntimeV1["resolveReviewedMatte"];
  /** Trusted dependency seam; never read from renderer or service payload. */
  runDesktopBatch?: typeof runBatchAutoEditItem;
}
function hostPath(value: string | undefined) {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) throw Error("ENGINE_TASK_HOST_RUNTIME_REQUIRED");
  assertLocalMediaPath(value); return value;
}
async function hostJobFiles(job: { progressPath: string; cancelPath: string } | undefined, cacheRoot: string, operationId: string): Promise<{ progressPath?: string; cancelPath?: string }> {
  if (!job) return {};
  if (!/^[a-z0-9-]{8,64}$/.test(operationId)) throw Error("ENGINE_TASK_JOB_ID_INVALID");
  const directory = join(cacheRoot, "engine-jobs-v1", operationId);
  if (job.progressPath !== join(directory, "progress.json") || job.cancelPath !== join(directory, "cancel.request")) throw Error("ENGINE_TASK_JOB_PATH_INVALID");
  const s = await lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(directory) !== directory) throw Error("ENGINE_TASK_JOB_LINK_OR_DIRECTORY_INVALID");
  // Native owns allocation/lifetime. Never overwrite an existing or foreign progress file on CLI admission.
  for (const name of await readdir(directory)) {
    if (name !== "cancel.request" || !(await lstat(join(directory, name))).isFile()) throw Error("ENGINE_TASK_JOB_NOT_FRESH");
  }
  return job;
}
async function assertNotCancelled(path: string | undefined, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (path && await lstat(path).catch(e => { if (e.code === "ENOENT") return undefined; throw e; })) throw Error(ENGINE_TASK_CANCELLED_V1);
}
/** The single H10 registry. Registered kinds delegate to existing package adapters; no project/history store. */
export async function dispatchEngineTaskV1(payload: unknown, requestedRuntime: EngineTaskRuntimeV1, controls: EngineTaskControlsV1 = {}): Promise<EngineTaskReplyV1> {
  controls.signal?.throwIfAborted(); const before = canonicalJson(payload);
  if (Buffer.byteLength(before, "utf8") > 16 * 1024 ** 2) throw Error("ENGINE_TASK_REQUEST_BUDGET");
  const request = engineTaskServiceRequestSchemaV1.parse(payload);
  const hostRuntime = { ...requestedRuntime };
  const runtime = Object.freeze({ assetBase: hostPath(requestedRuntime.assetBase), cacheRoot: hostPath(requestedRuntime.cacheRoot),
    ffmpegPath: hostPath(requestedRuntime.ffmpeg), ffprobePath: hostPath(requestedRuntime.ffprobe) });
  const files = await hostJobFiles(request.job, runtime.cacheRoot, request.input.operationId);
  await assertNotCancelled(files.cancelPath, controls.signal);
  const job = openFileJobControlV1<EngineTaskProgressV1>(files, { cancelMessage: ENGINE_TASK_CANCELLED_V1 });
  const signals = [controls.signal, job.signal].filter((s): s is AbortSignal => !!s), signal = signals.length ? AbortSignal.any(signals) : undefined;
  try {
    signal?.throwIfAborted();
    if (request.kind === "motion_library_render_v1") {
      // Render before dispatch (PHASE3_GUI): the host picks the cache root; the reply carries the asset records the GUI dispatches.
      const input = request.input, cacheRoot = request.hostInput ? hostPath(request.hostInput.cacheRoot) : runtime.cacheRoot;
      const { renderMotionLibraryForProjectV1, motionLibraryAssetRecordV1 } = await import("../application/motionLibraryClipsV1");
      let lastStage = "", lastAt = 0;
      const rendered = await renderMotionLibraryForProjectV1({ project: { width: input.width, height: input.height, fps: input.fps }, cacheRoot,
        itemId: input.itemId, params: input.params, signal, ffmpegPath: runtime.ffmpegPath, ffprobePath: runtime.ffprobePath,
        onProgress: progress => {
          const now = Date.now(), total = Math.max(1, Math.round(progress.total)), completed = Math.max(0, Math.min(total, Math.round(progress.completed)));
          if (progress.phase === lastStage && completed < total && now - lastAt < 100) return;
          lastStage = progress.phase; lastAt = now;
          const event: EngineTaskProgressV1 = { schema: "editkin.engine-task-progress/v1", kind: request.kind, operationId: input.operationId,
            progress: { stage: progress.phase, completed, total } };
          controls.onProgress?.(event); job.sink?.(event);
        } });
      await assertNotCancelled(files.cancelPath, signal);
      if (canonicalJson(payload) !== before) throw Error("ENGINE_TASK_REQUEST_CHANGED");
      const { item, result } = rendered;
      const roles = item.kind === "transition" ? ["matte" as const, ...(result.outputs.overlay ? ["overlay" as const] : [])] : ["clip" as const];
      const assets = Object.fromEntries(roles.map(role => [role, motionLibraryAssetRecordV1(rendered, role)]));
      return { schema: "editkin.engine-task-reply/v1", kind: request.kind, operationId: input.operationId, result: {
        schema: "editkin.motion-library-render-reply/v1", request: input, itemId: result.itemId, kind: result.kind, itemRevision: result.itemRevision,
        engineVersion: result.engineVersion, cacheKey: result.cacheKey, cacheHit: result.cacheHit, params: structuredClone(result.params) as Record<string, unknown>,
        width: result.width, height: result.height, fps: result.fps, frameCount: result.frameCount, durationSeconds: result.durationSeconds, assets } };
    }
    if (request.kind === "desktop_batch_item_v1") {
      const phaseCancel = new AbortController();
      const batchSignal = signal ? AbortSignal.any([signal, phaseCancel.signal]) : phaseCancel.signal;
      const refreshCancel = () => { if (files.cancelPath && existsSync(files.cancelPath)) phaseCancel.abort(new Error(ENGINE_TASK_CANCELLED_V1)); };
      if (request.hostInput.jobId !== request.input.jobId) throw Error("ENGINE_TASK_BATCH_JOB_BINDING_CHANGED");
      if (request.hostInput.sessionId !== undefined && request.hostInput.sessionId !== request.input.sessionId) throw Error("ENGINE_TASK_BATCH_SESSION_BINDING_CHANGED");
      const emit = (stage: DesktopBatchProgressV1["stage"], completed: number) => {
        const event: EngineTaskProgressV1 = { schema: "editkin.engine-task-progress/v1", kind: request.kind, operationId: request.input.operationId,
          progress: { stage, completed, total: 1, sessionId: request.input.sessionId, jobId: request.input.jobId } };
        try { void Promise.resolve(controls.onProgress?.(structuredClone(event))).catch(error => phaseCancel.abort(error instanceof Error ? error : Error(String(error)))); }
        catch (error) { phaseCancel.abort(error instanceof Error ? error : Error(String(error))); }
        job.sink?.(event); refreshCancel();
      };
      emit("queued", 0); batchSignal.throwIfAborted();
      emit("executing", 0); batchSignal.throwIfAborted();
      const result = await (controls.runDesktopBatch ?? runBatchAutoEditItem)({ ...request.hostInput, sessionId: request.input.sessionId,
        editorialProfile: request.hostInput.editorialProfile as BatchAutoEditRequest["editorialProfile"] }, {
        ffmpegPath: runtime.ffmpegPath, ffprobePath: runtime.ffprobePath, cacheRoot: runtime.cacheRoot,
        modelRoot: hostPath(hostRuntime.modelRoot), nativeCorePath: hostRuntime.nativeCore, signal: batchSignal,
        onProgress: progress => emit(progress.stage, progress.completed),
        creativePackRoot: hostRuntime.creativePackRoot, personalMusicRoot: hostRuntime.personalMusicRoot, fontRoot: hostRuntime.fontRoot, colorRoot: hostRuntime.colorRoot,
      });
      if (result.jobId !== request.input.jobId || canonicalJson(payload) !== before) throw Error("ENGINE_TASK_REPLY_BINDING_CHANGED");
      emit(result.status, result.status === "completed" ? 1 : 0);
      return { schema: "editkin.engine-task-reply/v1", kind: request.kind, operationId: request.input.operationId,
        result: { schema: "editkin.desktop-batch-result/v1", request: request.input, result } };
    }
    const project = parseProject(request.project);
    const { analyzeAutoReframeTaskV1 } = await import("../application/autoReframeTaskV1");
    const result = await analyzeAutoReframeTaskV1(project, request.input, { ...runtime, signal, resolveReviewedMatte: controls.resolveReviewedMatte,
      onProgress: progress => {
        const event: EngineTaskProgressV1 = { schema: "editkin.engine-task-progress/v1", kind: request.kind, operationId: request.input.operationId, progress };
        controls.onProgress?.(event); job.sink?.(event);
      } });
    await assertNotCancelled(files.cancelPath, signal);
    if (canonicalJson(payload) !== before) throw Error("ENGINE_TASK_REQUEST_CHANGED");
    if (result.schema !== "editkin.auto-reframe-reply/v1" || canonicalJson(result.request) !== canonicalJson(request.input)) throw Error("ENGINE_TASK_REPLY_BINDING_CHANGED");
    return { schema: "editkin.engine-task-reply/v1", kind: request.kind, operationId: request.input.operationId, result };
  } finally { await job.dispose(); }
}
