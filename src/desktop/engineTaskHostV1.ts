import { canonicalJson } from "../shared/canonicalJson";
import { engineTaskRequestSchemaV1, type EngineTaskProgressV1, type EngineTaskReplyV1, type EngineTaskRequestV1,
  type AutoReframeEngineTaskProgressV1, type AutoReframeEngineTaskReplyV1, type AutoReframeEngineTaskRequestV1,
  type DesktopBatchEngineTaskProgressV1, type DesktopBatchEngineTaskReplyV1, MOTION_LIBRARY_RENDER_STAGES_V1,
  type MotionLibraryRenderEngineTaskProgressV1, type MotionLibraryRenderEngineTaskReplyV1, type MotionLibraryRenderInputV1 } from "../application/engineTaskContractV1";
import { desktopBatchInputSchemaV1, type DesktopBatchInputV1 } from "../application/desktopBatchTaskContractV1";

export interface EngineTaskOptionsV1 { signal?: AbortSignal; onProgress?(progress: AutoReframeEngineTaskProgressV1): void; }
export interface DesktopBatchTaskOptionsV1 { signal?: AbortSignal; onProgress?(progress: DesktopBatchEngineTaskProgressV1): void; }
export interface MotionLibraryRenderTaskOptionsV1 { signal?: AbortSignal; onProgress?(progress: MotionLibraryRenderEngineTaskProgressV1): void; }
export interface EngineTaskApiV1 {
  runEngineTaskV1(request: AutoReframeEngineTaskRequestV1, options?: EngineTaskOptionsV1): Promise<AutoReframeEngineTaskReplyV1>;
  runDesktopBatchTaskV1(input: DesktopBatchInputV1, options?: DesktopBatchTaskOptionsV1): Promise<DesktopBatchEngineTaskReplyV1>;
  /** Motion Library render before dispatch (needs the native kind; see PHASE3_GUI_RESULT.md). */
  runMotionLibraryRenderTaskV1(input: MotionLibraryRenderInputV1, options?: MotionLibraryRenderTaskOptionsV1): Promise<MotionLibraryRenderEngineTaskReplyV1>;
  cancelEngineTaskV1(operationId: string): Promise<{ jobId: string; known: boolean; cancelRequested: boolean }>;
  cancelDesktopBatchTaskV1(input: DesktopBatchInputV1): Promise<{ jobId: string; known: boolean; cancelRequested: boolean }>;
}
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
/** Main-window native commands allocate paths. The renderer supplies only the typed project request. */
export function createEngineTaskHostV1(invoke: Invoke, channel: (receive: (event: unknown) => void) => unknown): EngineTaskApiV1 {
  const cancelEngineTaskV1: EngineTaskApiV1["cancelEngineTaskV1"] = operationId => invoke("cancel_engine_task_v1", { operationId });
  const cancelDesktopBatchTaskV1: EngineTaskApiV1["cancelDesktopBatchTaskV1"] = input => {
    const request = desktopBatchInputSchemaV1.parse(input);
    return invoke("cancel_engine_task_v1", { operationId: request.operationId, sessionId: request.sessionId, jobId: request.jobId });
  };
  const run = async (input: EngineTaskRequestV1, options: { signal?: AbortSignal; onProgress?(progress: EngineTaskProgressV1): void } = {}): Promise<EngineTaskReplyV1> => {
    options.signal?.throwIfAborted();
    const request = structuredClone(engineTaskRequestSchemaV1.parse(input)), operationId = request.input.operationId;
    let registered = false, finished = false, cancelSent = false, eventError: Error | undefined;
    const cancel = () => {
      if (!registered || finished || cancelSent) return;
      cancelSent = true;
      // An abort remains authoritative even if the transport could not acknowledge its stop.
      void (request.kind === "desktop_batch_item_v1" ? cancelDesktopBatchTaskV1(request.input) : cancelEngineTaskV1(operationId)).catch(() => undefined);
    };
    const aborted = () => { if (options.signal?.aborted) cancel(); };
    const onEvent = channel(raw => {
      if (finished) return;
      const event = raw as Partial<EngineTaskProgressV1> & { stage?: string };
      if (!event || event.operationId !== operationId || event.kind !== request.kind) return;
      if (event.schema === ("editkin.engine-task-host/v1" as string) && event.stage === "registered") {
        registered = true; aborted(); return;
      }
      const p = event.progress;
      const stages: readonly string[] = request.kind === "auto_reframe_v1" ? ["verify", "matte", "source", "finalize"]
        : request.kind === "motion_library_render_v1" ? MOTION_LIBRARY_RENDER_STAGES_V1 : ["queued", "executing", "prepare", "analyze", "apply", "render", "completed", "failed"];
      if (event.schema !== "editkin.engine-task-progress/v1" || !p || !stages.includes(p.stage)
        || !Number.isSafeInteger(p.completed) || !Number.isSafeInteger(p.total) || p.total <= 0 || p.completed < 0 || p.completed > p.total) return;
      if (request.kind === "desktop_batch_item_v1" && (event.kind !== "desktop_batch_item_v1" || !event.progress
        || !("sessionId" in event.progress) || event.progress.sessionId !== request.input.sessionId || event.progress.jobId !== request.input.jobId || p.total !== 1)) return;
      registered = true; aborted();
      if (!options.signal?.aborted && !eventError) {
        try { void Promise.resolve(options.onProgress?.(event as EngineTaskProgressV1)).catch(error => { eventError = error instanceof Error ? error : Error(String(error)); cancel(); }); }
        catch (error) { eventError = error instanceof Error ? error : Error(String(error)); cancel(); }
      }
    });
    options.signal?.addEventListener("abort", aborted, { once: true });
    try {
      options.signal?.throwIfAborted();
      const reply = await invoke<EngineTaskReplyV1>("run_engine_task_v1", { request, onEvent });
      options.signal?.throwIfAborted();
      if (eventError) throw eventError;
      if (reply?.schema !== "editkin.engine-task-reply/v1" || reply.kind !== request.kind || reply.operationId !== operationId
        || canonicalJson(reply.result?.request) !== canonicalJson(request.input)) throw Error("ENGINE_TASK_REPLY_BINDING_CHANGED");
      if (request.kind === "auto_reframe_v1" && reply.result?.schema !== "editkin.auto-reframe-reply/v1") throw Error("ENGINE_TASK_REPLY_BINDING_CHANGED");
      if (request.kind === "motion_library_render_v1" && (reply.result?.schema !== "editkin.motion-library-render-reply/v1"
        || (reply.result as { itemId?: unknown }).itemId !== request.input.itemId)) throw Error("ENGINE_TASK_REPLY_BINDING_CHANGED");
      if (request.kind === "desktop_batch_item_v1") {
        if (reply.kind !== "desktop_batch_item_v1" || reply.result?.schema !== "editkin.desktop-batch-result/v1"
          || !reply.result.result || reply.result.result.jobId !== request.input.jobId || !["completed", "failed"].includes(reply.result.result.status)
          || reply.result.session?.id !== request.input.sessionId || !Array.isArray(reply.result.session.jobs)) throw Error("ENGINE_TASK_REPLY_BINDING_CHANGED");
        const item = reply.result.session.jobs.filter(job => job.id === request.input.jobId);
        if (item.length !== 1 || item[0].status !== reply.result.result.status) throw Error("ENGINE_TASK_REPLY_BINDING_CHANGED");
      }
      return reply;
    } finally {
      finished = true; options.signal?.removeEventListener("abort", aborted);
    }
  };
  return { cancelEngineTaskV1, cancelDesktopBatchTaskV1,
    runEngineTaskV1: (input, options = {}) => run(input, { signal: options.signal, onProgress: p => p.kind === "auto_reframe_v1" ? options.onProgress?.(p) : undefined }) as Promise<AutoReframeEngineTaskReplyV1>,
    runDesktopBatchTaskV1: (input, options = {}) => run({ schema: "editkin.engine-task/v1", kind: "desktop_batch_item_v1", input },
      { signal: options.signal, onProgress: p => p.kind === "desktop_batch_item_v1" ? options.onProgress?.(p) : undefined }) as Promise<DesktopBatchEngineTaskReplyV1>,
    runMotionLibraryRenderTaskV1: (input, options = {}) => run({ schema: "editkin.engine-task/v1", kind: "motion_library_render_v1", input },
      { signal: options.signal, onProgress: p => p.kind === "motion_library_render_v1" ? options.onProgress?.(p) : undefined }) as Promise<MotionLibraryRenderEngineTaskReplyV1>,
  };
}
