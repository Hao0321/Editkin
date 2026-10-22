export const SOURCE_CLOCK_PCM_CONSTANT_POLICY_V2 = "diagnostic_lossless_source_clock_rgba8_pcm_constant_v2" as const;
const plans = new WeakSet<object>();
export interface PitchPreservingAudioPlanV1 {
  schema: "editkin.pitch-preserving-constant-audio/v1"; sampleRate: number; channels: 1 | 2; layout: "mono" | "stereo"; speed: number; volume: number;
  timeBase: Readonly<{ numerator: number; denominator: number }>; sourceStartSample: number; sourceEndSample: number; outputSamples: number;
  inputReadSeconds: number; tempo: readonly number[]; processingFilter: string; muxFilter: string; maximumTailSamples: 4096;
  processingEngine: "identity_pcm_v1" | "pinned_ffmpeg_rubberband_independent_smooth_v1";
  boundaryRoundingSamples: Readonly<{ start: number; end: number; output: number }>;
}
export function compilePitchPreservingAudioPlanV1(input: {
  sourceStartSeconds: number; consumedSourceSeconds: number; timelineDurationSeconds: number; direction: "forward" | "reverse";
  mode: string; speed: number; atempo: readonly number[]; volume: number; stream: Record<string, unknown>;
}): PitchPreservingAudioPlanV1 {
  if (input.direction !== "forward" || input.mode !== "pitch_preserving_constant" || !Number.isFinite(input.speed) || input.speed < 1 / 64 || input.speed > 64
    || !Number.isFinite(input.volume) || input.volume <= 0 || input.volume > 2) throw Error("PITCH_PCM_CONSTANT_FORWARD_REQUIRED");
  const sampleRate = Number(input.stream.sample_rate), channels = Number(input.stream.channels), layout = input.stream.channel_layout;
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || (channels !== 1 && channels !== 2)
    || layout !== (channels === 1 ? "mono" : "stereo")) throw Error("PITCH_PCM_RATE_OR_LAYOUT_UNSUPPORTED");
  const timebase = String(input.stream.time_base).split("/").map(Number);
  if (timebase.length !== 2 || !timebase.every(n => Number.isSafeInteger(n) && n > 0) || timebase[0] * 1000 > timebase[1]
    || !["string", "number"].includes(typeof input.stream.start_pts) || !["string", "number"].includes(typeof input.stream.start_time)
    || Number(input.stream.start_pts) !== 0 || Number(input.stream.start_time) !== 0) throw Error("PITCH_PCM_AUDIO_ORIGIN_OR_CLOCK_UNKNOWN");
  if (!input.atempo.length || input.atempo.length > 6 || input.atempo.some(n => !Number.isFinite(n) || n < .5 || n > 2)
    || Math.abs(input.atempo.reduce((a, b) => a * b, 1) - input.speed) > 16 * Number.EPSILON * Math.max(1, input.speed)) throw Error("PITCH_PCM_TEMPO_CHAIN_INVALID");
  for (const value of [input.sourceStartSeconds, input.consumedSourceSeconds, input.timelineDurationSeconds]) if (!Number.isFinite(value) || value < 0) throw Error("PITCH_PCM_TIME_INVALID");
  if (input.consumedSourceSeconds <= 0 || input.timelineDurationSeconds <= 0 || Math.abs(input.consumedSourceSeconds - input.timelineDurationSeconds * input.speed) > 16 * Number.EPSILON * Math.max(1, input.consumedSourceSeconds)) throw Error("PITCH_PCM_SOURCE_SPAN_INVALID");
  const start = input.sourceStartSeconds * sampleRate, end = (input.sourceStartSeconds + input.consumedSourceSeconds) * sampleRate, out = input.timelineDurationSeconds * sampleRate;
  const sourceStartSample = Math.round(start), sourceEndSample = Math.round(end), outputSamples = Math.round(out);
  if (![sourceStartSample, sourceEndSample, outputSamples, outputSamples * channels * 4].every(Number.isSafeInteger) || sourceEndSample <= sourceStartSample || outputSamples < 1) throw Error("PITCH_PCM_SAMPLE_COUNT_UNSAFE");
  const processingFilter = [`atrim=start_sample=${sourceStartSample}:end_sample=${sourceEndSample}`, "asetpts=PTS-STARTPTS",
    `aformat=sample_fmts=flt:sample_rates=${sampleRate}:channel_layouts=${layout}`,
    ...(input.speed === 1 ? [] : [`rubberband=tempo=${input.speed}:pitch=1:transients=smooth:detector=soft:phase=independent:window=long:smoothing=on:formant=preserved:pitchq=quality:channels=apart`]),
    `volume=${input.volume}:precision=float`].join(",");
  const plan: PitchPreservingAudioPlanV1 = { schema: "editkin.pitch-preserving-constant-audio/v1", sampleRate, channels, layout: channels === 1 ? "mono" : "stereo", speed: input.speed, volume: input.volume,
    timeBase: Object.freeze({ numerator: timebase[0], denominator: timebase[1] }), sourceStartSample, sourceEndSample, outputSamples,
    inputReadSeconds: sourceEndSample / sampleRate + 2, tempo: Object.freeze([...input.atempo]), processingFilter,
    processingEngine: input.speed === 1 ? "identity_pcm_v1" : "pinned_ffmpeg_rubberband_independent_smooth_v1",
    muxFilter: `${processingFilter},apad=whole_len=${outputSamples},atrim=end_sample=${outputSamples},asetpts=N/SR/TB`, maximumTailSamples: 4096,
    boundaryRoundingSamples: Object.freeze({ start: sourceStartSample - start, end: sourceEndSample - end, output: outputSamples - out }) };
  Object.freeze(plan); plans.add(plan); return plan;
}
export function assertPitchPreservingAudioPlanV1(value: PitchPreservingAudioPlanV1) { if (!plans.has(value)) throw Error("PITCH_PCM_AUTHENTIC_PLAN_REQUIRED"); }

