import { spawn } from "node:child_process";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderStageTimeout, renderLifetimeStallMs } from "./renderLifetime";
import type { DecodedPtsIndexV1 } from "./decodedPtsIndexV1";

/** A bounded decode window after a witnessed IDR; showinfo must agree with every indexed original PTS. */
export async function readRgbaPtsBatchV1(input: { ffmpegPath: string; sourcePath: string; index: DecodedPtsIndexV1; width: number; height: number;
  low: number; high: number; maximumBytes: number; timeoutMs: number; signal?: AbortSignal; onTerminal?: (receipt: unknown) => void }) {
  assertLocalMediaPath(input.ffmpegPath); assertLocalMediaPath(input.sourcePath); assertRenderActive();
  const count = input.high - input.low + 1, frameBytes = input.width * input.height * 4, expectedBytes = frameBytes * count;
  if (![input.low, input.high, input.width, input.height, frameBytes, expectedBytes, input.maximumBytes].every(Number.isSafeInteger)
    || input.low < 0 || input.high < input.low || input.high >= input.index.decodedFrameCount || count > 64 || input.width < 1 || input.height < 1
    || expectedBytes < 1 || expectedBytes > input.maximumBytes || input.maximumBytes > 64 * 1024 ** 2) throw Error("RGBA_PTS_BATCH_BUDGET_INVALID");
  await input.index.assertIdentity(); const signal = input.signal ?? renderLifetimeSignal(); signal?.throwIfAborted();
  const anchor = input.index.seekIndexAt(input.low), seekPts = input.index.ptsAt(anchor), lowPts = input.index.ptsAt(input.low);
  const endPts = input.high + 1 < input.index.decodedFrameCount ? input.index.ptsAt(input.high + 1) : input.index.lastFrameEndPts;
  const seekSeconds = seekPts * input.index.timeBase.numerator / input.index.timeBase.denominator;
  const args = ["-hide_banner", "-v", "info", "-nostats", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", ...(anchor ? ["-ss", String(seekSeconds)] : []),
    "-copyts", "-noautorotate", "-i", input.sourcePath, "-map", "0:v:0", "-an", "-sn", "-dn", "-filter_threads", "1", "-vf", `trim=start_pts=${lowPts}:end_pts=${endPts},format=rgba,showinfo`,
    "-fps_mode", "passthrough", "-frames:v", String(count), "-threads", "1", "-f", "rawvideo", "-"];
  const child = spawn(input.ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const pixels = Buffer.allocUnsafe(expectedBytes); let bytes = 0, frames = 0, partial = "", stderr = "", closed = false, failure: unknown, timeBaseSeen = false, largestChunk = 0;
  let timerKill: ReturnType<typeof setTimeout> | undefined;
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { child.on("error", e => { failure ??= e; }); child.on("close", (code, signal) => { closed = true; resolve({ code, signal }); }); });
  const stop = (e: unknown) => { failure ??= e; if (!closed) { child.kill(); timerKill ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4000); } };
  const abort = () => stop(signal?.reason ?? Error("RGBA_PTS_BATCH_CANCELLED")); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const checkLine = (line: string) => {
    if (!line.includes("showinfo")) return;
    const tb = /config in time_base:\s*(\d+)\/(\d+)/.exec(line);
    if (tb) { if (Number(tb[1]) * input.index.timeBase.denominator !== Number(tb[2]) * input.index.timeBase.numerator) throw Error("RGBA_PTS_BATCH_TIMEBASE_CHANGED"); timeBaseSeen = true; }
    if (!/\bn:\s*\d+\s+pts:/.test(line)) return;
    const n = Number(/\bn:\s*(\d+)/.exec(line)![1]), pts = Number(/\bpts:\s*(-?\d+)/.exec(line)![1]), shape = /\bs:(\d+)x(\d+)/.exec(line);
    if (!timeBaseSeen || n !== frames || frames >= count || !Number.isSafeInteger(pts) || pts !== input.index.ptsAt(input.low + frames)
      || !shape || Number(shape[1]) !== input.width || Number(shape[2]) !== input.height || !/\bfmt:rgba\b/.test(line)) throw Error("RGBA_PTS_BATCH_FRAME_CLOCK_OR_SHAPE_CHANGED");
    frames++;
  };
  child.stderr.on("data", chunk => {
    try { if (chunk.length > 262144) throw Error("RGBA_PTS_BATCH_STDERR_CHUNK_LIMIT"); const text = partial + chunk.toString("utf8"); const lines = text.split(/\r?\n/); partial = lines.pop()!;
      if (Buffer.byteLength(partial) > 8192) throw Error("RGBA_PTS_BATCH_STDERR_LINE_LIMIT"); for (const line of lines) checkLine(line); stderr = (stderr + chunk.toString("utf8")).slice(-65536);
    } catch (e) { stop(e); }
  });
  let activity = performance.now(); const timeout = setTimeout(() => stop(Error("RGBA_PTS_BATCH_DEADLINE")), renderStageTimeout(input.timeoutMs));
  const stallMs = Math.min(input.timeoutMs, renderLifetimeStallMs() ?? 600000), stall = setInterval(() => { if (performance.now() - activity > stallMs) stop(Error("RGBA_PTS_BATCH_STALLED")); }, Math.max(10, Math.min(1000, stallMs / 4)));
  try {
    for await (const chunk of child.stdout) { assertRenderActive(); if (failure !== undefined) throw failure; if (chunk.length > 262144 || bytes + chunk.length > expectedBytes) throw Error("RGBA_PTS_BATCH_EXTRA_BYTES"); chunk.copy(pixels, bytes); bytes += chunk.length; largestChunk = Math.max(largestChunk, chunk.length); activity = performance.now(); }
  } catch (e) { stop(e); }
  let result: Awaited<typeof terminal>; let closeTimeout: ReturnType<typeof setTimeout> | undefined;
  try { result = await Promise.race([terminal, new Promise<never>((_, reject) => { closeTimeout = setTimeout(() => { stop(Error("RGBA_PTS_BATCH_CLOSE_DEADLINE")); reject(Error("RGBA_PTS_BATCH_CLOSE_DEADLINE")); }, 5000); })]); }
  finally { clearTimeout(closeTimeout); clearTimeout(timeout); clearTimeout(timerKill); clearInterval(stall); signal?.removeEventListener("abort", abort); }
  if (partial) { try { checkLine(partial); } catch (e) { failure ??= e; } }
  const receipt = { pid: child.pid, ...result, closed, bytes, frames, expectedBytes, expectedFrames: count, seekAnchorFrame: anchor, seekPts, lowFrame: input.low,
    highFrame: input.high, largestChunkBytes: largestChunk, stdoutHighWaterMark: child.stdout.readableHighWaterMark, stderrTail: stderr, maximumBufferedPixelBytes: expectedBytes };
  input.onTerminal?.(receipt); if (failure !== undefined) throw failure;
  if (!closed || result.code !== 0 || result.signal || bytes !== expectedBytes || frames !== count) throw Error("RGBA_PTS_BATCH_INCOMPLETE"); await input.index.assertIdentity();
  return { pixels, frameBytes, receipt };
}
