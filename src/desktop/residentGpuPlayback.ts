import type { GpuPreviewApi, NativeGpuPlaybackEvent } from "./gpuPreviewApiTypes";
import type { GpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import { validateResidentEngineVideoFrame } from "./residentGpuEngineVideoPresenter";

export interface ResidentPlaybackTicket { key: string; alive: boolean; terminal?: boolean; generation?: number; api?: GpuPreviewApi; sessionId?: string; preview?: GpuEngineVideoPreviewGraph }
export interface PausedNativeFrame { frame: number; time: number }
export interface ResidentPlaybackCallbacks {
  onActive: (active: boolean) => void;
  onClock: (time: number) => void;
  onEnded: (event: NativeGpuPlaybackEvent) => void;
  onError: (reason: string) => void;
}

/** One owner, one replaceable transport intent, no frame timer or render queue
 * in JavaScript. The native channel keeps one unacknowledged event. */
export class ResidentGpuPlayback {
  private ticket?: ResidentPlaybackTicket;

  matches(key: string): boolean { return this.ticket?.key === key && this.ticket.alive; }
  canPause(): boolean { return Boolean(this.ticket?.alive && !this.ticket.terminal); }
  private current(ticket: ResidentPlaybackTicket): boolean { return this.ticket === ticket && ticket.alive; }
  reserve(key: string): ResidentPlaybackTicket {
    this.invalidate();
    return this.ticket = { key, alive: true };
  }
  invalidate(): void {
    const old = this.ticket;
    this.ticket = undefined;
    if (!old) return;
    old.alive = false;
    if (old.generation !== undefined) void old.api?.stopGpuPreviewPlayback?.(old.generation).catch(() => undefined);
  }

  /** Freeze the native cursor before reading it. A 10 Hz UI cursor may lag the
   * actual frame; pausing must not seek the GPU back to that stale UI value. */
  async pause(): Promise<PausedNativeFrame | undefined> {
    const old = this.ticket;
    this.ticket = undefined;
    if (!old) return undefined;
    old.alive = false;
    if (old.generation === undefined || !old.api || !old.preview) return undefined;
    await old.api.stopGpuPreviewPlayback!(old.generation);
    const snapshot = await old.api.inspectGpuPreviewPlayback!(old.generation, true);
    const receipt = snapshot.frameReceipt;
    if (snapshot.generation !== old.generation || snapshot.sessionId !== old.sessionId || snapshot.state === "playing"
      || !receipt || receipt.sessionId !== old.sessionId || receipt.timelineFrame !== snapshot.timelineFrame) throw new Error("暫停影格身分不一致");
    validateResidentEngineVideoFrame({ ...old.preview, timelineFrame: receipt.timelineFrame }, { receipt, endOfStream: receipt.endOfStream === true });
    return { frame: receipt.timelineFrame, time: receipt.timelineFrame * old.preview.graph.timebase.numerator / old.preview.graph.timebase.denominator };
  }

  async start(ticket: ResidentPlaybackTicket, api: GpuPreviewApi, sessionId: string,
    range: { startFrame: number; endFrame: number; audioGeneration?: number; audioOwnerId?:number },
    preview: GpuEngineVideoPreviewGraph, callbacks: ResidentPlaybackCallbacks): Promise<void> {
    if (!this.current(ticket)) return;
    if (!api.startGpuPreviewPlayback || !api.stopGpuPreviewPlayback || !api.inspectGpuPreviewPlayback) throw new Error("原生播放控制介面不完整");
    ticket.api = api;
    ticket.sessionId = sessionId;
    ticket.preview = preview;
    let lastDiagnosticFrame = -Infinity;
    let lastClockFrame = -1;
    let terminal = false;
    const fail = (error: unknown) => {
      if (!this.current(ticket)) return;
      this.invalidate();
      callbacks.onActive(false);
      callbacks.onError(error instanceof Error ? error.message : String(error));
    };
    try {
      const started = await api.startGpuPreviewPlayback(sessionId, range, async event => {
        if (!this.current(ticket) || terminal) return;
        try {
          if (event.state === "failed") throw new Error(event.reason || "原生播放失敗");
          if (event.state !== "playing") {
            terminal = true;
            ticket.terminal = true;
            callbacks.onActive(false);
            if (event.state === "ended") callbacks.onEnded(event);
            else throw new Error(event.reason || "原生播放意外停止");
            return;
          }
          if (event.timelineFrame < lastClockFrame) throw new Error("原生播放進度倒退");
          const framesPerSecond = preview.graph.timebase.denominator / preview.graph.timebase.numerator;
          if (event.presentedFrames > 0 && event.timelineFrame - lastDiagnosticFrame >= framesPerSecond) {
            const diagnostic = await api.inspectGpuPreviewPlayback!(event.generation, true);
            if (!this.current(ticket)) return;
            const receipt = diagnostic.frameReceipt;
            if (diagnostic.generation !== event.generation || diagnostic.sessionId !== sessionId
              || !receipt || receipt.sessionId !== sessionId || receipt.timelineFrame !== diagnostic.timelineFrame
              || diagnostic.timelineFrame < event.timelineFrame) throw new Error("原生播放診斷影格身分不一致");
            validateResidentEngineVideoFrame({ ...preview, timelineFrame: receipt.timelineFrame },
              { receipt, endOfStream: receipt.endOfStream === true });
            lastDiagnosticFrame = receipt.timelineFrame;
          }
          if (!this.current(ticket)) return;
          lastClockFrame = event.timelineFrame;
          callbacks.onClock(event.timelineSeconds);
        } catch (error) { fail(error); }
      });
      ticket.generation = started.generation;
      if (!this.current(ticket)) { await api.stopGpuPreviewPlayback(started.generation); return; }
      if (started.state === "failed") throw new Error(started.reason || "原生播放啟動失敗");
      if (!terminal && started.state === "playing") callbacks.onActive(true);
    } catch (error) { fail(error); }
  }
}
