import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createNativeAutoRoto, type NativeAutoRotoReceipt, type NativeOnnxRotoPackRequest } from "../render/nativeCore";
import { bindSam21VideoPack, createSam21VideoRoto, probeSam21VideoPackRuntime, type BoundSam21VideoPack, type Sam21RuntimeAvailability, type Sam21VideoPackRequest } from "./autoRotoVideoModel";
import {
  AUTO_ROTO_NATIVE_ENGINE,
  AUTO_ROTO_ONNX_ENGINE,
  AUTO_ROTO_SAM21_ENGINE,
  AutoRotoRouteError,
  rejectAutoRotoRoute,
  requireAutoRotoRoute,
  resolveAutoRotoRoute,
  routeAutoRotoNativeFallback,
  type AutoRotoRoutePolicy,
  type AutoRotoRouteReceipt,
} from "./autoRotoModelRouter";

export interface AnalyzeAutoRotoRequest {
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

export interface AutoRotoAnalysisResult extends NativeAutoRotoReceipt {
  manifestPath: string;
  analyzedSeconds: number;
  elapsedMs: number;
  cacheHit: boolean;
  qualityState: "diagnostic" | "measured";
  routeReceipt: AutoRotoRouteReceipt;
  runtimeFallback?: { requestedEngine: "editkin-sam21-video-memory-roto/v1"; executedEngine: "editkin-native-color-temporal-roto/v1"; probe: Sam21RuntimeAvailability };
}

export interface AutoRotoRuntime {
  ffmpegPath: string;
  nativeCorePath: string;
  cacheRoot: string;
  onnxPack?: NativeOnnxRotoPackRequest;
  sam21Pack?: Sam21VideoPackRequest;
  routePolicy?: AutoRotoRoutePolicy;
}

interface BoundOnnxPack {
  request: NativeOnnxRotoPackRequest;
  identity: {
    qualityTier: "production" | "integration_fixture";
    manifestSha256: string;
    modelSha256: string;
    runtimeSha256: string;
    runtimeVersionSha256: string;
    licenseSha256: string;
    allowIntegrationFixture: boolean;
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function bindOnnxPack(pack: NativeOnnxRotoPackRequest): Promise<BoundOnnxPack> {
  const trustedRoot = await realpath(pack.trustedRoot);
  const manifestPath = await realpath(pack.manifestPath);
  if (!isInside(trustedRoot, manifestPath)) throw new Error("Auto Roto ONNX manifest 超出可信 runtime 根目錄");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const entries = [
    ["modelPath", "modelSha256"],
    ["runtimePath", "runtimeSha256"],
    ["runtimeVersionPath", "runtimeVersionSha256"],
    ["licensePath", "licenseSha256"],
  ] as const;
  const observed: Record<string, string> = {};
  for (const [pathKey, hashKey] of entries) {
    const configuredPath = manifest[pathKey];
    const configuredHash = manifest[hashKey];
    if (typeof configuredPath !== "string" || !configuredPath || configuredPath.includes("\\") || isAbsolute(configuredPath)
      || typeof configuredHash !== "string" || !/^[a-f0-9]{64}$/i.test(configuredHash)) {
      throw new Error("Auto Roto ONNX manifest 路徑或 SHA-256 不合法");
    }
    const target = await realpath(resolve(trustedRoot, configuredPath));
    if (!isInside(trustedRoot, target)) throw new Error("Auto Roto ONNX pack 檔案超出可信 runtime 根目錄");
    const actual = sha256(await readFile(target));
    if (actual !== configuredHash.toLowerCase()) throw new Error(`Auto Roto ONNX ${hashKey} 驗證失敗`);
    observed[hashKey] = actual;
  }
  const qualityTier = manifest.qualityTier;
  if (qualityTier !== "production" && qualityTier !== "integration_fixture") throw new Error("Auto Roto ONNX qualityTier 不合法");
  if (qualityTier === "integration_fixture" && pack.allowIntegrationFixture !== true) throw new Error("Auto Roto ONNX integration-only 模型不得用於非 debug route");
  return {
    request: { trustedRoot, manifestPath, allowIntegrationFixture: pack.allowIntegrationFixture === true },
    identity: {
      qualityTier,
      manifestSha256: sha256(manifestBytes),
      modelSha256: observed.modelSha256,
      runtimeSha256: observed.runtimeSha256,
      runtimeVersionSha256: observed.runtimeVersionSha256,
      licenseSha256: observed.licenseSha256,
      allowIntegrationFixture: pack.allowIntegrationFixture === true,
    },
  };
}

function runFfmpeg(executable: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); rejectRun(new Error("Auto Roto 取樣逾時")); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once("error", (error) => { clearTimeout(timer); rejectRun(error); });
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolveRun() : rejectRun(new Error(`Auto Roto FFmpeg 取樣失敗：${stderr}`)); });
  });
}

