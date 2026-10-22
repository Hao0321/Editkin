import { spawn } from "node:child_process";
import { DEFAULT_RENDER_STALL_MS, renderLifetimeSignal, renderLifetimeStallMs, renderStageTimeout } from "./renderLifetime";

export interface RawVideoSinkV1 {
  /** Resolves only after the consumer has accepted this frame. Retained frames belong to the consumer. */
  onFrame(frame: Uint8Array, index: number, signal: AbortSignal): Promise<void>;
  signal?: AbortSignal;
}

export interface RawVideoProcessReceiptV1 {
  schema: "editkin.raw-video-process/v1";
  frames: number;
  bytes: number;
  frameBytes: number;
  maximumPendingFrames: 1;
  stdoutHighWaterMark: number;
  pid: number;
  closed: true;
}

/** Binary stdout is never decoded as progress text or accumulated as a full movie. */
export async function runRawVideoProcessV1(input: {
  executable: string; args: readonly string[]; timeoutMs: number; stallMs?: number;
  frameBytes: number; expectedFrames: number; sink: RawVideoSinkV1;
  /** Caller-owned storage for exactly one frame; reusable only after this awaited operation returns. */
  oneFrameBuffer?: Buffer;
}): Promise<RawVideoProcessReceiptV1> {
  if (!Number.isSafeInteger(input.frameBytes) || input.frameBytes < 1 || input.frameBytes > 256 * 1024 ** 2
    || !Number.isSafeInteger(input.expectedFrames) || input.expectedFrames < 1
    || !Number.isSafeInteger(input.expectedFrames * input.frameBytes)) throw Error("RAW_VIDEO_BUDGET_INVALID");
  if (input.oneFrameBuffer !== undefined && (!Buffer.isBuffer(input.oneFrameBuffer) || input.expectedFrames !== 1
    || input.oneFrameBuffer.byteLength !== input.frameBytes)) throw Error("RAW_VIDEO_BORROWED_BUFFER_INVALID");
  const timeoutMs = renderStageTimeout(input.timeoutMs), stallMs = input.stallMs ?? renderLifetimeStallMs() ?? DEFAULT_RENDER_STALL_MS;
  if (!Number.isFinite(stallMs) || stallMs <= 0) throw Error("RAW_VIDEO_BUDGET_INVALID");
  const inherited = [input.sink.signal, renderLifetimeSignal()].filter((s): s is AbortSignal => Boolean(s));
  for (const signal of inherited) signal.throwIfAborted();
  let frame = input.oneFrameBuffer ?? Buffer.allocUnsafe(input.frameBytes), filled = 0;
  const controller = new AbortController();
  const child = spawn(input.executable, [...input.args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let failure: unknown, stderr = "", frames = 0, bytes = 0, closed = false, lastActivity = performance.now();
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectFailure!: (reason: unknown) => void;
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
  void failed.catch(() => undefined);
  const stop = (reason: unknown) => {
    if (failure !== undefined) return;
    failure = reason ?? Error("RAW_VIDEO_CANCELLED");
    controller.abort(failure); rejectFailure(failure);
    if (!closed) {
      child.kill();
      killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 5_000);
    }
  };
  const listeners = inherited.map(signal => {
    const listener = () => stop(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
    return { signal, listener };
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-65_536); });
  child.on("error", stop);
  const completion = new Promise<void>((resolve, reject) => {
    child.on("close", (code, signal) => {
      closed = true; clearTimeout(killTimer);
      if (failure !== undefined) reject(failure);
      else if (code !== 0 || signal) { stop(Error(`RAW_VIDEO_PROCESS_FAILED: ${code}/${signal}: ${stderr}`)); reject(failure); }
      else resolve();
    });
  });
  void completion.catch(() => undefined);
  const timer = setTimeout(() => stop(Error("RAW_VIDEO_DEADLINE")), timeoutMs);
  const watchdog = setInterval(() => {
    if (performance.now() - lastActivity >= stallMs) stop(Error("RAW_VIDEO_STALLED"));
  }, Math.max(10, Math.min(2_000, stallMs / 4)));
  try {
    for await (const data of child.stdout) {
      const chunk = data as Buffer;
      let offset = 0;
      while (offset < chunk.length) {
        if (failure !== undefined) throw failure;
        if (frames >= input.expectedFrames) throw Error("RAW_VIDEO_FRAME_OVERRUN");
        const take = Math.min(frame.length - filled, chunk.length - offset);
        chunk.copy(frame, filled, offset, offset + take); filled += take; offset += take; bytes += take;
        lastActivity = performance.now();
        if (filled !== frame.length) continue;
        await Promise.race([Promise.resolve().then(() => input.sink.onFrame(frame, frames, controller.signal)), failed]);
        if (failure !== undefined) throw failure;
        frames++; lastActivity = performance.now(); filled = 0;
        if (frames < input.expectedFrames) frame = Buffer.allocUnsafe(input.frameBytes);
      }
    }
    await completion;
    if (failure !== undefined) throw failure;
    if (filled !== 0 || frames !== input.expectedFrames) throw Error(`RAW_VIDEO_PREMATURE_EOF: ${frames}/${input.expectedFrames}, partial=${filled}`);
    return { schema: "editkin.raw-video-process/v1", frames, bytes, frameBytes: input.frameBytes, maximumPendingFrames: 1,
      stdoutHighWaterMark: child.stdout.readableHighWaterMark, pid: child.pid!, closed: true };
  } catch (error) {
    stop(error);
    // A killed producer must close before its caller can remove the owned workspace or start another job.
    await completion.catch(() => undefined);
    throw failure;
  } finally {
    clearTimeout(timer); clearTimeout(killTimer); clearInterval(watchdog);
    for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
  }
}
