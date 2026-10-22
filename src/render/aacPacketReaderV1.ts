import { spawn } from "node:child_process";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderLifetimeStallMs, renderStageTimeout, MAX_RENDER_TIMER_MS } from "./renderLifetime";
import { parseAacPacketV1, type AacPacketV1 } from "./aacPacketWitnessV1";

export interface AacPacketReaderReceiptV1 {
  pid: number | undefined; code: number | null; signal: NodeJS.Signals | null; closed: boolean;
  packets: number; stdoutHighWaterMark: number; largestChunkBytes: number; maximumPendingConsumers: 1; stderrTail: string;
}
/** AAC FFprobe stdout, including Skip Samples, is consumed with backpressure, never captured as a movie-sized JSON array. */
export async function readAacPacketsV1(executable: string, mediaPath: string, consume: (packet: AacPacketV1) => Promise<void>,
  options: { signal?: AbortSignal; timeoutMs?: number; stallMs?: number; onTerminal?: (receipt: AacPacketReaderReceiptV1) => void } = {}) {
  assertLocalMediaPath(executable); assertLocalMediaPath(mediaPath); assertRenderActive();
  const signal = options.signal ?? renderLifetimeSignal(); signal?.throwIfAborted();
  const timeoutMs = renderStageTimeout(options.timeoutMs ?? 30_000);
  const stallMs = options.stallMs ?? renderLifetimeStallMs() ?? 10 * 60_000;
  if (!Number.isFinite(stallMs) || stallMs <= 0 || stallMs > MAX_RENDER_TIMER_MS) throw Error("AAC_PACKET_READER_STALL_BUDGET_INVALID");
  const args = ["-v", "error", "-threads", "1", "-select_streams", "a:0", "-show_packets", "-show_entries", "packet=pts,dts,duration,pos,size,flags:packet_side_data=side_data_type,skip_samples,discard_padding,skip_reason,discard_reason", "-of", "compact=p=0:nk=0", mediaPath];
  const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false, packets = 0, partial = "", largestChunkBytes = 0, stderr = "", failure: unknown;
  let rejectStopped!: (error: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  void stopped.catch(() => undefined);
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
    child.on("error", error => { failure ??= error; });
    child.on("close", (code, exitSignal) => { closed = true; done({ code, signal: exitSignal }); });
  });
  child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString("utf8")).slice(-65_536); });
  const stop = (error: unknown) => {
    failure ??= error;
    rejectStopped(failure);
    if (!closed) { child.kill(); killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4_000); }
  };
  const abort = () => stop(signal!.reason ?? Error("AAC_PACKET_READER_CANCELLED"));
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const timeout = setTimeout(() => stop(Error("AAC_PACKET_READER_TIMED_OUT")), timeoutMs);
  let lastProgress = performance.now();
  const stall = setInterval(() => { if (performance.now() - lastProgress >= stallMs) stop(Error("AAC_PACKET_READER_STALLED")); }, Math.max(10, Math.min(5_000, Math.floor(stallMs / 4))));
  try {
    for await (const chunk of child.stdout) {
      assertRenderActive(); if (failure !== undefined) throw failure;
      if (chunk.length > 262_144) throw Error("AAC_PACKET_READER_CHUNK_LIMIT"); largestChunkBytes = Math.max(largestChunkBytes, chunk.length);
      if (chunk.length) lastProgress = performance.now();
      const text = partial + chunk.toString("utf8"); let start = 0, end: number;
      while ((end = text.indexOf("\n", start)) >= 0) {
        const line = text.slice(start, end); start = end + 1; if (!line) continue;
        const packet = parseAacPacketV1(line); await Promise.race([consume(packet), stopped]); packets++;
        lastProgress = performance.now();
        if (!Number.isSafeInteger(packets)) throw Error("AAC_PACKET_COUNT_UNSAFE");
        assertRenderActive(); if (failure !== undefined) throw failure;
      }
      partial = text.slice(start); if (Buffer.byteLength(partial) > 4096) throw Error("AAC_PACKET_LINE_LIMIT");
    }
    if (partial.trim()) { await Promise.race([consume(parseAacPacketV1(partial)), stopped]); packets++; }
    if (failure !== undefined) throw failure;
  } catch (error) { stop(error); }
  let result: { code: number | null; signal: NodeJS.Signals | null };
  let closeDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([terminal, new Promise<never>((_, reject) => {
      closeDeadline = setTimeout(() => reject(Error("AAC_PACKET_READER_CHILD_NOT_CLOSED")), failure === undefined ? timeoutMs + 5_000 : 5_000);
    })]);
  } finally {
    clearTimeout(timeout); clearInterval(stall); clearTimeout(killTimer); clearTimeout(closeDeadline); signal?.removeEventListener("abort", abort);
  }
  const receipt: AacPacketReaderReceiptV1 = { pid: child.pid, code: result.code, signal: result.signal, closed,
    packets, stdoutHighWaterMark: child.stdout.readableHighWaterMark, largestChunkBytes, maximumPendingConsumers: 1, stderrTail: stderr };
  options.onTerminal?.(receipt);
  if (failure !== undefined) throw failure;
  if (!closed || result.code !== 0 || result.signal || packets < 1) throw Error(`AAC_PACKET_READER_FAILED: ${stderr.slice(-2000)}`);
  assertRenderActive(); signal?.throwIfAborted(); return receipt;
}
