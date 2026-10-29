import { helperProcessEnvironmentV1 } from "./helperProcessEnvironmentV1";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderLifetimeStallMs, renderStageTimeout } from "./renderLifetime";
import type { AudioDecodeWitnessV1 } from "./aacPacketClockV1";

export interface PcmDecodeRuntimeV1 {
  executable: string; source: string; sampleRate: number; channels: number; expectedSamples: number;
  /** Reference decodes from source origin, retaining codec history; output verification omits this. */
  referenceWindow?: { startSample: number; endSample: number }; signal?: AbortSignal; timeoutMs?: number; stallMs?: number;
  onTerminal?: (receipt: PcmDecodeReceiptV1) => void;
}
export interface PcmDecodeReceiptV1 {
  pid: number | undefined; code: number | null; signal: NodeJS.Signals | null; closed: boolean;
  bytes: number; largestChunkBytes: number; stdoutHighWaterMark: number; stderrTail: string;
}
/** Float32 PCM travels only through bounded stdout chunks into a digest, never a whole-film PCM file. */
export async function decodePcmWitnessV1(runtime: PcmDecodeRuntimeV1): Promise<AudioDecodeWitnessV1 & { producer: PcmDecodeReceiptV1 }> {
  assertLocalMediaPath(runtime.executable); assertLocalMediaPath(runtime.source); assertRenderActive();
  if (![runtime.sampleRate, runtime.channels, runtime.expectedSamples].every(v => Number.isSafeInteger(v) && v > 0)
    || runtime.sampleRate > 192000 || runtime.channels > 32 || !Number.isSafeInteger(runtime.expectedSamples * runtime.channels * 4)) throw Error("PCM_WITNESS_SHAPE_INVALID");
  const signal = runtime.signal ?? renderLifetimeSignal(); signal?.throwIfAborted();
  const args = ["-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", "-i", runtime.source, "-map", "0:a:0", "-vn", "-sn", "-dn"];
  if (runtime.referenceWindow) {
    const w = runtime.referenceWindow;
    if (!Number.isSafeInteger(w.startSample) || !Number.isSafeInteger(w.endSample) || w.startSample < 0 || w.endSample - w.startSample !== runtime.expectedSamples) throw Error("PCM_WITNESS_WINDOW_INVALID");
    args.push("-af", `atrim=start_sample=${w.startSample}:end_sample=${w.endSample},asetpts=PTS-STARTPTS`, "-t", String(runtime.expectedSamples / runtime.sampleRate));
  }
  // No -ar/-ac resampling/downmix: supplied shape is verified by the owning codec admission.
  args.push("-c:a", "pcm_f32le", "-f", "f32le", "-threads", "1", "-");
  const timeoutMs = renderStageTimeout(runtime.timeoutMs ?? 30_000), stallMs = runtime.stallMs ?? renderLifetimeStallMs() ?? 600_000;
  if (!Number.isFinite(stallMs) || stallMs <= 0 || stallMs > 2_147_483_647) throw Error("PCM_WITNESS_STALL_BUDGET_INVALID");
  const child = spawn(runtime.executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: helperProcessEnvironmentV1() });
  let closed = false, bytes = 0, largestChunkBytes = 0, stderr = "", failure: unknown, killTimer: ReturnType<typeof setTimeout> | undefined;
  const expectedBytes = runtime.expectedSamples * runtime.channels * 4, digest = createHash("sha256");
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
    child.on("error", error => { failure ??= error; }); child.on("close", (code, exitSignal) => { closed = true; done({ code, signal: exitSignal }); });
  });
  const stop = (error: unknown) => { failure ??= error; if (!closed) { child.kill(); killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4_000); } };
  const abort = () => stop(signal!.reason ?? Error("PCM_WITNESS_CANCELLED")); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-65536); });
  let lastProgress = performance.now();
  const timeout = setTimeout(() => stop(Error("PCM_WITNESS_TIMED_OUT")), timeoutMs);
  const stall = setInterval(() => { if (performance.now() - lastProgress >= stallMs) stop(Error("PCM_WITNESS_STALLED")); }, Math.max(10, Math.min(5_000, Math.floor(stallMs / 4))));
  try {
    for await (const chunk of child.stdout) {
      assertRenderActive(); if (failure !== undefined) throw failure;
      if (chunk.length > 262144) throw Error("PCM_WITNESS_CHUNK_LIMIT");
      largestChunkBytes = Math.max(largestChunkBytes, chunk.length); bytes += chunk.length;
      if (!Number.isSafeInteger(bytes) || bytes > expectedBytes) throw Error("PCM_WITNESS_EXTRA_SAMPLES");
      digest.update(chunk); if (chunk.length) lastProgress = performance.now();
    }
  } catch (error) { stop(error); }
  let result: { code: number | null; signal: NodeJS.Signals | null }, deadline: ReturnType<typeof setTimeout> | undefined;
  try { result = await Promise.race([terminal, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(Error("PCM_WITNESS_CHILD_NOT_CLOSED")), failure === undefined ? timeoutMs + 5_000 : 5_000); })]); }
  finally { clearTimeout(timeout); clearInterval(stall); clearTimeout(killTimer); clearTimeout(deadline); signal?.removeEventListener("abort", abort); }
  const producer = { pid: child.pid, code: result.code, signal: result.signal, closed, bytes, largestChunkBytes, stdoutHighWaterMark: child.stdout.readableHighWaterMark, stderrTail: stderr };
  runtime.onTerminal?.(producer); if (failure !== undefined) throw failure;
  if (!closed || result.code !== 0 || result.signal) throw Error(`PCM_WITNESS_DECODE_FAILED: ${stderr.slice(-2000)}`);
  if (bytes !== expectedBytes) throw Error("PCM_WITNESS_MISSING_OR_PARTIAL_SAMPLES");
  assertRenderActive(); signal?.throwIfAborted();
  return { bytes, samples: runtime.expectedSamples, channels: runtime.channels, sampleRate: runtime.sampleRate, sha256: digest.digest("hex"), complete: true, producer };
}
