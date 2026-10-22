import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withMediaCachePublishLock } from "./mediaCachePublishLock";
import { assertLocalMediaPath } from "../shared/localMediaPath";

/**
 * Subject matte v1: a per-frame person matte stored as a derived media asset keyed by the
 * source SHA-256, beside the preview proxies/waveforms of `mediaDerivatives.ts`.
 *
 * It lives in its own cache namespace (`<cacheRoot>/subject-matte-v1/<sha>/`), so the proxy
 * cache (schema v8, fixed file allow-list) and `MediaDerivatives` are untouched. Persisting a
 * reference inside a project needs the `MediaDerivatives.subjectMatte` schema change written in
 * `.rd/benchmarks/style-system-20261022/SUBJECT_MATTE_RESULT.md`; until then the cache lookup by
 * source SHA is the binding.
 *
 * Producer: `scripts/subject-matte/subject_matte_v1.py` (MediaPipe person segmentation, Apache-2.0).
 * A matte is diagnostic: technically valid, never an art or human-approval claim.
 */
export const SUBJECT_MATTE_CACHE_NAMESPACE = "subject-matte-v1";
export const SUBJECT_MATTE_RECEIPT_SCHEMA = "editkin.subject-matte-receipt/v1";
export const SUBJECT_MATTE_DERIVATIVE_SCHEMA = "editkin.subject-matte-derivative/v1";
export type SubjectMatteFormatV1 = "gray" | "gray16" | "alpha8" | "alpha16";
export type SubjectMatteModelV1 = "selfie" | "pose" | "selfie+pose" | "selfie+deeplab";

const FORMAT_PIXELS: Record<SubjectMatteFormatV1, { pixelFormat: string; trackMatteMode: "luma" | "alpha" }> = {
  gray: { pixelFormat: "gray", trackMatteMode: "luma" }, gray16: { pixelFormat: "gray16le", trackMatteMode: "luma" },
  alpha8: { pixelFormat: "bgra", trackMatteMode: "alpha" }, alpha16: { pixelFormat: "gbrap16le", trackMatteMode: "alpha" },
};
const SHA = /^[a-f0-9]{64}$/;

/** What a project needs to composite with a subject matte (see `behindSubjectRecipeV1.ts`). */
export interface SubjectMatteMediaV1 {
  schema: typeof SUBJECT_MATTE_DERIVATIVE_SCHEMA;
  sourceSha256: string;
  matteUri: string;
  matteSha256: string;
  matteBytes: number;
  receiptUri: string;
  width: number;
  height: number;
  frames: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  matteFormat: SubjectMatteFormatV1;
  pixelFormat: string;
  /** Renderer track-matte mode this file is made for. Alpha mattes read identically in FFmpeg and native paths. */
  trackMatteMode: "luma" | "alpha";
  models: Array<{ id: string; sha256: string; licence: "Apache-2.0" }>;
  licence: "Apache-2.0";
  qualityState: "diagnostic";
  generatedAt: string;
}

interface CacheManifestV1 {
  schema: "editkin.subject-matte-cache/v1";
  sourceSha256: string;
  files: Record<"matte.mkv" | "receipt.json", { bytes: number; sha256: string }>;
  derivative: Omit<SubjectMatteMediaV1, "matteUri" | "receiptUri">;
}

export interface SubjectMatteRequestV1 {
  sourcePath: string;
  cacheRoot: string;
  /** Absolute path of `scripts/subject-matte/subject_matte_v1.py` (or its packaged copy). */
  scriptPath: string;
  pythonPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  format?: SubjectMatteFormatV1;
  model?: SubjectMatteModelV1;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with the producer's `editkin.subject-matte-progress/v1` file contents. */
  onProgress?(progress: { stage: string; framesDone: number; framesExpected: number | null }): void;
}