function validResult(value: unknown, frameBytes: number, frameCount: number, onnxIdentity?: BoundOnnxPack["identity"], sam21Identity?: BoundSam21VideoPack["identity"]): value is NativeAutoRotoReceipt {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<NativeAutoRotoReceipt>;
  const engineMatches = sam21Identity
    ? result.engine === "editkin-sam21-video-memory-roto/v1"
      && result.onnxModel === undefined
      && result.sam2Model?.schema === sam21Identity.schema
      && result.sam2Model.manifestSha256 === sam21Identity.manifestSha256
      && result.sam2Model.hostSha256 === sam21Identity.hostSha256
      && result.sam2Model.pythonSha256 === sam21Identity.pythonSha256
      && result.sam2Model.sourceMarkerSha256 === sam21Identity.sourceMarkerSha256
      && result.sam2Model.configSha256 === sam21Identity.configSha256
      && result.sam2Model.checkpointSha256 === sam21Identity.checkpointSha256
      && result.sam2Model.licenseSha256 === sam21Identity.licenseSha256
      && result.sam2Model.runtimeReceiptSha256 === sam21Identity.runtimeReceiptSha256
      && result.sam2Model.sourceCommit === sam21Identity.sourceCommit
      && result.sam2Model.qualityTier === sam21Identity.qualityTier
      && (sam21Identity.qualityTier !== "production" || (
        result.sam2Model.receiptSha256 === sam21Identity.receiptSha256
        && result.sam2Model.signatureSha256 === sam21Identity.signatureSha256
        && result.sam2Model.inventorySha256 === sam21Identity.inventorySha256
        && result.sam2Model.publisherKeyId === sam21Identity.publisherKeyId
      ))
    : onnxIdentity
    ? result.engine === "editkin-native-onnx-assisted-roto/v1"
      && result.onnxModel?.schema === "editkin.auto-roto-onnx-pack/v1"
      && result.onnxModel.modelSha256 === onnxIdentity.modelSha256
      && result.onnxModel.runtimeSha256 === onnxIdentity.runtimeSha256
      && result.onnxModel.runtimeVersionSha256 === onnxIdentity.runtimeVersionSha256
      && result.onnxModel.licenseSha256 === onnxIdentity.licenseSha256
    : result.engine === "editkin-native-color-temporal-roto/v1" && result.onnxModel === undefined && result.sam2Model === undefined;
  const alphaRefinement = result.alphaRefinement;
  const alphaRefinementMatches = sam21Identity
    ? alphaRefinement === undefined
    : alphaRefinement?.schema === "editkin.optical-alpha-refinement-aggregate/v1"
      && alphaRefinement.engine === "editkin-self-authored-optical-alpha-refiner/v1"
      && alphaRefinement.appliedFrames === frameCount
      && Number.isInteger(alphaRefinement.radius) && alphaRefinement.radius >= 2 && alphaRefinement.radius <= 32
      && [alphaRefinement.backgroundThreshold, alphaRefinement.foregroundThreshold, alphaRefinement.coarseWeight,
        alphaRefinement.temporalStability, alphaRefinement.temporalGate, alphaRefinement.meanSolveConfidence]
        .every((metric) => Number.isFinite(metric) && metric >= 0 && metric <= 1)
      && alphaRefinement.backgroundThreshold + .05 < alphaRefinement.foregroundThreshold
      && [alphaRefinement.changedPixels, alphaRefinement.fractionalPixels, alphaRefinement.solvedPixels]
        .every((metric) => Number.isSafeInteger(metric) && metric >= 0)
      && alphaRefinement.solvedPixels <= alphaRefinement.fractionalPixels;
  return result.schema === "editkin.auto-roto-matte/v1" && engineMatches && alphaRefinementMatches && result.frozen === true
    && Array.isArray(result.frames) && result.frames.length === frameCount && typeof result.sequencePath === "string" && frameBytes > 0;
}

