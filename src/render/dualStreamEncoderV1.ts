import { helperProcessEnvironmentV1 } from "./helperProcessEnvironmentV1";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { renderStageTimeout } from "./renderLifetime";
/** Windows/native FD3 transport, one video write and one PCM write at a time. No intermediate media file. */
export function startDualStreamEncoderV1(input: { executable: string; args: readonly string[]; signal: AbortSignal; timeoutMs: number;
  maximumVideoWriteBytes: number; maximumAudioWriteBytes: number; expectedVideoWrites: number; expectedAudioBytes: number; onStdout?(text: string): void }) {
  assertLocalMediaPath(input.executable);
  if (![input.maximumVideoWriteBytes, input.maximumAudioWriteBytes, input.expectedVideoWrites, input.expectedAudioBytes].every(n => Number.isSafeInteger(n) && n > 0)
    || input.maximumAudioWriteBytes > 262144) throw Error("DUAL_ENCODER_BUDGET_INVALID");
  input.signal.throwIfAborted(); const timeoutMs = renderStageTimeout(input.timeoutMs), startedMs = Date.now();
  const child = spawn(input.executable, [...input.args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe", "pipe"], env: helperProcessEnvironmentV1() }), audio = child.stdio[3] as Writable;
  let closed = false, failure: unknown, videoBusy = false, audioBusy = false, videoEnded = false, audioEnded = false, writes = 0, audioBytes = 0, stderr = "", stdout = "";
  let killTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => { child.on("error", e => { failure ??= e; }); child.on("close", (code, signal) => { closed = true; done({ code, signal }); }); });
  const stop = (reason: unknown) => { failure ??= reason; child.stdin!.destroy(); audio.destroy(); if (!closed) { child.kill(); killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4000); } };
  const abort = () => stop(input.signal.reason ?? Error("DUAL_ENCODER_CANCELLED")); input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
  child.stdin!.on("error", stop); audio.on("error", stop); child.stderr!.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-65536); }); child.stdout!.on("data", chunk => { const text = chunk.toString("utf8"); stdout = (stdout + text).slice(-65536); try { input.onStdout?.(text); } catch (error) { stop(error); } });
  const deadline = setTimeout(() => stop(Error("DUAL_ENCODER_DEADLINE")), timeoutMs);
  // After a stop the child has 5 s to close. A finishing encoder may still flush, write its trailer and rewrite the whole
  // file for +faststart, so finish() waits for it; the stage deadline (and the caller's watchdog) still stop a hang.
  const settle = async (bounded = true) => {
    try { return bounded ? await Promise.race([terminal, new Promise<never>((_, fail) => { closeTimer = setTimeout(() => fail(Error("DUAL_ENCODER_CHILD_NOT_CLOSED")), 5000); })]) : await terminal; }
    finally { clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(closeTimer); input.signal.removeEventListener("abort", abort); }
  };
  const healthy = () => { input.signal.throwIfAborted(); if (failure !== undefined) throw failure; if (closed) throw Error("DUAL_ENCODER_CLOSED"); };
  const write = async (pipe: Writable, bytes: Uint8Array) => { await new Promise<void>((done, fail) => pipe.write(bytes, e => e ? fail(e) : done())); healthy(); };
  return {
    get closed() { return closed; },
    get receipt() { return { pid: child.pid, startedMs, writes, audioBytes, expectedAudioBytes: input.expectedAudioBytes, maximumPendingVideoWrites: 1, maximumPendingAudioWrites: 1,
      maximumVideoWriteBytes: input.maximumVideoWriteBytes, maximumAudioWriteBytes: input.maximumAudioWriteBytes, closed, stdout, stderr }; },
    async write(bytes: Uint8Array) {
      healthy(); if (videoBusy || videoEnded || writes >= input.expectedVideoWrites || bytes.length < 1 || bytes.length > input.maximumVideoWriteBytes) throw Error("DUAL_ENCODER_VIDEO_WRITE_REFUSED"); videoBusy = true;
      try { await write(child.stdin!, bytes); writes++; } catch (e) { stop(failure ?? e); throw failure; } finally { videoBusy = false; }
    },
    async writeAudio(bytes: Uint8Array) {
      healthy(); if (audioBusy || audioEnded || bytes.length < 1 || bytes.length > input.maximumAudioWriteBytes || audioBytes + bytes.length > input.expectedAudioBytes) throw Error("DUAL_ENCODER_AUDIO_WRITE_REFUSED"); audioBusy = true;
      try { await write(audio, bytes); audioBytes += bytes.length; } catch (e) { stop(failure ?? e); throw failure; } finally { audioBusy = false; }
    },
    endAudio() { healthy(); if (audioBusy || audioEnded || audioBytes !== input.expectedAudioBytes) throw Error("DUAL_ENCODER_AUDIO_END_REFUSED"); audioEnded = true; audio.end(); },
    endVideo() { healthy(); if (videoBusy || videoEnded || writes !== input.expectedVideoWrites) throw Error("DUAL_ENCODER_VIDEO_END_REFUSED"); videoEnded = true; child.stdin!.end(); },
    async finish() {
      input.signal.throwIfAborted(); if (failure !== undefined) throw failure;
      if (videoBusy || audioBusy || !videoEnded || !audioEnded || writes !== input.expectedVideoWrites) throw Error("DUAL_ENCODER_FINISH_REFUSED");
      const r = await settle(false); if (failure !== undefined) throw failure; if (!closed || r.code !== 0 || r.signal || stderr.trim()) throw Error("DUAL_ENCODER_FAILED"); return { ...r, closed, endedMs: Date.now() };
    },
    async stop(reason: unknown) { stop(reason); await settle(); },
  };
}
