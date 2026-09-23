import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { analyzeSegmentedCaptions, type CaptionSegmentation } from "./segmentedCaptions";
import { runAnalysisProcess } from "./analysisProcess";

export interface WhisperModelDescriptor {
  id: string;
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
  license: "MIT";
}

export const PINNED_WHISPER_MODEL: WhisperModelDescriptor = {
  id: "whisper-small-multilingual-q5_1-2026-08",
  fileName: "ggml-small-q5_1.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
  bytes: 190_085_487,
  sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  license: "MIT",
};

export interface AutomaticCaptionRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  sourceSha256?: string;
  language?: string;
  translationTarget?: "en";
}

export interface AutomaticCaptionCue {
  start: number;
  end: number;
  text: string;
  translation?: { text: string; language: "en" };
}

export interface AutomaticCaptionResult {
  cues: AutomaticCaptionCue[];
  engine: string;
  modelId: string;
  modelSha256: string;
  language: string;
  translationTarget?: "en";
  analyzedSeconds: number;
  elapsedMs: number;
  modelDownloaded: boolean;
  cacheHit: boolean;
  acceleration: "gpu" | "cpu";
}

export interface RawWhisperTranscript {
  format: "srt";
  text: string;
  sha256: string;
}

export interface AutomaticCaptionRecognition {
  status: "usable-cues" | "empty";
  /** Recognition is not VAD or verification of what is physically audible. */
  audioContent: "unverified";
  reason?: "recognition-completed-without-usable-cues";
}

export interface AutomaticCaptionAnalysisResult extends AutomaticCaptionResult {
  recognition: AutomaticCaptionRecognition;
  rawTranscript: RawWhisperTranscript;
  rawTranslation?: RawWhisperTranscript;
  segmentation?: CaptionSegmentation;
}

export class EmptyAutomaticCaptionError extends Error {
  readonly code = "AUTOMATIC_CAPTION_EMPTY";
  constructor(readonly result: AutomaticCaptionAnalysisResult) {
    super("辨識已完成，但沒有可用逐字稿；未產生字幕。這不代表已確認素材沒有語音");
    this.name = "EmptyAutomaticCaptionError";
  }
}

export class AutomaticCaptionParseError extends Error {
  readonly code = "AUTOMATIC_CAPTION_PARSE";
  constructor(block: number) {
    super(`Whisper SRT 第 ${block} 段格式或時間不合法；已停止分析，未將錯誤當成空逐字稿`);
    this.name = "AutomaticCaptionParseError";
  }
}

export type AutomaticCaptionEngine = "ffmpeg-filter" | "whisper-cli";

export interface AutomaticCaptionRuntimeCapability {
  engine: AutomaticCaptionEngine;
  ffmpegWhisperFilter: boolean;
  whisperCli: boolean;
}

interface ModelInspection {
  valid: boolean;
  bytes: number;
  sha256: string;
}

export interface AutomaticCaptionRuntime {
  ffmpegPath: string;
  modelRoot: string;
  cacheRoot?: string;
  modelPath?: string;
  whisperCliPath?: string;
  signal?: AbortSignal;
  segmentTimeoutMs?: number;
  onProgress?: (progress: { phase: "transcript"; completedSegments: number; totalSegments: number; analyzedSeconds: number; totalSeconds: number; cachedSegments: number }) => void | Promise<void>;
}

