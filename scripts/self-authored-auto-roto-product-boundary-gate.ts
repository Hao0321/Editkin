import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { AUTO_ROTO_ONNX_ENGINE, AUTO_ROTO_SAM21_ENGINE } from "../src/application/autoRotoModelRouter";
import { evaluateAutoRotoProductBoundary } from "../src/application/autoRotoProductBoundary";
import { bindAutoRotoRuntimeToServiceArtifact } from "../src/service/autoRotoServiceArtifact";
import { externalAutoRotoResourceFindings, inventoryProductResourceRoots, tauriResourcePaths } from "./lib/self-authored-product-resources.mjs";
import { evaluatePinnedProductRuntime, inspectPinnedWindowsProductRuntime } from "./lib/pinned-product-runtime.mjs";
import { PRODUCT_RELEASE_SCOPE, productInputExclusionReason, productReleaseManifestFindings } from "./lib/build-input-identity.mjs";
import { resolveDesktopStageTarget } from "./lib/desktop-stage-target-policy.mjs";
import { resolveTauriStageTarget } from "./lib/tauri-stage-target-policy.mjs";
import { buildMaterialColorBundle } from "./lib/material-color-bundle-identity.mjs";
import {
  assertExactReleaseRuntimeFileSet,
  EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES,
  EDITKIN_RELEASE_RUNTIME_FILES,
} from "./lib/editkin-mcp-generation-contract.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const reportRoot = join(appRoot, ".rd/benchmarks/editkin-self-authored-auto-roto-product-boundary");
const reportPath = join(reportRoot, "report.json");
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

interface BoundaryFacts {
  productDefaultAllowed: boolean;
  productExternalRoutesRejected: boolean;
  debugResearchDoubleOptIn: boolean;
  tauriResourcesClosed: boolean;
  stagedResourcesClosed: boolean;
  electronResourcesClosed: boolean;
  tauriBuildPreflight: boolean;
  releaseCompileGate: boolean;
  installRejectsBeforeFilesystem: boolean;
  serviceRejectsBeforePackBinding: boolean;
  callerCannotForgeResearchArtifact: boolean;
  callerCannotSubstituteProductExecutables: boolean;
  desktopProductBundleFresh: boolean;
  stagedProductBundleFresh: boolean;
  tauriRuntimeInventoryExact: boolean;
  desktopRuntimeInventoryExact: boolean;
  releaseManifestFresh: boolean;
  releaseManifestInputsCurrent: boolean;
  stagedBuildManifestsFresh: boolean;
  recursiveResourcePreflight: boolean;
  recursiveProductResourcesClosed: boolean;
  pinnedRuntimeFilesVerified: boolean;
  tauriProductBinaryFreshAndResearchFree: boolean;
  nativeProductBinaryFreshAndExternalRuntimeFree: boolean;
  productDistributionTagged: boolean;
  productUiHasNoPackInstaller: boolean;
  extractedRuntimeInspected: boolean;
  extractedRuntimeClosed: boolean;
  routerEvidenceGreen: boolean;
  routerEvidenceCurrent: boolean;
}

function evaluate(facts: BoundaryFacts): Record<keyof BoundaryFacts, boolean> {
  return { ...facts };
}

function allGreen(checks: Record<string, boolean>): boolean {
  return Object.values(checks).every(Boolean);
}

