import { helperProcessEnvironmentV1 } from "./helperProcessEnvironmentV1";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { renderStageTimeout } from "./renderLifetime";

/** One owned encoder; a frame write completes before the next frame is accepted. */
export function startStreamEncoderV1(input: { executable: string; args: readonly string[];
  signal: AbortSignal; timeoutMs: number; stallMs: number; maximumWriteBytes: number; expectedWrites?: number;
  onProgress?: (seconds: number, bytes: number) => void; activityPaths?: readonly string[] }) {
  const timeout = renderStageTimeout(input.timeoutMs);
  if (!Number.isSafeInteger(input.maximumWriteBytes) || input.maximumWriteBytes < 1
    || !Number.isFinite(input.stallMs) || input.stallMs <= 0
    || (input.expectedWrites !== undefined && (!Number.isSafeInteger(input.expectedWrites) || input.expectedWrites < 1))) throw Error("STREAM_ENCODER_BUDGET_INVALID");
  input.signal.throwIfAborted();
  const child = spawn(input.executable, [...input.args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: helperProcessEnvironmentV1() });
  let failure: unknown, closed = false, writing = false, ending = false, stderr = "", stdout = "", partial = "";
  let lastActivity = performance.now(), writes = 0, inputBytes = 0;
  const counters = new Map<string, number>();
  const activity = new Map<string, string>(); let sampling = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void, rejectClosed!: (reason: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // Failure is observed immediately even while the producer is between frames.
  void completion.catch(() => undefined);
  const stop = (reason: unknown) => {
    failure ??= reason;
    if (closed) return;
    child.stdin.destroy(); child.kill();
    killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 5_000);
  };
  const abort = () => stop(input.signal.reason ?? Error("STREAM_ENCODER_CANCELLED"));
  const timer = setTimeout(() => stop(Error("STREAM_ENCODER_DEADLINE")), timeout);
  const watchdog = setInterval(() => {
    if (closed || sampling) return;
    sampling = true;
    void (async () => {
      for (const path of input.activityPaths ?? []) {
        const info = await stat(path, { bigint: true }).catch(() => undefined);
        const signature = info ? `${info.size}:${info.mtimeNs}` : "missing", previous = activity.get(path);
        if (previous !== undefined && previous !== signature) lastActivity = performance.now();
        activity.set(path, signature);
      }
      if (!closed && performance.now() - lastActivity >= input.stallMs) stop(Error("STREAM_ENCODER_STALLED"));
    })().catch(stop).finally(() => { sampling = false; });
  }, Math.max(25, Math.min(2_000, input.stallMs / 4)));
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-65_536);
    const lines = (partial + chunk).split(/\r?\n/); partial = (lines.pop() ?? "").slice(-1_024);
    let seconds = -1, bytes = -1;
    for (const line of lines) {
      const match = /^(out_time_us|total_size)=(\d+)$/.exec(line);
      if (!match) continue;
      const number = Number(match[2]); if (!Number.isSafeInteger(number)) continue;
      const previous = counters.get(match[1]); if (previous !== undefined && number <= previous) continue;
      counters.set(match[1], number); lastActivity = performance.now();
      if (match[1] === "out_time_us") seconds = number / 1_000_000; else bytes = number;
    }
    try { input.onProgress?.(seconds, bytes); } catch (error) { stop(error); }
  });
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-65_536); });
  child.stdin.on("error", (error) => stop(error));
  child.on("error", (error) => { failure ??= error; });
  child.on("close", (code, signal) => {
    closed = true; clearTimeout(timer); clearTimeout(killTimer); clearInterval(watchdog);
    input.signal.removeEventListener("abort", abort);
    if (failure !== undefined) rejectClosed(failure);
    else if (code !== 0 || signal || (!ending && (input.expectedWrites === undefined || writes !== input.expectedWrites))) rejectClosed(Error(`STREAM_ENCODER_FAILED: code=${code}, signal=${signal}, premature=${!ending}, ${stderr}`));
    else resolveClosed();
  });
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  return {
    completion,
    get closed() { return closed; },
    get receipt() { return { writes, inputBytes, maximumPendingWrites: 1, stdout, stderr, closed }; },
    async write(bytes: Uint8Array): Promise<void> {
      input.signal.throwIfAborted();
      if (failure !== undefined) throw failure;
      if (closed || ending || writing || (input.expectedWrites !== undefined && writes >= input.expectedWrites)
        || bytes.byteLength > input.maximumWriteBytes || !bytes.byteLength) throw Error("STREAM_ENCODER_WRITE_REFUSED");
      writing = true;
      try {
        await new Promise<void>((resolve, reject) => child.stdin.write(bytes, (error) => error ? reject(error) : resolve()));
        if (failure !== undefined) throw failure;
        input.signal.throwIfAborted(); writes++; inputBytes += bytes.byteLength; lastActivity = performance.now();
      } finally { writing = false; }
    },
    async finish(): Promise<void> {
      if (closed) { await completion; return; }
      if (writing || ending) throw Error("STREAM_ENCODER_FINISH_REFUSED");
      if (failure !== undefined) throw failure;
      ending = true; child.stdin.end(); await completion;
    },
    async stop(reason: unknown): Promise<void> { stop(reason); await completion.catch(() => undefined); },
  };
}
