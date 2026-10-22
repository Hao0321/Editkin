import { addQuadPcmF32LeV2, prepareAudioInputGroupsV2 } from "./globalAudioGroupPlanV2";
import type { EditProject, TimelineClip } from "../domain/types";
import { effectiveClipFades } from "../domain/clipAudioEnvelope";
import { clipAudioEnvelopeFilter } from "./clipAudioEnvelopeFilters";
import { withFilterGraphArgs } from "./ffmpegComposite";
import { runProcess } from "./ffmpegMedia";
import { secondsToSamplesV1 } from "./longRenderClockV1";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";
import { runRawVideoProcessV1 } from "./rawVideoProcessV1";
import type { RenderPlan } from "./planner";

const RATE = 48000, SAMPLE_BYTES = 16, MAX_WRITE = 256 * 1024;
const decimal = (value: number) => value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
export interface GlobalAudioClipV1 {
  clip: TimelineClip; path: string; music: boolean; start: number; end: number; sourceStart: number;
  sourceRate: number; sourceOrigin: number;
}
export interface GlobalAudioPlanV1 { schema: "editkin.global-audio-plan/v1"; clips: GlobalAudioClipV1[]; hasVoice: boolean; hasMusic: boolean; sources: number }

export function* globalAudioWindowsV1(samples: number, windowSamples = RATE * 60) {
  if (!Number.isSafeInteger(samples) || samples < 1 || !Number.isSafeInteger(samples * SAMPLE_BYTES)
    || !Number.isSafeInteger(windowSamples) || windowSamples < 1 || windowSamples > RATE * 60) throw Error("GLOBAL_AUDIO_CLOCK_INVALID");
  for (let start = 0; start < samples; start += windowSamples) yield { startSample: start, sampleCount: Math.min(windowSamples, samples - start) };
}

/** One cached header probe per unique original path; no decoder remains open between windows. */
export async function prepareGlobalAudioPassV1(project: EditProject, plan: RenderPlan, ffprobePath: string, timeoutMs: number): Promise<GlobalAudioPlanV1> {
  const facts = new Map<string, { rate: number; origin: number } | null>(), clips: GlobalAudioClipV1[] = [];
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  for (const item of plan.audioClips) {
    const asset = assets.get(item.clip.assetId);
    if (!asset) throw new LongRenderRefusalV1("LONG_RENDER_SOURCE_UNMEASURED", "audio source asset is missing");
    if (!facts.has(item.assetPath)) {
      const { stdout } = await runProcess(ffprobePath, ["-v", "error", "-select_streams", "a:0", "-show_entries", "format=start_time:stream=sample_rate,start_time", "-of", "json", item.assetPath],
        timeoutMs, { completeStdoutMaxChars: 64 * 1024 });
      const data = JSON.parse(stdout), stream = data.streams?.[0];
      if (!stream) facts.set(item.assetPath, null);
      else {
        const rate = Number(stream.sample_rate), origin = Math.round((Number(stream.start_time ?? 0) - Number(data.format?.start_time ?? 0)) * RATE);
        if (!Number.isSafeInteger(rate) || rate < 8000 || rate > 384000 || !Number.isSafeInteger(origin) || origin < 0) {
          throw new LongRenderRefusalV1("LONG_RENDER_SOURCE_UNMEASURED", "the audio sample clock or negative stream origin requires explicit source-clock handling", { path: item.assetPath, rate, origin });
        }
        facts.set(item.assetPath, { rate, origin });
      }
    }
    const fact = facts.get(item.assetPath); if (!fact) continue;
    const clip = structuredClone(item.clip), start = secondsToSamplesV1(clip.timelineStart, RATE), end = secondsToSamplesV1(clip.timelineStart + clip.duration, RATE);
    if (end <= start) continue;
    clips.push({ clip, path: item.assetPath, music: asset.role === "background-music", start, end,
      sourceStart: secondsToSamplesV1(clip.sourceStart, RATE), sourceRate: fact.rate, sourceOrigin: fact.origin });
  }
  clips.sort((a, b) => a.start - b.start || a.end - b.end);
  return { schema: "editkin.global-audio-plan/v1", clips, hasVoice: clips.some(clip => !clip.music), hasMusic: clips.some(clip => clip.music), sources: facts.size };
}