function releaseCompileGatePresent(source: string): boolean {
  return /#\[cfg\(feature\s*=\s*"auto-roto-research"\)\]\s*fn external_auto_roto_research_allowed\b/u.test(source)
    && /external_auto_roto_research_allowed\([\s\S]{0,160}?cfg!\(debug_assertions\)/u.test(source)
    && /debug_build\s*&&\s*explicit_opt_in\s*==\s*Some\("1"\)/u.test(source);
}

function productDistributionTagPresent(source: string): boolean {
  return /auto_roto_distribution_mode:\s*if\s+auto_roto_external_research_enabled\s*\{[\s\S]{0,100}?"debug-research"[\s\S]{0,100}?\}\s*else\s*\{[\s\S]{0,100}?"product"/u.test(source)
    && /"autoRotoDistributionMode"\.into\(\)\s*,\s*json!\(runtime\.auto_roto_distribution_mode\)/u.test(source)
    && /"autoRotoExternalResearchEnabled"\.into\(\)\s*,\s*json!\(runtime\.auto_roto_external_research_enabled\)/u.test(source);
}

function rejectionPrecedes(source: string, rejectionMarker: string, accessMarker: string): boolean {
  const rejection = source.indexOf(rejectionMarker);
  const access = source.indexOf(accessMarker);
  return rejection >= 0 && access >= 0 && rejection < access;
}

function productUiHasNoPackInstaller(source: string): boolean {
  return !/(?:inspect|install|pickAndInstall|repair)AutoRotoVideoModel/.test(source)
    && !/(?:選擇|安裝|修復|下載).{0,16}模型包|(?:選擇|安裝|修復|下載).{0,12}(?:外部|影片記憶|Auto Roto).{0,8}(?:模型|模型包)|(?:模型|模型包).{0,12}(?:選擇|安裝|修復|下載)/u.test(source)
    && source.includes("Editkin 自研 Auto Roto");
}

async function buildExpectedProductService(): Promise<Buffer> {
  const result = await build({
    absWorkingDir: appRoot,
    entryPoints: ["src/service/cli.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    write: false,
    logLevel: "silent",
    define: { __EDITKIN_AUTO_ROTO_SERVICE_ARTIFACT_KIND__: JSON.stringify("product") },
  });
  if (result.outputFiles.length !== 1) throw new Error(`Expected one product service output, received ${result.outputFiles.length}`);
  return Buffer.from(result.outputFiles[0].contents);
}

interface ExpectedProductBundles {
  service: Buffer;
  mcp: Buffer;
  mcpIdentity: Buffer;
  remote: Buffer;
}

async function buildExpectedProductBundles(): Promise<ExpectedProductBundles> {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-auto-roto-product-bundles-"));
  try {
    const mcpPath = join(temporary, "mcp.mjs");
    await buildMaterialColorBundle({
      absWorkingDir: appRoot,
      entryPoints: ["src/mcp/server.ts"],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      outfile: mcpPath,
      minify: true,
      sourcemap: false,
      legalComments: "none",
    });
    const remoteResult = await build({
      absWorkingDir: appRoot,
      entryPoints: ["src/remote/server.ts"],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      minify: true,
      sourcemap: false,
      legalComments: "none",
      write: false,
      logLevel: "silent",
    });
    if (remoteResult.outputFiles.length !== 1) throw new Error("Expected one product remote output");
    const [service, mcp, mcpIdentity] = await Promise.all([
      buildExpectedProductService(),
      readFile(mcpPath),
      readFile(`${mcpPath}.material-color-identity.json`),
    ]);
    return { service, mcp, mcpIdentity, remote: Buffer.from(remoteResult.outputFiles[0].contents) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function executeForgedResearchRequest(nodePath: string, servicePath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(nodePath, [servicePath], { cwd: appRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(JSON.stringify({
    command: "analyze_auto_roto",
    payload: {},
    runtime: {
      ffmpeg: "Z:/editkin-redteam-missing-pack/ffmpeg.exe",
      nativeCore: "Z:/editkin-redteam-missing-pack/hao-core.exe",
      cacheRoot: "Z:/editkin-redteam-missing-pack/cache",
      autoRotoDistributionMode: "debug-research",
      autoRotoExternalResearchEnabled: true,
      autoRotoAllowResearchCandidate: true,
      autoRotoVideoModelRoot: "Z:/editkin-redteam-missing-pack",
    },
  }));
  const result = await new Promise<{ code: number | null }>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Product service forgery probe timed out"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code });
    });
  });
  return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

async function executeAllowedKeySubstitutionRequest(nodePath: string, servicePath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(nodePath, [servicePath], { cwd: appRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(JSON.stringify({
    command: "analyze_auto_roto",
    payload: {},
    runtime: {
      ffmpeg: "Z:/editkin-redteam-allowed-field/ffmpeg.exe",
      nativeCore: "Z:/editkin-redteam-allowed-field/hao-core.exe",
      cacheRoot: "Z:/editkin-redteam-allowed-field/cache",
    },
  }));
  const result = await new Promise<{ code: number | null }>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Product service executable substitution probe timed out"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code });
    });
  });
  return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

function manifestEntryMatches(entries: Array<{ path?: string; bytes?: number; sha256?: string }> | undefined, path: string, bytes: Buffer): boolean {
  const entry = entries?.find((candidate) => candidate.path === path);
  return entry?.bytes === bytes.length && entry?.sha256 === sha256(bytes);
}

function aggregateIdentity(entries: Array<{ path: string; bytes: number; sha256: string }>): { files: number; bytes: number; sha256: string } {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    hash.update(entry.path).update("\0").update(String(entry.bytes)).update("\0").update(entry.sha256).update("\n");
    bytes += entry.bytes;
  }
  return { files: entries.length, bytes, sha256: hash.digest("hex") };
}

async function receiptInputsAreCurrent(entries: Array<{ path: string; bytes: number; sha256: string }>): Promise<boolean> {
  const checks = await Promise.all(entries.map(async (entry) => {
    const target = resolve(appRoot, entry.path);
    const relation = relative(appRoot, target);
    if (relation.startsWith("..") || isAbsolute(relation)) return false;
    try {
      const bytes = await readFile(target);
      return bytes.length === entry.bytes && sha256(bytes) === entry.sha256;
    } catch {
      return false;
    }
  }));
  return checks.every(Boolean);
}

async function sourceIdentityRecordsAreCurrent(records: unknown): Promise<boolean> {
  if (!records || typeof records !== "object" || Array.isArray(records)) return false;
  const entries = Object.values(records as Record<string, { path?: string; sha256?: string }>);
  if (!entries.length) return false;
  const checks = await Promise.all(entries.map(async (entry) => {
    if (typeof entry?.path !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")) return false;
    const target = resolve(appRoot, entry.path);
    const relation = relative(appRoot, target);
    if (relation.startsWith("..") || isAbsolute(relation)) return false;
    try { return sha256(await readFile(target)) === entry.sha256; } catch { return false; }
  }));
  return checks.every(Boolean);
}

async function releaseManifestInputsAreCurrent(entries: Array<{ path?: string; bytes?: number; sha256?: string }> | undefined): Promise<boolean> {
  if (!Array.isArray(entries) || !entries.length) return false;
  const workspaceRoot = resolve(appRoot, "../..");
  const checks = await Promise.all(entries.map(async (entry) => {
    if (typeof entry.path !== "string" || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0
      || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")) return false;
    const workspacePath = entry.path.startsWith("workspace/");
    const boundary = workspacePath ? workspaceRoot : appRoot;
    const target = workspacePath ? resolve(workspaceRoot, entry.path.slice("workspace/".length)) : resolve(appRoot, entry.path);
    const relation = relative(boundary, target);
    if (relation.startsWith("..") || isAbsolute(relation)) return false;
    try {
      const bytes = await readFile(target);
      return bytes.length === entry.bytes && sha256(bytes) === entry.sha256;
    } catch { return false; }
  }));
  return checks.every(Boolean);
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return files.sort();
}

function runtimeInventoryIsExact(files: string[], expected: readonly string[]): boolean {
  if (files.some((path) => path.includes("/"))) return false;
  try {
    assertExactReleaseRuntimeFileSet(files, expected, "Product runtime");
    return true;
  } catch {
    return false;
  }
}

function productBoundaryControls(): { productDefaultAllowed: boolean; productExternalRoutesRejected: boolean; debugResearchDoubleOptIn: boolean } {
  const productDefault = evaluateAutoRotoProductBoundary({});
  const externalRequests = [
    { autoRotoModelRoot: "missing-model-root" },
    { autoRotoModelManifest: "missing-model-manifest" },
    { autoRotoVideoModelRoot: "missing-video-root" },
    { autoRotoVideoModelManifest: "missing-video-manifest" },
    { autoRotoVideoHost: "missing-host" },
    { autoRotoAllowResearchCandidate: true },
    { autoRotoRouteMode: "research" as const },
    { autoRotoRouteMode: "debug" as const },
    { autoRotoRequestedEngine: AUTO_ROTO_ONNX_ENGINE },
    { autoRotoRequestedEngine: AUTO_ROTO_SAM21_ENGINE },
  ];
  const debugRequest = { autoRotoRouteMode: "research" as const, autoRotoRequestedEngine: AUTO_ROTO_SAM21_ENGINE };
  return {
    productDefaultAllowed: productDefault.status === "allowed" && productDefault.reasonCode === "product-native-self-authored" && /^[a-f0-9]{64}$/.test(productDefault.receiptSha256),
    productExternalRoutesRejected: externalRequests.every((request) => evaluateAutoRotoProductBoundary(request).status === "rejected"),
    debugResearchDoubleOptIn:
      evaluateAutoRotoProductBoundary({ ...debugRequest, autoRotoExternalResearchEnabled: true }).status === "rejected"
      && evaluateAutoRotoProductBoundary({ ...debugRequest, autoRotoDistributionMode: "debug-research" }).status === "rejected"
      && evaluateAutoRotoProductBoundary({ ...debugRequest, autoRotoDistributionMode: "debug-research", autoRotoExternalResearchEnabled: true }).reasonCode === "explicit-debug-research",
  };
}

function parseCandidateRuntimeArgs(args: string[]): { tauri?: string; desktop?: string } {
  const result: { tauri?: string; desktop?: string } = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--candidate-runtime" && flag !== "--desktop-candidate-runtime") || !value || value.startsWith("--")) {
      throw new Error("Product boundary gate accepts only --candidate-runtime <approved-runtime-path> and --desktop-candidate-runtime <approved-runtime-path>");
    }
    const key = flag === "--candidate-runtime" ? "tauri" : "desktop";
    if (result[key]) throw new Error(`Product boundary gate rejects duplicate ${flag}`);
    result[key] = value;
  }
  return result;
}

if (process.argv.includes("--self-test")) {
  if (process.argv.slice(2).length !== 1) throw new Error("Product boundary self-test does not accept additional arguments");
  const valid: BoundaryFacts = {
    productDefaultAllowed: true,
    productExternalRoutesRejected: true,
    debugResearchDoubleOptIn: true,
    tauriResourcesClosed: true,
    stagedResourcesClosed: true,
    electronResourcesClosed: true,
    tauriBuildPreflight: true,
    releaseCompileGate: true,
    installRejectsBeforeFilesystem: true,
    serviceRejectsBeforePackBinding: true,
    callerCannotForgeResearchArtifact: true,
    callerCannotSubstituteProductExecutables: true,
    desktopProductBundleFresh: true,
    stagedProductBundleFresh: true,
    tauriRuntimeInventoryExact: true,
    desktopRuntimeInventoryExact: true,
    releaseManifestFresh: true,
    releaseManifestInputsCurrent: true,
    stagedBuildManifestsFresh: true,
    recursiveResourcePreflight: true,
    recursiveProductResourcesClosed: true,
    pinnedRuntimeFilesVerified: true,
    tauriProductBinaryFreshAndResearchFree: true,
    nativeProductBinaryFreshAndExternalRuntimeFree: true,
    productDistributionTagged: true,
    productUiHasNoPackInstaller: true,
    extractedRuntimeInspected: true,
    extractedRuntimeClosed: true,
    routerEvidenceGreen: true,
    routerEvidenceCurrent: true,
  };
  if (!allGreen(evaluate(valid))) throw new Error("boundary evaluator rejected valid fixture");
  const mutations = (Object.keys(valid) as Array<keyof BoundaryFacts>).map((key) => {
    const mutated = { ...valid, [key]: false };
    if (allGreen(evaluate(mutated))) throw new Error(`boundary evaluator missed ${key}`);
    return key;
  });
  const smuggles = [
    "runtime/auto-roto/manifest.json",
    "runtime/auto_roto_sam21_host.py",
    "runtime/sam2/checkpoint.pt",
    "runtime/person.safetensors",
    "runtime/site-packages/torch/__init__.py",
    "runtime/python.exe",
    "runtime/python311.dll",
    "runtime/torch_cpu.dll",
    "runtime/cudnn64_9.dll",
    "runtime/calibrator.onnx",
    "runtime/runner.py",
    "runtime/onnxruntime.dll",
    "runtime/hiera_tiny.ckpt",
    "runtime/pytorch_model.bin",
    "runtime/model.ort",
    "runtime/model.tflite",
    "runtime/segment_anything_2/weights.bin",
  ];
  if (externalAutoRotoResourceFindings(smuggles).length !== smuggles.length) throw new Error("resource policy missed an external artifact class");
  if (externalAutoRotoResourceFindings(["runtime/hao-core.exe", "runtime/ffmpeg.exe", "runtime/whisper-cli.exe"]).length) throw new Error("resource policy rejected self-authored product resources");
  assertExactReleaseRuntimeFileSet(EDITKIN_RELEASE_RUNTIME_FILES, EDITKIN_RELEASE_RUNTIME_FILES, "self-test Tauri runtime");
  assertExactReleaseRuntimeFileSet(EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES, EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES, "self-test desktop runtime");
  for (const mutation of [
    [...EDITKIN_RELEASE_RUNTIME_FILES, "vision.dat"],
    [...EDITKIN_RELEASE_RUNTIME_FILES, "pyhost.exe"],
    EDITKIN_RELEASE_RUNTIME_FILES.filter((name) => name !== "mcp.mjs"),
    [...EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES, "vision.zip"],
  ]) {
    let rejected = false;
    try {
      assertExactReleaseRuntimeFileSet(mutation, mutation.includes("vision.zip") ? EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES : EDITKIN_RELEASE_RUNTIME_FILES, "mutated runtime");
    } catch { rejected = true; }
    if (!rejected) throw new Error("closed-world runtime inventory accepted a neutral-name smuggle or missing bundle");
  }
  const structuralControls = [
    productUiHasNoPackInstaller("<b>Editkin 自研 Auto Roto</b>"),
    !productUiHasNoPackInstaller("<b>Editkin 自研 Auto Roto</b><button>選擇模型包</button>"),
    !productUiHasNoPackInstaller("pickAndInstallAutoRotoVideoModel: () => invoke('install')"),
    releaseCompileGatePresent('#[cfg(feature = "auto-roto-research")] fn external_auto_roto_research_allowed(debug_build: bool, explicit_opt_in: Option<&str>) { debug_build && explicit_opt_in == Some("1") } fn enabled() { external_auto_roto_research_allowed(\n        cfg!(debug_assertions), value); }'),
    !releaseCompileGatePresent('#[cfg(feature = "auto-roto-research")] fn external_auto_roto_research_allowed() { true } fn enabled() { external_auto_roto_research_allowed(\n        true, value); }'),
    rejectionPrecedes("if !enabled { return Err(()) } fs::canonicalize(path)", "if !enabled", "fs::canonicalize"),
    !rejectionPrecedes("fs::canonicalize(path); if !enabled { return Err(()) }", "if !enabled", "fs::canonicalize"),
  ];
  if (!structuralControls.every(Boolean)) throw new Error("structural boundary detector calibration failed");
  if (productInputExclusionReason("product-capabilities.json") !== "release-evidence-only") {
    throw new Error("release build identity still admits the self-referential product evidence ledger");
  }
  let forgedArtifactRejected = false;
  try {
    const forged = bindAutoRotoRuntimeToServiceArtifact({
      autoRotoDistributionMode: "debug-research",
      autoRotoExternalResearchEnabled: true,
      autoRotoVideoModelRoot: "external",
    } as any);
    forgedArtifactRejected = evaluateAutoRotoProductBoundary(forged).status === "rejected";
  } catch (error) {
    forgedArtifactRejected = String(error).includes("未允許欄位");
  }
  if (!forgedArtifactRejected) throw new Error("product artifact binder trusted caller research identity");
  const pinned = { path: "vendor/ffmpeg.exe", expectedBytes: 4, expectedSha256: "a".repeat(64), actualBytes: 4, actualSha256: "a".repeat(64) };
  if (evaluatePinnedProductRuntime([pinned]).status !== "GREEN_PINNED_PRODUCT_RUNTIME"
    || evaluatePinnedProductRuntime([{ ...pinned, actualSha256: "b".repeat(64) }]).status !== "BLOCK"
    || evaluatePinnedProductRuntime([{ ...pinned, actualBytes: 5 }]).status !== "BLOCK") {
    throw new Error("pinned runtime evaluator calibration failed");
  }
  const controls = productBoundaryControls();
  if (!Object.values(controls).every(Boolean)) throw new Error("runtime boundary controls are not calibrated");
  const candidateArgs = parseCandidateRuntimeArgs([
    "--candidate-runtime", "src-tauri/product-release-candidates/candidate-0123/runtime",
    "--desktop-candidate-runtime", ".desktop-product-release-candidates/candidate-0123/runtime",
  ]);
  const candidateArgMutations = [
    ["--candidate-runtime"],
    ["--desktop-candidate-runtime"],
    ["--unknown", "candidate/runtime"],
    ["--candidate-runtime", "one", "--candidate-runtime", "two"],
    ["--desktop-candidate-runtime", "one", "--desktop-candidate-runtime", "two"],
  ];
  if (!candidateArgs.tauri || !candidateArgs.desktop || !candidateArgMutations.every((args) => {
    try { parseCandidateRuntimeArgs(args); return false; } catch { return true; }
  })) throw new Error("candidate runtime argument controls are not calibrated");
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluatorMutationsRejected: mutations.length, externalRuntimeControlsRejected: 10, resourceSmugglesRejected: smuggles.length, structuralControls: structuralControls.length, candidateArgMutationsRejected: candidateArgMutations.length })}\n`);
  process.exit(0);
}

const candidateArgs = parseCandidateRuntimeArgs(process.argv.slice(2));
const tauriStage = resolveTauriStageTarget(appRoot, candidateArgs.tauri);
if (candidateArgs.tauri && !tauriStage.candidateTarget) throw new Error("--candidate-runtime must name an approved product release candidate generation");
const desktopStage = resolveDesktopStageTarget(appRoot, candidateArgs.desktop);
if (candidateArgs.desktop && !desktopStage.candidateTarget) throw new Error("--desktop-candidate-runtime must name an approved desktop product release candidate generation");
const { targetRoot: tauriRuntimeRoot } = tauriStage;
const desktopRuntimeRoot = desktopStage.targetRoot;
const usingCandidate = tauriStage.candidateTarget || desktopStage.candidateTarget;

const sourcePaths = [
  "scripts/self-authored-auto-roto-product-boundary-gate.ts",
  "src/application/autoRotoProductBoundary.ts",
  "src/application/autoRotoModelRouter.ts",
  "src/application/autoRotoNativeProduct.ts",
  "src/application/rotoKeyerAutopilot.ts",
  "src/service/autoRotoServiceArtifact.ts",
  "src/service/autoRotoServiceArtifact.test.ts",
  "src/service/cli.ts",
  "src/mcp/server.ts",
  "src/mcp/rotoKeyerAutopilotTools.ts",
  "src/ui/MaskStudio.tsx",
  "src/ui/MaskStudio.test.tsx",
  "src/desktop/apiTypes.ts",
  "src/desktop/tauriBridge.ts",
  "src-tauri/src/main.rs",
  "src-tauri/Cargo.toml",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.windows.conf.json",
  "src-tauri/tauri.macos.conf.json",
  "native/hao-core/Cargo.toml",
  "native/hao-core/Cargo.lock",
  "native/hao-core/src/engine/auto_roto_onnx.rs",
  "scripts/stage-tauri-resources.mjs",
  "scripts/stage-desktop-resources.mjs",
  "scripts/tauri-build.mjs",
  "scripts/build-desktop.mjs",
  "scripts/build-release-input-manifest.mjs",
  "scripts/build-tauri-product-binary.mjs",
  "scripts/build-native-core.mjs",
  "scripts/lib/self-authored-product-resources.mjs",
  "scripts/lib/self-authored-product-resources.d.mts",
  "scripts/lib/pinned-product-runtime.mjs",
  "scripts/lib/pinned-product-runtime.d.mts",
  "scripts/lib/desktop-stage-target-policy.mjs",
  "scripts/lib/desktop-stage-target-policy.d.mts",
  "scripts/lib/editkin-mcp-generation-contract.mjs",
  "scripts/lib/material-color-bundle-identity.mjs",
] as const;
const productManifestSourcePaths = [
  "src/application/autoRotoNativeProduct.ts",
  "src/application/rotoKeyerAutopilot.ts",
  "src/service/autoRotoServiceArtifact.ts",
  "src/service/cli.ts",
  "src/mcp/server.ts",
  "src/mcp/rotoKeyerAutopilotTools.ts",
  "src/ui/MaskStudio.tsx",
  "src/desktop/apiTypes.ts",
  "src/desktop/tauriBridge.ts",
  "src-tauri/src/main.rs",
  "src-tauri/Cargo.toml",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.windows.conf.json",
  "src-tauri/tauri.macos.conf.json",
  "native/hao-core/Cargo.toml",
  "native/hao-core/Cargo.lock",
  "scripts/stage-tauri-resources.mjs",
  "scripts/stage-desktop-resources.mjs",
  "scripts/tauri-build.mjs",
  "scripts/build-desktop.mjs",
  "scripts/build-release-input-manifest.mjs",
  "scripts/build-tauri-product-binary.mjs",
  "scripts/build-native-core.mjs",
  "scripts/lib/self-authored-product-resources.mjs",
  "scripts/lib/self-authored-product-resources.d.mts",
  "scripts/lib/pinned-product-runtime.mjs",
  "scripts/lib/pinned-product-runtime.d.mts",
  "scripts/lib/desktop-stage-target-policy.mjs",
  "scripts/lib/desktop-stage-target-policy.d.mts",
  "scripts/lib/editkin-mcp-generation-contract.mjs",
  "scripts/lib/material-color-bundle-identity.mjs",
] as const;
const researchOnlyManifestSourcePaths = [
  "src/application/autoRotoProductBoundary.ts",
  "src/application/autoRotoModelRouter.ts",
  "src/service/autoRotoServiceArtifact.test.ts",
  "src/ui/MaskStudio.test.tsx",
  "native/hao-core/src/engine/auto_roto_onnx.rs",
] as const;
const sources = new Map<string, string>();
await Promise.all(sourcePaths.map(async (path) => sources.set(path, await readFile(join(appRoot, path), "utf8"))));

const tauriResourceConfigPaths = ["src-tauri/tauri.conf.json", "src-tauri/tauri.windows.conf.json", "src-tauri/tauri.macos.conf.json"];
const tauriResources = tauriResourceConfigPaths.flatMap((path) => tauriResourcePaths(JSON.parse(sources.get(path)!)));
const stageTauri = sources.get("scripts/stage-tauri-resources.mjs")!;
const stageDesktop = sources.get("scripts/stage-desktop-resources.mjs")!;
const tauriBuild = sources.get("scripts/tauri-build.mjs")!;
const desktopBuild = sources.get("scripts/build-desktop.mjs")!;
const rust = sources.get("src-tauri/src/main.rs")!;
const service = sources.get("src/service/cli.ts")!;
const uiSurface = `${sources.get("src/ui/MaskStudio.tsx")}\n${sources.get("src/desktop/apiTypes.ts")}\n${sources.get("src/desktop/tauriBridge.ts")}`;
const installFunction = rust.slice(rust.indexOf("async fn install_auto_roto_video_model_internal"), rust.indexOf("#[tauri::command]\nasync fn inspect_auto_roto_video_model"));
const serviceAnalyze = service.slice(service.indexOf('if (request.command === "analyze_auto_roto")'), service.indexOf('if (request.command === "render_project")'));

const expectedProductBundles = await buildExpectedProductBundles();
const expectedBundleEntries = [
  { name: "service.mjs", outputPath: "desktop-dist/service.mjs", bytes: expectedProductBundles.service },
  { name: "mcp.mjs", outputPath: "desktop-dist/mcp.mjs", bytes: expectedProductBundles.mcp },
  { name: "mcp.mjs.material-color-identity.json", outputPath: "desktop-dist/mcp.mjs.material-color-identity.json", bytes: expectedProductBundles.mcpIdentity },
  { name: "remote.mjs", outputPath: "desktop-dist/remote.mjs", bytes: expectedProductBundles.remote },
] as const;
const desktopProductServicePath = join(appRoot, "desktop-dist/service.mjs");
const desktopProductService = await readFile(desktopProductServicePath);
const stagedProductServicePath = join(tauriRuntimeRoot, "service.mjs");
let stagedProductService: Buffer | undefined;
try { stagedProductService = await readFile(stagedProductServicePath); } catch { /* fact remains false */ }
const desktopProductBundles = await Promise.all(expectedBundleEntries.map(async (entry) => {
  const path = join(appRoot, entry.outputPath);
  try { return { ...entry, path, actual: await readFile(path) }; } catch { return { ...entry, path, actual: undefined }; }
}));
const stagedProductBundles = await Promise.all(expectedBundleEntries.map(async (entry) => {
  const path = join(tauriRuntimeRoot, entry.name);
  try { return { ...entry, path, actual: await readFile(path) }; } catch { return { ...entry, path, actual: undefined }; }
}));
const nodePath = join(appRoot, "vendor/node/win32-x64/node.exe");
const forgedProbe = await executeForgedResearchRequest(nodePath, desktopProductServicePath);
const executableSubstitutionProbe = await executeAllowedKeySubstitutionRequest(nodePath, desktopProductServicePath);
let forgedProbePayload: Record<string, unknown> = {};
try { forgedProbePayload = JSON.parse(forgedProbe.stdout) as Record<string, unknown>; } catch { /* fact remains false */ }
let executableSubstitutionPayload: Record<string, unknown> = {};
try { executableSubstitutionPayload = JSON.parse(executableSubstitutionProbe.stdout) as Record<string, unknown>; } catch { /* fact remains false */ }
const forgedProbeArtifact = forgedProbePayload.serviceArtifact as Record<string, unknown> | undefined;
const executableSubstitutionArtifact = executableSubstitutionPayload.serviceArtifact as Record<string, unknown> | undefined;

const releaseManifestPath = join(appRoot, ".release-input-manifest.json");
const releaseManifestBytes = await readFile(releaseManifestPath);
const releaseManifest = JSON.parse(releaseManifestBytes.toString("utf8")) as {
  schemaVersion?: number;
  scope?: unknown;
  inputs?: Array<{ path?: string; bytes?: number; sha256?: string }>;
  outputs?: Array<{ path?: string; bytes?: number; sha256?: string }>;
};
const manifestProductSourcesFresh = productManifestSourcePaths.every((path) => manifestEntryMatches(releaseManifest.inputs, path, Buffer.from(sources.get(path)!)));
const manifestResearchSourcesExcluded = researchOnlyManifestSourcePaths.every((path) => !releaseManifest.inputs?.some((entry) => entry.path === path));
const releaseManifestPolicyFindings = productReleaseManifestFindings(releaseManifest);
const manifestScopeCurrent = JSON.stringify(releaseManifest.scope) === JSON.stringify(PRODUCT_RELEASE_SCOPE);
const manifestBundleFresh = expectedBundleEntries.every((entry) => manifestEntryMatches(releaseManifest.outputs, entry.outputPath, entry.bytes));
const releaseManifestInputSetCurrent = !releaseManifest.inputs?.some((entry) => entry.path === "product-capabilities.json")
  && await releaseManifestInputsAreCurrent(releaseManifest.inputs);
const stagedManifestPaths = [
  join(tauriRuntimeRoot, "BUILD-MANIFEST.json"),
  join(desktopRuntimeRoot, "BUILD-MANIFEST.json"),
];
const stagedManifestResults = await Promise.all(stagedManifestPaths.map(async (path) => {
  try { return (await readFile(path)).equals(releaseManifestBytes); } catch { return false; }
}));
const recursiveProductRoots = [
  ".creative-packs/hao-creator-library",
  ".personal-packs/hao-music-library",
  "public/fonts",
  "public/color/aces2",
  "plugins",
];
const recursiveProductInventory = await inventoryProductResourceRoots(recursiveProductRoots, appRoot);
const recursiveProductFindings = externalAutoRotoResourceFindings(recursiveProductInventory);
const pinnedRuntime = process.platform === "win32" ? await inspectPinnedWindowsProductRuntime(appRoot) : undefined;
const tauriProductReceiptPath = join(appRoot, ".rd/build-receipts/editkin-tauri-product.json");
let tauriProductReceipt: {
  schema?: string;
  productMode?: string;
  inputs?: Array<{ path: string; bytes: number; sha256: string }>;
  inputIdentity?: { files: number; bytes: number; sha256: string };
  binary?: { path: string; bytes: number; sha256: string };
  presentForbiddenCommandIds?: string[];
} | undefined;
let tauriProductBinary: Buffer | undefined;
let tauriReceiptInputsCurrent = false;
let tauriReceiptIdentityCurrent = false;
try {
  tauriProductReceipt = JSON.parse(await readFile(tauriProductReceiptPath, "utf8"));
  const receiptInputs = tauriProductReceipt?.inputs ?? [];
  tauriReceiptInputsCurrent = receiptInputs.length > 0 && await receiptInputsAreCurrent(receiptInputs);
  tauriReceiptIdentityCurrent = JSON.stringify(aggregateIdentity(receiptInputs)) === JSON.stringify(tauriProductReceipt?.inputIdentity);
  if (tauriProductReceipt?.binary?.path) tauriProductBinary = await readFile(resolve(appRoot, tauriProductReceipt.binary.path));
} catch { /* fact remains false */ }
const nativeProductReceiptPath = join(appRoot, ".rd/benchmarks/editkin-native-core-build-receipt.json");
const expectedNativeProductPath = process.platform === "win32"
  ? join(appRoot, "native/bin/win32-x64/hao-core.exe")
  : join(appRoot, "native/hao-core/target/release/hao-core");
let nativeProductReceipt: {
  schema?: string;
  productMode?: string;
  command?: string[];
  inputs?: { files?: Array<{ path: string; bytes: number; sha256: string }>; aggregateSha256?: string };
  dependencyClosure?: { ortPresent?: boolean; sha256?: string; lines?: number };
  promoted?: { path?: string; bytes?: number; sha256?: string };
} | undefined;
let nativeProductBinary: Buffer | undefined;
let nativeReceiptInputsCurrent = false;
let nativeReceiptIdentityCurrent = false;
try {
  nativeProductReceipt = JSON.parse(await readFile(nativeProductReceiptPath, "utf8"));
  const receiptInputs = nativeProductReceipt?.inputs?.files ?? [];
  nativeReceiptInputsCurrent = receiptInputs.length > 0 && await receiptInputsAreCurrent(receiptInputs);
  nativeReceiptIdentityCurrent = aggregateIdentity(receiptInputs).sha256 === nativeProductReceipt?.inputs?.aggregateSha256;
  if (nativeProductReceipt?.promoted?.path && resolve(nativeProductReceipt.promoted.path) === expectedNativeProductPath) {
    nativeProductBinary = await readFile(expectedNativeProductPath);
  }
} catch { /* fact remains false */ }

const extractedRoots = [tauriRuntimeRoot, desktopRuntimeRoot];
const extractedFiles: Array<{ root: string; files: string[]; findings: string[] }> = [];
for (const root of extractedRoots) {
  try {
    if (!(await stat(root)).isDirectory()) continue;
    const files = await walkFiles(root);
    extractedFiles.push({ root, files, findings: externalAutoRotoResourceFindings(files) });
  } catch { /* absent artifact is reported below, never treated as public evidence */ }
}
const routerEvidencePath = join(appRoot, ".rd/benchmarks/editkin-auto-roto-model-router/report.json");
const routerEvidenceBytes = await readFile(routerEvidencePath);
const routerEvidence = JSON.parse(routerEvidenceBytes.toString("utf8"));
const routerEvidenceCurrent = await sourceIdentityRecordsAreCurrent(routerEvidence.sources);
const controls = productBoundaryControls();
const facts: BoundaryFacts = {
  ...controls,
  tauriResourcesClosed: externalAutoRotoResourceFindings(tauriResources).length === 0,
  stagedResourcesClosed: stageTauri.includes("assertSelfAuthoredProductResources(resources.flat()") && !/\[\s*["'][^"']*(?:auto[-_.]?roto|sam(?:2|21)|\.onnx|\.pth|\.pt)[^"']*["']\s*,/i.test(stageTauri),
  electronResourcesClosed: stageDesktop.includes("assertSelfAuthoredProductResources(runtimeResources") && !/runtimeResources\s*=\s*\[[\s\S]*?["'][^"']*(?:auto[-_.]?roto|sam(?:2|21)|\.onnx|\.pth|\.pt)[^"']*["']/i.test(stageDesktop),
  tauriBuildPreflight: tauriBuild.includes("assertSelfAuthoredProductResources(tauriProductResources"),
  releaseCompileGate: releaseCompileGatePresent(rust),
  installRejectsBeforeFilesystem: rejectionPrecedes(installFunction, "if !external_auto_roto_research_enabled()", "fs::canonicalize"),
  serviceRejectsBeforePackBinding: rejectionPrecedes(serviceAnalyze, "assertProductServiceAutoRotoRuntime(runtime)", "analyzeProductAutoRoto("),
  callerCannotForgeResearchArtifact: forgedProbe.code === 1
    && forgedProbePayload.ok === false
    && (String(forgedProbePayload.error).includes("product-external-runtime-rejected")
      || String(forgedProbePayload.error).includes("product service runtime 含未允許欄位"))
    && !String(forgedProbePayload.error).includes("ENOENT")
    && forgedProbeArtifact?.kind === "product"
    && forgedProbeArtifact?.externalResearchRuntime === "disabled",
  callerCannotSubstituteProductExecutables: executableSubstitutionProbe.code === 1
    && executableSubstitutionPayload.ok === false
    && String(executableSubstitutionPayload.error).includes("executable identity attestation")
    && !String(executableSubstitutionPayload.error).includes("ENOENT")
    && executableSubstitutionArtifact?.kind === "product"
    && executableSubstitutionArtifact?.externalResearchRuntime === "disabled",
  desktopProductBundleFresh: desktopProductBundles.every((entry) => entry.actual?.equals(entry.bytes))
    && desktopProductService.includes(Buffer.from("editkin.auto-roto-service-artifact/v1"))
    && !desktopProductService.includes(Buffer.from("inspect_auto_roto_video_pack"))
    && !desktopProductService.includes(Buffer.from("bindSam21VideoPack"))
    && !desktopProductService.includes(Buffer.from("createSam21VideoRoto"))
    && desktopBuild.includes('__EDITKIN_AUTO_ROTO_SERVICE_ARTIFACT_KIND__: JSON.stringify("product")'),
  stagedProductBundleFresh: stagedProductBundles.every((entry) => entry.actual?.equals(entry.bytes)),
  tauriRuntimeInventoryExact: runtimeInventoryIsExact(
    extractedFiles.find((entry) => entry.root === tauriRuntimeRoot)?.files ?? [],
    EDITKIN_RELEASE_RUNTIME_FILES,
  ),
  desktopRuntimeInventoryExact: runtimeInventoryIsExact(
    extractedFiles.find((entry) => entry.root === desktopRuntimeRoot)?.files ?? [],
    EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES,
  ),
  releaseManifestFresh: releaseManifest.schemaVersion === 2
    && manifestScopeCurrent
    && releaseManifestPolicyFindings.length === 0
    && manifestProductSourcesFresh
    && manifestResearchSourcesExcluded
    && manifestBundleFresh,
  releaseManifestInputsCurrent: releaseManifestInputSetCurrent,
  stagedBuildManifestsFresh: stagedManifestResults.every(Boolean),
  recursiveResourcePreflight: stageTauri.includes("assertSelfAuthoredProductResourceRoots")
    && stageDesktop.includes("assertSelfAuthoredProductResourceRoots")
    && tauriBuild.includes("assertSelfAuthoredProductResourceRoots"),
  recursiveProductResourcesClosed: recursiveProductFindings.length === 0,
  pinnedRuntimeFilesVerified: process.platform !== "win32" || pinnedRuntime?.status === "GREEN_PINNED_PRODUCT_RUNTIME",
  tauriProductBinaryFreshAndResearchFree: tauriProductReceipt?.schema === "editkin.tauri-product-build-receipt/v1"
    && tauriProductReceipt.productMode === "no-default-features-no-auto-roto-research"
    && tauriReceiptInputsCurrent
    && tauriReceiptIdentityCurrent
    && Array.isArray(tauriProductReceipt.presentForbiddenCommandIds)
    && tauriProductReceipt.presentForbiddenCommandIds.length === 0
    && Boolean(tauriProductBinary)
    && tauriProductBinary?.length === tauriProductReceipt.binary?.bytes
    && sha256(tauriProductBinary!) === tauriProductReceipt.binary?.sha256
    && !["inspect_auto_roto_video_model", "install_auto_roto_video_model", "pick_and_install_auto_roto_video_model", "repair_auto_roto_video_model", "inspect_auto_roto_video_pack"]
      .some((marker) => tauriProductBinary!.includes(Buffer.from(marker))),
  nativeProductBinaryFreshAndExternalRuntimeFree: nativeProductReceipt?.schema === "editkin.native-core-build-receipt/v1"
    && nativeProductReceipt.productMode === "no-default-features-self-authored-auto-roto"
    && nativeProductReceipt.command?.includes("--no-default-features") === true
    && nativeProductReceipt.dependencyClosure?.ortPresent === false
    && nativeReceiptInputsCurrent
    && nativeReceiptIdentityCurrent
    && Boolean(nativeProductBinary)
    && nativeProductBinary?.length === nativeProductReceipt.promoted?.bytes
    && sha256(nativeProductBinary!) === nativeProductReceipt.promoted?.sha256,
  productDistributionTagged: productDistributionTagPresent(rust),
  productUiHasNoPackInstaller: productUiHasNoPackInstaller(uiSurface),
  extractedRuntimeInspected: extractedFiles.length === extractedRoots.length,
  extractedRuntimeClosed: extractedFiles.every((entry) => entry.findings.length === 0),
  routerEvidenceGreen: routerEvidence.status === "GREEN_INTERNAL_PRODUCT_POLICY"
    && Object.values(routerEvidence.facts ?? {}).every(Boolean)
    && routerEvidence.evaluator?.allRejected === true,
  routerEvidenceCurrent,
};
const checks = evaluate(facts);
const status = allGreen(checks)
  ? usingCandidate
    ? "GREEN_SELF_AUTHORED_PRODUCT_BOUNDARY_CANDIDATE_NOT_ACTIVATED"
    : "GREEN_INTERNAL_SELF_AUTHORED_PRODUCT_BOUNDARY"
  : "FAIL";
const report = {
  schema: "editkin.self-authored-auto-roto-product-boundary-gate/v1",
  status,
  activation: {
    mode: usingCandidate ? "candidate-not-activated" : "canonical-runtime",
    tauri: {
      mode: tauriStage.candidateTarget ? "candidate-not-activated" : "canonical-runtime",
      runtimeRoot: relative(appRoot, tauriRuntimeRoot).replaceAll("\\", "/"),
    },
    desktop: {
      mode: desktopStage.candidateTarget ? "candidate-not-activated" : "canonical-runtime",
      runtimeRoot: relative(appRoot, desktopRuntimeRoot).replaceAll("\\", "/"),
    },
  },
  checks,
  policy: {
    productEngine: "editkin-native-color-temporal-roto/v1",
    externalModels: "isolated-debug-research-only",
    commercialModelLicenseDependency: false,
  },
  resources: {
    tauri: tauriResources,
    tauriFindings: externalAutoRotoResourceFindings(tauriResources),
    recursiveProductInventory: { files: recursiveProductInventory.length, findings: recursiveProductFindings },
    pinnedRuntime,
    extracted: extractedFiles,
  },
  artifacts: {
    expectedProductBundles: expectedBundleEntries.map((entry) => ({ name: entry.name, bytes: entry.bytes.length, sha256: sha256(entry.bytes) })),
    desktopProductBundles: desktopProductBundles.map((entry) => ({
      name: entry.name,
      path: relative(appRoot, entry.path).replaceAll("\\", "/"),
      bytes: entry.actual?.length ?? null,
      sha256: entry.actual ? sha256(entry.actual) : null,
      matchesExpected: entry.actual?.equals(entry.bytes) ?? false,
    })),
    stagedProductBundles: stagedProductBundles.map((entry) => ({
      name: entry.name,
      path: relative(appRoot, entry.path).replaceAll("\\", "/"),
      bytes: entry.actual?.length ?? null,
      sha256: entry.actual ? sha256(entry.actual) : null,
      matchesExpected: entry.actual?.equals(entry.bytes) ?? false,
    })),
    desktopProductService: { path: relative(appRoot, desktopProductServicePath).replaceAll("\\", "/"), bytes: desktopProductService.length, sha256: sha256(desktopProductService) },
    stagedProductService: stagedProductService ? { path: relative(appRoot, stagedProductServicePath).replaceAll("\\", "/"), bytes: stagedProductService.length, sha256: sha256(stagedProductService) } : null,
    forgedResearchProbe: { code: forgedProbe.code, payload: forgedProbePayload, stderr: forgedProbe.stderr },
    executableSubstitutionProbe: { code: executableSubstitutionProbe.code, payload: executableSubstitutionPayload, stderr: executableSubstitutionProbe.stderr },
    releaseManifest: {
      path: ".release-input-manifest.json",
      bytes: releaseManifestBytes.length,
      sha256: sha256(releaseManifestBytes),
      schemaVersion: releaseManifest.schemaVersion ?? null,
      scope: releaseManifest.scope ?? null,
      policyFindings: releaseManifestPolicyFindings,
      productSourcesFresh: manifestProductSourcesFresh,
      researchSourcesExcluded: manifestResearchSourcesExcluded,
      inputsCurrent: releaseManifestInputSetCurrent,
    },
    stagedManifestResults,
    tauriProductBuildReceipt: tauriProductReceipt ?? null,
    nativeProductBuildReceipt: nativeProductReceipt ?? null,
  },
  sources: sourcePaths.map((path) => ({ path, sha256: sha256(sources.get(path)!) })),
  inputs: { routerEvidence: { path: relative(appRoot, routerEvidencePath).replaceAll("\\", "/"), bytes: routerEvidenceBytes.length, sha256: sha256(routerEvidenceBytes) } },
  claimBoundary: usingCandidate
    ? "Internal source/preflight and selected non-activated candidate runtime boundary only. External models remain isolated research controls. Canonical locked runtimes were not switched; this does not prove Auto Roto quality, public installer freshness/signing, macOS parity, or superiority over any competitor."
    : "Internal source/preflight and currently extracted local runtime boundary only. External models remain isolated research controls. This does not prove Auto Roto quality, public installer freshness/signing, macOS parity, or superiority over any competitor.",
};
await mkdir(reportRoot, { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`SELF_AUTHORED_AUTO_ROTO_PRODUCT_BOUNDARY status=${status} report=${reportPath}\n`);
if (status === "FAIL") process.exitCode = 1;
