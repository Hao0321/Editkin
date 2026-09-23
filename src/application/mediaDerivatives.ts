import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AssetKind, MediaColorMetadata, MediaDerivatives } from "../domain/types";
import { inspectMedia } from "./inspectMedia";
import { BROWSER_PROXY_COLOR_CONTRACT, CURRENT_MEDIA_PREVIEW_RECIPE, browserProxyColorPlan, browserProxyFilters, browserThumbnailFilters, type BrowserProxyColorPlan } from "./mediaDerivativeColor";
import { withMediaCachePublishLock } from "./mediaCachePublishLock";

// v6 JPEGs copied display-referred Rec.709 values without the sRGB viewing
// transform. A v7 generation must not silently warm-hit those old thumbnails.
// Bump this schema whenever a transform/encoder/metadata recipe changes.
const CACHE_SCHEMA = 7;
const CACHE_RECIPE = CURRENT_MEDIA_PREVIEW_RECIPE;

interface CacheManifest {
  schemaVersion: 7;
  recipe: typeof CACHE_RECIPE;
  kind: AssetKind;
  producer: typeof BROWSER_PROXY_COLOR_CONTRACT;
  sourceSha256: string;
  generatedAt: string;
  proxy?: string;
  proxyWidth?: number;
  proxyHeight?: number;
  proxyColor?: MediaColorMetadata;
  files: Record<string, { bytes: number; sha256: string }>;
  overlayProxy?: string;
  overlayProxyWidth?: number;
  overlayProxyHeight?: number;
  overlayProxyFrameRateNumerator?: number;
  overlayProxyFrameRateDenominator?: number;
  overlayProxyProfile?: "editkin-small-overlay-performance/v1";
  thumbnail?: string;
  waveform?: string;
}

export interface DerivativeRequest {
  sourcePath: string;
  kind: AssetKind;
  duration: number;
  hasAudio: boolean;
  cacheRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  sourceHeight?: number;
  timeoutMs?: number;
}

export interface DerivativeResult {
  derivatives: MediaDerivatives;
  cacheHit: boolean;
}

function run(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-64_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    // `exit` does not guarantee the child's stdio handles have closed. Wait for
    // close before validating/promoting output, especially on Windows.
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${basename(executable)} 產生媒體快取逾時`));
      else if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${basename(executable)} exit ${code}: ${stderr.slice(-2_000)}`));
    });
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function materialize(directory: string, manifest: CacheManifest): MediaDerivatives {
  return {
    sourceSha256: manifest.sourceSha256,
    previewRecipe: manifest.recipe,
    proxyUri: manifest.proxy ? join(directory, manifest.proxy) : undefined,
    proxyWidth: manifest.proxyWidth,
    proxyHeight: manifest.proxyHeight,
    proxyColor: manifest.proxyColor,
    proxyColorContract: manifest.proxy ? BROWSER_PROXY_COLOR_CONTRACT : undefined,
    overlayProxyUri: manifest.overlayProxy ? join(directory, manifest.overlayProxy) : undefined,
    overlayProxyWidth: manifest.overlayProxyWidth,
    overlayProxyHeight: manifest.overlayProxyHeight,
    overlayProxyFrameRateNumerator: manifest.overlayProxyFrameRateNumerator,
    overlayProxyFrameRateDenominator: manifest.overlayProxyFrameRateDenominator,
    overlayProxyProfile: manifest.overlayProxyProfile,
    thumbnailUri: manifest.thumbnail ? join(directory, manifest.thumbnail) : undefined,
    waveformUri: manifest.waveform ? join(directory, manifest.waveform) : undefined,
    generatedAt: manifest.generatedAt,
  };
}

