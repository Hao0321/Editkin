import { helperProcessEnvironmentV1 } from "./helperProcessEnvironmentV1";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderStageTimeout } from "./renderLifetime";
import { assertPitchPreservingAudioPlanV1, type PitchPreservingAudioPlanV1 } from "./pitchPreservingAudioPlanV1";

/** Processed reference PCM is hashed incrementally; no whole-film audio buffer or temporary WAV. */
export async function witnessPitchPcmV1(input: { ffmpegPath: string; sourcePath: string; plan: PitchPreservingAudioPlanV1; signal?: AbortSignal; timeoutMs: number;
  onTerminal?: (receipt: unknown) => void }) {
  assertLocalMediaPath(input.ffmpegPath); assertLocalMediaPath(input.sourcePath); assertPitchPreservingAudioPlanV1(input.plan); assertRenderActive();
  const signal = input.signal ?? renderLifetimeSignal(); signal?.throwIfAborted(); const timeoutMs = renderStageTimeout(input.timeoutMs), p = input.plan;
  const args = ["-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", "-t", String(p.inputReadSeconds), "-i", input.sourcePath,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-filter_threads", "1", "-af", p.processingFilter, "-c:a", "pcm_f32le", "-f", "f32le", "-threads", "1", "-"];
  const startedMs = Date.now(), child = spawn(input.ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: helperProcessEnvironmentV1() }), digest = createHash("sha256");
  const frameBytes = p.channels * 4, targetBytes = p.outputSamples * frameBytes, maximumBytes = (p.outputSamples + p.maximumTailSamples) * frameBytes;
  let bytes = 0, largestChunk = 0, finiteValues = 0, carry = Buffer.alloc(0), stderr = "", closed = false, failure: unknown;
  const channelPeaks = Array(p.channels).fill(0) as number[];
  let killTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => { child.on("error", e => { failure ??= e; }); child.on("close", (code, exitSignal) => { closed = true; done({ code, signal: exitSignal }); }); });
  const stop = (e: unknown) => { failure ??= e; if (!closed) { child.kill(); killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4000); } };
  const abort = () => stop(signal?.reason ?? Error("PITCH_PCM_CANCELLED")); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-32768); });
  const deadline = setTimeout(() => stop(Error("PITCH_PCM_DEADLINE")), timeoutMs);
  try {
    for await (const chunk of child.stdout) {
      assertRenderActive(); if (failure !== undefined) throw failure;
      if (chunk.length > 262144 || bytes + chunk.length > maximumBytes) throw Error("PITCH_PCM_CHUNK_OR_TAIL_BUDGET"); largestChunk = Math.max(largestChunk, chunk.length);
      if (bytes < targetBytes) digest.update(chunk.subarray(0, Math.min(chunk.length, targetBytes - bytes)));
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk, end = data.length - data.length % 4;
      for (let at = 0; at < end; at += 4) { const value = data.readFloatLE(at); if (!Number.isFinite(value)) throw Error("PITCH_PCM_NONFINITE");
        if (finiteValues < p.outputSamples * p.channels) channelPeaks[finiteValues % p.channels] = Math.max(channelPeaks[finiteValues % p.channels], Math.abs(value)); finiteValues++; }
      carry = Buffer.from(data.subarray(end)); bytes += chunk.length;
    }
  } catch (error) { stop(failure ?? error); }
  let result: Awaited<typeof terminal>;
  try { result = await Promise.race([terminal, new Promise<never>((_, reject) => { closeTimer = setTimeout(() => reject(Error("PITCH_PCM_CHILD_NOT_CLOSED")), failure === undefined ? timeoutMs + 5000 : 5000); })]); }
  finally { clearTimeout(closeTimer); clearTimeout(killTimer); clearTimeout(deadline); signal?.removeEventListener("abort", abort); }
  const producer = { pid: child.pid, startedMs, endedMs: Date.now(), ...result, closed, bytes, largestChunkBytes: largestChunk,
    stdoutHighWaterMark: child.stdout.readableHighWaterMark, finiteValues, maximumPartialSampleBytes: 3, rawPcmFileStagingBytes: 0, stderrTail: stderr };
  input.onTerminal?.(producer); if (failure !== undefined) throw failure;
  if (!closed || result.code !== 0 || result.signal || stderr.trim() || carry.length || bytes % frameBytes) throw Error("PITCH_PCM_DECODE_OR_SAMPLE_SHAPE_FAILED");
  const processedSamples = bytes / frameBytes, paddingSamples = Math.max(0, p.outputSamples - processedSamples), trimmedSamples = Math.max(0, processedSamples - p.outputSamples);
  if (!processedSamples || paddingSamples > p.maximumTailSamples || trimmedSamples > p.maximumTailSamples) throw Error("PITCH_PCM_EMPTY_OR_EXCESSIVE_PROCESSING_TAIL");
  const zero = Buffer.alloc(16384); let paddingBytes = paddingSamples * frameBytes;
  while (paddingBytes) { const count = Math.min(paddingBytes, zero.length); digest.update(zero.subarray(0, count)); paddingBytes -= count; }
  assertRenderActive(); signal?.throwIfAborted();
  return { schema: "editkin.pitch-preserving-pcm-reference/v1", sha256: digest.digest("hex"), samples: p.outputSamples, bytes: targetBytes, sampleRate: p.sampleRate, channels: p.channels,
    processedSamples, paddingSamples, trimmedSamples, inputSampleWindow: { start: p.sourceStartSample, end: p.sourceEndSample }, finiteValues, channelPeaks, rawPcmFileStagingBytes: 0, producer };
}
