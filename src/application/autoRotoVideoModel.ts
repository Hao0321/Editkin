import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { NativeAutoRotoReceipt } from "../render/nativeCore";
import { verifyProductionAutoRotoPack, type VerifiedAutoRotoPackReceipt } from "./autoRotoVideoPack";

export interface Sam21VideoPackRequest {
  trustedRoot: string;
  manifestPath: string;
  hostScriptPath: string;
  allowResearchCandidate?: boolean;
}

export interface Sam21VideoRotoRequest {
  frameDirectory: string;
  outputDirectory: string;
  width: number;
  height: number;
  frameCount: number;
  analysisFps: number;
  initialFrame: number;
  initialRect: { x: number; y: number; width: number; height: number };
  temporalStability: number;
  feather: number;
  edgeShift: number;
  contrast: number;
  corrections: Array<{ id: string; frame: number; mode: "foreground" | "background"; radius: number; points: Array<{ x: number; y: number }> }>;
}

export interface BoundSam21VideoPack {
  identity: {
    schema: "editkin.auto-roto-video-pack/v1" | "editkin.auto-roto-video-pack/v2";
    id: string;
    version: string;
    qualityTier: "production" | "research_candidate";
    manifestSha256: string;
    hostSha256: string;
    pythonSha256: string;
    sourceMarkerSha256: string;
    configSha256: string;
    checkpointSha256: string;
    licenseSha256: string;
    runtimeReceiptSha256: string;
    sourceCommit: string;
    precision: "float16";
    selfContained: boolean;
    receiptSha256?: string;
    signatureSha256?: string;
    inventorySha256?: string;
    manifestIdentitySha256?: string;
    publisherKeyId?: string;
  };
  paths: {
    python: string;
    host: string;
    sourceRoot: string;
    config: string;
    checkpoint: string;
    license: string;
    runtimeReceipt: string;
  };
  configName: string;
}

export interface Sam21RuntimeAvailability {
  available: boolean;
  python?: string;
  torch?: string;
  cudaRuntime?: string | null;
  gpu?: string | null;
  reason?: string;
}

type Manifest = Record<string, unknown>;
const runtimeProbeCache = new Map<string, { createdAt: number; promise: Promise<Sam21RuntimeAvailability> }>();

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function textField(manifest: Manifest, key: string, pattern?: RegExp): string {
  const value = manifest[key];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new Error(`Auto Roto SAM 2.1 manifest ${key} 不合法`);
  }
  return value;
}

async function bindFile(root: string, manifest: Manifest, pathKey: string, shaKey: string, signedReceipt?: VerifiedAutoRotoPackReceipt): Promise<{ path: string; sha256: string }> {
  const configuredPath = textField(manifest, pathKey);
  const configuredSha = textField(manifest, shaKey, /^[a-f0-9]{64}$/i).toLowerCase();
  if (configuredPath.includes("\\") || isAbsolute(configuredPath)) throw new Error(`Auto Roto SAM 2.1 ${pathKey} 必須是正規相對路徑`);
  const target = await realpath(resolve(root, configuredPath));
  if (!isInside(root, target)) throw new Error(`Auto Roto SAM 2.1 ${pathKey} 超出可信 runtime 根目錄`);
  if (signedReceipt) {
    const signed = signedReceipt.files.find((file) => file.path === configuredPath);
    if (!signed || signed.sha256 !== configuredSha || (await stat(target)).size !== signed.bytes) throw new Error(`Auto Roto SAM 2.1 ${shaKey} 不等於已驗證 publisher receipt`);
    return { path: target, sha256: configuredSha };
  }
  const observedSha = hash(await readFile(target));
  if (observedSha !== configuredSha) throw new Error(`Auto Roto SAM 2.1 ${shaKey} 驗證失敗`);
  return { path: target, sha256: observedSha };
}

async function assertSelfContainedRuntime(root: string, pythonPath: string, runtimePath: string, runtime: Record<string, unknown>): Promise<void> {
  if (runtime.schema !== "editkin.auto-roto-python-runtime/v2" || runtime.selfContained !== true || runtime.isolated !== true
    || runtime.userSite !== false || runtime.externalImports !== 0 || !runtime.moduleRoots || typeof runtime.moduleRoots !== "object") {
    throw new Error("Auto Roto SAM 2.1 production runtime receipt 不符合離線自足合約");
  }
  const pythonRelative = relative(root, pythonPath).replaceAll("\\", "/");
  if (runtime.pythonPath !== pythonRelative) throw new Error("Auto Roto SAM 2.1 runtime Python 身分不一致");
  const required = ["torch", "torchvision", "numpy", "PIL", "hydra", "omegaconf", "iopath", "sam2"];
  const modules = runtime.moduleRoots as Record<string, unknown>;
  for (const name of required) {
    const configured = modules[name];
    if (typeof configured !== "string" || !configured || configured.includes("\\") || isAbsolute(configured)) {
      throw new Error(`Auto Roto SAM 2.1 runtime module ${name} receipt 不合法`);
    }
    const target = await realpath(resolve(root, configured));
    if (!isInside(root, target)) throw new Error(`Auto Roto SAM 2.1 runtime module ${name} 超出 pack`);
  }
  if (!isInside(root, runtimePath)) throw new Error("Auto Roto SAM 2.1 runtime receipt 超出 pack");
}

