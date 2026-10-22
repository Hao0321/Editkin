// Leaf media I/O: no project renderer, desktop bridge, or audio-stage imports.
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaProbe } from "./ffmpegContracts";
import { sourceFrameRateFromProbe } from "./sourceFrameRateProbe";
import { mediaDisplayAspectRatio, mediaDisplayRotation, mediaSampleAspectRatio } from "./mediaDisplayGeometry";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeAbort, renderLifetimeSignal, renderLifetimeStallMs, renderStageTimeout, renderStallError } from "./renderLifetime";
import { renderProgressTimeReporter } from "./renderProgress";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";

/** Machine-readable FFmpeg progress on stdout. Place it before the output path (never as a trailing option). */
export const FFMPEG_PROGRESS_ARGS: readonly string[] = ["-progress", "pipe:1", "-nostats"];

/**
 * Evidence that a long-running export process is still working. Inside a render lifetime, a watched process that
 * shows none of it for the lifetime's stall window is stopped and the whole render fails (never GREEN).
 */
export interface ProcessProgressWatch {
  /** Advancing `frame` / `out_time_us` / `total_size` counters from {@link FFMPEG_PROGRESS_ARGS} on stdout, and
   * `encoder_input_frame` lines (`-stats_enc_pre:v pipe:1`): packets lag the encoder's lookahead, encoder input does not. */
  ffmpegProgress?: boolean;
  /** Files (size or modification time) or directories (entry count or modification time) that change. */
  paths?: readonly string[];
}

const FFMPEG_PROGRESS_COUNTER = /^(frame|out_time_us|out_time_ms|total_size|encoder_input_frame)=(\d+)$/;

async function pathActivitySignature(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    if (info.isDirectory()) return `d:${(await readdir(path)).length}:${info.mtimeNs}`;
    return `f:${info.size}:${info.mtimeNs}`;
  } catch {
    return "missing";
  }
}

/** `onOutputTime` receives FFmpeg's written output time in seconds (the export panel's progress). */
function createProgressMonitor(watch: ProcessProgressWatch, onOutputTime?: (seconds: number) => void) {
  let lastProgressAt = performance.now();
  let partialLine = "";
  const counters = new Map<string, number>();
  const signatures = new Map<string, string>();
  return {
    get lastProgressAt() { return lastProgressAt; },
    observeStdout(chunk: string) {
      if (!watch.ffmpegProgress) return;
      const lines = `${partialLine}${chunk}`.split(/\r?\n/);
      partialLine = (lines.pop() ?? "").slice(-1_024);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "progress=end") { lastProgressAt = performance.now(); continue; }
        const match = FFMPEG_PROGRESS_COUNTER.exec(trimmed);
        if (!match) continue;
        const value = Number(match[2]), previous = counters.get(match[1]);
        if (!Number.isSafeInteger(value) || (previous !== undefined && value <= previous)) continue;
        counters.set(match[1], value);
        lastProgressAt = performance.now();
        // FFmpeg writes `out_time_ms` in microseconds too (a long-standing naming quirk).
        if (match[1] === "out_time_us" || match[1] === "out_time_ms") onOutputTime?.(value / 1_000_000);
      }
    },
    async samplePaths() {
      for (const path of watch.paths ?? []) {
        const signature = await pathActivitySignature(path);
        const previous = signatures.get(path);
        signatures.set(path, signature);
        if (previous !== undefined && previous !== signature) lastProgressAt = performance.now();
      }
    },
  };
}

