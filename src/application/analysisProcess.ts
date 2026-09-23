import { spawn } from "node:child_process";

/** Only direct, trusted FFmpeg/Whisper binaries are accepted by callers. They
 * do not launch shell children. Cancellation settles on close, never on kill(). */
export function runAnalysisProcess(executable: string, args: string[], options: {
  cwd?: string; timeoutMs: number; label: string; signal?: AbortSignal;
  maximumStdout?: number; maximumStderr?: number;
}): Promise<{ stdout: Buffer; stderr: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let bytes = 0, stderr = "", failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill(); };
    const abort = () => stop(Object.assign(new Error("分析已取消"), { name: "AbortError" }));
    const timer = setTimeout(() => stop(Object.assign(new Error(`${options.label}逾時`), { name: "TimeoutError" })), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maximumStdout ?? 4_000_000)) stop(new Error(`${options.label} stdout 超過預算`));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-(options.maximumStderr ?? 4_000_000)); });
    child.on("error", error => { failure ??= error; });
    child.on("close", code => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${options.label}失敗 (exit ${code})：${stderr.trim().slice(-3000)}`));
      else resolve({ stdout: Buffer.concat(chunks), stderr });
    });
  });
}
