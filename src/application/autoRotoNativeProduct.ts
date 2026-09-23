import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeAutoRoto, type NativeAutoRotoReceipt } from "../render/nativeCore";
import {
  createProductAutoRotoRouteReceipt,
  parseProductAutoRotoRouteReceipt,
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
  PRODUCT_AUTO_ROTO_MAX_DURATION_SECONDS,
  PRODUCT_AUTO_ROTO_MAX_FRAMES,
  PRODUCT_AUTO_ROTO_MAX_PREVIEW_BYTES,
  PRODUCT_AUTO_ROTO_MAX_PREVIEW_TOTAL_BYTES,
  PRODUCT_AUTO_ROTO_MAX_RGB_BYTES,
  PRODUCT_AUTO_ROTO_ROUTE_POLICY,
  verifyProductAutoRotoArtifactPaths,
  verifyProductAutoRotoStagingPayloadPaths,
  type ProductAutoRotoRouteReceipt,
} from "./autoRotoProductContract";

export {
  createProductAutoRotoRouteReceipt,
  parseProductAutoRotoRouteReceipt,
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
  PRODUCT_AUTO_ROTO_MAX_DURATION_SECONDS,
  PRODUCT_AUTO_ROTO_MAX_FRAMES,
  PRODUCT_AUTO_ROTO_MAX_RGB_BYTES,
  PRODUCT_AUTO_ROTO_ROUTE_POLICY,
  type ProductAutoRotoRouteReceipt,
} from "./autoRotoProductContract";

export interface AnalyzeProductAutoRotoRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  sourceWidth: number;
  sourceHeight: number;
  initialTime: number;
  initialRect: { x: number; y: number; width: number; height: number };
  sourceSha256?: string;
  temporalStability?: number;
  feather?: number;
  edgeShift?: number;
  contrast?: number;
  corrections?: Array<{ id: string; frame: number; mode: "foreground" | "background"; radius: number; points: Array<{ x: number; y: number }> }>;
}

export interface ProductAutoRotoRuntime {
  ffmpegPath: string;
  nativeCorePath: string;
  cacheRoot: string;
}

export interface ProductAutoRotoAnalysisResult extends NativeAutoRotoReceipt {
  manifestPath: string;
  analyzedSeconds: number;
  elapsedMs: number;
  cacheHit: boolean;
  qualityState: "diagnostic";
  routeReceipt: ProductAutoRotoRouteReceipt;
}

const PRODUCT_AUTO_ROTO_PREVIEW_READ_CONCURRENCY = 4;

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) digest.update(chunk);
  return digest.digest("hex");
}

