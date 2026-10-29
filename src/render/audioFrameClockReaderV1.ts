import { helperProcessEnvironmentV1 } from "./helperProcessEnvironmentV1";
import { spawn } from "node:child_process";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderStageTimeout } from "./renderLifetime";
import { assertPitchPreservingAudioPlanV1, checkPitchAudioClockFrameV1, type PitchPreservingAudioPlanV1 } from "./pitchPreservingAudioPlanV1";

/** Origin decode up to the required audio end. Metadata travels as bounded lines, not full-film JSON. */
export async function readPitchAudioClockV1(input: { ffprobePath: string; sourcePath: string; plan: PitchPreservingAudioPlanV1;
  signal?: AbortSignal; timeoutMs: number; onTerminal?: (receipt: unknown) => void }) {
  assertLocalMediaPath(input.ffprobePath); assertLocalMediaPath(input.sourcePath); assertPitchPreservingAudioPlanV1(input.plan); assertRenderActive();
  const signal = input.signal ?? renderLifetimeSignal(); signal?.throwIfAborted(); const timeoutMs = renderStageTimeout(input.timeoutMs);
  const args = ["-v", "error", "-threads", "1", "-select_streams", "a:0", "-err_detect", "explode", "-read_intervals", `%${input.plan.sourceEndSample / input.plan.sampleRate}`,
    "-show_frames", "-show_entries", "frame=pts,best_effort_timestamp,nb_samples,channels,channel_layout:frame_side_data=", "-of", "compact=p=0:nk=0", input.sourcePath];
  const startedMs = Date.now(), child = spawn(input.ffprobePath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: helperProcessEnvironmentV1() });
  const state = { samples: 0, frames: 0 }; let partial = "", stderr = "", closed = false, failure: unknown, largestChunk = 0, maximumLineBytes = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
    child.on("error", e => { failure ??= e; }); child.on("close", (code, exitSignal) => { closed = true; done({ code, signal: exitSignal }); });
  });
  const stop = (e: unknown) => { failure ??= e; if (!closed) { child.kill(); killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4000); } };
  const abort = () => stop(signal?.reason ?? Error("PITCH_AUDIO_CLOCK_CANCELLED")); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-32768); });
  const deadline = setTimeout(() => stop(Error("PITCH_AUDIO_CLOCK_DEADLINE")), timeoutMs);
  const line = (text: string) => { if (!text.trim()) return; const bytes = Buffer.byteLength(text); maximumLineBytes = Math.max(maximumLineBytes, bytes); if (bytes > 2048) throw Error("PITCH_AUDIO_CLOCK_LINE_LIMIT"); checkPitchAudioClockFrameV1(text, input.plan, state); };
  try {
    for await (const chunk of child.stdout) {
      assertRenderActive(); if (failure !== undefined) throw failure; if (chunk.length > 262144) throw Error("PITCH_AUDIO_CLOCK_CHUNK_LIMIT"); largestChunk = Math.max(largestChunk, chunk.length);
      const lines = (partial + chunk.toString("utf8")).split(/\r?\n/); partial = lines.pop()!; if (Buffer.byteLength(partial) > 2048) throw Error("PITCH_AUDIO_CLOCK_LINE_LIMIT"); for (const text of lines) line(text);
    }
    if (partial) line(partial);
  } catch (error) { stop(failure ?? error); }
  let result: Awaited<typeof terminal>;
  try { result = await Promise.race([terminal, new Promise<never>((_, reject) => { closeTimer = setTimeout(() => reject(Error("PITCH_AUDIO_CLOCK_CHILD_NOT_CLOSED")), failure === undefined ? timeoutMs + 5000 : 5000); })]); }
  finally { clearTimeout(closeTimer); clearTimeout(deadline); clearTimeout(killTimer); signal?.removeEventListener("abort", abort); }
  const receipt = { pid: child.pid, startedMs, endedMs: Date.now(), ...result, closed, decodedSamples: state.samples, decodedFrames: state.frames,
    largestChunkBytes: largestChunk, maximumLineBytes, stdoutHighWaterMark: child.stdout.readableHighWaterMark, stderrTail: stderr, metadataMovieArrayBytes: 0 };
  input.onTerminal?.(receipt); if (failure !== undefined) throw failure;
  if (!closed || result.code !== 0 || result.signal || stderr.trim()) throw Error("PITCH_AUDIO_CLOCK_DECODE_FAILED");
  if (state.samples < input.plan.sourceEndSample) throw Error("PITCH_AUDIO_CLOCK_SOURCE_WINDOW_MISSING");
  assertRenderActive(); signal?.throwIfAborted(); return { schema: "editkin.decoded-audio-window/v1", ...receipt, sourceStartSample: input.plan.sourceStartSample, sourceEndSample: input.plan.sourceEndSample, exactWindowVerified: true };
}