export interface SubjectMatteResultV1 { derivative: SubjectMatteMediaV1; cacheHit: boolean }

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Pure admission of the producer receipt. Throws a SUBJECT_MATTE_* code on any mismatch. */
export function parseSubjectMatteReceiptV1(receipt: unknown, expected: { sourceSha256: string; matteUri: string; receiptUri: string; format?: SubjectMatteFormatV1 }): SubjectMatteMediaV1 {
  if (!isRecord(receipt) || receipt.schema !== SUBJECT_MATTE_RECEIPT_SCHEMA || receipt.status !== "GREEN" || receipt.qualityState !== "diagnostic") throw Error("SUBJECT_MATTE_RECEIPT_SCHEMA");
  const source = receipt.source, output = receipt.output, licence = receipt.licence, models = receipt.models;
  if (!isRecord(source) || !isRecord(output) || !isRecord(licence) || !Array.isArray(models)) throw Error("SUBJECT_MATTE_RECEIPT_SCHEMA");
  if (!SHA.test(expected.sourceSha256) || source.sha256 !== expected.sourceSha256) throw Error("SUBJECT_MATTE_SOURCE_IDENTITY_CHANGED");
  if (licence.spdx !== "Apache-2.0" || !models.length || models.some(model => !isRecord(model) || model.licence !== "Apache-2.0" || typeof model.id !== "string" || !SHA.test(String(model.sha256)))) throw Error("SUBJECT_MATTE_LICENCE_NOT_APACHE_2");
  const format = output.matteFormat as SubjectMatteFormatV1;
  const pixels = FORMAT_PIXELS[format];
  if (!pixels || (expected.format && expected.format !== format) || output.pixelFormat !== pixels.pixelFormat || output.trackMatteMode !== pixels.trackMatteMode
    || output.codec !== "ffv1" || output.range !== "pc") throw Error("SUBJECT_MATTE_FORMAT");
  const rate = output.frameRate, sourceRate = source.frameRate;
  if (!positiveInteger(output.width) || !positiveInteger(output.height) || !positiveInteger(output.frames) || !isRecord(rate) || !isRecord(sourceRate)
    || !positiveInteger(rate.numerator) || !positiveInteger(rate.denominator) || rate.numerator !== sourceRate.numerator || rate.denominator !== sourceRate.denominator
    || output.width !== source.width || output.height !== source.height || output.frames !== source.decodedFrames || output.coversWholeSource !== true
    || !SHA.test(String(output.sha256)) || !positiveInteger(output.bytes)) throw Error("SUBJECT_MATTE_FRAME_CONTRACT");
  return {
    schema: SUBJECT_MATTE_DERIVATIVE_SCHEMA, sourceSha256: expected.sourceSha256, matteUri: expected.matteUri, matteSha256: String(output.sha256), matteBytes: output.bytes,
    receiptUri: expected.receiptUri, width: output.width, height: output.height, frames: output.frames, frameRateNumerator: rate.numerator, frameRateDenominator: rate.denominator,
    matteFormat: format, pixelFormat: pixels.pixelFormat, trackMatteMode: pixels.trackMatteMode,
    models: models.map(model => ({ id: String((model as Record<string, unknown>).id), sha256: String((model as Record<string, unknown>).sha256), licence: "Apache-2.0" as const })),
    licence: "Apache-2.0", qualityState: "diagnostic", generatedAt: typeof receipt.generatedAt === "string" ? receipt.generatedAt : new Date(0).toISOString(),
  };
}

export function subjectMatteCacheDirectory(cacheRoot: string, sourceSha256: string): string {
  if (!SHA.test(sourceSha256)) throw Error("SUBJECT_MATTE_SOURCE_SHA_INVALID");
  return join(cacheRoot, SUBJECT_MATTE_CACHE_NAMESPACE, sourceSha256);
}

/** Valid cached matte for this exact source content, or undefined. Re-hashes the files. */
export async function readSubjectMatteDerivativeV1(cacheRoot: string, sourceSha256: string, format?: SubjectMatteFormatV1): Promise<SubjectMatteMediaV1 | undefined> {
  const directory = subjectMatteCacheDirectory(cacheRoot, sourceSha256);
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as CacheManifestV1;
    if (manifest.schema !== "editkin.subject-matte-cache/v1" || manifest.sourceSha256 !== sourceSha256 || !isRecord(manifest.files)
      || Object.keys(manifest.files).sort().join(",") !== "matte.mkv,receipt.json") return undefined;
    const canonicalRoot = await realpath(directory);
    for (const name of ["matte.mkv", "receipt.json"] as const) {
      const path = join(directory, name), record = manifest.files[name];
      if (!record || !positiveInteger(record.bytes) || !SHA.test(record.sha256) || dirname(await realpath(path)) !== canonicalRoot
        || (await stat(path)).size !== record.bytes || await sha256File(path) !== record.sha256) return undefined;
    }
    const matteUri = join(directory, "matte.mkv"), receiptUri = join(directory, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptUri, "utf8")) as Record<string, unknown>;
    const output = receipt.output as Record<string, unknown> | undefined;
    // The receipt names the producer's staging path; bind by content instead of path.
    const derivative = parseSubjectMatteReceiptV1(receipt, { sourceSha256, matteUri, receiptUri, format });
    if (!output || derivative.matteSha256 !== manifest.files["matte.mkv"].sha256 || derivative.matteBytes !== manifest.files["matte.mkv"].bytes) return undefined;
    return derivative;
  } catch {
    return undefined;
  }
}

function readProgress(path: string, onProgress: SubjectMatteRequestV1["onProgress"]) {
  if (!onProgress) return;
  readFile(path, "utf8").then(text => {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.schema === "editkin.subject-matte-progress/v1" && typeof value.stage === "string" && typeof value.framesDone === "number")
      onProgress({ stage: value.stage, framesDone: value.framesDone, framesExpected: typeof value.framesExpected === "number" ? value.framesExpected : null });
  }).catch(() => undefined);
}