async function validFrozenArtifacts(result: NativeAutoRotoReceipt, frameBytes: number, production: boolean): Promise<boolean> {
  if (result.frames.some((frame) => !frame.alphaPath.toLowerCase().endsWith(".png"))) return false;
  try {
    const sequence = await readFile(result.sequencePath);
    if (sequence.length !== frameBytes * result.frames.length) return false;
    const previews = await Promise.all(result.frames.map((frame) => readFile(frame.alphaPath)));
    if (previews.some((preview) => preview.length < 32 || preview.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")) return false;
    if (!production) return true;
    if (result.sequenceBytes !== sequence.length || result.sequenceSha256 !== sha256(sequence)) return false;
    return result.frames.every((frame, index) => frame.previewSha256 === sha256(previews[index])
      && frame.alphaFrameSha256 === sha256(sequence.subarray(index * frameBytes, (index + 1) * frameBytes)));
  } catch { return false; }
}

export async function analyzeAutoRoto(request: AnalyzeAutoRotoRequest, runtime: AutoRotoRuntime): Promise<AutoRotoAnalysisResult> {
  const startedAt = Date.now();
  if (!request.sourcePath || !Number.isFinite(request.duration) || request.duration <= 0 || request.duration > 4 * 3600) throw new Error("Auto Roto 時長不合法");
  if (!Number.isFinite(request.fps) || request.fps <= 0 || request.fps > 240 || !Number.isFinite(request.initialTime) || request.initialTime < 0 || request.initialTime > request.duration) throw new Error("Auto Roto 時間基準不合法");
  if (![request.sourceWidth, request.sourceHeight].every((value) => Number.isFinite(value) && value >= 16)) throw new Error("Auto Roto 需要有效素材解析度");
  if (!Object.values(request.initialRect).every(Number.isFinite) || request.initialRect.width < 0.02 || request.initialRect.height < 0.02) throw new Error("Auto Roto 初始框至少需要 2% 大小");
  let routeReceipt: AutoRotoRouteReceipt = requireAutoRotoRoute(resolveAutoRotoRoute({
    policy: runtime.routePolicy,
    onnxConfigured: Boolean(runtime.onnxPack),
    sam21Configured: Boolean(runtime.sam21Pack),
  }));
  await Promise.all([
    access(request.sourcePath),
    access(runtime.ffmpegPath),
    access(runtime.nativeCorePath),
    routeReceipt.selectedEngine === AUTO_ROTO_ONNX_ENGINE && runtime.onnxPack ? access(runtime.onnxPack.manifestPath) : Promise.resolve(),
    routeReceipt.selectedEngine === AUTO_ROTO_ONNX_ENGINE && runtime.onnxPack ? access(runtime.onnxPack.trustedRoot) : Promise.resolve(),
    routeReceipt.selectedEngine === AUTO_ROTO_SAM21_ENGINE && runtime.sam21Pack ? access(runtime.sam21Pack.manifestPath) : Promise.resolve(),
    routeReceipt.selectedEngine === AUTO_ROTO_SAM21_ENGINE && runtime.sam21Pack ? access(runtime.sam21Pack.trustedRoot) : Promise.resolve(),
    routeReceipt.selectedEngine === AUTO_ROTO_SAM21_ENGINE && runtime.sam21Pack ? access(runtime.sam21Pack.hostScriptPath) : Promise.resolve(),
    mkdir(runtime.cacheRoot, { recursive: true }),
  ]);
  let boundOnnxPack: BoundOnnxPack | undefined;
  let requestedSam21Pack: BoundSam21VideoPack | undefined;
  try {
    if (routeReceipt.selectedEngine === AUTO_ROTO_ONNX_ENGINE && runtime.onnxPack) boundOnnxPack = await bindOnnxPack(runtime.onnxPack);
    if (routeReceipt.selectedEngine === AUTO_ROTO_SAM21_ENGINE && runtime.sam21Pack) requestedSam21Pack = await bindSam21VideoPack(runtime.sam21Pack);
    routeReceipt = requireAutoRotoRoute(resolveAutoRotoRoute({
      policy: runtime.routePolicy,
      onnxConfigured: Boolean(runtime.onnxPack),
      sam21Configured: Boolean(runtime.sam21Pack),
      onnxQualityTier: boundOnnxPack?.identity.qualityTier,
      sam21QualityTier: requestedSam21Pack?.identity.qualityTier,
    }));
  } catch (error) {
    if (error instanceof AutoRotoRouteError) throw error;
    const rejected = rejectAutoRotoRoute(routeReceipt, "candidate-binding-failed");
    throw new AutoRotoRouteError(rejected, `Auto Roto route 綁定失敗：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const sam21Probe = requestedSam21Pack?.identity.qualityTier === "production" ? await probeSam21VideoPackRuntime(requestedSam21Pack) : undefined;
  const boundSam21Pack = sam21Probe && !sam21Probe.available ? undefined : requestedSam21Pack;
  if (requestedSam21Pack && sam21Probe && !sam21Probe.available) routeReceipt = routeAutoRotoNativeFallback(routeReceipt);
  const runtimeFallback = requestedSam21Pack && sam21Probe && !sam21Probe.available ? {
    requestedEngine: "editkin-sam21-video-memory-roto/v1" as const,
    executedEngine: "editkin-native-color-temporal-roto/v1" as const,
    probe: sam21Probe,
  } : undefined;
  const qualityState: AutoRotoAnalysisResult["qualityState"] = routeReceipt.mode === "product" && boundSam21Pack?.identity.qualityTier === "production" ? "measured" : "diagnostic";
  const source = await stat(request.sourcePath);
  const analysisFps = Math.min(12, request.fps);
  const width = Math.min(480, Math.max(160, Math.round(Math.min(request.sourceWidth, 480) / 2) * 2));
  const height = Math.max(90, Math.round((width * request.sourceHeight / request.sourceWidth) / 2) * 2);
  const expectedFrames = Math.max(1, Math.ceil(request.duration * analysisFps));
  const refine = { temporalStability: request.temporalStability ?? 0.22, feather: request.feather ?? 0.01, edgeShift: request.edgeShift ?? 0, contrast: request.contrast ?? 1.7 };
  if (!Number.isFinite(refine.temporalStability) || refine.temporalStability < 0 || refine.temporalStability > .9 || !Number.isFinite(refine.feather) || refine.feather < 0 || refine.feather > .25 || !Number.isFinite(refine.edgeShift) || refine.edgeShift < -.25 || refine.edgeShift > .25 || !Number.isFinite(refine.contrast) || refine.contrast < 0 || refine.contrast > 4) throw new Error("Auto Roto 邊緣精修參數不合法");
  const corrections = request.corrections ?? [];
  for (const stroke of corrections) {
    if (!stroke.id.trim() || !Number.isInteger(stroke.frame) || stroke.frame < 0 || !["foreground", "background"].includes(stroke.mode) || !Number.isFinite(stroke.radius) || stroke.radius < .001 || stroke.radius > .25 || stroke.points.length === 0 || stroke.points.length > 4096 || stroke.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) throw new Error("Auto Roto 修正筆刷資料不合法");
  }
  const engine = boundSam21Pack ? AUTO_ROTO_SAM21_ENGINE : boundOnnxPack ? AUTO_ROTO_ONNX_ENGINE : AUTO_ROTO_NATIVE_ENGINE;
  const identity = { schemaVersion: 9, alphaRefinementEngine: boundSam21Pack ? undefined : "editkin-self-authored-optical-alpha-refiner/v1", routeReceiptSha256: routeReceipt.receiptSha256, source: request.sourceSha256 ?? { path: resolve(request.sourcePath), bytes: source.size, modifiedMs: source.mtimeMs }, sourceStart: request.sourceStart, duration: request.duration, analysisFps, width, height, initialTime: request.initialTime, initialRect: request.initialRect, ...refine, corrections, engine, onnxPack: boundOnnxPack?.identity, requestedSam21Pack: requestedSam21Pack?.identity, sam21Probe };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const outputDir = join(runtime.cacheRoot, "auto-roto", key);
  const manifestPath = join(outputDir, "matte-manifest.json");
  try {
    const cached = JSON.parse(await readFile(manifestPath, "utf8"));
    if (validResult(cached, width * height, expectedFrames, boundOnnxPack?.identity, boundSam21Pack?.identity)
      && await validFrozenArtifacts(cached, width * height, boundSam21Pack?.identity.qualityTier === "production")) {
      return { ...cached, manifestPath, analyzedSeconds: request.duration, elapsedMs: Date.now() - startedAt, cacheHit: true, qualityState, routeReceipt, runtimeFallback };
    }
  } catch { /* cache miss */ }
  const workspace = await mkdtemp(join(tmpdir(), "editkin-auto-roto-"));
  const rawPath = join(workspace, "frames.rgb24");
  const frameDirectory = join(workspace, "frames");
  try {
    const timeoutMs = Math.min(2 * 3600_000, Math.max(5 * 60_000, request.duration * 12_000));
    let frameCount: number;
    if (boundSam21Pack) {
      await mkdir(frameDirectory, { recursive: true });
      await runFfmpeg(runtime.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(request.sourceStart), "-t", String(request.duration), "-i", resolve(request.sourcePath), "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `fps=${analysisFps},scale=${width}:${height}:flags=lanczos,format=yuvj420p`, "-q:v", "2", "-start_number", "0", join(frameDirectory, "%06d.jpg")], timeoutMs);
      const sampled = (await readdir(frameDirectory)).filter((name) => /^\d{6}\.jpg$/i.test(name)).sort();
      if (!sampled.length || sampled.some((name, index) => name !== `${String(index).padStart(6, "0")}.jpg`)) throw new Error("Auto Roto JPEG frame pack 不完整");
      frameCount = sampled.length;
    } else {
      await runFfmpeg(runtime.ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(request.sourceStart), "-t", String(request.duration), "-i", resolve(request.sourcePath), "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `fps=${analysisFps},scale=${width}:${height}:flags=bilinear,format=rgb24`, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath], timeoutMs);
      const rawBytes = (await stat(rawPath)).size;
      const frameBytes = width * height * 3;
      if (rawBytes === 0 || rawBytes % frameBytes !== 0) throw new Error("Auto Roto RGB frame pack 不完整");
      frameCount = rawBytes / frameBytes;
    }
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    if (corrections.some((stroke) => stroke.frame >= frameCount)) throw new Error("Auto Roto 修正筆刷超出分析影格範圍");
    const common = { outputDirectory: outputDir, width, height, frameCount, analysisFps, initialFrame: Math.min(frameCount - 1, Math.max(0, Math.round(request.initialTime * analysisFps))), initialRect: request.initialRect, ...refine, corrections };
    const result = boundSam21Pack
      ? await createSam21VideoRoto({ frameDirectory, ...common }, boundSam21Pack, join(workspace, "sam21-request.json"), timeoutMs)
      : await createNativeAutoRoto({ rawPath, outputDir, width, height, frameCount, analysisFps, initialFrame: common.initialFrame, initialRect: request.initialRect, ...refine, corrections, onnxPack: boundOnnxPack?.request }, runtime.nativeCorePath, timeoutMs);
    if (!validResult(result, width * height, frameCount, boundOnnxPack?.identity, boundSam21Pack?.identity)
      || !await validFrozenArtifacts(result, width * height, boundSam21Pack?.identity.qualityTier === "production")) throw new Error("Auto Roto matte sequence 驗證失敗");
    const enriched = { ...result, qualityState, routeReceipt, ...(runtimeFallback ? { runtimeFallback } : {}) };
    await writeFile(manifestPath, JSON.stringify(enriched, null, 2), "utf8");
    return { ...enriched, manifestPath, analyzedSeconds: request.duration, elapsedMs: Date.now() - startedAt, cacheHit: false };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
