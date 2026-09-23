import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { GpuPreviewApi, GpuPreviewOwner, NativeGpuPlaybackEvent } from "./gpuPreviewApiTypes";

export function validNativeGpuPlaybackEvent(event: NativeGpuPlaybackEvent, owner: string | undefined, session: string): boolean {
  return Boolean(owner) && event?.schema === "editkin.native-preview-playback/v1"
    && event.owner === owner && event.sessionId === session
    && Number.isSafeInteger(event.generation) && event.generation > 0
    && [event.timelineFrame, event.presentedFrames, event.droppedFrames, event.sequence].every(value => Number.isSafeInteger(value) && value >= 0)
    && Number.isFinite(event.timelineSeconds) && event.timelineSeconds >= 0
    && ["playing", "stopped", "superseded", "ended", "failed"].includes(event.state)
    && ["native-audio", "native-monotonic"].includes(event.clock)
    && (event.reason == null || typeof event.reason === "string" && event.reason.length <= 2048);
}

export function createTauriGpuPreviewApi(previewOwner?: string): GpuPreviewApi {
  const request = <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => invoke(command, { ...args, previewOwner });
  return {
    startGpuPreviewPlayback: async (sessionId, range, onEvent) => {
      if (!previewOwner) throw new Error("原生播放需要有效的預覽持有者");
      let generation: number | undefined;
      let buffered: NativeGpuPlaybackEvent | undefined;
      let startupError: unknown;
      let lastSequence = 0;
      const consume = async (event: NativeGpuPlaybackEvent) => {
        if (!validNativeGpuPlaybackEvent(event, previewOwner, sessionId)) throw new Error("原生播放事件不合法");
        if (generation === undefined) { buffered = event; return; }
        if (event.generation !== generation || event.sequence <= lastSequence) return;
        lastSequence = event.sequence;
        try { await onEvent?.(event); }
        catch (error) { await request("stop_gpu_preview_playback", { generation }); throw error; }
        finally { await request("acknowledge_gpu_preview_playback", { generation, sequence: event.sequence }); }
      };
      const channel = onEvent ? new Channel<NativeGpuPlaybackEvent>() : undefined;
      if (channel) channel.onmessage = event => { void consume(event).catch(error => {
        if (generation === undefined) startupError = error;
        if (generation !== undefined) void request("stop_gpu_preview_playback", { generation }).catch(() => undefined);
        console.warn("Editkin native playback event failed", error);
      }); };
      const result = await request<NativeGpuPlaybackEvent>("start_gpu_preview_playback", { sessionId, ...range, onEvent: channel });
      if (!validNativeGpuPlaybackEvent(result, previewOwner, sessionId)) {
        if (Number.isSafeInteger(result?.generation) && result.generation > 0) await request("stop_gpu_preview_playback", { generation: result.generation });
        throw new Error("原生播放啟動回應不合法");
      }
      generation = result.generation;
      if (startupError) { await request("stop_gpu_preview_playback", { generation }); throw startupError; }
      if (buffered) await consume(buffered);
      return result;
    },
    stopGpuPreviewPlayback: generation => request("stop_gpu_preview_playback", { generation }),
    inspectGpuPreviewPlayback: (generation, diagnostic = false) => request("inspect_gpu_preview_playback", { generation, diagnostic }),
    loadGpuPreviewSession: (sessionId, graph) => request("load_gpu_preview_session", { sessionId, graph }),
    loadGpuEnginePreviewSession: (sessionId, graph, assetBindings, timelineFrame) => request("load_gpu_engine_preview_session", { sessionId, graph, assetBindings, timelineFrame }),
    updateGpuEnginePreviewFrame: (sessionId, timelineFrame) => request("update_gpu_engine_preview_frame", { sessionId, timelineFrame }),
    loadGpuEngineVideoPreviewSession: (sessionId, graph, assetBindings, timelineFrame) => request("load_gpu_engine_video_preview_session", { sessionId, graph, assetBindings, timelineFrame }),
    presentGpuEngineVideoPreviewFrame: (sessionId, timelineFrame, toleranceSeconds) => request("present_gpu_engine_video_preview_frame", { sessionId, timelineFrame, toleranceSeconds }),
    releaseGpuEngineVideoPreviewSession: (sessionId) => request("release_gpu_engine_video_preview_session", { sessionId }),
    updateGpuPreviewProperties: (sessionId, params) => request("update_gpu_preview_properties", { sessionId, params }),
    renderGpuPreviewFrame: async (sessionId) => {
      const result = await request<import("./types").GpuCompositionResult>("render_gpu_preview_frame", { sessionId });
      const hash = typeof result.receipt === "object" && result.receipt && "outputHash" in result.receipt ? String(result.receipt.outputHash) : String(Date.now());
      return { ...result, outputUrl: `${convertFileSrc(result.outputPath)}?v=${encodeURIComponent(hash)}` };
    },
    releaseGpuPreviewSession: (sessionId) => request("release_gpu_preview_session", { sessionId }),
    openGpuVideoPreviewSession: (sessionId, inputPath) => request("open_gpu_video_preview_session", { sessionId, inputPath }),
    decodeGpuVideoPreviewFrame: async (sessionId) => {
      const result = await request<import("./types").GpuVideoPreviewFrame>("decode_gpu_video_preview_frame", { sessionId });
      const hash = result.receipt.frame?.outputHash ?? String(Date.now());
      return result.outputPath
        ? { ...result, outputUrl: `${convertFileSrc(result.outputPath)}?v=${encodeURIComponent(hash)}` }
        : result;
    },
    decodeGpuVideoPreviewAtTime: async (sessionId, timeSeconds, toleranceSeconds) => {
      const result = await request<import("./types").GpuVideoPreviewFrame>("decode_gpu_video_preview_at_time", { sessionId, timeSeconds, toleranceSeconds });
      const hash = result.receipt.frame?.outputHash ?? String(Date.now());
      return result.outputPath
        ? { ...result, outputUrl: `${convertFileSrc(result.outputPath)}?v=${encodeURIComponent(hash)}` }
        : result;
    },
    stageGpuVideoPreviewAtTime: (sessionId, timeSeconds, toleranceSeconds) => request("stage_gpu_video_preview_at_time", { sessionId, timeSeconds, toleranceSeconds }),
    bindGpuPreviewSurface: ({ x, y, width, height, surfaceColorSpace }) => request("bind_gpu_preview_surface", { x, y, width, height, surfaceColorSpace }),
    presentGpuVideoPreviewAtTime: (sessionId, timeSeconds, toleranceSeconds) => request("present_gpu_video_preview_at_time", { sessionId, timeSeconds, toleranceSeconds }),
    hideGpuPreviewSurface: () => request("hide_gpu_preview_surface"),
    releaseGpuPreviewSurface: () => request("release_gpu_preview_surface"),
    seekGpuVideoPreviewSession: (sessionId, timeSeconds) => request("seek_gpu_video_preview_session", { sessionId, timeSeconds }),
    releaseGpuVideoPreviewSession: (sessionId) => request("release_gpu_video_preview_session", { sessionId }),
    recoverGpuDevice: () => request("recover_gpu_device"),
  };
}

