// Leaf media I/O: no project renderer, desktop bridge, or audio-stage imports.
import { spawn } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaProbe } from "./ffmpegContracts";
import { mediaDisplayRotation } from "./mediaDisplayGeometry";

export async function runProcess(executable: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-100_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-100_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    // Wait for stdio closure, not merely exit, before parsing a probe/receipt.
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${basename(executable)} 執行逾時`));
      else if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${basename(executable)} exit ${code}: ${stderr.slice(-4_000)}`));
    });
  });
}

export async function probeMedia(path: string, ffprobePath = "ffprobe"): Promise<MediaProbe> {
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type,codec_name,profile,width,height,pix_fmt,bits_per_raw_sample,color_primaries,color_transfer,color_space,color_range:stream_side_data=side_data_type,rotation:stream_tags=rotate",
    "-of", "json", path,
  ], 30_000);
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; profile?: string; width?: number; height?: number; pix_fmt?: string; bits_per_raw_sample?: string; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string; side_data_list?: Array<{ side_data_type?: string; rotation?: unknown }>; tags?: { rotate?: unknown } }> };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  return {
    duration: Number(data.format?.duration ?? 0), width: video?.width, height: video?.height,
    encodedWidth: video?.width, encodedHeight: video?.height,
    displayRotationDegrees: mediaDisplayRotation(video), hasVideo: Boolean(video),
    hasAudio: Boolean(data.streams?.some((stream) => stream.codec_type === "audio")),
    colorPrimaries: video?.color_primaries, colorTransfer: video?.color_transfer,
    colorMatrix: video?.color_space, colorRange: video?.color_range,
    pixelFormat: video?.pix_fmt, bitsPerRawSample: video?.bits_per_raw_sample ? Number(video.bits_per_raw_sample) : undefined,
    codecName: video?.codec_name, codecProfile: video?.profile, audioCodecName: audio?.codec_name,
  };
}

export function resolveMediaPath(uri: string, assetBase?: string): string {
  if (uri.startsWith("file:")) return fileURLToPath(uri);
  if (isAbsolute(uri)) return uri;
  if (uri.startsWith("local://")) throw new Error(`瀏覽器工作階段素材無法桌面輸出：${uri}`);
  if (!assetBase) throw new Error(`無法解析素材路徑：${uri}`);
  return resolve(assetBase, uri.replace(/^[/\\]+/, ""));
}