async function validCache(directory: string, expectedSha: string, expectedKind: AssetKind): Promise<MediaDerivatives | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as CacheManifest;
    if (manifest.schemaVersion !== CACHE_SCHEMA || manifest.recipe !== CACHE_RECIPE || manifest.sourceSha256 !== expectedSha || manifest.kind !== expectedKind
      || manifest.producer !== BROWSER_PROXY_COLOR_CONTRACT || !manifest.files
      || (expectedKind === "video" && (!manifest.proxy || !manifest.overlayProxy || !manifest.thumbnail || !manifest.proxyColor))
      || (manifest.proxyColor && (!["auto", "rec709"].includes(manifest.proxyColor.interpretation)
        || (manifest.proxyColor.interpretation === "rec709" && ([manifest.proxyColor.primaries, manifest.proxyColor.transfer, manifest.proxyColor.matrix].some(value => value !== "bt709") || manifest.proxyColor.range !== "tv"))))
      || (manifest.proxy && (!Number.isSafeInteger(manifest.proxyWidth) || !Number.isSafeInteger(manifest.proxyHeight)
        || manifest.proxyWidth! <= 0 || manifest.proxyHeight! <= 0))
      || (manifest.overlayProxy && (!Number.isSafeInteger(manifest.overlayProxyWidth) || !Number.isSafeInteger(manifest.overlayProxyHeight)
        || !Number.isSafeInteger(manifest.overlayProxyFrameRateNumerator) || !Number.isSafeInteger(manifest.overlayProxyFrameRateDenominator)
        || manifest.overlayProxyWidth! <= 0 || manifest.overlayProxyHeight! <= 0 || manifest.overlayProxyHeight! > 216 || manifest.overlayProxyFrameRateNumerator! <= 0
        || manifest.overlayProxyFrameRateDenominator! <= 0 || manifest.overlayProxyProfile !== "editkin-small-overlay-performance/v1"))) return undefined;
    const names = [manifest.proxy, manifest.overlayProxy, manifest.thumbnail, manifest.waveform].filter((item): item is string => Boolean(item));
    const allowed = new Set(["proxy.mp4", "overlay-proxy.mp4", "thumbnail.jpg", "waveform.png"]);
    if (!names.length || Object.keys(manifest.files).length !== names.length || names.some(name => !allowed.has(name))) return undefined;
    const canonicalRoot = await realpath(directory);
    for (const name of names) {
      const path = join(directory, name), record = manifest.files[name];
      if (!record || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || !/^[a-f0-9]{64}$/.test(record.sha256)
        || dirname(await realpath(path)) !== canonicalRoot || (await stat(path)).size !== record.bytes || await sha256(path) !== record.sha256) return undefined;
    }
    return materialize(directory, manifest);
  } catch {
    return undefined;
  }
}

async function probeProxyVideo(ffprobe: string, path: string, timeoutMs: number, color: MediaColorMetadata): Promise<{ width: number; height: number; frameRateNumerator: number; frameRateDenominator: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,codec_name,pix_fmt,color_primaries,color_transfer,color_space,color_range", "-of", "json", path], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${basename(ffprobe)} 讀取 proxy 尺寸逾時`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-64_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`${basename(ffprobe)} exit ${code}: ${stderr.slice(-2_000)}`);
        const stream = (JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; codec_name?: string; pix_fmt?: string; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string }> }).streams?.[0];
        if (!Number.isSafeInteger(stream?.width) || !Number.isSafeInteger(stream?.height) || stream!.width! <= 0 || stream!.height! <= 0) throw new Error("proxy 沒有有效影片尺寸");
        if (stream!.width! % 2 || stream!.height! % 2 || stream?.codec_name !== "h264" || stream.pix_fmt !== "yuv420p") throw new Error("proxy 不是瀏覽器可解碼的 8-bit H.264 4:2:0 偶數尺寸影片");
        if (color.interpretation === "rec709" && ([stream.color_primaries, stream.color_transfer, stream.color_space].some(value => value !== "bt709") || stream.color_range !== "tv")) throw new Error("HDR 預覽輸出沒有正確的 Rec.709 顯示 metadata");
        const [numerator, denominator] = (stream?.avg_frame_rate ?? "").split("/").map(Number);
        if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) throw new Error("proxy 沒有有效影格率");
        resolvePromise({ width: stream!.width!, height: stream!.height!, frameRateNumerator: numerator, frameRateDenominator: denominator });
      } catch (error) { reject(error); }
    });
  });
}

function boundedEvenHeight(sourceHeight: number | undefined, maximum: number): number {
  const bounded = Math.max(2, Math.min(maximum, Number.isFinite(sourceHeight) ? Math.round(sourceHeight!) : maximum));
  return Math.max(2, Math.floor(bounded / 2) * 2);
}

