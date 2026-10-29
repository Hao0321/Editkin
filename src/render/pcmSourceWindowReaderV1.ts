import { helperProcessEnvironmentV1 } from "./helperProcessEnvironmentV1";
import { spawn } from "node:child_process";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderStageTimeout } from "./renderLifetime";
import { assertPitchPreservingAudioPlanV1, type PitchPreservingAudioPlanV1 } from "./pitchPreservingAudioPlanV1";
/** Monotonic source windows. One PCM pipe, a fixed ring, scalar statistics; no movie-sized audio storage. */
export function startPcmSourceWindowReaderV1(input: { ffmpegPath: string; sourcePath: string; plan: PitchPreservingAudioPlanV1; fftSize?: number;
  signal?: AbortSignal; timeoutMs: number; onTerminal?: (receipt: unknown) => void }) {
  assertLocalMediaPath(input.ffmpegPath); assertLocalMediaPath(input.sourcePath); assertPitchPreservingAudioPlanV1(input.plan); assertRenderActive();
  const p = input.plan, n = input.fftSize ?? 4096, capacity = n + n / 16;
  if (!Number.isSafeInteger(n) || n < 512 || n > 8192 || (n & (n - 1))) throw Error("PCM_WINDOW_SIZE_INVALID");
  const signal = input.signal ?? renderLifetimeSignal(); signal?.throwIfAborted(); const timeoutMs = renderStageTimeout(input.timeoutMs);
  const args = ["-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", "-t", String(p.inputReadSeconds), "-i", input.sourcePath,
    "-map", "0:a:0", "-vn", "-filter_threads", "1", "-af", `atrim=start_sample=${p.sourceStartSample}:end_sample=${p.sourceEndSample},asetpts=PTS-STARTPTS,aformat=sample_fmts=flt:sample_rates=${p.sampleRate}:channel_layouts=${p.layout}`,
    "-c:a", "pcm_f32le", "-threads", "1", "-f", "f32le", "-"];
  const startedMs = Date.now(), child = spawn(input.ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: helperProcessEnvironmentV1() }), iterator = child.stdout[Symbol.asyncIterator]();
  const total = p.sourceEndSample - p.sourceStartSample, frameBytes = p.channels * 4, ring = Array.from({ length: p.channels }, () => new Float64Array(capacity)), scratch = Array.from({ length: p.channels }, () => new Float64Array(n));
  const peaks = Array(p.channels).fill(0) as number[], sum = Array(p.channels).fill(0) as number[], squares = Array(p.channels).fill(0) as number[]; let cross = 0;
  let cursor = 0, pending = Buffer.alloc(0), at = 0, bytes = 0, lastStart = -Infinity, closed = false, disposed = false, busy = false, failure: unknown, stderr = "", largestChunk = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => { child.on("error", e => { failure ??= e; }); child.on("close", (code, exitSignal) => { closed = true; done({ code, signal: exitSignal }); }); });
  const stop = (e: unknown) => { failure ??= e; if (!closed) { child.kill(); killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4000); } child.stdout.destroy(); };
  const abort = () => stop(signal?.reason ?? Error("PCM_WINDOW_CANCELLED")); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  child.stdout.on("error", e => { failure ??= e; }); child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-32768); });
  const deadline = setTimeout(() => stop(Error("PCM_WINDOW_DEADLINE")), timeoutMs);
  const healthy = () => { assertRenderActive(); signal?.throwIfAborted(); if (failure !== undefined) throw failure; if (disposed) throw Error("PCM_WINDOW_DISPOSED"); };
  const settle = async (status: string) => {
    try {
      const r = await Promise.race([terminal, new Promise<never>((_, fail) => { closeTimer = setTimeout(() => fail(Error("PCM_WINDOW_CHILD_NOT_CLOSED")), 5000); })]);
      const producer = { pid: child.pid, startedMs, endedMs: Date.now(), ...r, closed, status, samples: cursor, expectedSamples: total, bytes, largestChunkBytes: largestChunk,
        ringFrames: capacity, workingWindowBytes: p.channels * (capacity + n) * 8, pendingChunkMaxBytes: 262144, rawPcmFileStagingBytes: 0, stderrTail: stderr };
      input.onTerminal?.(producer); return producer;
    } finally { clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(closeTimer); signal?.removeEventListener("abort", abort); disposed = true; pending = Buffer.alloc(0); }
  };
  const frame = Buffer.alloc(frameBytes);
  const consume = async () => {
    let used = 0;
    while (used < frameBytes) {
      healthy(); if (at === pending.length) {
        const next = await iterator.next(); healthy(); if (next.done) throw Error("PCM_WINDOW_SOURCE_ENDED_EARLY"); pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value); at = 0;
        if (pending.length > 262144 || bytes + pending.length > total * frameBytes) throw Error("PCM_WINDOW_EXTRA_BYTES_OR_CHUNK_LIMIT"); largestChunk = Math.max(largestChunk, pending.length);
      }
      const count = Math.min(frameBytes - used, pending.length - at); pending.copy(frame, used, at, at + count); used += count; at += count; bytes += count;
    }
    let left = 0, right = 0;
    for (let c = 0; c < p.channels; c++) { const value = frame.readFloatLE(c * 4); if (!Number.isFinite(value)) throw Error("PCM_WINDOW_NONFINITE"); ring[c][cursor % capacity] = value; peaks[c] = Math.max(peaks[c], Math.abs(value)); sum[c] += value; squares[c] += value * value; if (c === 0) left = value; else right = value; }
    if (p.channels === 2) cross += left * right; cursor++;
  };
  return {
    async readWindow(start: number, length: number): Promise<readonly Float64Array[]> {
      healthy(); if (busy || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || length < 1 || length > n || start < lastStart) throw Error("PCM_WINDOW_REQUEST_INVALID"); busy = true;
      try {
        const end = Math.min(total, Math.max(0, start + length)); while (cursor < end) await consume();
        if (Math.max(0, start) < cursor - capacity) throw Error("PCM_WINDOW_EVICTED");
        for (let c = 0; c < p.channels; c++) for (let k = 0; k < length; k++) { const pos = start + k; scratch[c][k] = pos < 0 || pos >= total ? 0 : ring[c][pos % capacity]; }
        lastStart = start; return scratch.map(a => a.subarray(0, length));
      } catch (e) { const cause = failure ?? e; stop(cause); await settle("FAILED"); throw cause; } finally { busy = false; }
    },
    async finish() {
      healthy(); if (busy) throw Error("PCM_WINDOW_BUSY"); busy = true;
      try {
        while (cursor < total) await consume(); if (at !== pending.length) throw Error("PCM_WINDOW_EXTRA_BYTES"); const next = await iterator.next(); healthy(); if (!next.done) throw Error("PCM_WINDOW_EXTRA_BYTES");
        const producer = await settle("COMPLETE"); if (failure !== undefined) throw failure; if (!closed || producer.code !== 0 || producer.signal || stderr.trim()) throw Error("PCM_WINDOW_DECODE_FAILED");
        let correlation: number | null = null;
        if (p.channels === 2) { const a = Math.max(0, squares[0] - sum[0] ** 2 / cursor), b = Math.max(0, squares[1] - sum[1] ** 2 / cursor); if (a > 1e-20 && b > 1e-20) correlation = Math.max(-1, Math.min(1, (cross - sum[0] * sum[1] / cursor) / Math.sqrt(a * b))); }
        return { samples: cursor, channels: p.channels, sampleRate: p.sampleRate, channelPeaks: peaks, centeredStereoCorrelation: correlation, producer };
      } catch (e) { const cause = failure ?? e; stop(cause); if (!disposed) await settle("FAILED"); throw cause; } finally { busy = false; }
    },
    async close() { if (disposed) return; stop(Error("PCM_WINDOW_OWNER_CLOSED")); await settle("OWNER_CLOSED"); },
  };
}
