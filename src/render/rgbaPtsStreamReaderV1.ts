import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderStageTimeout, renderLifetimeStallMs } from "./renderLifetime";
import type { DecodedPtsIndexV1 } from "./decodedPtsIndexV1";

/** One owned sequential decode window. Pixels go into caller-owned frame slots, never a movie-sized array. */
export async function startRgbaPtsStreamV1(input: {
  ffmpegPath: string; sourcePath: string; index: DecodedPtsIndexV1; width: number; height: number;
  low: number; high: number; timeoutMs: number; signal?: AbortSignal; onTerminal?: (receipt: unknown) => void;
}) {
  assertLocalMediaPath(input.ffmpegPath); assertLocalMediaPath(input.sourcePath); assertRenderActive();
  const frameBytes = input.width * input.height * 4, count = input.high - input.low + 1, expectedBytes = count * frameBytes;
  if (![input.width, input.height, frameBytes, input.low, input.high, count, expectedBytes].every(Number.isSafeInteger)
    || input.width < 1 || input.height < 1 || frameBytes < 4 || frameBytes > 32 * 1024 ** 2 || input.low < 0
    || input.high < input.low || input.high >= input.index.decodedFrameCount) throw Error("RGBA_STREAM_WINDOW_INVALID");
  const timeoutMs = renderStageTimeout(input.timeoutMs), stallMs = Math.min(input.timeoutMs, renderLifetimeStallMs() ?? 600000);
  if (!Number.isFinite(stallMs) || stallMs <= 0) throw Error("RGBA_STREAM_STALL_BUDGET_INVALID");
  const signal = input.signal ?? renderLifetimeSignal(); signal?.throwIfAborted(); await input.index.assertIdentity();
  const anchor = input.index.seekIndexAt(input.low), seekPts = input.index.ptsAt(anchor), lowPts = input.index.ptsAt(input.low);
  const endPts = input.high + 1 < input.index.decodedFrameCount ? input.index.ptsAt(input.high + 1) : input.index.lastFrameEndPts;
  const seekSeconds = seekPts * input.index.timeBase.numerator / input.index.timeBase.denominator;
  const args = ["-hide_banner", "-v", "info", "-nostats", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1",
    ...(anchor ? ["-ss", String(seekSeconds)] : []), "-copyts", "-noautorotate", "-i", input.sourcePath, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-filter_threads", "1", "-vf", `trim=start_pts=${lowPts}:end_pts=${endPts},format=rgba,showinfo`, "-fps_mode", "passthrough",
    "-frames:v", String(count), "-threads", "1", "-f", "rawvideo", "-"];
  const startedMs = Date.now(), child = spawn(input.ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const iterator = child.stdout[Symbol.asyncIterator](), digest = createHash("sha256");
  let closed = false, disposed = false, completed = false, busy = false, activeRead = false, failure: unknown;
  let framesRead = 0, framesSeen = 0, bytesRead = 0, pending = Buffer.alloc(0), pendingAt = 0, partial = "", stderr = "", timeBaseSeen = false;
  let lastProgress = performance.now(), killTimer: ReturnType<typeof setTimeout> | undefined;
  let clockWaiter: { target: number; done(): void; fail(error: unknown): void } | undefined;
  const metrics = { largestChunkBytes: 0, maximumPendingChunkBytes: 0, maximumReadableBufferedBytes: 0, maximumClockLeadFrames: 0 };
  let reported = false;
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
    child.on("error", error => { failure ??= error; clockWaiter?.fail(failure); clockWaiter = undefined; });
    child.on("close", (code, exitSignal) => {
      closed = true; if (clockWaiter && framesSeen < clockWaiter.target) { clockWaiter.fail(failure ?? Error("RGBA_STREAM_CLOCK_ENDED_EARLY")); clockWaiter = undefined; }
      done({ code, signal: exitSignal });
    });
  });
  const stop = (error: unknown) => {
    failure ??= error; clockWaiter?.fail(failure); clockWaiter = undefined;
    if (!closed) { child.kill(); killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4000); }
    child.stdout.destroy();
  };
  const abort = () => stop(signal?.reason ?? Error("RGBA_STREAM_CANCELLED"));
  const checkLine = (line: string) => {
    if (!line.includes("showinfo")) return;
    const tb = /config in time_base:\s*(\d+)\/(\d+)/.exec(line);
    if (tb) {
      if (BigInt(tb[1]) * BigInt(input.index.timeBase.denominator) !== BigInt(tb[2]) * BigInt(input.index.timeBase.numerator)) throw Error("RGBA_STREAM_TIMEBASE_CHANGED");
      timeBaseSeen = true;
    }
    if (!/\bn:\s*\d+\s+pts:/.test(line)) return;
    const n = Number(/\bn:\s*(\d+)/.exec(line)![1]), pts = Number(/\bpts:\s*(-?\d+)/.exec(line)![1]), shape = /\bs:(\d+)x(\d+)/.exec(line);
    if (!timeBaseSeen || n !== framesSeen || framesSeen >= count || !Number.isSafeInteger(pts) || pts !== input.index.ptsAt(input.low + framesSeen)
      || !shape || Number(shape[1]) !== input.width || Number(shape[2]) !== input.height || !/\bfmt:rgba\b/.test(line)) throw Error("RGBA_STREAM_FRAME_CLOCK_OR_SHAPE_CHANGED");
    framesSeen++; metrics.maximumClockLeadFrames = Math.max(metrics.maximumClockLeadFrames, framesSeen - framesRead);
    if (clockWaiter && framesSeen >= clockWaiter.target) { clockWaiter.done(); clockWaiter = undefined; }
  };
  child.stdout.on("error", error => { failure ??= error; clockWaiter?.fail(failure); clockWaiter = undefined; });
  child.stderr.on("data", chunk => {
    try {
      if (chunk.length > 262144) throw Error("RGBA_STREAM_STDERR_CHUNK_LIMIT");
      const lines = (partial + chunk.toString("utf8")).split(/\r?\n/); partial = lines.pop()!;
      if (Buffer.byteLength(partial) > 8192) throw Error("RGBA_STREAM_STDERR_LINE_LIMIT");
      for (const line of lines) checkLine(line); stderr = (stderr + chunk.toString("utf8")).slice(-65536);
    } catch (error) { stop(error); }
  });
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const deadline = setTimeout(() => stop(Error("RGBA_STREAM_DEADLINE")), timeoutMs);
  // An intentionally paused sink is backpressure, not a decoder stall. The overall deadline still applies.
  const stall = setInterval(() => { if (activeRead && performance.now() - lastProgress >= stallMs) stop(Error("RGBA_STREAM_STALLED")); }, Math.max(10, Math.min(1000, stallMs / 4)));
  const settle = async (status: "COMPLETED" | "OWNER_CLOSED" | "FAILED") => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([terminal, new Promise<never>((_, reject) => { closeTimer = setTimeout(() => { stop(Error("RGBA_STREAM_CHILD_NOT_CLOSED")); reject(Error("RGBA_STREAM_CHILD_NOT_CLOSED")); }, 5000); })]);
      if (partial) { try { checkLine(partial); } catch (error) { failure ??= error; } partial = ""; }
      if (status === "COMPLETED") {
        if (!closed || result.code !== 0 || result.signal || framesSeen !== count || bytesRead !== expectedBytes) failure ??= Error("RGBA_STREAM_INCOMPLETE");
        completed = failure === undefined;
      }
      if (!reported) {
        input.onTerminal?.({ pid: child.pid, startedMs, endedMs: Date.now(), ...result, closed, status: status === "COMPLETED" && !completed ? "FAILED" : status, framesRead, verifiedFrameClocks: framesSeen, bytesRead, expectedFrames: count, expectedBytes,
          lowFrame: input.low, highFrame: input.high, seekAnchorFrame: anchor, seekPts, ...metrics, stdoutHighWaterMark: child.stdout.readableHighWaterMark,
          maximumFrameClockWaiters: 1, allocatedMovieFrameBytes: 0, firstFailure: failure === undefined ? null : String(failure), stderrTail: stderr, decodedPixelSha256: completed ? digest.digest("hex") : null }); reported = true;
      }
      return result;
    } finally { clearTimeout(closeTimer); clearTimeout(deadline); clearTimeout(killTimer); clearInterval(stall); signal?.removeEventListener("abort", abort); disposed = true; }
  };
  const healthy = () => { assertRenderActive(); signal?.throwIfAborted(); if (failure !== undefined) throw failure; if (disposed) throw Error("RGBA_STREAM_DISPOSED"); };
  return {
    /** Exactly one frame, written into a caller-owned slot. Bytes and matching stderr PTS must both arrive. */
    async readInto(destination: Uint8Array) {
      healthy(); if (busy || completed || framesRead >= count || destination.byteLength !== frameBytes) throw Error("RGBA_STREAM_READ_STATE_INVALID"); busy = true; activeRead = true; lastProgress = performance.now();
      try {
        await input.index.assertIdentity(); let at = 0;
        while (at < frameBytes) {
          healthy(); if (pendingAt === pending.length) {
            const next = await iterator.next(); healthy(); if (next.done) throw Error("RGBA_STREAM_PIXELS_ENDED_EARLY");
            pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value); pendingAt = 0;
            if (pending.length > 262144 || bytesRead + pending.length > expectedBytes) throw Error("RGBA_STREAM_EXTRA_BYTES_OR_CHUNK_LIMIT");
            metrics.largestChunkBytes = Math.max(metrics.largestChunkBytes, pending.length); metrics.maximumPendingChunkBytes = Math.max(metrics.maximumPendingChunkBytes, pending.length);
            metrics.maximumReadableBufferedBytes = Math.max(metrics.maximumReadableBufferedBytes, child.stdout.readableLength);
          }
          const take = Math.min(frameBytes - at, pending.length - pendingAt); destination.set(pending.subarray(pendingAt, pendingAt + take), at);
          digest.update(pending.subarray(pendingAt, pendingAt + take)); at += take; pendingAt += take; bytesRead += take; lastProgress = performance.now();
        }
        if (framesSeen < framesRead + 1) {
          if (closed) throw Error("RGBA_STREAM_CLOCK_ENDED_EARLY");
          await new Promise<void>((done, fail) => { clockWaiter = { target: framesRead + 1, done, fail }; });
        }
        healthy(); const index = input.low + framesRead; framesRead++; return { index, pts: input.index.ptsAt(index) };
      } catch (error) { const cause = failure ?? error; stop(cause); await settle("FAILED"); throw cause; }
      finally { busy = false; activeRead = false; }
    },
    async finish() {
      healthy(); if (busy || framesRead !== count || pendingAt !== pending.length) throw Error("RGBA_STREAM_FINISH_STATE_INVALID"); busy = true; activeRead = true; lastProgress = performance.now();
      try {
        const next = await iterator.next(); healthy(); if (!next.done) throw Error("RGBA_STREAM_EXTRA_BYTES");
        await input.index.assertIdentity(); await settle("COMPLETED"); if (failure !== undefined) throw failure;
      } catch (error) { const cause = failure ?? error; stop(cause); if (!disposed) await settle("FAILED"); throw cause; }
      finally { busy = false; activeRead = false; pending = Buffer.alloc(0); }
    },
    async close() { if (disposed) return; const status = failure === undefined ? "OWNER_CLOSED" : "FAILED"; stop(Error("RGBA_STREAM_OWNER_CLOSED")); await settle(status); pending = Buffer.alloc(0); },
  };
}