export async function bindSam21VideoPack(pack: Sam21VideoPackRequest): Promise<BoundSam21VideoPack> {
  let trustedRoot = await realpath(pack.trustedRoot);
  let manifestPath = await realpath(pack.manifestPath);
  let host = await realpath(pack.hostScriptPath);
  if (!isInside(trustedRoot, manifestPath)) throw new Error("Auto Roto SAM 2.1 manifest 超出可信 runtime 根目錄");
  let manifestBytes: Uint8Array = await readFile(manifestPath);
  let manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as Manifest;
  let productionTrust: Awaited<ReturnType<typeof verifyProductionAutoRotoPack>> | undefined;
  if (manifest.schema === "editkin.auto-roto-video-pack/v2") {
    productionTrust = await verifyProductionAutoRotoPack(trustedRoot, manifestPath);
    trustedRoot = productionTrust.root;
    manifestPath = productionTrust.manifestPath;
    manifestBytes = productionTrust.manifestBytes;
    manifest = productionTrust.manifest;
  } else if (manifest.schema !== "editkin.auto-roto-video-pack/v1") throw new Error("Auto Roto SAM 2.1 manifest schema 不支援");
  const qualityTier = textField(manifest, "qualityTier") as BoundSam21VideoPack["identity"]["qualityTier"];
  if (!(["production", "research_candidate"] as string[]).includes(qualityTier)) throw new Error("Auto Roto SAM 2.1 qualityTier 不合法");
  if (qualityTier === "production" && !productionTrust) throw new Error("Auto Roto SAM 2.1 production pack 必須使用簽章 v2 schema");
  if (qualityTier === "research_candidate" && pack.allowResearchCandidate !== true) throw new Error("Auto Roto SAM 2.1 研究候選包不得用於產品模式");
  const boundHost = productionTrust ? await bindFile(trustedRoot, manifest, "hostPath", "hostSha256", productionTrust.receipt) : undefined;
  if (boundHost && host !== boundHost.path) throw new Error("Auto Roto SAM 2.1 host 不等於簽章 pack host");
  host = boundHost?.path ?? host;
  const hostSha256 = textField(manifest, "hostSha256", /^[a-f0-9]{64}$/i).toLowerCase();
  if (!productionTrust && hash(await readFile(host)) !== hostSha256) throw new Error("Auto Roto SAM 2.1 host SHA-256 驗證失敗");
  const [python, sourceMarker, config, checkpoint, license, runtimeReceipt] = await Promise.all([
    bindFile(trustedRoot, manifest, "pythonPath", "pythonSha256", productionTrust?.receipt),
    bindFile(trustedRoot, manifest, "sourceMarkerPath", "sourceMarkerSha256", productionTrust?.receipt),
    bindFile(trustedRoot, manifest, "configPath", "configSha256", productionTrust?.receipt),
    bindFile(trustedRoot, manifest, "checkpointPath", "checkpointSha256", productionTrust?.receipt),
    bindFile(trustedRoot, manifest, "licensePath", "licenseSha256", productionTrust?.receipt),
    bindFile(trustedRoot, manifest, "runtimeReceiptPath", "runtimeReceiptSha256", productionTrust?.receipt),
  ]);
  const configuredSourceRoot = textField(manifest, "sourceRoot");
  if (configuredSourceRoot.includes("\\") || isAbsolute(configuredSourceRoot)) throw new Error("Auto Roto SAM 2.1 sourceRoot 必須是正規相對路徑");
  const sourceRoot = await realpath(resolve(trustedRoot, configuredSourceRoot));
  if (!isInside(trustedRoot, sourceRoot) || !(await stat(sourceRoot)).isDirectory()) throw new Error("Auto Roto SAM 2.1 sourceRoot 超出可信 runtime 根目錄");
  const runtime = JSON.parse((await readFile(runtimeReceipt.path)).toString("utf8")) as Record<string, unknown>;
  const selfContained = runtime.selfContained === true;
  if (qualityTier === "production" && !selfContained) throw new Error("Auto Roto SAM 2.1 production runtime 必須可攜且自足");
  if (qualityTier === "production") await assertSelfContainedRuntime(trustedRoot, python.path, runtimeReceipt.path, runtime);
  if (manifest.precision !== "float16" || manifest.requiredDevice !== "cuda") throw new Error("Auto Roto SAM 2.1 目前只接受已量測的 CUDA float16 cell");
  return {
    identity: {
      schema: manifest.schema as BoundSam21VideoPack["identity"]["schema"],
      id: textField(manifest, "id", /^[a-z0-9][a-z0-9._-]{2,80}$/),
      version: textField(manifest, "version", /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i),
      qualityTier,
      manifestSha256: hash(manifestBytes),
      hostSha256,
      pythonSha256: python.sha256,
      sourceMarkerSha256: sourceMarker.sha256,
      configSha256: config.sha256,
      checkpointSha256: checkpoint.sha256,
      licenseSha256: license.sha256,
      runtimeReceiptSha256: runtimeReceipt.sha256,
      sourceCommit: textField(manifest, "sourceCommit", /^[a-f0-9]{40}$/i).toLowerCase(),
      precision: "float16",
      selfContained,
      ...(productionTrust ? {
        receiptSha256: productionTrust.receiptSha256,
        signatureSha256: productionTrust.signatureSha256,
        inventorySha256: productionTrust.receipt.inventorySha256,
        manifestIdentitySha256: productionTrust.receipt.manifestIdentitySha256,
        publisherKeyId: productionTrust.receipt.publisherKeyId,
      } : {}),
    },
    paths: { python: python.path, host, sourceRoot, config: config.path, checkpoint: checkpoint.path, license: license.path, runtimeReceipt: runtimeReceipt.path },
    configName: textField(manifest, "configName", /^configs\/[a-zA-Z0-9._/+\-]+\.yaml$/),
  };
}