export async function runProcess(executable: string, args: string[], timeoutMs: number, capture?: { completeStdoutMaxChars: number }, watch?: ProcessProgressWatch): Promise<{ stdout: string; stderr: string }> {
  assertRenderActive();
  const signal = renderLifetimeSignal();
  const stageTimeout = renderStageTimeout(timeoutMs);
  const stallMs = watch ? renderLifetimeStallMs() : undefined;
  const abortLifetime = renderLifetimeAbort();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failure: unknown;
    let settled = false;
    let stopping = false;
    let childClosed = false, stdoutClosed = false, stderrClosed = false;
    let exitCode: number | null = null;
    let acknowledgeClosed!: () => void;
    const closed = new Promise<void>(resolveClosed => { acknowledgeClosed = resolveClosed; });
    let closePending: PendingNativeCloseError | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    // Bound now: stdout events may run outside the render's async context.
    const monitor = watch && stallMs !== undefined ? createProgressMonitor(watch, watch.ffmpegProgress ? renderProgressTimeReporter() : undefined) : undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(closeTimer); clearTimeout(watchdog);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolvePromise({ stdout, stderr });
    };
    const stop = (error: unknown) => {
      closePending?.observeFailure(error);
      // Late events may enrich an existing quarantine error, never restart a retired stop timer.
      if (settled) return;
      failure ??= error;
      if (stopping) return;
      stopping = true;
      try { child.kill(); } catch (killError) { failure ??= killError; }
      closeTimer ??= setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (killError) { failure ??= killError; }
        closePending = new PendingNativeCloseError(`${basename(executable)} 未在取消後關閉；仍保留工作，關閉前禁止重試`, closed, failure);
        finish(closePending);
      }, 5_000);
    };
    const abort = () => stop(signal!.reason ?? new Error("影片輸出已取消"));
    const timer = setTimeout(() => stop(new Error(`${basename(executable)} 執行逾時`)), stageTimeout);
    if (monitor && stallMs !== undefined) {
      const pollMs = Math.max(25, Math.min(5_000, Math.floor(stallMs / 4)));
      const stalled = () => performance.now() - monitor.lastProgressAt >= stallMs;
      const tick = async () => {
        watchdog = undefined;
        try {
          if (settled || failure !== undefined) return;
          await monitor.samplePaths();
          // A late timer can run before already-queued stdout is read; let one I/O phase pass before deciding.
          if (stalled()) await new Promise(resolveImmediate => setImmediate(resolveImmediate));
          if (settled || failure !== undefined) return;
          if (stalled()) {
            const error = renderStallError(basename(executable), stallMs);
            stop(error);
            // The whole export fails: later stages and the publication refuse to continue.
            abortLifetime?.(error);
            return;
          }
        } catch {
          // Sampling problems are not evidence of a stall; keep watching.
        }
        if (!settled && failure === undefined) watchdog = setTimeout(() => void tick(), pollMs);
      };
      watchdog = setTimeout(() => void tick(), pollMs);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      monitor?.observeStdout(String(chunk));
      const next = `${stdout}${String(chunk)}`;
      if (capture) {
        if (next.length > capture.completeStdoutMaxChars) stop(new Error(`${basename(executable)} stdout exceeds capture bound`));
        else stdout = next;
      } else stdout = next.slice(-100_000);
    });
    child.stderr.on("data", (chunk) => { if (!settled) stderr = `${stderr}${String(chunk)}`.slice(-100_000); });
    child.on("error", error => stop(error));
    child.stdout.on("error", error => stop(error));
    child.stderr.on("error", error => stop(error));
    const finishAfterClose = () => {
      if (!childClosed || !stdoutClosed || !stderrClosed) return;
      acknowledgeClosed();
      if (failure !== undefined) finish(failure);
      else if (exitCode === 0) {
        try { assertRenderActive(); finish(); } catch (error) { finish(error); }
      } else finish(new Error(`${basename(executable)} exit ${exitCode}: ${stderr.slice(-4_000)}`));
    };
    // Retirement requires all three observations, even after public fallback rejection.
    child.stdout.once("close", () => { stdoutClosed = true; finishAfterClose(); });
    child.stderr.once("close", () => { stderrClosed = true; finishAfterClose(); });
    child.on("close", code => { childClosed = true; exitCode = code; finishAfterClose(); });
  });
}

/** `inputOptions` such as the media utility input policy are placed before the input path. */
export async function probeMedia(path: string, ffprobePath = "ffprobe", inputOptions: readonly string[] = []): Promise<MediaProbe> {
  assertLocalMediaPath(path);
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error", ...inputOptions, "-show_entries", "format=duration", "-show_entries", "stream=codec_type,codec_name,profile,width,height,sample_aspect_ratio,avg_frame_rate,pix_fmt,bits_per_raw_sample,color_primaries,color_transfer,color_space,color_range:stream_disposition=attached_pic:stream_side_data=side_data_type,rotation:stream_tags=rotate",
    "-of", "json", path,
  ], 30_000);
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; profile?: string; width?: number; height?: number; sample_aspect_ratio?: unknown; avg_frame_rate?: unknown; pix_fmt?: string; bits_per_raw_sample?: string; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string; disposition?: { attached_pic?: number }; side_data_list?: Array<{ side_data_type?: string; rotation?: unknown }>; tags?: { rotate?: unknown } }> };
  const video = data.streams?.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const probe: MediaProbe = {
    duration: Number(data.format?.duration ?? 0), width: video?.width, height: video?.height,
    encodedWidth: video?.width, encodedHeight: video?.height,
    displayRotationDegrees: mediaDisplayRotation(video), hasVideo: Boolean(video),
    sampleAspectRatio: mediaSampleAspectRatio(video?.sample_aspect_ratio),
    hasAudio: Boolean(data.streams?.some((stream) => stream.codec_type === "audio")),
    colorPrimaries: video?.color_primaries, colorTransfer: video?.color_transfer,
    colorMatrix: video?.color_space, colorRange: video?.color_range,
    pixelFormat: video?.pix_fmt, bitsPerRawSample: video?.bits_per_raw_sample ? Number(video.bits_per_raw_sample) : undefined,
    codecName: video?.codec_name, codecProfile: video?.profile, audioCodecName: audio?.codec_name,
  };
  const displayAspectRatio = mediaDisplayAspectRatio(probe), frameRate = sourceFrameRateFromProbe(video?.avg_frame_rate);
  return { ...probe, ...(displayAspectRatio === undefined ? {} : { displayAspectRatio }), ...(frameRate === undefined ? {} : { frameRate }) };
}

export function resolveMediaPath(uri: string, assetBase?: string): string {
  assertLocalMediaPath(uri);
  if (uri.startsWith("file:")) {
    const path = fileURLToPath(uri);
    assertLocalMediaPath(path);
    return path;
  }
  if (isAbsolute(uri)) {
    assertLocalMediaPath(uri);
    return uri;
  }
  if (uri.startsWith("local://")) throw new Error(`瀏覽器工作階段素材無法桌面輸出：${uri}`);
  if (!assetBase) throw new Error(`無法解析素材路徑：${uri}`);
  assertLocalMediaPath(assetBase);
  const path = resolve(assetBase, uri.replace(/^[/\\]+/, ""));
  assertLocalMediaPath(path);
  return path;
}