function runProducer(request: SubjectMatteRequestV1, staging: string, timeoutMs: number): Promise<void> {
  const progressPath = join(staging, "progress.json"), cancelPath = join(staging, "cancel.request");
  const args = ["-I", request.scriptPath, request.sourcePath, join(staging, "matte.mkv"), "--receipt", join(staging, "receipt.json"),
    "--format", request.format ?? "alpha8", "--model", request.model ?? "selfie", "--progress", progressPath, "--cancel", cancelPath];
  if (request.ffmpegPath) args.push("--ffmpeg", request.ffmpegPath);
  if (request.ffprobePath) args.push("--ffprobe", request.ffprobePath);
  return new Promise((resolvePromise, reject) => {
    // The producer lowers its own priority (BELOW_NORMAL) and that of its FFmpeg children.
    const child = spawn(request.pythonPath ?? "python", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll); request.signal?.removeEventListener("abort", abort); if (error) reject(error); else resolvePromise(); };
    // Cooperative cancel first (the producer deletes its partial file), then a hard stop.
    const stop = (reason: string) => { writeFile(cancelPath, reason).catch(() => undefined); setTimeout(() => child.kill(), 20_000).unref(); };
    const abort = () => { stop("abort"); finish(Error("SUBJECT_MATTE_CANCELLED")); };
    const timer = setTimeout(() => { stop("timeout"); finish(Error("SUBJECT_MATTE_TIMEOUT")); }, timeoutMs);
    const poll = setInterval(() => readProgress(progressPath, request.onProgress), 1_000);
    request.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { stdout = `${stdout}${String(chunk)}`.slice(-16_000); });
    child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.on("error", error => finish(error));
    child.on("close", code => {
      if (code === 0) return finish();
      let codeName = "SUBJECT_MATTE_PRODUCER_FAILED";
      try { const last = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "{}") as { code?: string }; if (last.code) codeName = `SUBJECT_MATTE_PRODUCER_${last.code}`; } catch { /* keep generic code */ }
      finish(Error(`${codeName}: exit ${code}: ${stdout.slice(-1_000)} ${stderr.slice(-1_000)}`));
    });
  });
}

/** Cache hit by source SHA, else run the producer into a staging folder and publish atomically. */
export async function generateSubjectMatteDerivativeV1(request: SubjectMatteRequestV1): Promise<SubjectMatteResultV1> {
  assertLocalMediaPath(request.sourcePath);
  assertLocalMediaPath(request.scriptPath);
  request.signal?.throwIfAborted();
  const format = request.format ?? "alpha8";
  if (!FORMAT_PIXELS[format]) throw Error("SUBJECT_MATTE_FORMAT");
  const sourceSha256 = await sha256File(request.sourcePath);
  const cached = await readSubjectMatteDerivativeV1(request.cacheRoot, sourceSha256, format);
  if (cached) return { derivative: cached, cacheHit: true };
  const directory = subjectMatteCacheDirectory(request.cacheRoot, sourceSha256);
  await mkdir(dirname(directory), { recursive: true });
  const staging = await mkdtemp(`${directory}.staging-`);
  try {
    await runProducer({ ...request, format }, staging, request.timeoutMs ?? 60 * 60_000);
    const matte = join(staging, "matte.mkv"), receiptPath = join(staging, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
    const staged = parseSubjectMatteReceiptV1(receipt, { sourceSha256, matteUri: matte, receiptUri: receiptPath, format });
    const matteSha = await sha256File(matte), matteBytes = (await stat(matte)).size;
    if (matteSha !== staged.matteSha256 || matteBytes !== staged.matteBytes) throw Error("SUBJECT_MATTE_OUTPUT_HASH_CHANGED");
    if (await sha256File(request.sourcePath) !== sourceSha256) throw Error("SUBJECT_MATTE_SOURCE_CHANGED_DURING_ANALYSIS");
    await rm(join(staging, "progress.json"), { force: true });
    await rm(join(staging, "cancel.request"), { force: true });
    const { matteUri: _m, receiptUri: _r, ...derivative } = staged;
    const manifest: CacheManifestV1 = { schema: "editkin.subject-matte-cache/v1", sourceSha256,
      files: { "matte.mkv": { bytes: matteBytes, sha256: matteSha }, "receipt.json": { bytes: (await stat(receiptPath)).size, sha256: await sha256File(receiptPath) } }, derivative };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const winner = await withMediaCachePublishLock(directory, async () => {
      const existing = await readSubjectMatteDerivativeV1(request.cacheRoot, sourceSha256, format);
      if (existing) return existing;
      if (await exists(directory)) await rename(directory, `${directory}.invalid-${randomUUID()}`);
      if (dirname(resolve(staging)) !== dirname(resolve(directory)) || basename(directory) !== sourceSha256) throw Error("SUBJECT_MATTE_CACHE_TARGET");
      await rename(staging, directory);
      return undefined;
    });
    if (winner) { await rm(staging, { recursive: true, force: true }); return { derivative: winner, cacheHit: true }; }
    const published = await readSubjectMatteDerivativeV1(request.cacheRoot, sourceSha256, format);
    if (!published) throw Error("SUBJECT_MATTE_PUBLISH_VERIFY");
    return { derivative: published, cacheHit: false };
  } catch (error) {
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 });
    throw error;
  }
}
