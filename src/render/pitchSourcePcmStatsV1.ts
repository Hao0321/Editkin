import { helperProcessEnvironmentV1 } from "./helperProcessEnvironmentV1";
import { spawn } from "node:child_process";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderStageTimeout } from "./renderLifetime";
import { assertPitchPreservingAudioPlanV1, type PitchPreservingAudioPlanV1 } from "./pitchPreservingAudioPlanV1";
export interface PitchSourcePcmStatsV1 { samples: number; channels: number; sampleRate: number; channelPeaks: readonly number[]; centeredStereoCorrelation: number | null }
export function assertPitchSourceEligibilityV1(plan: PitchPreservingAudioPlanV1, stats: PitchSourcePcmStatsV1) {
  assertPitchPreservingAudioPlanV1(plan);
  if (stats.samples !== plan.sourceEndSample - plan.sourceStartSample || stats.channels !== plan.channels || stats.sampleRate !== plan.sampleRate) throw Error("PITCH_SOURCE_PCM_STATS_SHAPE_CHANGED");
  if (plan.speed !== 1 && plan.channels === 2 && stats.centeredStereoCorrelation !== null && stats.centeredStereoCorrelation < -.9999) throw Error("PITCH_SOURCE_OPPOSITE_PHASE_CONSUMER_REQUIRED");
}
export function assertPitchOutputPeakV1(plan: PitchPreservingAudioPlanV1, source: PitchSourcePcmStatsV1, outputPeaks: readonly number[]) {
  assertPitchSourceEligibilityV1(plan, source);
  if (outputPeaks.length !== plan.channels || outputPeaks.some((value, n) => !Number.isFinite(value) || value > source.channelPeaks[n] * plan.volume * 1.25 + .001)) throw Error("PITCH_PCM_PROCESSING_PEAK_CHANGED");
}
/** Source window statistics are streaming scalars, needed to refuse known channel/peak corruption before publication. */
export async function readPitchSourcePcmStatsV1(input: { ffmpegPath: string; sourcePath: string; plan: PitchPreservingAudioPlanV1; signal?: AbortSignal; timeoutMs: number;
  onTerminal?: (receipt: unknown) => void }): Promise<PitchSourcePcmStatsV1 & { producer: unknown }> {
  assertLocalMediaPath(input.ffmpegPath); assertLocalMediaPath(input.sourcePath); assertPitchPreservingAudioPlanV1(input.plan); assertRenderActive();
  const p = input.plan, signal = input.signal ?? renderLifetimeSignal(); signal?.throwIfAborted(); const timeoutMs = renderStageTimeout(input.timeoutMs), expectedSamples = p.sourceEndSample - p.sourceStartSample;
  const args = ["-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", "-t", String(p.inputReadSeconds), "-i", input.sourcePath,
    "-map", "0:a:0", "-vn", "-filter_threads", "1", "-af", `atrim=start_sample=${p.sourceStartSample}:end_sample=${p.sourceEndSample},asetpts=PTS-STARTPTS,aformat=sample_fmts=flt:sample_rates=${p.sampleRate}:channel_layouts=${p.layout}`,
    "-c:a", "pcm_f32le", "-threads", "1", "-f", "f32le", "-"];
  const startedMs = Date.now(), child = spawn(input.ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: helperProcessEnvironmentV1() });
  let closed = false, failure: unknown, partial = Buffer.alloc(0), samples = 0, stderr = "", largestChunk = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  const peaks = Array(p.channels).fill(0) as number[], sum = Array(p.channels).fill(0) as number[], squares = Array(p.channels).fill(0) as number[]; let product = 0;
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => { child.on("error", e => { failure ??= e; }); child.on("close", (code, exitSignal) => { closed = true; done({ code, signal: exitSignal }); }); });
  const stop = (e: unknown) => { failure ??= e; if (!closed) { child.kill(); killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4000); } };
  const abort = () => stop(signal?.reason ?? Error("PITCH_SOURCE_PCM_CANCELLED")); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-32768); }); const deadline = setTimeout(() => stop(Error("PITCH_SOURCE_PCM_DEADLINE")), timeoutMs), frameBytes = p.channels * 4;
  try {
    for await (const chunk of child.stdout) {
      assertRenderActive(); if (failure !== undefined) throw failure; if (chunk.length > 262144) throw Error("PITCH_SOURCE_PCM_CHUNK_LIMIT"); largestChunk = Math.max(largestChunk, chunk.length);
      const data = partial.length ? Buffer.concat([partial, chunk]) : chunk, end = data.length - data.length % frameBytes;
      for (let at = 0; at < end; at += frameBytes) {
        let left = 0, right = 0;
        for (let c = 0; c < p.channels; c++) { const value = data.readFloatLE(at + c * 4); if (!Number.isFinite(value)) throw Error("PITCH_SOURCE_PCM_NONFINITE"); peaks[c] = Math.max(peaks[c], Math.abs(value)); sum[c] += value; squares[c] += value * value; if (c === 0) left = value; else right = value; }
        if (p.channels === 2) product += left * right; samples++; if (samples > expectedSamples) throw Error("PITCH_SOURCE_PCM_EXTRA_SAMPLES");
      }
      partial = Buffer.from(data.subarray(end));
    }
  } catch (e) { stop(failure ?? e); }
  let result: Awaited<typeof terminal>;
  try { result = await Promise.race([terminal, new Promise<never>((_, fail) => { closeTimer = setTimeout(() => fail(Error("PITCH_SOURCE_PCM_CHILD_NOT_CLOSED")), failure === undefined ? timeoutMs + 5000 : 5000); })]); }
  finally { clearTimeout(closeTimer); clearTimeout(deadline); clearTimeout(killTimer); signal?.removeEventListener("abort", abort); }
  const producer = { pid: child.pid, startedMs, endedMs: Date.now(), ...result, closed, samples, largestChunkBytes: largestChunk, maximumPartialBytes: frameBytes - 1, rawPcmFileStagingBytes: 0, stderrTail: stderr };
  input.onTerminal?.(producer); if (failure !== undefined) throw failure;
  if (!closed || result.code !== 0 || result.signal || stderr.trim() || partial.length || samples !== expectedSamples) throw Error("PITCH_SOURCE_PCM_WINDOW_OR_DECODE_FAILED");
  let centeredStereoCorrelation: number | null = null;
  if (p.channels === 2) { const a = Math.max(0, squares[0] - sum[0] ** 2 / samples), b = Math.max(0, squares[1] - sum[1] ** 2 / samples); if (a > 1e-20 && b > 1e-20) centeredStereoCorrelation = Math.max(-1, Math.min(1, (product - sum[0] * sum[1] / samples) / Math.sqrt(a * b))); }
  assertRenderActive(); signal?.throwIfAborted(); return { samples, channels: p.channels, sampleRate: p.sampleRate, channelPeaks: peaks, centeredStereoCorrelation, producer };
}