export function validateAnalyzeProductAutoRotoRequest(request: AnalyzeProductAutoRotoRequest): void {
  if (!request.sourcePath || !Number.isFinite(request.sourceStart) || request.sourceStart < 0 || request.sourceStart > 7 * 24 * 3600
    || !Number.isFinite(request.duration) || request.duration <= 0 || request.duration > PRODUCT_AUTO_ROTO_MAX_DURATION_SECONDS
    || request.sourceStart + request.duration > 7 * 24 * 3600) throw new Error("Auto Roto 時間範圍不合法");
  if (!Number.isFinite(request.fps) || request.fps <= 0 || request.fps > 240
    || !Number.isFinite(request.initialTime) || request.initialTime < 0 || request.initialTime > request.duration) {
    throw new Error("Auto Roto 時間基準不合法");
  }
  if (![request.sourceWidth, request.sourceHeight].every((value) => Number.isInteger(value) && value >= 16 && value <= 32_768)
    || request.sourceWidth / request.sourceHeight < 1 / 8 || request.sourceWidth / request.sourceHeight > 8) {
    throw new Error("Auto Roto 需要合理的素材解析度與長寬比");
  }
  const rect = request.initialRect;
  if (!rect || typeof rect !== "object") throw new Error("Auto Roto 初始框不合法");
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.x < 0 || rect.y < 0 || rect.width < .02 || rect.height < .02 || rect.width > 1 || rect.height > 1
    || rect.x + rect.width > 1 || rect.y + rect.height > 1) throw new Error("Auto Roto 初始框必須完整位於畫面內且至少 2% 大小");
  if (request.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(request.sourceSha256)) {
    throw new Error("Auto Roto sourceSha256 不合法");
  }
  const corrections = request.corrections ?? [];
  if (!Array.isArray(corrections) || corrections.length > 4_096) throw new Error("Auto Roto 修正筆刷數量不合法");
  const correctionIds = new Set<string>();
  let totalCorrectionPoints = 0;
  for (const stroke of corrections) {
    if (!stroke || typeof stroke !== "object" || typeof stroke.id !== "string" || !stroke.id.trim() || stroke.id.length > 128 || correctionIds.has(stroke.id)
      || !Number.isInteger(stroke.frame) || stroke.frame < 0 || !["foreground", "background"].includes(stroke.mode)
      || !Number.isFinite(stroke.radius) || stroke.radius < .001 || stroke.radius > .25 || !Array.isArray(stroke.points)
      || stroke.points.length === 0 || stroke.points.length > 4096
      || stroke.points.some((point) => !point || typeof point !== "object" || !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
      throw new Error("Auto Roto 修正筆刷資料不合法");
    }
    totalCorrectionPoints += stroke.points.length;
    if (totalCorrectionPoints > 1_000_000) throw new Error("Auto Roto 修正筆刷點數超出安全範圍");
    correctionIds.add(stroke.id);
  }
}

export interface ProductAutoRotoSourceIdentity {
  path: string;
  sha256: string;
  bytes: number;
  modifiedMs: number;
  changedMs: number;
  device: number;
  inode: number;
}

export async function verifyProductAutoRotoSourceIdentity(
  sourcePathInput: string,
  claimedSha256?: string,
): Promise<ProductAutoRotoSourceIdentity> {
  if (claimedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(claimedSha256)) throw new Error("Auto Roto sourceSha256 不合法");
  const path = await realpath(resolve(sourcePathInput));
  const before = await stat(path);
  if (!before.isFile() || before.size <= 0) throw new Error("Auto Roto source 不是有效檔案");
  const measured = await sha256File(path);
  const after = await stat(path);
  if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("Auto Roto source 在身分量測期間發生變更");
  }
  if (claimedSha256 !== undefined && claimedSha256 !== measured) throw new Error("Auto Roto source SHA-256 與呼叫端聲明不一致");
  return {
    path,
    sha256: measured,
    bytes: after.size,
    modifiedMs: after.mtimeMs,
    changedMs: after.ctimeMs,
    device: after.dev,
    inode: after.ino,
  };
}

export async function withProductAutoRotoCacheLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 4 * 3600_000 + 15 * 60_000;
  const staleMs = options.staleMs ?? 5 * 3600_000;
  const startedAt = Date.now();
  const token = `${process.pid}:${randomUUID()}`;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try { await handle.writeFile(`${JSON.stringify({ token, createdAt: new Date().toISOString() })}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > staleMs) {
          const stalePath = `${lockPath}.stale-${randomUUID()}`;
          try { await rename(lockPath, stalePath); await rm(stalePath, { force: true }); }
          catch { /* another waiter recovered or the owner released it */ }
          continue;
        }
      } catch { continue; }
      if (Date.now() - startedAt >= timeoutMs) throw new Error("Auto Roto 等待相同 cache key 的分析工作逾時");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(500, 25 + Math.floor((Date.now() - startedAt) / 20))));
    }
  }
  try {
    return await task();
  } finally {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
      if (current.token === token) await rm(lockPath, { force: true });
    } catch { /* lock was already removed or replaced */ }
  }
}

function runFfmpeg(executable: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error("Auto Roto 取樣逾時"));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once("error", (error) => { clearTimeout(timer); rejectRun(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolveRun() : rejectRun(new Error(`Auto Roto FFmpeg 取樣失敗：${stderr}`));
    });
  });
}

type FrozenProductAutoRotoManifest = NativeAutoRotoReceipt & {
  qualityState: "diagnostic";
  routeReceipt: ProductAutoRotoRouteReceipt;
};

export interface ExpectedNativeAutoRotoShape {
  width: number;
  height: number;
  analysisFps: number;
  frameCount: number;
  initialFrame: number;
  correctionStrokesApplied: number;
  correctedFrames: number[];
}

const RAW_NATIVE_RESULT_KEYS = [
  "schema", "engine", "width", "height", "analysisFps", "initialFrame", "sequencePath", "frames",
  "meanBoundaryChatter", "correctionStrokesApplied", "correctedFrames", "alphaRefinement",
  "regionMemoryRouting", "frozen",
] as const;
const FROZEN_NATIVE_RESULT_KEYS = [...RAW_NATIVE_RESULT_KEYS, "sequenceSha256", "sequenceBytes"] as const;
const PRODUCT_MANIFEST_KEYS = [...FROZEN_NATIVE_RESULT_KEYS, "qualityState", "routeReceipt"] as const;
const RAW_FRAME_KEYS = ["frame", "time", "alphaPath", "confidence", "foregroundRatio", "boundaryChatter"] as const;
const FROZEN_FRAME_KEYS = [...RAW_FRAME_KEYS, "previewSha256", "alphaFrameSha256"] as const;
const ROUTING_KEYS = ["schema", "requested", "executed", "candidateAttempted", "deterministicFallback"] as const;
const ALPHA_REFINEMENT_KEYS = [
  "schema", "engine", "appliedFrames", "radius", "backgroundThreshold", "foregroundThreshold", "coarseWeight",
  "temporalStability", "temporalGate", "changedPixels", "fractionalPixels", "solvedPixels", "meanSolveConfidence",
] as const;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const observed = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  return JSON.stringify(observed) === JSON.stringify(sortedExpected);
}

function validNativeProductResult(
  value: unknown,
  expected: ExpectedNativeAutoRotoShape,
  frozen: boolean,
): value is NativeAutoRotoReceipt {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<NativeAutoRotoReceipt>;
  const { width, height, analysisFps, frameCount } = expected;
  const frameBytes = width * height;
  const refinement = result.alphaRefinement;
  const routing = result.regionMemoryRouting;
  const refinementValid = refinement !== undefined && hasExactKeys(refinement, ALPHA_REFINEMENT_KEYS)
    && refinement.schema === "editkin.optical-alpha-refinement-aggregate/v1"
    && refinement.engine === "editkin-self-authored-optical-alpha-refiner/v1"
    && refinement.appliedFrames === frameCount
    && Number.isInteger(refinement.radius) && refinement.radius >= 2 && refinement.radius <= 32
    && [refinement.backgroundThreshold, refinement.foregroundThreshold, refinement.coarseWeight,
      refinement.temporalStability, refinement.temporalGate, refinement.meanSolveConfidence]
      .every((metric) => Number.isFinite(metric) && metric >= 0 && metric <= 1)
    && refinement.backgroundThreshold + .05 < refinement.foregroundThreshold
    && [refinement.changedPixels, refinement.fractionalPixels, refinement.solvedPixels]
      .every((metric) => Number.isSafeInteger(metric) && metric >= 0 && metric <= frameBytes * frameCount)
    && refinement.solvedPixels <= refinement.fractionalPixels;
  const correctedFrames = [...expected.correctedFrames].sort((left, right) => left - right);
  return hasExactKeys(value, frozen ? FROZEN_NATIVE_RESULT_KEYS : RAW_NATIVE_RESULT_KEYS)
    && result.schema === "editkin.auto-roto-matte/v1"
    && result.engine === PRODUCT_AUTO_ROTO_ENGINE
    && routing !== undefined && hasExactKeys(routing, ROUTING_KEYS)
    && routing.schema === "editkin.region-memory-routing/v1"
    && routing.requested === "fixed_baseline"
    && routing.executed === "fixed_baseline"
    && routing.candidateAttempted === false
    && routing.deterministicFallback === false
    && routing.fallbackReason === undefined
    && refinementValid
    && result.frozen === true
    && result.width === width
    && result.height === height
    && result.analysisFps === analysisFps
    && result.initialFrame === expected.initialFrame
    && Array.isArray(result.frames)
    && result.frames.length === frameCount
    && result.frames.every((frame, index) => hasExactKeys(frame, frozen ? FROZEN_FRAME_KEYS : RAW_FRAME_KEYS)
      && frame.frame === index
      && Number.isFinite(frame.time) && frame.time >= 0
      && Number.isFinite(frame.confidence) && frame.confidence >= 0 && frame.confidence <= 1
      && Number.isFinite(frame.foregroundRatio) && frame.foregroundRatio >= 0 && frame.foregroundRatio <= 1
      && Number.isFinite(frame.boundaryChatter) && frame.boundaryChatter >= 0 && frame.boundaryChatter <= 1
      && (!frozen || (typeof frame.previewSha256 === "string" && /^[a-f0-9]{64}$/.test(frame.previewSha256)
        && typeof frame.alphaFrameSha256 === "string" && /^[a-f0-9]{64}$/.test(frame.alphaFrameSha256))))
    && typeof result.sequencePath === "string"
    && (!frozen || (typeof result.sequenceSha256 === "string" && /^[a-f0-9]{64}$/.test(result.sequenceSha256)
      && result.sequenceBytes === frameBytes * frameCount))
    && typeof result.meanBoundaryChatter === "number" && Number.isFinite(result.meanBoundaryChatter)
    && result.meanBoundaryChatter >= 0 && result.meanBoundaryChatter <= 1
    && result.correctionStrokesApplied === expected.correctionStrokesApplied
    && Array.isArray(result.correctedFrames)
    && JSON.stringify([...result.correctedFrames].sort((left, right) => left - right)) === JSON.stringify(correctedFrames)
    && frameBytes > 0;
}

export function parseNativeProductAutoRotoResult(
  value: unknown,
  expected: ExpectedNativeAutoRotoShape,
  options: { frozen?: boolean } = {},
): NativeAutoRotoReceipt {
  if (!validNativeProductResult(value, expected, options.frozen === true)) {
    throw new Error("Auto Roto native product receipt 不符合封閉式 contract");
  }
  return value;
}

function validProductResult(value: unknown, expected: ExpectedNativeAutoRotoShape): value is FrozenProductAutoRotoManifest {
  if (!value || typeof value !== "object" || !hasExactKeys(value, PRODUCT_MANIFEST_KEYS)
    || !validNativeProductResult(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "qualityState" && key !== "routeReceipt")), expected, true)) return false;
  const result = value as FrozenProductAutoRotoManifest;
  if (result.qualityState !== "diagnostic") return false;
  try { parseProductAutoRotoRouteReceipt(result.routeReceipt); return true; } catch { return false; }
}

async function measureFrozenArtifacts(result: NativeAutoRotoReceipt, frameBytes: number): Promise<NativeAutoRotoReceipt> {
  if (result.frames.some((frame) => !frame.alphaPath.toLowerCase().endsWith(".png"))) throw new Error("Auto Roto preview 副檔名不合法");
  const expectedSequenceBytes = frameBytes * result.frames.length;
  if (expectedSequenceBytes <= 0 || expectedSequenceBytes > PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES
    || (await stat(result.sequencePath)).size !== expectedSequenceBytes) throw new Error("Auto Roto matte sequence 長度超出安全 envelope");
  const sequenceDigest = createHash("sha256");
  const alphaHashes: string[] = [];
  const handle = await open(result.sequencePath, "r");
  try {
    for (let frame = 0; frame < result.frames.length; frame += 1) {
      const alpha = Buffer.allocUnsafe(frameBytes);
      let offset = 0;
      while (offset < alpha.length) {
        const read = await handle.read(alpha, offset, alpha.length - offset, frame * frameBytes + offset);
        if (read.bytesRead === 0) throw new Error("Auto Roto matte sequence 提前結束");
        offset += read.bytesRead;
      }
      sequenceDigest.update(alpha);
      alphaHashes.push(sha256(alpha));
    }
  } finally {
    await handle.close();
  }
  const previewHashes = new Array<string>(result.frames.length);
  let totalPreviewBytes = 0;
  for (const frame of result.frames) {
    const bytes = (await stat(frame.alphaPath)).size;
    if (bytes < 32 || bytes > PRODUCT_AUTO_ROTO_MAX_PREVIEW_BYTES
      || (totalPreviewBytes += bytes) > PRODUCT_AUTO_ROTO_MAX_PREVIEW_TOTAL_BYTES) throw new Error("Auto Roto preview PNG 超出安全 envelope");
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(PRODUCT_AUTO_ROTO_PREVIEW_READ_CONCURRENCY, result.frames.length) }, async () => {
    while (cursor < result.frames.length) {
      const index = cursor;
      cursor += 1;
      const preview = await readFile(result.frames[index].alphaPath);
      if (preview.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Auto Roto preview 不是 PNG");
      previewHashes[index] = sha256(preview);
    }
  }));
  return {
    ...result,
    sequenceBytes: expectedSequenceBytes,
    sequenceSha256: sequenceDigest.digest("hex"),
    frames: result.frames.map((frame, index) => ({
      ...frame,
      previewSha256: previewHashes[index],
      alphaFrameSha256: alphaHashes[index],
    })),
  };
}

async function validFrozenArtifacts(result: NativeAutoRotoReceipt, frameBytes: number): Promise<boolean> {
  try {
    const measured = await measureFrozenArtifacts(result, frameBytes);
    return measured.sequenceBytes === result.sequenceBytes && measured.sequenceSha256 === result.sequenceSha256
      && measured.frames.every((frame, index) => frame.previewSha256 === result.frames[index].previewSha256
        && frame.alphaFrameSha256 === result.frames[index].alphaFrameSha256);
  } catch { return false; }
}

async function readValidCachedProductResult(
  manifestPath: string,
  cacheRoot: string,
  expected: ExpectedNativeAutoRotoShape,
): Promise<FrozenProductAutoRotoManifest | undefined> {
  try {
    const cached: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!validProductResult(cached, expected)) return undefined;
    await verifyProductAutoRotoArtifactPaths({ ...cached, manifestPath }, cacheRoot);
    return await validFrozenArtifacts(cached, expected.width * expected.height) ? cached : undefined;
  } catch {
    return undefined;
  }
}

async function assertProductAutoRotoSourceUnchanged(source: ProductAutoRotoSourceIdentity): Promise<void> {
  const before = await stat(source.path);
  if (!before.isFile() || before.size !== source.bytes || before.mtimeMs !== source.modifiedMs || before.ctimeMs !== source.changedMs
    || before.dev !== source.device || before.ino !== source.inode) {
    throw new Error("Auto Roto source 在分析期間發生變更");
  }
  const measured = await sha256File(source.path);
  const after = await stat(source.path);
  if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || before.dev !== after.dev || before.ino !== after.ino || measured !== source.sha256) {
    throw new Error("Auto Roto source 在分析期間發生變更");
  }
}

function retargetProductAutoRotoResult(result: NativeAutoRotoReceipt, outputDir: string): NativeAutoRotoReceipt {
  return {
    ...result,
    sequencePath: join(outputDir, "matte-sequence.alpha8"),
    frames: result.frames.map((frame, index) => ({
      ...frame,
      frame: index,
      alphaPath: join(outputDir, `frame-${String(index).padStart(6, "0")}.png`),
    })),
  };
}

function boundedProductAnalysisDimensions(
  sourceWidth: number,
  sourceHeight: number,
  frameCount: number,
): { width: number; height: number } {
  let width = Math.min(480, Math.max(160, Math.round(Math.min(sourceWidth, 480) / 2) * 2));
  while (width >= 160) {
    const height = Math.max(90, Math.round((width * sourceHeight / sourceWidth) / 2) * 2);
    const alphaBytes = width * height * frameCount;
    if (alphaBytes <= PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES && alphaBytes * 3 <= PRODUCT_AUTO_ROTO_MAX_RGB_BYTES) {
      return { width, height };
    }
    width -= 2;
  }
  throw new Error("Auto Roto 片段在安全記憶體 envelope 內無法分析；請縮短片段或先裁切極端長寬比素材");
}

export async function analyzeProductAutoRoto(
  request: AnalyzeProductAutoRotoRequest,
  runtime: ProductAutoRotoRuntime,
): Promise<ProductAutoRotoAnalysisResult> {
  const startedAt = Date.now();
  validateAnalyzeProductAutoRotoRequest(request);
  const cacheRoot = resolve(runtime.cacheRoot);
  const productRoot = join(cacheRoot, "auto-roto-product");
  await Promise.all([access(runtime.ffmpegPath), access(runtime.nativeCorePath), mkdir(productRoot, { recursive: true })]);
  const source = await verifyProductAutoRotoSourceIdentity(request.sourcePath, request.sourceSha256);
  const analysisFps = Math.min(12, request.fps);
  const expectedFrames = Math.max(1, Math.ceil(request.duration * analysisFps));
  if (expectedFrames > PRODUCT_AUTO_ROTO_MAX_FRAMES) throw new Error("Auto Roto 分析影格超出 product 安全上限");
  const { width, height } = boundedProductAnalysisDimensions(request.sourceWidth, request.sourceHeight, expectedFrames);
  const refine = { temporalStability: request.temporalStability ?? .22, feather: request.feather ?? .01, edgeShift: request.edgeShift ?? 0, contrast: request.contrast ?? 1.7 };
  if (!Number.isFinite(refine.temporalStability) || refine.temporalStability < 0 || refine.temporalStability > .9
    || !Number.isFinite(refine.feather) || refine.feather < 0 || refine.feather > .25
    || !Number.isFinite(refine.edgeShift) || refine.edgeShift < -.25 || refine.edgeShift > .25
    || !Number.isFinite(refine.contrast) || refine.contrast < 0 || refine.contrast > 4) throw new Error("Auto Roto 邊緣精修參數不合法");
  const corrections = request.corrections ?? [];

  const routeReceipt = createProductAutoRotoRouteReceipt();
  const identity = {
    schemaVersion: 11,
    productArtifactPolicy: PRODUCT_AUTO_ROTO_ROUTE_POLICY,
    routeReceiptSha256: routeReceipt.receiptSha256,
    source: { sha256: source.sha256, bytes: source.bytes },
    sourceStart: request.sourceStart,
    duration: request.duration,
    analysisFps,
    width,
    height,
    initialTime: request.initialTime,
    initialRect: request.initialRect,
    ...refine,
    corrections,
    engine: PRODUCT_AUTO_ROTO_ENGINE,
    regionMemoryPolicy: "fixed_baseline",
  };
  const key = sha256(JSON.stringify(identity));
  const outputDir = join(productRoot, key);
  const manifestPath = join(outputDir, "matte-manifest.json");
  const correctedFrames = [...new Set(corrections.map((stroke) => stroke.frame))].sort((left, right) => left - right);
  const expectedResult = {
    width,
    height,
    analysisFps,
    frameCount: expectedFrames,
    initialFrame: Math.min(expectedFrames - 1, Math.max(0, Math.round(request.initialTime * analysisFps))),
    correctionStrokesApplied: corrections.length,
    correctedFrames,
  };
  const cached = await readValidCachedProductResult(manifestPath, cacheRoot, expectedResult);
  if (cached) return { ...cached, manifestPath, analyzedSeconds: request.duration, elapsedMs: Date.now() - startedAt, cacheHit: true };

  return withProductAutoRotoCacheLock(`${outputDir}.lock`, async () => {
    await assertProductAutoRotoSourceUnchanged(source);
    const replay = await readValidCachedProductResult(manifestPath, cacheRoot, expectedResult);
    if (replay) return { ...replay, manifestPath, analyzedSeconds: request.duration, elapsedMs: Date.now() - startedAt, cacheHit: true };

    const workspace = await mkdtemp(join(tmpdir(), "editkin-auto-roto-product-"));
    const stagingRoot = join(productRoot, `.${key}.${randomUUID()}.staging`);
    const rawPath = join(workspace, "frames.rgb24");
    let published = false;
    try {
      await mkdir(stagingRoot);
      const timeoutMs = Math.min(2 * 3600_000, Math.max(5 * 60_000, request.duration * 12_000));
      await runFfmpeg(runtime.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(request.sourceStart), "-t", String(request.duration), "-i", source.path, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `fps=${analysisFps},scale=${width}:${height}:flags=bilinear,format=rgb24`, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath], timeoutMs);
      await assertProductAutoRotoSourceUnchanged(source);
      const rawBytes = (await stat(rawPath)).size;
      const frameBytes = width * height * 3;
      if (rawBytes === 0 || rawBytes > PRODUCT_AUTO_ROTO_MAX_RGB_BYTES || rawBytes % frameBytes !== 0) throw new Error("Auto Roto RGB frame pack 不完整或超出安全上限");
      const frameCount = rawBytes / frameBytes;
      if (frameCount !== expectedFrames || frameCount > PRODUCT_AUTO_ROTO_MAX_FRAMES || width * height * frameCount > PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES
        || corrections.some((stroke) => stroke.frame >= frameCount)) throw new Error("Auto Roto 修正筆刷或分析影格超出安全範圍");
      const initialFrame = Math.min(frameCount - 1, Math.max(0, Math.round(request.initialTime * analysisFps)));
      const staged = await createNativeAutoRoto({
        rawPath,
        outputDir: stagingRoot,
        width,
        height,
        frameCount,
        analysisFps,
        initialFrame,
        initialRect: request.initialRect,
        ...refine,
        corrections,
        regionMemoryPolicy: "fixed_baseline",
      }, runtime.nativeCorePath, timeoutMs);
      const actualExpected = { width, height, analysisFps, frameCount, initialFrame, correctionStrokesApplied: corrections.length, correctedFrames };
      parseNativeProductAutoRotoResult(staged, actualExpected);
      await verifyProductAutoRotoStagingPayloadPaths(staged, productRoot, stagingRoot);
      const frozenStaged = await measureFrozenArtifacts(staged, width * height);
      parseNativeProductAutoRotoResult(frozenStaged, actualExpected, { frozen: true });

      const result = retargetProductAutoRotoResult(frozenStaged, outputDir);
      const enriched: FrozenProductAutoRotoManifest = { ...result, qualityState: "diagnostic", routeReceipt };
      if (!validProductResult(enriched, actualExpected)) throw new Error("Auto Roto product manifest contract 驗證失敗");
      await writeFile(join(stagingRoot, "matte-manifest.json"), JSON.stringify(enriched, null, 2), "utf8");
      await rm(outputDir, { recursive: true, force: true });
      await rename(stagingRoot, outputDir);
      published = true;
      await verifyProductAutoRotoArtifactPaths({ ...enriched, manifestPath }, cacheRoot);
      if (!await validFrozenArtifacts(enriched, width * height)) throw new Error("Auto Roto published artifact 驗證失敗");
      return { ...enriched, manifestPath, analyzedSeconds: request.duration, elapsedMs: Date.now() - startedAt, cacheHit: false };
    } catch (error) {
      if (published) await rm(outputDir, { recursive: true, force: true });
      throw error;
    } finally {
      await Promise.all([rm(stagingRoot, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
    }
  });
}