function runHost(pack: BoundSam21VideoPack, requestPath: string, timeoutMs: number): Promise<NativeAutoRotoReceipt> {
  return new Promise((resolveRun, rejectRun) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", EDITKIN_AUTO_ROTO_OFFLINE: "1" };
    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    const child = spawn(pack.paths.python, ["-I", "-B", pack.paths.host, requestPath], {
      cwd: pack.paths.sourceRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => { if (!settled) { settled = true; clearTimeout(timer); callback(); } };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => rejectRun(new Error("Auto Roto SAM 2.1 影片記憶推論逾時")));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-2_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    child.once("error", (error) => finish(() => rejectRun(error)));
    child.once("exit", (code) => finish(() => {
      if (code !== 0) return rejectRun(new Error(stderr.trim() || `Auto Roto SAM 2.1 host exit ${code}`));
      try { resolveRun(JSON.parse(stdout.trim()) as NativeAutoRotoReceipt); }
      catch { rejectRun(new Error(`Auto Roto SAM 2.1 host 回傳無效 JSON：${stderr.trim()}`)); }
    }));
  });
}

export function probeSam21VideoPackRuntime(pack: BoundSam21VideoPack, timeoutMs = 60_000): Promise<Sam21RuntimeAvailability> {
  const cacheKey = `${pack.identity.manifestSha256}\n${process.env.CUDA_VISIBLE_DEVICES ?? ""}`;
  const cached = runtimeProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt <= 120_000) return cached.promise;
  const promise = new Promise<Sam21RuntimeAvailability>((resolveProbe) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", EDITKIN_AUTO_ROTO_OFFLINE: "1" };
    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    const probe = "import json,sys\ntry:\n import torch\n ok=bool(torch.cuda.is_available())\n print(json.dumps({'available':ok,'python':sys.version.split()[0],'torch':torch.__version__,'cudaRuntime':torch.version.cuda,'gpu':torch.cuda.get_device_name(0) if ok else None,'reason':None if ok else 'cuda-unavailable'},separators=(',',':')))\nexcept Exception as error:\n print(json.dumps({'available':False,'reason':type(error).__name__+': '+str(error)[:600]},separators=(',',':')))\n";
    const child = spawn(pack.paths.python, ["-I", "-B", "-c", probe], { cwd: pack.paths.sourceRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: environment });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: Sam21RuntimeAvailability) => { if (!settled) { settled = true; clearTimeout(timer); resolveProbe(value); } };
    const timer = setTimeout(() => { child.kill(); finish({ available: false, reason: "runtime-probe-timeout" }); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-16_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2_000); });
    child.once("error", (error) => finish({ available: false, reason: error.message.slice(0, 600) }));
    child.once("exit", (code) => {
      if (code !== 0) return finish({ available: false, reason: stderr.trim().slice(-600) || `runtime-probe-exit-${code}` });
      try { finish(JSON.parse(stdout.trim()) as Sam21RuntimeAvailability); }
      catch { finish({ available: false, reason: "runtime-probe-invalid-json" }); }
    });
  });
  runtimeProbeCache.set(cacheKey, { createdAt: Date.now(), promise });
  return promise;
}

export async function createSam21VideoRoto(request: Sam21VideoRotoRequest, pack: BoundSam21VideoPack, requestPath: string, timeoutMs: number): Promise<NativeAutoRotoReceipt> {
  const envelope = {
    schema: "editkin.auto-roto-video-request/v1",
    ...request,
    sourceRoot: pack.paths.sourceRoot,
    configPath: pack.paths.config,
    configName: pack.configName,
    checkpointPath: pack.paths.checkpoint,
    model: pack.identity,
  };
  await writeFile(requestPath, JSON.stringify(envelope), "utf8");
  return runHost(pack, requestPath, timeoutMs);
}
