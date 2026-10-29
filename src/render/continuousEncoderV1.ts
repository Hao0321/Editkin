import { stat } from "node:fs/promises";
import { startDualStreamEncoderV1 } from "./dualStreamEncoderV1";
import { masterAudioFilter } from "./ffmpegMedia";
import { outputColorMetadataArgs } from "./outputColorMetadata";
import { FFMPEG_PROGRESS_ARGS } from "./mediaProcess";
import { renderLifetimeStallMs, DEFAULT_RENDER_STALL_MS } from "./renderLifetime";
import { renderProgressTimeReporter } from "./renderProgress";
import type { GlobalAudioPlanV1 } from "./globalAudioPassV1";
import type { LongOutputIdentityPlanV1, LongRenderSpaceGuardHandleV1 } from "./longRenderContractsV1";
import type { AcesOutputTransform } from "../domain/types";
import { audioSidechainStagesV1 } from "./audioFinalMixV1";

export function continuousAudioFilterV1(plan: Pick<GlobalAudioPlanV1, "hasVoice" | "hasMusic">, duration: number, samples: number): string {
  const filters: string[] = [];
  if (!plan.hasVoice && !plan.hasMusic) return `[1:a]pan=stereo|c0=c0|c1=c1,atrim=end_sample=${samples}[aout]`;
  if (plan.hasVoice && plan.hasMusic) {
    const stages = audioSidechainStagesV1(samples);
    filters.push("[1:a]asplit=2[voiceraw][musicraw]", `[voiceraw]pan=stereo|c0=c0|c1=c1,${stages.voiceSplit}`,
      `[musicraw]pan=stereo|c0=c2|c1=c3,${stages.musicPad}`, ...stages.tail);
  } else filters.push(`[1:a]pan=stereo|c0=c${plan.hasVoice ? 0 : 2}|c1=c${plan.hasVoice ? 1 : 3}[premaster]`);
  filters.push(masterAudioFilter("[premaster]", duration));
  return filters.join(";");
}