async function releaseOwner(previewOwner: string): Promise<void> {
  const result = await invoke<{ released: boolean; superseded: boolean }>("end_gpu_preview_owner", { previewOwner });
  if (typeof result?.released !== "boolean" || typeof result?.superseded !== "boolean" || result.released === result.superseded) {
    throw new Error("GPU preview cleanup receipt invalid; cleanup unconfirmed");
  }
}

export async function createTauriGpuPreviewOwner(): Promise<GpuPreviewOwner> {
  const owner = await invoke<{ schema: string; token: string; sessions: GpuPreviewOwner["sessions"] }>("begin_gpu_preview_owner");
  const tokenValid = typeof owner?.token === "string" && /^gpu-owner-[1-9][0-9]{0,9}-[1-9][0-9]{0,19}$/.test(owner.token);
  if (owner?.schema !== "editkin.gpu-preview-owner/v1" || !tokenValid
    || owner.sessions?.image !== owner.token + "-image" || owner.sessions?.video !== owner.token + "-video"
    || owner.sessions?.engineVideo !== owner.token + "-engine-video") {
    // A malformed session receipt can still have created a native owner. End
    // that exact bounded token; a delayed end cannot affect its successor.
    if (tokenValid) await releaseOwner(owner.token);
    throw new Error("GPU preview owner receipt invalid");
  }
  return { sessions: owner.sessions, desktop: createTauriGpuPreviewApi(owner.token),
    release: () => releaseOwner(owner.token) };
}
