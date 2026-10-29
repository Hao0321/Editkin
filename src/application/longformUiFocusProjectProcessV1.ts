import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { LongformUiFocusProjectTraceV1, type LongformUiFocusProjectTraceConfigV1, type LongformUiFocusProjectTraceFrameV1 } from "./longformUiFocusProjectTraceV1";
/** Whole prefixes stream without retaining their pixels. Only the bounded
 * selected hold's frame fingerprints leave this decoder. Both pipes must settle
 * and the real child must close before cancellation or success is returned. */
export function runLongformUiFocusProjectProcessV1(executable: string, args: string[], config: LongformUiFocusProjectTraceConfigV1,
  capture: (row: LongformUiFocusProjectTraceFrameV1) => boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<{ frames: Array<LongformUiFocusProjectTraceFrameV1 & { imageSha256: string }>;
    sourceTimestampOffsetPts: number; inputFramesObserved: number; outputFramesObserved: number; droppedSourceFrames: number; duplicatedSourceFrames: number;
    stdoutBytes: number; stderrBytes: number; processStdoutSha256: string; processStderrSha256: string }>((resolve, reject) => {
    const frameBytes = config.width * config.height;
    if (!Number.isSafeInteger(frameBytes) || frameBytes < 1 || frameBytes > 1280 * 1280) { reject(Error("UI_FOCUS_PROJECT_PROCESS_GEOMETRY")); return; }
    const metadata: LongformUiFocusProjectTraceFrameV1[] = [], pixels: Buffer[] = [], frames: Array<LongformUiFocusProjectTraceFrameV1 & { imageSha256: string }> = [];
    let partial = Buffer.allocUnsafe(frameBytes), partialBytes = 0, consumed = 0, stdoutBytes = 0, stderrBytes = 0, carry = "", failure: Error | undefined;
    const stdoutHash = createHash("sha256"), stderrHash = createHash("sha256");
    const flush = () => {
      while (metadata.length && pixels.length) {
        const row = metadata.shift()!, gray = pixels.shift()!;
        if (row.frame !== consumed++) throw Error("UI_FOCUS_PROJECT_PROCESS_PIPE_ORDER");
        if (capture(row)) {
          if (frames.length >= 256) throw Error("UI_FOCUS_PROJECT_PROCESS_CAPTURE_BUDGET");
          frames.push({ ...row, imageSha256: createHash("sha256").update(gray).digest("hex") });
        }
      }
    };
    const trace = new LongformUiFocusProjectTraceV1(config, row => {
      metadata.push(row); if (metadata.length > 1024) throw Error("UI_FOCUS_PROJECT_PROCESS_METADATA_BUDGET"); flush();
    });
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = (reason: Error) => { failure ??= reason; child.kill(); };
    const abort = () => stop(Error("analysis-cancelled"));
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(Error("UI_FOCUS_PROJECT_PROCESS_TIMEOUT")), 180000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      try {
        stdoutBytes += chunk.length; if (stdoutBytes > 64 * 1024 ** 3) throw Error("UI_FOCUS_PROJECT_PROCESS_STDOUT_BUDGET");
        stdoutHash.update(chunk);
        let at = 0;
        while (at < chunk.length) {
          const length = Math.min(frameBytes - partialBytes, chunk.length - at); chunk.copy(partial, partialBytes, at, at + length);
          partialBytes += length; at += length;
          if (partialBytes === frameBytes) {
            pixels.push(partial); partial = Buffer.allocUnsafe(frameBytes); partialBytes = 0;
            if (pixels.length > 32) throw Error("UI_FOCUS_PROJECT_PROCESS_PIXELS_BUDGET"); flush();
          }
        }
      } catch (error) { stop(error instanceof Error ? error : Error(String(error))); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      try {
        stderrBytes += chunk.length; if (stderrBytes > 256 * 1024 ** 2) throw Error("UI_FOCUS_PROJECT_PROCESS_STDERR_BUDGET");
        stderrHash.update(chunk); carry += chunk.toString("utf8");
        let newline: number;
        while ((newline = carry.indexOf("\n")) >= 0) { const line = carry.slice(0, newline).replace(/\r$/, ""); carry = carry.slice(newline + 1); trace.line(line); }
        if (carry.length > 65536) throw Error("UI_FOCUS_PROJECT_TRACE_LINE_BUDGET");
      } catch (error) { stop(error instanceof Error ? error : Error(String(error))); }
    });
    child.on("error", error => { failure ??= error; });
    child.on("close", (code, terminalSignal) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      try {
        if (code !== 0 || terminalSignal) throw Error(`UI_FOCUS_PROJECT_PROCESS_EXIT_${code}`);
        if (carry) trace.line(carry.replace(/\r$/, "")); flush();
        const summary = trace.finish();
        if (partialBytes || metadata.length || pixels.length || consumed !== summary.outputFramesObserved || stdoutBytes !== consumed * frameBytes)
          throw Error("UI_FOCUS_PROJECT_PROCESS_BYTE_COVERAGE");
        resolve({ frames, ...summary, stdoutBytes, stderrBytes, processStdoutSha256: stdoutHash.digest("hex"), processStderrSha256: stderrHash.digest("hex") });
      } catch (error) { reject(error); }
    });
  });
}
