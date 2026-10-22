import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderLifetimeStallMs, renderStageTimeout } from "./renderLifetime";


export interface RgbaDecodeRuntimeV1 {
 executable: string; source: string; width: number; height: number; expectedFrames: number;
 signal?: AbortSignal; timeoutMs?: number; stallMs?: number;
 onTerminal?: (receipt: RgbaDecodeReceiptV1) => void;
}
export interface RgbaDecodeReceiptV1 {
  pid: number | undefined; code: number | null; signal: NodeJS.Signals | null; closed: boolean;
  bytes: number; largestChunkBytes: number; stdoutHighWaterMark: number; stderrTail: string;
}
/** Decoded output RGBA travels through bounded stdout chunks into a digest, never a raw movie file. */
export async function decodeRgbaOutputWitnessV1(runtime: RgbaDecodeRuntimeV1): Promise<{ bytes: number; frames: number; sha256: string; complete: true; producer: RgbaDecodeReceiptV1 }> {
  assertLocalMediaPath(runtime.executable); assertLocalMediaPath(runtime.source); assertRenderActive();
  if (![runtime.width, runtime.height, runtime.expectedFrames].every(v => Number.isSafeInteger(v) && v > 0)
    || !Number.isSafeInteger(runtime.width * runtime.height * 4 * runtime.expectedFrames)) throw Error("RGBA_WITNESS_SHAPE_INVALID");
  const signal = runtime.signal ?? renderLifetimeSignal(); signal?.throwIfAborted();
  const args = ["-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", "-noautorotate", "-i", runtime.source,
    "-map", "0:v:0", "-an", "-sn", "-dn", "-pix_fmt", "rgba", "-fps_mode", "passthrough", "-c:v", "rawvideo", "-f", "rawvideo", "-threads", "1", "-"];
  const timeoutMs = renderStageTimeout(runtime.timeoutMs ?? 30_000), stallMs = runtime.stallMs ?? renderLifetimeStallMs() ?? 600_000;
  if (!Number.isFinite(stallMs) || stallMs <= 0 || stallMs > 2_147_483_647) throw Error("RGBA_WITNESS_STALL_BUDGET_INVALID");
  const child = spawn(runtime.executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false, bytes = 0, largestChunkBytes = 0, stderr = "", failure: unknown, killTimer: ReturnType<typeof setTimeout> | undefined;
  const expectedBytes = runtime.expectedFrames * runtime.width * runtime.height * 4, digest = createHash("sha256");
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
    child.on("error", error => { failure ??= error; }); child.on("close", (code, exitSignal) => { closed = true; done({ code, signal: exitSignal }); });
  });
  const stop = (error: unknown) => { failure ??= error; if (!closed) { child.kill(); killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 4_000); } };
  const abort = () => stop(signal!.reason ?? Error("RGBA_WITNESS_CANCELLED")); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-65536); });
  let lastProgress = performance.now();
  const timeout = setTimeout(() => stop(Error("RGBA_WITNESS_TIMED_OUT")), timeoutMs);
  const stall = setInterval(() => { if (performance.now() - lastProgress >= stallMs) stop(Error("RGBA_WITNESS_STALLED")); }, Math.max(10, Math.min(5_000, Math.floor(stallMs / 4))));
  try {
    for await (const chunk of child.stdout) {
      assertRenderActive(); if (failure !== undefined) throw failure;
      if (chunk.length > 262144) throw Error("RGBA_WITNESS_CHUNK_LIMIT");
      largestChunkBytes = Math.max(largestChunkBytes, chunk.length); bytes += chunk.length;
      if (!Number.isSafeInteger(bytes) || bytes > expectedBytes) throw Error("RGBA_WITNESS_EXTRA_SAMPLES");
      digest.update(chunk); if (chunk.length) lastProgress = performance.now();
    }
  } catch (error) { stop(error); }
  let result: { code: number | null; signal: NodeJS.Signals | null }, deadline: ReturnType<typeof setTimeout> | undefined;
  try { result = await Promise.race([terminal, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(Error("RGBA_WITNESS_CHILD_NOT_CLOSED")), failure === undefined ? timeoutMs + 5_000 : 5_000); })]); }
  finally { clearTimeout(timeout); clearInterval(stall); clearTimeout(killTimer); clearTimeout(deadline); signal?.removeEventListener("abort", abort); }
  const producer = { pid: child.pid, code: result.code, signal: result.signal, closed, bytes, largestChunkBytes, stdoutHighWaterMark: child.stdout.readableHighWaterMark, stderrTail: stderr };
  runtime.onTerminal?.(producer); if (failure !== undefined) throw failure;
  if (!closed || result.code !== 0 || result.signal || stderr.trim()) throw Error(`RGBA_WITNESS_DECODE_FAILED: ${stderr.slice(-2000)}`);
  if (bytes !== expectedBytes) throw Error("RGBA_WITNESS_MISSING_OR_PARTIAL_SAMPLES");
  assertRenderActive(); signal?.throwIfAborted();
  return { bytes, frames: runtime.expectedFrames, sha256: digest.digest("hex"), complete: true, producer };
}