type CaptionRuntimeProbe = (
  executable: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export function configuredWhisperCliPath(runtime: Pick<AutomaticCaptionRuntime, "whisperCliPath">): string | undefined {
  return runtime.whisperCliPath?.trim() || process.env.EDITKIN_WHISPER_CLI_PATH?.trim() || undefined;
}

/** Read-only cache dependency fingerprint, not a capability or licence verdict.
 * Include the actual bytes (also adjacent shared libraries), not just a path or
 * mtime: installation/repair in the same directory must invalidate a failure.
 * No runtime is launched and no model is downloaded by this inspection.
 */
export async function automaticCaptionRuntimeSha256(runtime: AutomaticCaptionRuntime): Promise<string> {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  async function fileIdentity(path: string | undefined) {
    if (!path) return { state: "unconfigured" };
    const location = resolve(path), locationSha256 = digest(location);
    const handle = await open(location, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!handle) return { state: "missing", locationSha256 };
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("語音辨識依賴不是檔案");
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
      let position = 0;
      while (position < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) throw new Error("語音辨識依賴在讀取期間改變");
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("語音辨識依賴在讀取期間改變");
      return { state: "present", locationSha256, bytes: position, sha256: hash.digest("hex") };
    } finally { await handle.close(); }
  }
  const cli = configuredWhisperCliPath(runtime);
  const libraries: Array<{ name: string; identity: Awaited<ReturnType<typeof fileIdentity>> }> = [];
  if (cli) {
    const directory = dirname(resolve(cli));
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of entries.filter(name => /\.(?:dll|dylib|so(?:\.\d+)*)$/i.test(name)).sort()) {
      libraries.push({ name, identity: await fileIdentity(join(directory, name)) });
    }
  }
  return digest(JSON.stringify({
    schema: "editkin.speech-runtime-identity/v1",
    ffmpeg: await fileIdentity(runtime.ffmpegPath), cli: await fileIdentity(cli), libraries,
    model: await fileIdentity(runtime.modelPath?.trim() || join(runtime.modelRoot, PINNED_WHISPER_MODEL.fileName)),
    expectedModelSha256: PINNED_WHISPER_MODEL.sha256,
  }));
}

function assertSafeModelDescriptor(model: WhisperModelDescriptor): void {
  const url = new URL(model.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Whisper 模型來源必須是無帳密的 HTTPS URL");
  if (!/^[a-z0-9][a-z0-9._-]{2,100}$/i.test(model.fileName) || basename(model.fileName) !== model.fileName) {
    throw new Error("Whisper 模型檔名不安全");
  }
  if (!Number.isSafeInteger(model.bytes) || model.bytes <= 0 || !/^[a-f0-9]{64}$/.test(model.sha256)) {
    throw new Error("Whisper 模型完整性資料不合法");
  }
}

export async function inspectWhisperModel(path: string, model: WhisperModelDescriptor = PINNED_WHISPER_MODEL): Promise<ModelInspection> {
  assertSafeModelDescriptor(model);
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size !== model.bytes) return { valid: false, bytes: fileStat.size, sha256: "" };
    const hash = createHash("sha256");
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
      let position = 0;
      while (position < fileStat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, fileStat.size - position), position);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally { await handle.close(); }
    const sha256 = hash.digest("hex");
    return { valid: sha256 === model.sha256, bytes: fileStat.size, sha256 };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { valid: false, bytes: 0, sha256: "" };
    throw error;
  }
}

async function downloadHttpsFile(url: URL, destination: string, model: WhisperModelDescriptor, redirects = 0, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (redirects > 6) throw new Error("Whisper 模型下載重新導向過多");
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Whisper 模型下載被導向不安全網址");
  await new Promise<void>((resolveDownload, rejectDownload) => {
    const request = httpsRequest(url, {
      signal,
      headers: { "user-agent": "Editkin/0.5 local-model-manager", accept: "application/octet-stream" },
    }, async (response) => {
      try {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          const location = response.headers.location;
          if (!location) throw new Error("Whisper 模型重新導向缺少網址");
          await downloadHttpsFile(new URL(location, url), destination, model, redirects + 1, signal);
          resolveDownload();
          return;
        }
        if (status !== 200) {
          response.resume();
          throw new Error(`Whisper 模型下載失敗：HTTP ${status}`);
        }
        const declaredBytes = Number(response.headers["content-length"] ?? 0);
        if (declaredBytes > model.bytes) throw new Error("Whisper 模型下載大小超出固定上限");
        let received = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > model.bytes) callback(new Error("Whisper 模型下載大小超出固定上限"));
            else callback(null, chunk);
          },
        });
        await pipeline(response, limiter, createWriteStream(destination, { flags: "wx" }), { signal });
        resolveDownload();
      } catch (error) { rejectDownload(error); }
    });
    request.setTimeout(15 * 60_000, () => request.destroy(new Error("Whisper 模型下載逾時")));
    request.on("error", rejectDownload);
    request.end();
  });
}

