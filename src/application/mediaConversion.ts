// Leaf media utility. Never renders EditProject, applies commands or accepts artwork.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { mediaUtilityInputOptions } from "./mediaUtilityInputPolicy";

export const CONVERSION_PROFILES = {
  "mp4-h264": { ext: ".mp4", kind: "video", codec: "h264", alpha: false },
  "mp4-hevc": { ext: ".mp4", kind: "video", codec: "hevc", alpha: false },
  "mov-h264": { ext: ".mov", kind: "video", codec: "h264", alpha: false },
  "mkv-h264": { ext: ".mkv", kind: "video", codec: "h264", alpha: false },
  "avi-mpeg4": { ext: ".avi", kind: "video", codec: "mpeg4", alpha: false },
  "webm-vp9": { ext: ".webm", kind: "video", codec: "vp9", alpha: false },
  "mov-alpha-qtrle": { ext: ".mov", kind: "video", codec: "qtrle", alpha: true },
  gif: { ext: ".gif", kind: "video", codec: "gif", alpha: false },
  mp3: { ext: ".mp3", kind: "audio", codec: "mp3", alpha: false },
  wav: { ext: ".wav", kind: "audio", codec: "pcm_s16le", alpha: false },
  aac: { ext: ".aac", kind: "audio", codec: "aac", alpha: false },
  flac: { ext: ".flac", kind: "audio", codec: "flac", alpha: false },
  png: { ext: ".png", kind: "image", codec: "png", alpha: true },
  jpeg: { ext: ".jpg", kind: "image", codec: "mjpeg", alpha: false },
  webp: { ext: ".webp", kind: "image", codec: "webp", alpha: true },
} as const;
export type ConversionProfile = keyof typeof CONVERSION_PROFILES;
export const conversionRequestSchema = z.object({
  sourcePaths: z.array(z.string().min(1).max(1024)).min(1).max(64),
  outputDirectory: z.string().min(1).max(1024),
  profile: z.enum(Object.keys(CONVERSION_PROFILES) as [ConversionProfile, ...ConversionProfile[]]),
  maxEdge: z.number().int().min(2).max(7680).optional(),
  crf: z.number().int().min(0).max(40).default(18),
  gifFps: z.number().int().min(1).max(24).default(15),
  allowAlphaFlatten: z.boolean().default(false),
}).strict();
export type ConversionRequest = z.input<typeof conversionRequestSchema>;
export interface ConversionRuntime {
  ffmpegPath: string;
  ffprobePath: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: { index: number; total: number; seconds: number; phase: "encode" | "decode" | "complete" }) => void;
}
interface Stream { index?: number; codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; color_transfer?: string; disposition?: { attached_pic?: number } }
interface Probe { streams?: Stream[]; format?: { duration?: string } }
export async function mediaFileSha256(path: string, options: { signal?: AbortSignal; deadlineEpochMs?: number; maximumBytes?: number } = {}): Promise<string> {
  options.signal?.throwIfAborted();
  const remaining = (options.deadlineEpochMs ?? Date.now() + 30_000) - Date.now();
  if (!Number.isFinite(remaining) || remaining < 1) throw Error("素材雜湊逾時");
  const timeout = AbortSignal.timeout(Math.min(Math.ceil(remaining), 2_147_483_647));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const maximumBytes = options.maximumBytes ?? 16 * 1024 * 1024 * 1024;
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    signal.throwIfAborted(); bytes += chunk.length;
    if (bytes > maximumBytes) throw Error("素材雜湊超出 16 GiB 預算");
    hash.update(chunk);
  }
  return hash.digest("hex");
}
function stopped(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function within(root: string, path: string): boolean { const r = relative(root, path); return !isAbsolute(r) && r !== ".." && !r.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`); }
async function localExisting(path: string, root?: string): Promise<string> {
  assertLocalMediaPath(path);
  if (!isAbsolute(path)) throw Error("轉檔需要本機絕對路徑");
  const canonical = await realpath(path); assertLocalMediaPath(canonical);
  if (root && !within(root, canonical)) throw Error("轉檔路徑必須位於工作區內");
  return canonical;
}
// Real child close is the terminal signal. Bound logs and kill only this child.
export function runConversionProcess(executable: string, args: string[], signal?: AbortSignal, timeoutMs = 120_000, onTime?: (seconds: number) => void): Promise<string> {
  stopped(signal);
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", pending = "", terminalError: Error | undefined;
    const abort = () => { terminalError = new Error("轉檔已取消"); child.kill(); };
    const timer = setTimeout(() => { terminalError = new Error("轉檔逾時"); child.kill(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", bytes => {
      const text = String(bytes); stdout = (stdout + text).slice(-256_000); pending += text;
      const rows = pending.split(/\r?\n/); pending = rows.pop()!.slice(-4096);
      for (const row of rows) if (row.startsWith("out_time_us=")) {
        const seconds = Number(row.slice(12)) / 1_000_000;
        if (Number.isFinite(seconds) && seconds >= 0) (() => { try { onTime?.(seconds); } catch { /* Observer cannot alter job state. */ } })();
      }
    });
    child.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-16_000); });
    child.on("error", error => { terminalError = error; });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (terminalError) reject(terminalError);
      else if (code !== 0) reject(new Error(`轉檔程序 exit ${code}: ${stderr.slice(-2000)}`));
      else accept(stdout);
    });
  });
}
async function probe(path: string, runtime: ConversionRuntime, remainingMs: number): Promise<Probe> {
  return JSON.parse(await runConversionProcess(runtime.ffprobePath, ["-v", "error", ...mediaUtilityInputOptions(path), "-show_streams", "-show_format", "-of", "json", path], runtime.signal, Math.min(remainingMs, 30_000))) as Probe;
}
function encoderArgs(profile: ConversionProfile, crf: number): string[] {
  switch (profile) {
    case "mp4-h264": case "mov-h264": case "mkv-h264": return ["-c:v", "libx264", "-crf", String(crf), "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", ...(profile !== "mkv-h264" ? ["-movflags", "+faststart"] : [])];
    case "mp4-hevc": return ["-c:v", "libx265", "-crf", String(crf), "-preset", "medium", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
    case "avi-mpeg4": return ["-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-c:a", "libmp3lame", "-b:a", "192k"];
    case "webm-vp9": return ["-c:v", "libvpx-vp9", "-crf", String(crf), "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "128k"];
    case "mov-alpha-qtrle": return ["-c:v", "qtrle", "-pix_fmt", "argb", "-c:a", "pcm_s16le"];
    case "gif": return ["-loop", "0"];
    case "mp3": return ["-c:a", "libmp3lame", "-b:a", "320k"];
    case "wav": return ["-c:a", "pcm_s16le"];
    case "aac": return ["-c:a", "aac", "-b:a", "256k"];
    case "flac": return ["-c:a", "flac"];
    case "png": return ["-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgba"];
    case "jpeg": return ["-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p"];
    case "webp": return ["-frames:v", "1", "-c:v", "libwebp", "-quality", "90", "-pix_fmt", "bgra"];
  }
}
export async function convertMediaBatch(input: ConversionRequest, runtime: ConversionRuntime) {
  const request = conversionRequestSchema.parse(input), profile = CONVERSION_PROFILES[request.profile];
  if (!Number.isFinite(runtime.timeoutMs ?? 120_000) || (runtime.timeoutMs ?? 120_000) < 1) throw Error("無效逾時設定");
  const deadlineEpochMs = Date.now() + (runtime.timeoutMs ?? 120_000);
  const remainingMs = () => { stopped(runtime.signal); const remaining = deadlineEpochMs - Date.now(); if (remaining < 1) throw Error("批次轉檔總期限已到"); return Math.ceil(remaining); };
  const hashFile = (path: string) => mediaFileSha256(path, { signal: runtime.signal, deadlineEpochMs });
  const workspace = runtime.workspaceRoot ? await localExisting(resolve(runtime.workspaceRoot)) : undefined;
  const directory = await localExisting(request.outputDirectory, workspace);
  if (!(await stat(directory)).isDirectory()) throw Error("輸出位置不是資料夾");
  const sources = await Promise.all(request.sourcePaths.map(path => localExisting(path, workspace)));
  const results: Array<{ sourcePath: string; status: "COMPLETE" | "FAILED"; outputPath?: string; sourceSha256?: string; outputSha256?: string; bytes?: number; probe?: Probe; warnings?: string[]; error?: string }> = [];
  for (const [index, source] of sources.entries()) {
    remainingMs();
    const session = join(directory, `.editkin-convert-${randomUUID()}`), temporary = join(session, `output${profile.ext}`);
    await mkdir(session);
    try {
      if (!(await stat(source)).isFile()) throw Error("來源不是一般檔案");
      const sourceSha256 = await hashFile(source); stopped(runtime.signal);
      const before = await probe(source, runtime, remainingMs()), video = before.streams?.find(s => s.codec_type === "video" && !s.disposition?.attached_pic), audio = before.streams?.find(s => s.codec_type === "audio");
      if (profile.kind === "audio" ? !audio : !video) throw Error(profile.kind === "audio" ? "來源沒有音訊" : "來源沒有可轉換的畫面");
      if (["smpte2084", "arib-std-b67"].includes(video?.color_transfer ?? "")) throw Error("HDR 素材需要明確色彩轉換，此工具不會默默當成 SDR");
      const alpha = /^(rgba|bgra|argb|abgr|yuva|gbrap|ya|pal8)/.test(video?.pix_fmt ?? "");
      if (profile.kind !== "audio" && alpha && !profile.alpha && !request.allowAlphaFlatten) throw Error("此格式會移除透明通道；請選透明格式或明確允許移除");
      const duration = Number(before.format?.duration ?? 0);
      if (request.profile === "gif" && (!Number.isFinite(duration) || duration <= 0 || duration > 30)) throw Error("GIF 僅接受 30 秒以內的有時長影片");
      const args = ["-hide_banner", "-nostdin", "-v", "error", "-n", "-progress", "pipe:1", ...mediaUtilityInputOptions(source), "-i", source];
      args.push(...(profile.kind === "audio" ? ["-map", "0:a:0", "-vn"] : ["-map", `0:${video!.index}`, ...(profile.kind === "image" || request.profile === "gif" ? ["-an"] : ["-map", "0:a:0?"])]));
      if (profile.kind !== "audio") {
        const edge = request.maxEdge ?? (request.profile === "gif" ? 720 : undefined);
        const filters: string[] = [];
        if (edge) filters.push(`scale=w='min(iw,${edge})':h='min(ih,${edge})':force_original_aspect_ratio=decrease:flags=lanczos`);
        if (profile.kind === "video" && !profile.alpha && request.profile !== "gif") filters.push("pad=ceil(iw/2)*2:ceil(ih/2)*2");
        if (request.profile === "gif") filters.push(`fps=${request.gifFps}`, "split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a");
        if (filters.length) args.push("-vf", filters.join(","));
      }
      args.push(...encoderArgs(request.profile, request.crf), "-map_metadata", "-1", temporary);
      const emit = (phase: "encode" | "decode" | "complete") => (seconds: number) => { try { runtime.onProgress?.({ index, total: sources.length, seconds, phase }); } catch { /* Progress is observational. */ } };
      await runConversionProcess(runtime.ffmpegPath, args, runtime.signal, remainingMs(), emit("encode"));
      const after = await probe(temporary, runtime, remainingMs()), outputStream = after.streams?.find(s => s.codec_type === (profile.kind === "audio" ? "audio" : "video"));
      if (outputStream?.codec_name !== profile.codec) throw Error("輸出編碼與選擇格式不一致");
      if (alpha && profile.alpha && !/^(rgba|bgra|argb|abgr|yuva|gbrap|ya)/.test(outputStream.pix_fmt ?? "")) throw Error("輸出沒有透明通道");
      // Independent full decode, including all optional audio, before publication.
      await runConversionProcess(runtime.ffmpegPath, ["-hide_banner", "-nostdin", "-v", "error", "-xerror", ...mediaUtilityInputOptions(temporary), "-i", temporary, "-map", "0:v?", "-map", "0:a?", "-f", "null", "-"], runtime.signal, remainingMs(), emit("decode"));
      if (sourceSha256 !== await hashFile(source)) throw Error("轉檔期間來源變動，未發佈結果");
      if (await localExisting(directory, workspace) !== directory) throw Error("輸出位置變動");
      const bytes = (await stat(temporary)).size, outputSha256 = await hashFile(temporary); remainingMs();
      if (bytes <= 0) throw Error("轉檔輸出為空");
      const stem = basename(source, extname(source)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100) || "media";
      // Atomic hard-link creation fails if a concurrent file already exists. No -y or rename-overwrite.
      const outputPath = join(directory, `${stem}-${request.profile}-${randomUUID().slice(0, 8)}${profile.ext}`);
      await link(temporary, outputPath);
      results.push({ sourcePath: source, status: "COMPLETE", outputPath, sourceSha256, outputSha256, bytes, probe: after,
        warnings: [...(profile.kind === "image" ? ["圖片模式只取第一個畫面；動畫請選 GIF 或影片"] : []), ...(alpha && !profile.alpha && profile.kind !== "audio" ? ["已依明確要求移除透明通道"] : [])] });
      emit("complete")(Number.isFinite(duration) ? duration : 0);
    } catch (error) {
      if (runtime.signal?.aborted) throw error;
      results.push({ sourcePath: source, status: "FAILED", error: error instanceof Error ? error.message : String(error) });
    } finally { await rm(session, { recursive: true, force: true }); }
  }
  return { schema: "editkin.media-conversion/v1" as const, status: results.every(r => r.status === "COMPLETE") ? "COMPLETE" : "PARTIAL_OR_FAILED", utilityOnly: true, projectModified: false, artworkAccepted: false, results };
}