/** One final codec instance. Video and PCM each have one acknowledged OS-pipe write at a time. */
export function startContinuousEncoderV1(input: {
  ffmpegPath: string; outputPath: string; identity: LongOutputIdentityPlanV1; frameBytes: number;
  /** Raw input uses an exact fixed plane size; PNG input uses frameBytes as its per-frame cap. */
  videoInput?: "rawvideo" | "png";
  /** Scene-linear display PNG conversion/ASS; omitted by existing resident/raw routes. */
  pngDisplayFilter?: string; hdrMastering?: boolean;
  outputTransform: AcesOutputTransform; audio: Pick<GlobalAudioPlanV1, "hasVoice" | "hasMusic">;
  signal: AbortSignal; timeoutMs: number; stallMs?: number; guard: LongRenderSpaceGuardHandleV1;
}) {
  input.signal.throwIfAborted();
  if (input.videoInput !== undefined && input.videoInput !== "rawvideo" && input.videoInput !== "png") throw Error("CONTINUOUS_INPUT_KIND_INVALID");
  if ((input.pngDisplayFilter || input.hdrMastering) && input.videoInput !== "png") throw Error("CONTINUOUS_PNG_DISPLAY_OPTIONS_INVALID");
  const identity = input.identity, controller = new AbortController(), progress = renderProgressTimeReporter();
  const abort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  let lastActivity = performance.now(), lastFile = "", lastTime = -1, lastBytes = -1, sampling = false, failure: unknown, pendingOutput = "";
  const consumeOutput = (text: string) => {
    pendingOutput += text;
    if (pendingOutput.length > 131072) throw Error("CONTINUOUS_ENCODER_PROGRESS_OVERFLOW");
    const lines = pendingOutput.split(/\r?\n/); pendingOutput = lines.pop()!;
    for (const line of lines) {
      const match = /^(out_time_us|total_size)=(\d+)$/.exec(line); if (!match) continue;
      const value = Number(match[2]); if (!Number.isSafeInteger(value)) continue;
      if (match[1] === "out_time_us" && value > lastTime) { lastTime = value; lastActivity = performance.now(); progress?.(value / 1_000_000); }
      if (match[1] === "total_size" && value > lastBytes) { lastBytes = value; lastActivity = performance.now(); input.guard.observeWrittenBytes("continuous-encoder", value); }
    }
  };
  let transport: ReturnType<typeof startDualStreamEncoderV1>;
  try {
    const flags = outputColorMetadataArgs(identity.encoder, input.outputTransform);
    const inputFlags = outputColorMetadataArgs("prores_ks", input.outputTransform);
    const videoArgs = input.videoInput === "png"
      ? ["-f", "image2pipe", "-thread_queue_size", "1", "-probesize", "32", "-analyzeduration", "1", "-fpsprobesize", "0", "-threads:v", "1",
        "-framerate", `${identity.frameRate.numerator}/${identity.frameRate.denominator}`, "-c:v", "png", "-i", "pipe:0"]
      : ["-f", "rawvideo", "-pixel_format", identity.pixelFormat, "-video_size", `${identity.width}x${identity.height}`,
        "-framerate", `${identity.frameRate.numerator}/${identity.frameRate.denominator}`, ...inputFlags, "-color_range", "tv", "-i", "pipe:0"];
    const args = ["-n", "-hide_banner", "-loglevel", "error", ...videoArgs, "-f", "f32le", "-ar", "48000", "-ac", "4", "-channel_layout", "quad", "-i", "pipe:3",
      "-filter_complex", continuousAudioFilterV1(input.audio, identity.durationSeconds, identity.audio.expectedSamples),
      "-map", "0:v:0", "-map", "[aout]", ...(input.pngDisplayFilter ? ["-vf", input.pngDisplayFilter] : []),
      ...identity.encoderArgs, "-pix_fmt", identity.pixelFormat, ...flags,
      ...(input.hdrMastering && identity.encoder === "libx265" ? ["-x265-params", `colorprim=9:transfer=${input.outputTransform === "rec2100_hlg_1000" ? 18 : 16}:colormatrix=9:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400`] : []),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-t", String(identity.durationSeconds),
      "-video_track_timescale", "90000", "-movflags", "+faststart", ...FFMPEG_PROGRESS_ARGS, input.outputPath];
    transport = startDualStreamEncoderV1({ executable: input.ffmpegPath, args, signal: controller.signal, timeoutMs: input.timeoutMs,
      maximumVideoWriteBytes: input.frameBytes, maximumAudioWriteBytes: 262144, expectedVideoWrites: identity.expectedFrames,
      expectedAudioBytes: identity.audio.expectedSamples * 16, onStdout: consumeOutput });
  } catch (error) { input.signal.removeEventListener("abort", abort); throw error; }
  let videoEnded = false, audioEnded = false;
  const fail = (reason: unknown) => { if (failure !== undefined) return; failure = reason; controller.abort(reason); };
  const stallMs = input.stallMs ?? renderLifetimeStallMs() ?? DEFAULT_RENDER_STALL_MS;
  const watchdog = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void (async () => {
      const receipt = transport.receipt;
      const info = await stat(input.outputPath, { bigint: true }).catch(() => undefined);
      const signature = info ? `${info.size}:${info.mtimeNs}` : "missing";
      if (lastFile && signature !== lastFile) lastActivity = performance.now(); lastFile = signature;
      if (receipt.closed && (!videoEnded || !audioEnded)) fail(Error("CONTINUOUS_ENCODER_PREMATURE_CLOSE"));
      if (!receipt.closed && performance.now() - lastActivity >= stallMs) fail(Error("CONTINUOUS_ENCODER_STALLED"));
    })().catch(fail).finally(() => { sampling = false; });
  }, 100);
  const clean = () => { clearInterval(watchdog); input.signal.removeEventListener("abort", abort); };
  return {
    signal: controller.signal,
    get receipt() { return { ...transport.receipt, schema: "editkin.continuous-encoder/v1" as const, expectedFrames: identity.expectedFrames,
      expectedSamples: identity.audio.expectedSamples, finalEncoderInstances: 1 as const }; },
    async writeVideo(bytes: Uint8Array) {
      try { if (input.videoInput === "png" ? bytes.byteLength < 1 || bytes.byteLength > input.frameBytes : bytes.byteLength !== input.frameBytes) throw Error("CONTINUOUS_FRAME_BYTES_INVALID"); await transport.write(bytes); lastActivity = performance.now(); }
      catch (error) { fail(error); throw failure; }
    },
    async writeAudio(bytes: Uint8Array) { try { await transport.writeAudio(bytes); lastActivity = performance.now(); } catch (error) { fail(error); throw failure; } },
    endVideo() { try { transport.endVideo(); videoEnded = true; } catch (error) { fail(error); throw failure; } },
    endAudio() { try { transport.endAudio(); audioEnded = true; } catch (error) { fail(error); throw failure; } },
    async finish() {
      try { if (failure !== undefined) throw failure; await transport.finish(); if (failure !== undefined) throw failure; return this.receipt; }
      catch (error) { fail(error); await transport.stop(failure); throw failure; } finally { clean(); }
    },
    async stop(reason: unknown) { fail(reason); try { await transport.stop(reason); } finally { clean(); } },
  };
}