async function createProxy(ffmpeg: string, ffprobe: string, source: string, output: string, sourceHeight: number | undefined, plan: BrowserProxyColorPlan, timeoutMs: number) {
  const targetHeight = boundedEvenHeight(sourceHeight, 540);
  const base = ["-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", "-i", source,
    "-vf", browserProxyFilters(plan, targetHeight, undefined, sourceHeight), "-map", "0:v:0", "-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p", ...plan.outputArgs, "-movflags", "+faststart"];
  try {
    const hardware = process.platform === "darwin"
      ? ["-c:v", "h264_videotoolbox", "-realtime", "1", "-b:v", "4M"]
      : ["-c:v", "h264_nvenc", "-preset", "p3", "-rc", "vbr", "-cq", "25", "-b:v", "0"];
    await run(ffmpeg, [...base, ...hardware, output], timeoutMs);
  } catch {
    await rm(output, { force: true });
    await run(ffmpeg, [...base, "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "24", output], timeoutMs);
  }
  return probeProxyVideo(ffprobe, output, Math.min(timeoutMs, 60_000), plan.outputColor);
}

async function createOverlayProxy(ffmpeg: string, ffprobe: string, source: string, output: string, sourceHeight: number | undefined, plan: BrowserProxyColorPlan, timeoutMs: number) {
  const targetHeight = boundedEvenHeight(sourceHeight, 216);
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", "-i", source, "-map", "0:v:0", "-an",
    "-vf", browserProxyFilters(plan, targetHeight, 15), "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-tune", "fastdecode", "-pix_fmt", "yuv420p", ...plan.outputArgs,
    "-profile:v", "baseline", "-crf", "28", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-bf", "0",
    "-movflags", "+faststart", output,
  ], timeoutMs);
  const probe = await probeProxyVideo(ffprobe, output, Math.min(timeoutMs, 60_000), plan.outputColor);
  if (probe.frameRateNumerator !== 15 || probe.frameRateDenominator !== 1) throw new Error("overlay proxy 影格率契約不是 15/1");
  return probe;
}

async function promoteCache(staging: string, directory: string, sourceSha: string, kind: AssetKind): Promise<MediaDerivatives | undefined> {
  // Both are exact producer-owned children of the versioned cache, never a
  // user source path. Do not remove/overwrite a valid concurrent generation.
  if (dirname(resolve(staging)) !== dirname(resolve(directory)) || basename(directory) !== sourceSha || !/^[a-f0-9]{64}$/.test(sourceSha)) throw new Error("媒體快取目標不合法");
  return withMediaCachePublishLock(directory, async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const winner = await validCache(directory, sourceSha, kind);
    if (winner) return winner;
    if (await exists(directory)) await rename(directory, `${directory}.invalid-${randomUUID()}`).catch(error => { if (error.code !== "ENOENT") throw error; });
    try { await rename(staging, directory); return undefined; }
    catch (error) {
      if (attempt === 4 || !["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 60 * (attempt + 1)));
    }
  }
  throw new Error("媒體快取無法完成原子保存");
  });
}