/** Decoded sample counts, not codec packets, bind a contiguous audio window to the canonical source seconds. */
export function checkPitchAudioClockFrameV1(line: string, plan: PitchPreservingAudioPlanV1, state: { samples: number; frames: number }) {
  assertPitchPreservingAudioPlanV1(plan); const fields = new Map(line.split("|").map(v => { const at = v.indexOf("="); return [v.slice(0, at), v.slice(at + 1)] as const; }));
  const integer = (key: string) => { const v = fields.get(key); if (!v || !/^-?\d+$/.test(v)) throw Error("PITCH_PCM_FRAME_FIELD_MISSING"); const n = Number(v); if (!Number.isSafeInteger(n)) throw Error("PITCH_PCM_FRAME_INTEGER_UNSAFE"); return n; };
  const pts = integer("pts"), best = integer("best_effort_timestamp"), samples = integer("nb_samples"), channels = integer("channels");
  if (pts < 0 || pts !== best || samples < 1 || samples > 8192 || channels !== plan.channels || fields.get("channel_layout") !== plan.layout) throw Error("PITCH_PCM_FRAME_SHAPE_OR_CLOCK_CHANGED");
  const delta = BigInt(pts) * BigInt(plan.timeBase.numerator) * BigInt(plan.sampleRate) - BigInt(state.samples) * BigInt(plan.timeBase.denominator);
  if ((delta < 0n ? -delta : delta) * 2n > BigInt(plan.timeBase.numerator) * BigInt(plan.sampleRate)) throw Error("PITCH_PCM_FRAME_GAP_OR_ORIGIN_CHANGED");
  const next = state.samples + samples; if (!Number.isSafeInteger(next)) throw Error("PITCH_PCM_FRAME_SAMPLE_COUNT_UNSAFE");
  state.samples = next; state.frames++;
}