/** Unmastered lanes: exact 48k sample placement and clip-local envelopes, followed by explicit quad channel order. */
export function globalAudioWindowGraphV1(active: readonly GlobalAudioClipV1[], window: { startSample: number; sampleCount: number }) {
  if (active.length > 64) throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "one audio window exceeds the bounded concurrent input budget", { inputs: active.length });
  const N = window.sampleCount, windowEnd = window.startSample + N;
  const args = ["-f", "lavfi", "-t", decimal(N / RATE), "-i", "anullsrc=r=48000:cl=stereo"];
  const filters = [`[0:a]atrim=end_sample=${N},asplit=2[vsilence][msilence]`], voice = ["[vsilence]"], music = ["[msilence]"];
  let input = 1;
  for (const item of active) {
    let from = Math.max(item.start, window.startSample), to = Math.min(item.end, windowEnd);
    let source = item.sourceStart + from - item.start;
    if (source < item.sourceOrigin) { const silent = Math.min(to - from, item.sourceOrigin - source); from += silent; source += silent; }
    if (to <= from) continue;
    // A source-rate phase period maps to an integer count at both rates (e.g. 147@44.1k =160@48k).
    // FFmpeg input seeks use integer microseconds too. Align all three clocks, not just both sample rates.
    const phase = RATE / gcd(gcd(item.sourceRate, RATE), 1_000_000);
    const seek = item.sourceOrigin + Math.max(0, Math.floor((source - item.sourceOrigin - RATE / 10) / phase)) * phase;
    const discard = source - seek, count = to - from, localOffset = (from - item.start) / RATE;
    args.push("-ss", decimal(seek / RATE), "-t", decimal((discard + count + RATE / 10) / RATE), "-i", item.path);
    const faded: TimelineClip = { ...item.clip, duration: count / RATE, audioEnvelope: {
      schema: "editkin.clip-audio-envelope/v1", fades: { ...effectiveClipFades(item.clip, item.music), offset: effectiveClipFades(item.clip, item.music).offset + localOffset },
      ...(item.clip.audioEnvelope?.volume ? { volume: { ...item.clip.audioEnvelope.volume, offset: item.clip.audioEnvelope.volume.offset + localOffset } } : {}),
    } };
    const label = `a${input}`;
    filters.push(`[${input}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=${discard}:end_sample=${discard + count},asetpts=PTS-STARTPTS${clipAudioEnvelopeFilter(faded, item.music)},adelay=${from - window.startSample}S:all=1,volume=${decimal(item.clip.volume)}[${label}]`);
    (item.music ? music : voice).push(`[${label}]`); input++;
  }
  for (const [name, labels] of [["voice", voice], ["music", music]] as const) {
    filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,apad=whole_len=${N},atrim=end_sample=${N},aformat=sample_fmts=fltp:channel_layouts=stereo[${name}]`);
  }
  filters.push("[voice][music]join=inputs=2:channel_layout=quad:map=0.0-FL|0.1-FR|1.0-BL|1.1-BR[lanes]");
  if (args.reduce((sum, arg) => sum + 2 * arg.length + 3, 0) > 24_000) throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "audio window exceeds the Windows argument budget", { reason: "audio-window-argument-budget" });
  return { args, graph: filters.join(";"), sampleCount: N, expectedBytes: N * SAMPLE_BYTES, inputCount: input - 1 };
}

export async function writeGlobalAudioPassV1(plan: GlobalAudioPlanV1, input: {
  samples: number; ffmpegPath: string; timeoutMs: number; signal: AbortSignal; windowSamples?: number;
  /** Resolves after accepting/copying this view; its backing storage is reused for the next group/window. */
  write(bytes: Uint8Array): Promise<void>;
}) {
  const first = globalAudioWindowsV1(input.samples, input.windowSamples).next();
  if (first.done) throw Error("GLOBAL_AUDIO_CLOCK_INVALID");
  const capacitySamples = Math.max(2, first.value.sampleCount), storage = Buffer.allocUnsafe(capacitySamples * SAMPLE_BYTES);
  const active = new Set<GlobalAudioClipV1>();
  let next = 0, bytes = 0, windows = 0, peakInputs = 0, peakWindowBytes = 0, processes = 0, peakGroups = 0, startSample = 0;
  const relay = async (windowBytes: Uint8Array) => {
    for (let at = 0; at < windowBytes.byteLength; at += MAX_WRITE) {
      input.signal.throwIfAborted(); const block = windowBytes.subarray(at, Math.min(at + MAX_WRITE, windowBytes.byteLength));
      await input.write(block); bytes += block.byteLength;
    }
  };
  while (startSample < input.samples) {
    input.signal.throwIfAborted();
    const window = { startSample, sampleCount: Math.min(first.value.sampleCount, input.samples - startSample) };
    while (next < plan.clips.length && plan.clips[next].start < startSample + window.sampleCount) active.add(plan.clips[next++]);
    for (const item of active) if (item.end <= startSample) active.delete(item);
    const prepare = () => prepareAudioInputGroupsV2([...active].filter(item => item.start < startSample + window.sampleCount),
      group => globalAudioWindowGraphV1(group, window));
    let groups = prepare();
    // One shared allocation: grouped accumulation and decoder each use one half-window.
    if (groups.length > 1 && 2 * window.sampleCount > capacitySamples) {
      window.sampleCount = Math.max(1, Math.floor(capacitySamples / 2)); groups = prepare();
    }
    const size = window.sampleCount * SAMPLE_BYTES, grouped = groups.length > 1;
    const mixed = storage.subarray(0, size), scratch = grouped ? storage.subarray(size, 2 * size) : mixed;
    if (grouped) mixed.fill(0);
    peakWindowBytes = Math.max(peakWindowBytes, size); peakGroups = Math.max(peakGroups, groups.length);
    for (const prepared of groups) {
      input.signal.throwIfAborted(); peakInputs = Math.max(peakInputs, prepared.inputCount);
      // A single group decodes straight into `mixed` (its borrowed frame). The relay to the encoder runs after the decoder
      // exits: inside onFrame it is paced by the video encode and tripped the decoder's no-progress watchdog.
      const accept = async (data: Uint8Array) => { if (grouped) addQuadPcmF32LeV2(mixed, data); };
      if (!prepared.inputCount) { scratch.fill(0); await accept(scratch); continue; }
      await withFilterGraphArgs(prepared.graph, async filterArgs => {
        await runRawVideoProcessV1({ executable: input.ffmpegPath, args: ["-hide_banner", "-loglevel", "error", "-nostdin", ...prepared.args, ...filterArgs,
          "-map", "[lanes]", "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "4", "-channel_layout", "quad", "-f", "f32le", "pipe:1"],
          timeoutMs: input.timeoutMs, frameBytes: prepared.expectedBytes, expectedFrames: 1, oneFrameBuffer: scratch,
          sink: { signal: input.signal, onFrame: accept } });
      });
      processes++;
    }
    await relay(mixed);
    windows++; startSample += window.sampleCount;
  }
  if (bytes !== input.samples * SAMPLE_BYTES) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "global audio byte count differs from its sample clock");
  return { schema: "editkin.global-audio-pass/v1" as const, samples: input.samples, bytes, windows, maximumWriteBytes: MAX_WRITE,
    peakWindowBytes, peakInputs, wholeAudioStagingBytes: 0 as const, processes, peakGroups,
    pcmBufferAllocations: 1 as const, allocatedPcmBytes: storage.byteLength };
}