export async function generateMediaDerivatives(request: DerivativeRequest): Promise<DerivativeResult> {
  const ffmpeg = request.ffmpegPath ?? "ffmpeg";
  const ffprobe = request.ffprobePath ?? "ffprobe";
  const timeoutMs = request.timeoutMs ?? 30 * 60_000;
  if (!["video", "audio", "image"].includes(request.kind)) throw new Error("不支援的媒體類型");
  const sourceSha256 = await sha256(request.sourcePath);
  const directory = join(request.cacheRoot, `v${CACHE_SCHEMA}`, sourceSha256);
  const cached = await validCache(directory, sourceSha256, request.kind);
  if (cached) return { derivatives: cached, cacheHit: true };

  await mkdir(join(request.cacheRoot, `v${CACHE_SCHEMA}`), { recursive: true });
  const staging = await mkdtemp(join(request.cacheRoot, `v${CACHE_SCHEMA}`, `${sourceSha256}.staging-`));
  const manifest: CacheManifest = { schemaVersion: CACHE_SCHEMA, recipe: CACHE_RECIPE, kind: request.kind, producer: BROWSER_PROXY_COLOR_CONTRACT, sourceSha256, files: {}, generatedAt: new Date().toISOString() };
  try {
    const sourceProbe = await inspectMedia(request.sourcePath, ffprobe);
    if (request.kind === "audio" && !sourceProbe.hasAudio) throw new Error("音訊素材沒有可解碼的聲音軌");
    const colorPlan = request.kind === "audio" ? undefined : browserProxyColorPlan(sourceProbe);
    if (request.kind === "video") {
      if (!sourceProbe.hasVideo || !sourceProbe.height) throw new Error("影片沒有可解碼的影像軌");
      manifest.proxy = "proxy.mp4";
      const dimensions = await createProxy(ffmpeg, ffprobe, request.sourcePath, join(staging, manifest.proxy), sourceProbe.height, colorPlan!, timeoutMs);
      manifest.proxyWidth = dimensions.width;
      manifest.proxyHeight = dimensions.height;
      manifest.proxyColor = colorPlan!.outputColor;
      manifest.overlayProxy = "overlay-proxy.mp4";
      // Main proxy has already received the display transform. Reuse that
      // decoded surface for the smaller derivative, never tone-map it twice.
      const overlay = await createOverlayProxy(ffmpeg, ffprobe, join(staging, manifest.proxy), join(staging, manifest.overlayProxy), dimensions.height,
        { ...colorPlan!, normalization: [], treatment: "source-transfer-preserved" }, timeoutMs);
      manifest.overlayProxyWidth = overlay.width;
      manifest.overlayProxyHeight = overlay.height;
      manifest.overlayProxyFrameRateNumerator = overlay.frameRateNumerator;
      manifest.overlayProxyFrameRateDenominator = overlay.frameRateDenominator;
      manifest.overlayProxyProfile = "editkin-small-overlay-performance/v1";
    }
    if (request.kind === "video" || request.kind === "image") {
      manifest.thumbnail = "thumbnail.jpg";
      const seek = request.kind === "video" ? ["-ss", String(Math.min(5, Math.max(0, request.duration * 0.25)))] : [];
      const thumbnailSource = manifest.proxy ? join(staging, manifest.proxy) : request.sourcePath;
      const thumbnailFilters = browserThumbnailFilters(colorPlan!, Boolean(manifest.proxy)).join(",");
      await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", ...seek, "-i", thumbnailSource, "-frames:v", "1", "-vf", thumbnailFilters, "-q:v", "3", join(staging, manifest.thumbnail)], timeoutMs);
    }
    if (sourceProbe.hasAudio) {
      manifest.waveform = "waveform.png";
      await run(ffmpeg, [
        "-y", "-hide_banner", "-loglevel", "error", "-i", request.sourcePath,
        "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x180:colors=#59d9ff", "-frames:v", "1", join(staging, manifest.waveform),
      ], timeoutMs);
    }
    for (const name of [manifest.proxy, manifest.overlayProxy, manifest.thumbnail, manifest.waveform].filter((name): name is string => Boolean(name))) {
      const path = join(staging, name);
      // A zero-byte/truncated encoder result is not a ready preview.
      const decoded = await run(ffmpeg, ["-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-f", "framemd5", "-"], Math.min(timeoutMs, 60_000));
      if (!decoded.split(/\r?\n/).some(line => /^0,/.test(line))) throw new Error("媒體快取沒有可解碼的影格");
      const size = (await stat(path)).size;
      if (!size) throw new Error("媒體快取產生了空白檔案");
      manifest.files[name] = { bytes: size, sha256: await sha256(path) };
    }
    if (await sha256(request.sourcePath) !== sourceSha256) throw new Error("建立預覽時原片內容改變，請重新加入；未保存不一致的快取。");
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const raced = await promoteCache(staging, directory, sourceSha256, request.kind);
    if (raced) { await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 }); return { derivatives: raced, cacheHit: true }; }
    return { derivatives: materialize(directory, manifest), cacheHit: false };
  } catch (error) {
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 });
    throw error;
  }
}
