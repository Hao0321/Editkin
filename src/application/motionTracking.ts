import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { NativeMotionTrackPlan } from "../render/nativeCore";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { readBoundedFile } from "../shared/boundedFile";
import { mediaUtilityInputOptions } from "./mediaUtilityInputPolicy";
import { runAnalysisProcess } from "./analysisProcess";
import { assertRenderActive, renderLifetimeSignal } from "../render/renderLifetime";
import { motionTrackingSamplingV2, validMotionTrackPlanV2, assertMotionTrackStorageV2 } from "./motionTrackingPolicyV2";

export interface AnalyzeMotionTrackRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  sourceWidth: number;
  sourceHeight: number;
  initialTime: number;
  initialRect: { x: number; y: number; width: number; height: number };
  sourceSha256?: string;
}

export interface MotionTrackAnalysisResult extends NativeMotionTrackPlan {
  analyzedSeconds: number;
  elapsedMs: number;
  cacheHit: boolean;
}

type TrackingRuntime = { ffmpegPath: string; nativeCorePath: string; cacheRoot?: string; workRoot?: string; rawByteBudget?: number; signal?: AbortSignal; timeoutMs?: number };
type Sampling = ReturnType<typeof motionTrackingSamplingV2>;
type FileIdentity = { path: string; bytes: number; modifiedMs: number; changedMs: number; device: number; inode: number; sha256?: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A declared SHA is checked against bytes. No-SHA media retains an explicit metadata identity. */
async function fileIdentity(path: string, hashContents: boolean, signal: AbortSignal): Promise<FileIdentity> {
  signal.throwIfAborted(); const before = await stat(path);
  if (!before.isFile() || !Number.isSafeInteger(before.size)) throw new Error("TRACK_INPUT_FILE_REQUIRED");
  const identity = { path: resolve(path), bytes: before.size, modifiedMs: before.mtimeMs, changedMs: before.ctimeMs, device: before.dev, inode: before.ino };
  let sha256: string | undefined;
  if (hashContents) {
    const hash = createHash("sha256"), stream = createReadStream(path, { highWaterMark: 65_536, signal }); let bytes = 0;
    try { for await (const chunk of stream) { signal.throwIfAborted(); bytes += chunk.length; hash.update(chunk); } }
    finally { if (!stream.closed) await new Promise<void>(done => stream.close(() => done())); }
    if (bytes !== identity.bytes) throw new Error("TRACK_INPUT_CHANGED_DURING_HASH"); sha256 = hash.digest("hex");
  }
  signal.throwIfAborted(); const after = await stat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.dev !== before.dev || after.ino !== before.ino) throw new Error("TRACK_INPUT_CHANGED_DURING_HASH");
  return { ...identity, ...(sha256 ? { sha256 } : {}) };
}
async function inputIdentities(request: AnalyzeMotionTrackRequest, runtime: TrackingRuntime, signal: AbortSignal) {
  const source = await fileIdentity(request.sourcePath, request.sourceSha256 !== undefined, signal);
  if (request.sourceSha256 !== undefined && source.sha256 !== request.sourceSha256.toLowerCase()) throw new Error("TRACK_SOURCE_SHA_MISMATCH");
  return { source, core: await fileIdentity(runtime.nativeCorePath, true, signal), decoder: await fileIdentity(runtime.ffmpegPath, true, signal) };
}
async function verifyIdentities(expected: Awaited<ReturnType<typeof inputIdentities>>, signal: AbortSignal) {
  for (const previous of [expected.source, expected.core, expected.decoder]) {
    const current = await fileIdentity(previous.path, previous.sha256 !== undefined, signal);
    if (digest(current) !== digest(previous)) throw new Error("TRACK_SOURCE_OR_TOOL_CHANGED");
  }
}
async function withTrackingLifetime<T>(runtime: TrackingRuntime, defaultTimeout: number, work: (signal: AbortSignal, remaining: () => number) => Promise<T>) {
  const timeout = runtime.timeoutMs ?? defaultTimeout;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 4 * 3600_000) throw new Error("TRACK_TIMEOUT_INVALID");
  const owner = new AbortController(), start = Date.now(), inherited = renderLifetimeSignal(); let expired = false;
  const abort = () => owner.abort(), check = () => { inherited?.throwIfAborted(); assertRenderActive(); if (owner.signal.aborted) throw Object.assign(new Error(expired ? "動態追蹤總時間逾時" : "動態追蹤已取消"), { name: expired ? "TimeoutError" : "AbortError" }); };
  const sources = [...new Set([runtime.signal, inherited].filter((signal): signal is AbortSignal => Boolean(signal)))];
  for (const signal of sources) { signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }
  const timer = setTimeout(() => { expired = true; owner.abort(); }, timeout);
  try { check(); const result = await work(owner.signal, () => { check(); return Math.max(1, timeout - (Date.now() - start)); }); check(); return result; }
  catch (error) { check(); throw error; }
  finally { clearTimeout(timer); for (const signal of sources) signal.removeEventListener("abort", abort); }
}
async function readTrackCache(path: string | undefined, key: string, sampling: Sampling, duration: number) {
  if (!path) return undefined;
  try {
    const cached = JSON.parse((await readBoundedFile(path, Math.min(64 * 1024 * 1024, sampling.maxFrames * 1200 + 16384))).toString("utf8"));
    if (cached.schemaVersion === 3 && cached.identitySha256 === key && digest(cached.identity) === key
      && validMotionTrackPlanV2(cached.result, sampling) && cached.result.analyzedSeconds === duration && cached.resultSha256 === digest(cached.result)) return cached.result as MotionTrackAnalysisResult;
  } catch { /* An invalid bounded cache is a miss, never an authority. */ }
  return undefined;
}
async function writeTrackCache(path: string, identity: unknown, result: MotionTrackAnalysisResult, signal: AbortSignal) {
  signal.throwIfAborted(); await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`, stored = JSON.parse(JSON.stringify({ ...result, elapsedMs: undefined, cacheHit: undefined }));
  try {
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 3, identity, identitySha256: digest(identity), resultSha256: digest(stored), result: stored })}\n`, { encoding: "utf8", flag: "wx" });
    signal.throwIfAborted(); try { await rename(temporary, path); } catch { await access(path); }
  } finally { await rm(temporary, { force: true }); }
}
async function sampleAndTrack(request: AnalyzeMotionTrackRequest, runtime: TrackingRuntime, sampling: Sampling, inputOptions: string[], workspace: string,
  identities: Awaited<ReturnType<typeof inputIdentities>>, signal: AbortSignal, remaining: () => number, stageTimeout: number) {
  const rawPath = join(workspace, "frames.gray"), { analysisFps, width: analysisWidth, height: analysisHeight } = sampling;
  await runAnalysisProcess(runtime.ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(request.sourceStart), "-t", String(request.duration), ...inputOptions, "-i", resolve(request.sourcePath),
    "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `fps=${analysisFps},scale=${analysisWidth}:${analysisHeight}:flags=bilinear,format=gray`,
    "-frames:v", String(sampling.maxFrames), "-f", "rawvideo", "-pix_fmt", "gray", rawPath,
  ], { timeoutMs: Math.min(stageTimeout, remaining()), signal, label: "動態追蹤取樣", maximumStdout: 1024, maximumStderr: 12_000, captureStdout: false });
  const bytes = (await stat(rawPath)).size, frameBytes = analysisWidth * analysisHeight;
  if (bytes % frameBytes !== 0 || bytes === 0 || bytes > sampling.rawBytes || bytes / frameBytes < sampling.minFrames) throw new Error("動態追蹤取樣輸出不完整或超過預算");
  await verifyIdentities(identities, signal);
  const frameCount = bytes / frameBytes, input = join(workspace, "native-request.json");
  await writeFile(input, JSON.stringify({ rawPath, width: analysisWidth, height: analysisHeight, frameCount, analysisFps,
    initialFrame: Math.min(frameCount - 1, Math.max(0, Math.round(request.initialTime * analysisFps))), initialRect: request.initialRect,
    searchRadius: 0.65, confidenceThreshold: 0.48, maxHoldFrames: 5, maxRotationStep: 8 }), { encoding: "utf8", flag: "wx" });
  const output = await runAnalysisProcess(runtime.nativeCorePath, ["motion-track", input], { timeoutMs: Math.min(stageTimeout, remaining()), signal,
    label: "原生動態追蹤", maximumStdout: Math.min(16 * 1024 * 1024, sampling.maxFrames * 1200 + 16384), maximumStderr: 12_000 });
  const plan = JSON.parse(output.stdout.toString("utf8")) as NativeMotionTrackPlan;
  if (!validMotionTrackPlanV2(plan, sampling)) throw new Error("TRACK_NATIVE_RESULT_INVALID"); return plan;
}
async function analyzeTrackInputs(request: AnalyzeMotionTrackRequest, runtime: TrackingRuntime, sampling: Sampling, inputOptions: string[], startedAt: number,
  stageTimeout: number, signal: AbortSignal, remaining: () => number): Promise<MotionTrackAnalysisResult> {
  const identities = await inputIdentities(request, runtime, signal);
  const identity = { schemaVersion: 3, ...identities, sourceIdentityMode: request.sourceSha256 === undefined ? "metadata" : "sha256",
    sourceStart: request.sourceStart, duration: request.duration, analysisFps: sampling.analysisFps, analysisWidth: sampling.width, analysisHeight: sampling.height,
    initialTime: request.initialTime, initialRect: request.initialRect, engine: "hao-core-rust-motion-track-0.4-planar" };
  const key = digest(identity), cachePath = runtime.cacheRoot ? join(runtime.cacheRoot, "motion-tracking", `${key}.json`) : undefined;
  const cached = await readTrackCache(cachePath, key, sampling, request.duration);
  if (cached) { await verifyIdentities(identities, signal); return { ...cached, elapsedMs: Date.now() - startedAt, cacheHit: true }; }
  const workRoot = resolve(runtime.workRoot ?? runtime.cacheRoot ?? tmpdir()); await mkdir(workRoot, { recursive: true }); signal.throwIfAborted();
  const free = await statfs(workRoot, { bigint: true }); assertMotionTrackStorageV2(Number(free.bavail * free.bsize), sampling);
  if (runtime.cacheRoot && resolve(runtime.cacheRoot) !== workRoot) {
    await mkdir(runtime.cacheRoot, { recursive: true }); const cacheFree = await statfs(runtime.cacheRoot, { bigint: true });
    assertMotionTrackStorageV2(Number(cacheFree.bavail * cacheFree.bsize), { ...sampling, rawBytes: 0 });
  }
  signal.throwIfAborted(); const workspace = await mkdtemp(join(workRoot, "editkin-motion-track-"));
  try {
    const plan = await sampleAndTrack(request, runtime, sampling, inputOptions, workspace, identities, signal, remaining, stageTimeout);
    await verifyIdentities(identities, signal);
    const result: MotionTrackAnalysisResult = { ...plan, analyzedSeconds: request.duration, elapsedMs: Date.now() - startedAt, cacheHit: false };
    if (cachePath) await writeTrackCache(cachePath, identity, result, signal);
    signal.throwIfAborted(); return result;
  } finally {
    if (dirname(resolve(workspace)) !== workRoot) throw new Error("TRACK_WORKSPACE_OUTSIDE_ROOT");
    await rm(workspace, { recursive: true, force: true });
  }
}

