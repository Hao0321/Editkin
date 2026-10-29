import { createHash } from "node:crypto";
import { assertRenderActive, renderLifetimeSignal } from "./renderLifetime";
import { assertPitchPreservingAudioPlanV1, type PitchPreservingAudioPlanV1 } from "./pitchPreservingAudioPlanV1";
import { createPhaseCoherentStretchV1 } from "./phaseCoherentStretchV1";
import { startPcmSourceWindowReaderV1 } from "./pcmSourceWindowReaderV1";
export const SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3 = "diagnostic_lossless_source_clock_rgba8_shared_phase_pcm_v3" as const;
/** The exact PCM sent to FD3 is hashed once. Source and output stats are bounded scalars, verified before publication. */
export async function pumpPhasePcmV1(input: { ffmpegPath: string; sourcePath: string; plan: PitchPreservingAudioPlanV1; signal?: AbortSignal; timeoutMs: number;
  write(bytes: Uint8Array): Promise<void>; end(): void }) {
  assertPitchPreservingAudioPlanV1(input.plan); const p = input.plan, signal = input.signal ?? renderLifetimeSignal(); signal?.throwIfAborted();
  // The experimental source policy has no quality evidence outside these ratios; refuse before starting a PCM child.
  if (p.speed < .5 || p.speed > 4) throw Error("PHASE_PCM_SPEED_QUALITY_NOT_VERIFIED");
  const readers: unknown[] = [], reader = startPcmSourceWindowReaderV1({ ...input, signal, onTerminal: r => readers.push(r) }), hash = createHash("sha256"), peaks = Array(p.channels).fill(0) as number[];
  let samples = 0, bytes = 0;
  const dsp = p.speed === 1 ? undefined : createPhaseCoherentStretchV1({ sampleRate: p.sampleRate, channels: p.channels, speed: p.speed,
    sourceSamples: p.sourceEndSample - p.sourceStartSample, outputSamples: p.outputSamples, readSourceWindow: (start, count) => reader.readWindow(start, count), signal });
  const identity = new Float32Array(256 * p.channels);
  const send = async (pcm: Float32Array, count: number) => {
    assertRenderActive(); signal?.throwIfAborted();
    for (let n = 0; n < count * p.channels; n++) { const value = pcm[n] * p.volume; if (!Number.isFinite(value)) throw Error("PHASE_PCM_NONFINITE"); pcm[n] = value; peaks[n % p.channels] = Math.max(peaks[n % p.channels], Math.abs(pcm[n])); }
    const payload = Buffer.from(pcm.buffer, pcm.byteOffset, count * p.channels * 4); hash.update(payload); await input.write(payload); samples += count; bytes += payload.length;
  };
  try {
    if (dsp) { while (true) { const block = await dsp.next(); if (!block) break; await send(block.pcm, block.samples); } }
    else {
      while (samples < p.outputSamples) { const count = Math.min(256, p.outputSamples - samples), window = await reader.readWindow(samples, count);
        for (let n = 0; n < count; n++) for (let c = 0; c < p.channels; c++) identity[n * p.channels + c] = window[c][n]; await send(identity, count); }
    }
    if (samples !== p.outputSamples || bytes !== p.outputSamples * p.channels * 4) throw Error("PHASE_PCM_OUTPUT_COUNT_CHANGED");
    const sourceStats = await reader.finish();
    if (peaks.some((value, c) => value > sourceStats.channelPeaks[c] * p.volume * 1.25 + .001)) throw Error("PHASE_PCM_PROCESSING_PEAK_CHANGED");
    assertRenderActive(); signal?.throwIfAborted(); input.end();
    return { schema: "editkin.shared-phase-pcm/v1", samples, bytes, sha256: hash.digest("hex"), sampleRate: p.sampleRate, channels: p.channels, channelPeaks: peaks, sourceStats,
      algorithm: dsp ? "shared_bin_phase_vocoder_v1" : "identity_pcm_v1", processingReceipt: dsp?.receipt ?? null, readers,
      paddingSamples: 0, trimmedSamples: 0, sourceInputWindow: { start: p.sourceStartSample, end: p.sourceEndSample }, rawPcmFileStagingBytes: 0, humanQualityCertified: false };
  } finally { dsp?.close(); await reader.close(); }
}
