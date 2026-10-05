// Leaf media I/O: no project renderer, desktop bridge, or audio-stage imports.
import { spawn } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaProbe } from "./ffmpegContracts";
import { mediaDisplayAspectRatio, mediaDisplayRotation, mediaSampleAspectRatio } from "./mediaDisplayGeometry";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { assertRenderActive, renderLifetimeSignal, renderStageTimeout } from "./renderLifetime";

export async function runProcess(executable: string, args: string[], timeoutMs: number, capture?: { completeStdoutMaxChars: number }): Promise<{ stdout: string; stderr: string }> {
  assertRenderActive();
  const signal = renderLifetimeSignal();
  const stageTimeout = renderStageTimeout(timeoutMs);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failure: unknown;
    let settled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(closeTimer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolvePromise({ stdout, stderr });
    };
    const stop = (error: unknown) => {
      failure ??= error;
      child.kill();
      closeTimer ??= setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`${basename(executable)} 未在取消後關閉`, { cause: failure }));
      }, 5_000);
    };
    const abort = () => stop(signal!.reason ?? new Error("影片輸出已取消"));
    const timer = setTimeout(() => stop(new Error(`${basename(executable)} 執行逾時`)), stageTimeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      const next = `${stdout}${String(chunk)}`;
      if (capture) {
        if (next.length > capture.completeStdoutMaxChars) stop(new Error(`${basename(executable)} stdout exceeds capture bound`));
        else stdout = next;
      } else stdout = next.slice(-100_000);
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-100_000); });
    child.on("error", error => stop(error));
    // Wait for stdio closure, not merely exit, before parsing a probe/receipt.
    child.on("close", (code) => {
      if (failure !== undefined) finish(failure);
      else if (code === 0) {
        try { assertRenderActive(); finish(); } catch (error) { finish(error); }
      } else finish(new Error(`${basename(executable)} exit ${code}: ${stderr.slice(-4_000)}`));
    });
  });
}

export async function probeMedia(path: string, ffprobePath = "ffprobe"): Promise<MediaProbe> {
  assertLocalMediaPath(path);
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type,codec_name,profile,width,height,sample_aspect_ratio,pix_fmt,bits_per_raw_sample,color_primaries,color_transfer,color_space,color_range:stream_side_data=side_data_type,rotation:stream_tags=rotate",
    "-of", "json", path,
  ], 30_000);
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; profile?: string; width?: number; height?: number; sample_aspect_ratio?: unknown; pix_fmt?: string; bits_per_raw_sample?: string; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string; side_data_list?: Array<{ side_data_type?: string; rotation?: unknown }>; tags?: { rotate?: unknown } }> };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
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
  const displayAspectRatio = mediaDisplayAspectRatio(probe);
  return { ...probe, ...(displayAspectRatio === undefined ? {} : { displayAspectRatio }) };
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