export async function ensureWhisperModel(
  runtime: Pick<AutomaticCaptionRuntime, "modelRoot" | "modelPath" | "signal">,
  model: WhisperModelDescriptor = PINNED_WHISPER_MODEL,
): Promise<{ path: string; downloaded: boolean }> {
  assertSafeModelDescriptor(model);
  const configuredPath = runtime.modelPath?.trim();
  runtime.signal?.throwIfAborted();
  const destination = configuredPath ? resolve(configuredPath) : join(resolve(runtime.modelRoot), model.fileName);
  const existing = await inspectWhisperModel(destination, model);
  if (existing.valid) return { path: destination, downloaded: false };
  if (configuredPath) {
    throw new Error(`指定的 Whisper 模型未通過 SHA-256／大小驗證：${destination}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${model.fileName}.${process.pid}.${randomUUID()}.download`);
  try {
    await downloadHttpsFile(new URL(model.url), temporary, model, 0, runtime.signal);
    const downloaded = await inspectWhisperModel(temporary, model);
    if (!downloaded.valid) {
      throw new Error(`Whisper 模型完整性驗證失敗：${downloaded.bytes} bytes / ${downloaded.sha256 || "no-sha256"}`);
    }
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    runtime.signal?.throwIfAborted();
    await rm(destination, { force: true });
    await rename(temporary, destination);
    await writeFile(`${destination}.receipt.json`, `${JSON.stringify({ schemaVersion: 1, ...model, installedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    return { path: destination, downloaded: true };
  } finally { await rm(temporary, { force: true }); }
}

function parseTimestamp(value: string): number | undefined {
  const match = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return undefined;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function parseWhisperSrt(input: string, duration = Number.POSITIVE_INFINITY): AutomaticCaptionCue[] {
  const normalized = input.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").trim();
  if (!normalized) return [];
  const cues: AutomaticCaptionCue[] = [];
  for (const [index, block] of normalized.split(/\n\s*\n/).entries()) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if ((timingIndex !== 0 && timingIndex !== 1) || (timingIndex === 1 && !/^\d+$/.test(lines[0].trim()))
      || lines.filter((line) => line.includes("-->")).length !== 1) throw new AutomaticCaptionParseError(index + 1);
    const timestamps = lines[timingIndex].split("-->");
    if (timestamps.length !== 2) throw new AutomaticCaptionParseError(index + 1);
    const [startText, endText] = timestamps;
    const start = parseTimestamp(startText ?? "");
    const end = parseTimestamp((endText ?? "").trim().split(/\s+/)[0]);
    const text = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (start === undefined || end === undefined || end <= start || !text) throw new AutomaticCaptionParseError(index + 1);
    // Preserve the existing exact marker policy; this is not a speech detector.
    // The complete original output is retained by parseWhisperRecognition.
    if (/^[[(](?:silence|music|noise|applause|inaudible|blank audio)[\])]$/i.test(text)) continue;
    const clampedStart = Math.max(0, Math.min(duration, start));
    const clampedEnd = Math.max(clampedStart, Math.min(duration, end));
    if (clampedEnd > clampedStart) cues.push({ start: clampedStart, end: clampedEnd, text });
  }
  return cues;
}

export function parseWhisperRecognition(input: string, duration: number): Pick<AutomaticCaptionAnalysisResult, "cues" | "recognition" | "rawTranscript"> {
  const cues = parseWhisperSrt(input, duration);
  return {
    cues,
    recognition: cues.length
      ? { status: "usable-cues", audioContent: "unverified" }
      : { status: "empty", audioContent: "unverified", reason: "recognition-completed-without-usable-cues" },
    rawTranscript: { format: "srt", text: input, sha256: createHash("sha256").update(input, "utf8").digest("hex") },
  };
}

function validateCaptionRequest(request: AutomaticCaptionRequest): { language: string; translationTarget?: "en" } {
  if (!request.sourcePath || !Number.isFinite(request.sourceStart) || request.sourceStart < 0) throw new Error("自動字幕素材起點不合法");
  if (!Number.isFinite(request.duration) || request.duration <= 0 || request.duration > 24 * 3600) throw new Error("自動字幕素材時長不合法");
  const language = (request.language?.trim().toLowerCase() || "auto");
  if (language !== "auto" && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language)) throw new Error("自動字幕語言代碼不合法");
  const translationTarget = request.translationTarget;
  if (translationTarget !== undefined && translationTarget !== "en") throw new Error("目前本機雙語字幕只支援翻譯成英文");
  if (translationTarget === "en" && language === "en") throw new Error("來源已指定為英文，不需要再翻譯成英文");
  return { language, translationTarget };
}

function captureProcess(executable: string, args: string[], timeoutMs = 10_000, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  if (signal) return runAnalysisProcess(executable, args, { timeoutMs, signal, label: "FFmpeg 字幕能力檢查" }).then(result => ({ stdout: result.stdout.toString("utf8"), stderr: result.stderr }));
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun({ stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error("FFmpeg 字幕能力檢查逾時")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-4_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000_000); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(code === 0 ? undefined : new Error(`FFmpeg 字幕能力檢查失敗：${stderr.trim().slice(-3_000)}`)));
  });
}

export function ffmpegSupportsWhisperFilter(filterInventory: string): boolean {
  return filterInventory
    .split(/\r?\n/)
    .some((line) => /^\s*[.A-Z|]{3,8}\s+whisper(?:\s|$)/.test(line));
}

export function whisperCliSupportsTranscription(helpText: string, requireTranslation = false): boolean {
  const supportsSrt = /(?:^|\s)(?:-osrt|--output-srt)(?:\s|,|$)/m.test(helpText);
  const supportsLanguage = /(?:^|\s)(?:-l|--language)(?:\s|,|$)/m.test(helpText);
  const supportsTranslation = /(?:^|\s)(?:-tr|--translate)(?:\s|,|$)/m.test(helpText);
  return supportsSrt && supportsLanguage && (!requireTranslation || supportsTranslation);
}

export function whisperCaptionSegmentation(language: string) {
  return { maxCharacters: ["auto", "zh", "ja", "ko"].includes(language) ? 18 : 42,
    splitOnWord: ["en", "de", "fr", "es", "it", "pt", "nl"].includes(language) };
}

export function buildWhisperCliArgs(
  modelPath: string,
  audioPath: string,
  outputPrefix: string,
  language: string,
  translateToEnglish = false,
): string[] {
  return [
    "-m", resolve(modelPath), "-f", audioPath, "-l", language,
    ...(translateToEnglish ? ["-tr"] : []),
    "-osrt", "-of", outputPrefix, "-ml", String(whisperCaptionSegmentation(language).maxCharacters),
    // Chinese/Japanese and auto detection cannot use whitespace-only splitting:
    // a full CJK sentence otherwise survives max-len as one enormous "word".
    // Let Whisper emit its own token timestamps, never interpolate cue times.
    ...(whisperCaptionSegmentation(language).splitOnWord ? ["-sow"] : []), "-np",
  ];
}

export async function assertAutomaticCaptionRuntime(
  runtime: Pick<AutomaticCaptionRuntime, "ffmpegPath" | "whisperCliPath" | "signal">,
  translationTarget?: "en",
  probe: CaptionRuntimeProbe = (executable, args) => captureProcess(executable, args, 10000, runtime.signal),
): Promise<AutomaticCaptionRuntimeCapability> {
  const ffmpegPath = resolve(runtime.ffmpegPath);
  await access(ffmpegPath);
  let inventory: { stdout: string; stderr: string };
  try {
    inventory = await probe(ffmpegPath, ["-hide_banner", "-filters"]);
  } catch (error) {
    throw new Error(`無法確認自動字幕 runtime，已在下載模型前停止：${error instanceof Error ? error.message : String(error)}`);
  }
  const ffmpegWhisperFilter = ffmpegSupportsWhisperFilter(`${inventory.stdout}\n${inventory.stderr}`);
  const whisperCliRequired = !ffmpegWhisperFilter || translationTarget === "en";
  if (!whisperCliRequired) {
    return { engine: "ffmpeg-filter", ffmpegWhisperFilter: true, whisperCli: false };
  }

  const whisperCliPath = configuredWhisperCliPath(runtime);
  if (!whisperCliPath) {
    throw new Error(ffmpegWhisperFilter
      ? "這個版本未包含 whisper-cli；雙語字幕已停用，沒有下載模型或改動專案"
      : "這個版本的 FFmpeg 沒有 whisper filter，而且未包含 bundled whisper-cli；自動字幕已停用，沒有下載模型或改動專案");
  }
  const resolvedWhisperCli = resolve(whisperCliPath);
  try {
    await access(resolvedWhisperCli);
  } catch {
    throw new Error(ffmpegWhisperFilter
      ? "找不到這個版本的 whisper-cli；雙語字幕已停用，沒有下載模型或改動專案"
      : "找不到這個版本的 bundled whisper-cli；自動字幕已停用，沒有下載模型或改動專案");
  }
  let whisperHelp: { stdout: string; stderr: string };
  try {
    whisperHelp = await probe(resolvedWhisperCli, ["--help"]);
  } catch (error) {
    throw new Error(`bundled whisper-cli 無法啟動；已在下載模型前停止：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!whisperCliSupportsTranscription(`${whisperHelp.stdout}\n${whisperHelp.stderr}`, translationTarget === "en")) {
    throw new Error(`${translationTarget === "en" ? "雙語字幕" : "自動字幕"}需要的 whisper-cli language／SRT${translationTarget === "en" ? "／translate" : ""} 能力不完整；沒有下載模型或改動專案`);
  }
  return {
    engine: ffmpegWhisperFilter ? "ffmpeg-filter" : "whisper-cli",
    ffmpegWhisperFilter,
    whisperCli: true,
  };
}

export function mergeBilingualCues(original: AutomaticCaptionCue[], translated: AutomaticCaptionCue[]): AutomaticCaptionCue[] {
  return original.map((cue) => {
    const overlaps = translated
      .map((candidate) => ({
        candidate,
        overlap: Math.max(0, Math.min(cue.end, candidate.end) - Math.max(cue.start, candidate.start)),
      }))
      .filter(({ candidate, overlap }) => overlap > 0 && overlap / Math.max(0.001, Math.min(cue.end - cue.start, candidate.end - candidate.start)) >= 0.3)
      .sort((left, right) => left.candidate.start - right.candidate.start);
    const nearest = translated
      .map((candidate) => ({ candidate, distance: Math.abs((candidate.start + candidate.end) / 2 - (cue.start + cue.end) / 2) }))
      .sort((left, right) => left.distance - right.distance)[0];
    const matches = overlaps.length > 0 ? overlaps.map(({ candidate }) => candidate) : nearest && nearest.distance <= Math.max(1, cue.end - cue.start) ? [nearest.candidate] : [];
    const text = [...new Set(matches.map((candidate) => candidate.text.trim()).filter(Boolean))].join(" ");
    return text ? { ...cue, translation: { text, language: "en" } } : cue;
  });
}

async function transcribeWithWhisperCli(
  request: AutomaticCaptionRequest,
  runtime: AutomaticCaptionRuntime,
  modelPath: string,
  language: string,
  translateToEnglish: boolean,
): Promise<ReturnType<typeof parseWhisperRecognition>> {
  const whisperCliPath = configuredWhisperCliPath(runtime);
  if (!whisperCliPath) throw new Error(`${translateToEnglish ? "雙語字幕" : "自動字幕"}缺少本機 whisper-cli runtime`);
  await access(whisperCliPath);
  const workspace = await mkdtemp(join(tmpdir(), translateToEnglish ? "editkin-bilingual-" : "editkin-transcribe-"));
  const audioPath = join(workspace, "speech.wav");
  const outputPrefix = join(workspace, translateToEnglish ? "english" : "transcript");
  const timeoutMs = Math.min(runtime.segmentTimeoutMs ?? 180_000, 180_000);
  try {
    await runAnalysisProcess(runtime.ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", String(request.sourceStart), "-t", String(request.duration),
      "-i", resolve(request.sourcePath), "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath,
    ], { timeoutMs, signal: runtime.signal, label: `${translateToEnglish ? "雙語字幕" : "自動字幕"}音訊準備` });
    await runAnalysisProcess(
      resolve(whisperCliPath),
      buildWhisperCliArgs(modelPath, audioPath, outputPrefix, language, translateToEnglish),
      { cwd: dirname(resolve(whisperCliPath)), timeoutMs, signal: runtime.signal, label: translateToEnglish ? "本機英文翻譯" : "本機 whisper-cli 轉錄" },
    );
    return parseWhisperRecognition(await readFile(`${outputPrefix}.srt`, "utf8"), request.duration);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function translateCaptionsToEnglish(
  request: AutomaticCaptionRequest,
  runtime: AutomaticCaptionRuntime,
  modelPath: string,
  language: string,
): Promise<ReturnType<typeof parseWhisperRecognition>> {
  return transcribeWithWhisperCli(request, runtime, modelPath, language, true);
}

function runWhisperFilter(
  request: AutomaticCaptionRequest,
  runtime: AutomaticCaptionRuntime,
  modelPath: string,
  outputPath: string,
  language: string,
  useGpu: boolean,
): Promise<void> {
  return (async () => {
    const modelName = basename(modelPath);
    const outputName = basename(outputPath);
    const filter = `asetpts=PTS-STARTPTS,whisper=model='${modelName}':language=${language}:queue=3:use_gpu=${useGpu ? "true" : "false"}:destination='${outputName}':format=srt`;
    const args = [
      "-hide_banner", "-nostdin", "-ss", String(request.sourceStart), "-t", String(request.duration), "-i", resolve(request.sourcePath),
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", filter, "-f", "null", "-",
    ];
    await runAnalysisProcess(runtime.ffmpegPath, args, { cwd: dirname(modelPath), timeoutMs: Math.min(runtime.segmentTimeoutMs ?? 180_000, 180_000), signal: runtime.signal, label: "FFmpeg whisper.cpp 轉錄" });
  })();
}

function validCachedResult(value: unknown, request: AutomaticCaptionRequest, language: string, translationTarget?: "en"): value is Omit<AutomaticCaptionAnalysisResult, "cacheHit" | "elapsedMs" | "modelDownloaded"> {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AutomaticCaptionAnalysisResult>;
  if (!(result.modelId === PINNED_WHISPER_MODEL.id && result.modelSha256 === PINNED_WHISPER_MODEL.sha256
    && result.language === language && result.translationTarget === translationTarget && result.analyzedSeconds === request.duration && Array.isArray(result.cues)
    && (result.acceleration === "cpu" || result.acceleration === "gpu") && typeof result.engine === "string"
    && result.rawTranscript?.format === "srt" && typeof result.rawTranscript.text === "string")) return false;
  try {
    const parsed = parseWhisperRecognition(result.rawTranscript.text, request.duration);
    if (result.rawTranscript.sha256 !== parsed.rawTranscript.sha256
      || JSON.stringify(result.recognition) !== JSON.stringify(parsed.recognition)) return false;
    let expectedCues = parsed.cues;
    if (translationTarget && expectedCues.length) {
      if (result.rawTranslation?.format !== "srt" || typeof result.rawTranslation.text !== "string") return false;
      const translated = parseWhisperRecognition(result.rawTranslation.text, request.duration);
      if (result.rawTranslation.sha256 !== translated.rawTranscript.sha256) return false;
      expectedCues = mergeBilingualCues(expectedCues, translated.cues);
      if (expectedCues.some((cue) => !cue.translation?.text.trim())) return false;
    } else if (result.rawTranslation !== undefined) return false;
    return JSON.stringify(result.cues) === JSON.stringify(expectedCues);
  } catch { return false; }
}

export async function analyzeAutomaticCaptionTranscript(
  request: AutomaticCaptionRequest,
  runtime: AutomaticCaptionRuntime,
): Promise<AutomaticCaptionAnalysisResult> {
  const startedAt = Date.now();
  runtime = { ...runtime, whisperCliPath: configuredWhisperCliPath(runtime) };
  const { language, translationTarget } = validateCaptionRequest(request);
  runtime.signal?.throwIfAborted();
  if (request.duration > 60) {
    await assertAutomaticCaptionRuntime(runtime, translationTarget);
    await ensureWhisperModel(runtime);
    const identity = await automaticCaptionRuntimeSha256(runtime), source = await stat(request.sourcePath);
    const result = await analyzeSegmentedCaptions(request, runtime, analyzeAutomaticCaptionTranscript, parseWhisperRecognition);
    runtime.signal?.throwIfAborted();
    const after = await stat(request.sourcePath);
    if (source.size !== after.size || source.mtimeMs !== after.mtimeMs || source.ctimeMs !== after.ctimeMs
      || identity !== await automaticCaptionRuntimeSha256(runtime)) throw Error("來源或語音辨識依賴在分段期間改變，未合併失效逐字稿");
    return result;
  }
  await access(request.sourcePath);
  await access(runtime.ffmpegPath);
  const sourceStat = await stat(request.sourcePath);
  const cacheIdentity = {
    schemaVersion: 6,
    segmentationPolicy: whisperCaptionSegmentation(language),
    source: request.sourceSha256 ?? { path: resolve(request.sourcePath), bytes: sourceStat.size, modifiedMs: sourceStat.mtimeMs },
    sourceStart: request.sourceStart,
    duration: request.duration,
    language,
    translationTarget,
    modelSha256: PINNED_WHISPER_MODEL.sha256,
    runtimeSha256: await automaticCaptionRuntimeSha256(runtime),
  };
  const cacheKey = createHash("sha256").update(JSON.stringify(cacheIdentity)).digest("hex");
  const cachePath = runtime.cacheRoot ? join(runtime.cacheRoot, "automatic-captions", `${cacheKey}.json`) : undefined;
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as { schemaVersion?: number; result?: unknown };
      if (cached.schemaVersion === 6 && validCachedResult(cached.result, request, language, translationTarget)) {
        return { ...cached.result, elapsedMs: Date.now() - startedAt, modelDownloaded: false, cacheHit: true };
      }
    } catch { /* invalid cache is a miss */ }
  }
  const captionRuntime = await assertAutomaticCaptionRuntime(runtime, translationTarget);
  const model = await ensureWhisperModel(runtime);
  runtime.signal?.throwIfAborted();
  const executionRuntimeSha256 = await automaticCaptionRuntimeSha256(runtime);
  const outputPath = join(dirname(model.path), `.editkin-transcript-${process.pid}-${randomUUID()}.srt`);
  let acceleration: "gpu" | "cpu" = captionRuntime.engine === "whisper-cli" && process.platform !== "darwin" ? "cpu" : "gpu";
  try {
    let recognition: ReturnType<typeof parseWhisperRecognition>;
    if (captionRuntime.engine === "whisper-cli") {
      recognition = await transcribeWithWhisperCli(request, runtime, model.path, language, false);
    } else {
      try {
        await runWhisperFilter(request, runtime, model.path, outputPath, language, true);
      } catch (error) {
        runtime.signal?.throwIfAborted();
        if (!/gpu|opencl|cuda|device|backend/i.test(error instanceof Error ? error.message : String(error))) throw error;
        acceleration = "cpu";
        await rm(outputPath, { force: true });
        await runWhisperFilter(request, runtime, model.path, outputPath, language, false);
      }
      recognition = parseWhisperRecognition(await readFile(outputPath, "utf8"), request.duration);
    }
    let cues = recognition.cues;
    let rawTranslation: RawWhisperTranscript | undefined;
    if (translationTarget === "en" && cues.length) {
      const translated = await translateCaptionsToEnglish(request, runtime, model.path, language);
      cues = mergeBilingualCues(cues, translated.cues);
      rawTranslation = translated.rawTranscript;
      if (cues.some((cue) => !cue.translation?.text.trim())) throw new Error("英文翻譯沒有完整對齊原文，已停止套用，避免產生缺行字幕");
    }
    const result: AutomaticCaptionAnalysisResult = {
      cues,
      recognition: recognition.recognition,
      rawTranscript: recognition.rawTranscript,
      ...(rawTranslation ? { rawTranslation } : {}),
      engine: `${captionRuntime.engine === "ffmpeg-filter" ? "ffmpeg-whisper.cpp" : "whisper-cli"}-${PINNED_WHISPER_MODEL.id}${translationTarget ? "+whisper-cli-translate-en" : ""}`,
      modelId: PINNED_WHISPER_MODEL.id,
      modelSha256: PINNED_WHISPER_MODEL.sha256,
      language,
      translationTarget,
      analyzedSeconds: request.duration,
      elapsedMs: Date.now() - startedAt,
      modelDownloaded: model.downloaded,
      cacheHit: false,
      acceleration,
    };
    if (cachePath) {
      runtime.signal?.throwIfAborted();
      // A first-run model download changes the dependency set. Store against
      // the installed bytes so the next identical invocation can reuse it.
      const completedRuntimeSha256 = await automaticCaptionRuntimeSha256(runtime);
      if (completedRuntimeSha256 !== executionRuntimeSha256) throw new Error("語音辨識依賴在分析期間改變；未保存失效逐字稿");
      const completedIdentity = { ...cacheIdentity, runtimeSha256: completedRuntimeSha256 };
      const completedKey = createHash("sha256").update(JSON.stringify(completedIdentity)).digest("hex");
      const completedPath = join(dirname(cachePath), `${completedKey}.json`);
      await mkdir(dirname(cachePath), { recursive: true });
      const temporary = `${completedPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ schemaVersion: 6, result: { ...result, elapsedMs: undefined, modelDownloaded: undefined, cacheHit: undefined } })}\n`, "utf8");
      try { await rename(temporary, completedPath); } catch {
        try { await access(completedPath); } catch (error) { throw error; }
      } finally { await rm(temporary, { force: true }); }
    }
    return result;
  } finally { await rm(outputPath, { force: true }); }
}

/** Caption creation requires actual cues; only material analysis accepts empty recognition. */
export async function transcribeAutomaticCaptions(
  request: AutomaticCaptionRequest,
  runtime: AutomaticCaptionRuntime,
): Promise<AutomaticCaptionResult> {
  const result = await analyzeAutomaticCaptionTranscript(request, runtime);
  if (result.recognition.status === "empty") throw new EmptyAutomaticCaptionError(result);
  const { recognition: _recognition, rawTranscript: _rawTranscript, rawTranslation: _rawTranslation, ...captions } = result;
  return captions;
}