function validRect(rect: AnalyzeMotionTrackRequest["initialRect"]): boolean {
  return Object.values(rect).every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width >= 0.02 && rect.height >= 0.02
    && rect.x + rect.width <= 1 && rect.y + rect.height <= 1;
}

export async function analyzeMotionTrack(
  request: AnalyzeMotionTrackRequest,
  runtime: TrackingRuntime,
): Promise<MotionTrackAnalysisResult> {
  request = structuredClone(request); runtime = Object.freeze({ ...runtime });
  assertLocalMediaPath(request.sourcePath);
  const startedAt = Date.now();
  if (!request.sourcePath || !Number.isFinite(request.sourceStart) || request.sourceStart < 0) throw new Error("動態追蹤素材起點不合法");
  if (!Number.isFinite(request.duration) || request.duration <= 0 || request.duration > 4 * 3600) throw new Error("動態追蹤時長不合法");
  if (!Number.isFinite(request.fps) || request.fps <= 0 || request.fps > 240) throw new Error("動態追蹤 fps 不合法");
  if (!Number.isFinite(request.initialTime) || request.initialTime < 0 || request.initialTime > request.duration || !validRect(request.initialRect)) throw new Error("請在片段範圍內框選至少 2% 大小的追蹤區域");
  if (![request.sourceWidth, request.sourceHeight].every((value) => Number.isFinite(value) && value >= 16)) throw new Error("動態追蹤需要有效的素材解析度");
  const sampling = motionTrackingSamplingV2(request, runtime.rawByteBudget);
  const inputOptions = mediaUtilityInputOptions(request.sourcePath);
  if (request.sourceSha256 !== undefined && !/^[a-f\d]{64}$/i.test(request.sourceSha256)) throw new Error("TRACK_SOURCE_SHA_INVALID");
  const stageTimeout = Math.min(2 * 3600_000, Math.max(5 * 60_000, request.duration * 10_000));
  // One lifetime covers both old per-stage budgets plus their I/O; explicit shorter deadlines are opt-in.
  return withTrackingLifetime(runtime, stageTimeout * 2, (signal, remaining) =>
    analyzeTrackInputs(request, runtime, sampling, inputOptions, startedAt, stageTimeout, signal, remaining));
}
