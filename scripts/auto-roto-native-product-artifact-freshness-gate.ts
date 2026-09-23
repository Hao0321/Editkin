import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import { productReleaseManifestFindings } from "./lib/build-input-identity.mjs";
import { resolveDesktopCandidateForTauriArtifact } from "./lib/desktop-stage-target-policy.mjs";
import { NATIVE_CORE_BUILD_INPUT_ROOTS, NATIVE_SHARED_PROCESS_INPUTS } from "./lib/native-shared-inputs.mjs";
import {
  assertTauriArtifactTargetBinding,
  assertTauriCandidateArtifactRoot,
  inspectWindowsTauriCandidatePrimaryArtifacts,
  resolveTauriCandidateArtifactRoot,
} from "./lib/tauri-candidate-artifact-root.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const reportPath = resolve(appRoot, ".rd/benchmarks/editkin-auto-roto-native-product-artifact-freshness/report.json");
const SHA256 = /^[a-f0-9]{64}$/;

const PRODUCT_AUTO_ROTO_MODULES = new Set([
  "src/application/autoRotoNativeProduct.ts",
  "src/application/autoRotoProductContract.ts",
  "src/domain/autoRotoPreviewProjection.ts",
  "src/domain/autoRotoProductReceipt.ts",
  "src/render/autoRotoMatteIntegrity.ts",
  "src/service/autoRotoServiceArtifact.ts",
]);
const PRODUCT_NATIVE_ENGINE_MODULES = new Set([
  "src/application/autoRotoNativeProduct.ts",
  "src/application/autoRotoProductContract.ts",
  "src/domain/autoRotoProductReceipt.ts",
  "src/render/nativeCore.ts",
  "src/shared/utf8ByteOrder.ts",
]);
const SERVICE_RESEARCH_MARKERS = [
  "editkin-native-onnx-assisted-roto/v1",
  "editkin-sam21-video-memory-roto/v1",
  "editkin.auto-roto-video-pack/v1",
  "editkin.auto-roto-video-pack/v2",
  "editkin.auto-roto-video-pack/v3",
  "bindSam21VideoPack",
  "createSam21VideoRoto",
  "inspect_auto_roto_video_pack",
] as const;
const TAURI_RESEARCH_MARKERS = [
  "inspect_auto_roto_video_model",
  "install_auto_roto_video_model",
  "pick_and_install_auto_roto_video_model",
  "repair_auto_roto_video_model",
  "inspect_auto_roto_video_pack",
  "EDITKIN_AUTO_ROTO_ENABLE_EXTERNAL_RESEARCH_PACKS",
  "EDITKIN_AUTO_ROTO_VIDEO_MODEL_ROOT",
  "auto-roto-sam21-video-host.py",
  "editkin.auto-roto-active-pack/v1",
] as const;
const NATIVE_RESEARCH_MARKERS = [
  "editkin-native-onnx-assisted-roto/v1",
  "OnnxRotoPackRequest",
  "onnxPack",
  "external ONNX Auto Roto runtime",
] as const;
const PRODUCT_RESEARCH_MARKERS = [...new Set([
  ...SERVICE_RESEARCH_MARKERS,
  ...TAURI_RESEARCH_MARKERS,
  ...NATIVE_RESEARCH_MARKERS,
])];

const TAURI_RUNTIME_SOURCES = {
  "BUILD-MANIFEST.json": ".release-input-manifest.json",
  "demo-source.mp4": "public/demo-source.mp4",
  "editkin-demo-preview.mp4": "public/editkin-demo-preview.mp4",
  "editkin-gpu-compositor.exe": "native/bin/win32-x64/editkin-gpu-compositor.exe",
  "editkin.spdx.json": "release/editkin.spdx.json",
  "FFMPEG-LICENSE.txt": "vendor/ffmpeg/win32-x64/FFMPEG-LICENSE.txt",
  "ffmpeg.exe": "vendor/ffmpeg/win32-x64/ffmpeg.exe",
  "ffprobe.exe": "vendor/ffmpeg/win32-x64/ffprobe.exe",
  "ggml-base.dll": "vendor/whisper/win32-x64/ggml-base.dll",
  "ggml-cpu.dll": "vendor/whisper/win32-x64/ggml-cpu.dll",
  "ggml.dll": "vendor/whisper/win32-x64/ggml.dll",
  "hao-core.exe": "native/bin/win32-x64/hao-core.exe",
  "mcp.mjs": "desktop-dist/mcp.mjs",
  "mcp.mjs.material-color-identity.json": "desktop-dist/mcp.mjs.material-color-identity.json",
  "NODE-LICENSE.txt": "vendor/node/win32-x64/NODE-LICENSE.txt",
  "NODE-MANIFEST.json": "vendor/node/win32-x64/manifest.json",
  "node.exe": "vendor/node/win32-x64/node.exe",
  "remote.mjs": "desktop-dist/remote.mjs",
  "service.mjs": "desktop-dist/service.mjs",
  "THIRD_PARTY_NOTICES.md": "release/THIRD_PARTY_NOTICES.md",
  "whisper-cli.exe": "vendor/whisper/win32-x64/whisper-cli.exe",
  "WHISPER-LICENSE.txt": "vendor/whisper/win32-x64/WHISPER-LICENSE.txt",
  "WHISPER-MANIFEST.json": "vendor/whisper/win32-x64/manifest.json",
  "whisper.dll": "vendor/whisper/win32-x64/whisper.dll",
} as const;
const DESKTOP_RUNTIME_SOURCES = {
  "BUILD-MANIFEST.json": ".release-input-manifest.json",
  "demo-source.mp4": "public/demo-source.mp4",
  "editkin-demo-preview.mp4": "public/editkin-demo-preview.mp4",
  "FFMPEG-LICENSE.txt": "vendor/ffmpeg/win32-x64/FFMPEG-LICENSE.txt",
  "FFMPEG-MANIFEST.json": "vendor/ffmpeg/win32-x64/manifest.json",
  "ffmpeg.exe": "vendor/ffmpeg/win32-x64/ffmpeg.exe",
  "ffprobe.exe": "vendor/ffmpeg/win32-x64/ffprobe.exe",
  "ggml-base.dll": "vendor/whisper/win32-x64/ggml-base.dll",
  "ggml-cpu.dll": "vendor/whisper/win32-x64/ggml-cpu.dll",
  "ggml.dll": "vendor/whisper/win32-x64/ggml.dll",
  "hao-core.exe": "native/bin/win32-x64/hao-core.exe",
  "whisper-cli.exe": "vendor/whisper/win32-x64/whisper-cli.exe",
  "WHISPER-LICENSE.txt": "vendor/whisper/win32-x64/WHISPER-LICENSE.txt",
  "WHISPER-MANIFEST.json": "vendor/whisper/win32-x64/manifest.json",
  "whisper.dll": "vendor/whisper/win32-x64/whisper.dll",
} as const;
const TAURI_RUNTIME_FILES = Object.keys(TAURI_RUNTIME_SOURCES);
const DESKTOP_RUNTIME_FILES = Object.keys(DESKTOP_RUNTIME_SOURCES);
const TAURI_OWNED_RESEARCH_SURFACES = ["BUILD-MANIFEST.json", "hao-core.exe", "mcp.mjs", "remote.mjs", "service.mjs"] as const;
const DESKTOP_OWNED_RESEARCH_SURFACES = ["BUILD-MANIFEST.json", "hao-core.exe"] as const;

interface InventoryEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  bytes?: number;
  sha256?: string;
}

interface ReceiptInput {
  path: string;
  bytes: number;
  sha256: string;
}

interface FactSet {
  productImportGraphClosed: boolean;
  expectedServiceResearchFree: boolean;
  desktopServiceFreshAndResearchFree: boolean;
  tauriStagedServiceFreshAndResearchFree: boolean;
  tauriRuntimeClosedWorld: boolean;
  desktopRuntimeClosedWorld: boolean;
  desktopCandidateEnvelopeFresh: boolean;
  tauriRuntimeBytesFresh: boolean;
  desktopRuntimeBytesFresh: boolean;
  tauriOwnedRuntimeResearchFree: boolean;
  desktopOwnedRuntimeResearchFree: boolean;
  releaseManifestProductScoped: boolean;
  stagedManifestsFresh: boolean;
  stagedNativeCopiesFresh: boolean;
  tauriReceiptFreshNoDefaultFeatures: boolean;
  tauriBinaryResearchFree: boolean;
  nativeReceiptFreshNoDefaultFeatures: boolean;
  nativeBinaryResearchFree: boolean;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalize(path: string): string {
  return path.split(sep).join("/");
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function isCleanedProductBuildGeneration(pathValue: unknown): Promise<boolean> {
  if (typeof pathValue !== "string" || pathValue.includes("\\") || pathValue.startsWith("/") || isAbsolute(pathValue)) return false;
  const generationRoot = resolve(appRoot, "src-tauri/target-product-generations");
  const generationPath = resolve(appRoot, pathValue);
  const relation = relative(generationRoot, generationPath);
  if (!relation || relation.startsWith("..") || isAbsolute(relation) || relation.includes(sep) || !relation.startsWith("generation-")) return false;
  try {
    await lstat(generationPath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function assertNoSymlinkAncestry(boundaryInput: string, targetInput: string): Promise<void> {
  const boundary = resolve(boundaryInput);
  const target = resolve(targetInput);
  if (!isInside(boundary, target)) throw new Error(`Product artifact path escaped app root: ${target}`);
  let cursor = boundary;
  for (const part of ["", ...relative(boundary, target).split(/[\\/]+/u).filter(Boolean)]) {
    if (part) cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Product artifact path contains symlink/junction ancestry: ${normalize(relative(boundary, cursor)) || "."}`);
  }
  const [canonicalBoundary, canonicalTarget] = await Promise.all([realpath(boundary), realpath(target)]);
  if (!isInside(canonicalBoundary, canonicalTarget)) throw new Error(`Product artifact canonical path escaped app root: ${target}`);
}

function markerFindings(bytes: Uint8Array, markers: readonly string[]): string[] {
  const buffer = Buffer.from(bytes);
  return markers.filter((marker) => buffer.includes(Buffer.from(marker)));
}

function serviceArtifactFresh(expected: Buffer, candidate: Buffer | undefined): boolean {
  return Boolean(candidate?.equals(expected)) && markerFindings(candidate!, SERVICE_RESEARCH_MARKERS).length === 0;
}

function evaluateFacts(facts: FactSet): "GREEN_NATIVE_PRODUCT_ARTIFACT_FRESH" | "FAIL" {
  return Object.values(facts).every(Boolean) ? "GREEN_NATIVE_PRODUCT_ARTIFACT_FRESH" : "FAIL";
}

export function evaluateClosedWorldInventory(entries: InventoryEntry[], expectedFiles: readonly string[]): {
  passed: boolean;
  missing: string[];
  extra: string[];
  extraDirectories: string[];
  links: string[];
  unsupported: string[];
  duplicates: string[];
} {
  const expected = new Set(expectedFiles);
  const expectedDirectories = new Set(expectedFiles.flatMap((path) => {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  }));
  const observedPaths = entries.map((entry) => entry.path);
  const folded = new Map<string, string[]>();
  for (const path of observedPaths) {
    const key = path.toLocaleLowerCase("en-US");
    folded.set(key, [...(folded.get(key) ?? []), path]);
  }
  const duplicates = [...folded.values()].filter((paths) => paths.length > 1).flat().sort();
  const files = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
  const links = entries.filter((entry) => entry.kind === "symlink").map((entry) => entry.path).sort();
  const unsupported = entries.filter((entry) => entry.kind === "other").map((entry) => entry.path).sort();
  const extraDirectories = entries.filter((entry) => entry.kind === "directory" && !expectedDirectories.has(entry.path)).map((entry) => entry.path).sort();
  const missing = [...expected].filter((path) => !files.has(path)).sort();
  const extra = [...files].filter((path) => !expected.has(path)).sort();
  return {
    passed: missing.length === 0 && extra.length === 0 && extraDirectories.length === 0 && links.length === 0 && unsupported.length === 0 && duplicates.length === 0,
    missing, extra, extraDirectories, links, unsupported, duplicates,
  };
}

async function inventoryTree(rootInput: string): Promise<InventoryEntry[]> {
  const root = resolve(rootInput);
  await assertNoSymlinkAncestry(appRoot, root);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Product runtime root must be a real directory: ${root}`);
  const output: InventoryEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = normalize(relative(root, absolute));
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        output.push({ path, kind: "symlink" });
      } else if (info.isDirectory()) {
        output.push({ path, kind: "directory" });
        await visit(absolute);
      } else if (info.isFile()) {
        const bytes = await readFile(absolute);
        output.push({ path, kind: "file", bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        output.push({ path, kind: "other" });
      }
    }
  }
  await visit(root);
  return output.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function inspectDesktopCandidateEnvelope(envelopeRoot: string): Promise<{
  passed: boolean;
  topLevel: string[];
  missingTopLevel: string[];
  extraTopLevel: string[];
  nonDirectories: string[];
  mismatchedRoots: string[];
}> {
  const expectedTopLevel = ["color", "creative-packs", "font-packs", "personal-packs", "plugins", "runtime"];
  await assertNoSymlinkAncestry(appRoot, envelopeRoot);
  const entries = await readdir(envelopeRoot, { withFileTypes: true });
  const topLevel = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right, "en"));
  const folded = new Set<string>();
  const nonDirectories: string[] = [];
  for (const entry of entries) {
    const foldedName = entry.name.toLocaleLowerCase("en-US");
    const info = await lstat(resolve(envelopeRoot, entry.name));
    if (folded.has(foldedName) || !info.isDirectory() || info.isSymbolicLink()) nonDirectories.push(entry.name);
    folded.add(foldedName);
  }
  const missingTopLevel = expectedTopLevel.filter((name) => !topLevel.includes(name));
  const extraTopLevel = topLevel.filter((name) => !expectedTopLevel.includes(name));
  const roots = [
    ["creative-packs", ".creative-packs/hao-creator-library", "creative-packs/hao-creator-library"],
    ["personal-packs", ".personal-packs/hao-music-library", "personal-packs/hao-music-library"],
    ["font-packs", "public/fonts", "font-packs/editkin-open-fonts"],
    ["color", "public/color/aces2", "color/aces2"],
    ["plugins", "plugins", "plugins"],
  ] as const;
  const mismatchedRoots: string[] = [];
  for (const [label, source, destination] of roots) {
    try {
      const [sourceInventory, candidateInventory] = await Promise.all([
        inventoryTree(resolve(appRoot, source)),
        inventoryTree(resolve(envelopeRoot, destination)),
      ]);
      if (JSON.stringify(sourceInventory) !== JSON.stringify(candidateInventory)) mismatchedRoots.push(label);
    } catch {
      mismatchedRoots.push(label);
    }
  }
  return {
    passed: missingTopLevel.length === 0 && extraTopLevel.length === 0 && nonDirectories.length === 0 && mismatchedRoots.length === 0,
    topLevel,
    missingTopLevel,
    extraTopLevel,
    nonDirectories: nonDirectories.sort(),
    mismatchedRoots: mismatchedRoots.sort(),
  };
}

function aggregateIdentity(entries: ReceiptInput[]): { files: number; bytes: number; sha256: string } {
  const digest = createHash("sha256");
  let bytes = 0;
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    digest.update(entry.path).update("\0").update(String(entry.bytes)).update("\0").update(entry.sha256).update("\n");
    bytes += entry.bytes;
  }
  return { files: entries.length, bytes, sha256: digest.digest("hex") };
}

async function collectInputInventory(roots: readonly string[]): Promise<ReceiptInput[]> {
  const output: ReceiptInput[] = [];
  async function visit(target: string): Promise<void> {
    const relation = relative(appRoot, target);
    if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Build input escaped app root: ${target}`);
    await assertNoSymlinkAncestry(appRoot, target);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Build input is a symlink/junction: ${normalize(relation)}`);
    if (info.isFile()) {
      const bytes = await readFile(target);
      output.push({ path: normalize(relation), bytes: bytes.length, sha256: sha256(bytes) });
      return;
    }
    if (!info.isDirectory()) throw new Error(`Build input has unsupported type: ${normalize(relation)}`);
    const entries = await readdir(target, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) await visit(resolve(target, entry.name));
  }
  for (const root of roots) await visit(resolve(appRoot, root));
  return output.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function receiptInputsCurrent(entries: unknown, expected: ReceiptInput[] | undefined): Promise<{
  passed: boolean;
  reason: string;
  identity?: ReturnType<typeof aggregateIdentity>;
  path?: string;
  receipt?: { bytes: number; sha256: string };
  current?: { bytes: number; sha256: string };
  missing?: string[];
  extra?: string[];
}> {
  if (!expected) return { passed: false, reason: "current-input-inventory-unavailable" };
  if (!Array.isArray(entries) || entries.length === 0) return { passed: false, reason: "missing-input-inventory" };
  const parsed: ReceiptInput[] = [];
  const seen = new Set<string>();
  const seenFolded = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") return { passed: false, reason: "invalid-input-entry" };
    const entry = raw as Partial<ReceiptInput>;
    if (typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.startsWith("/") || isAbsolute(entry.path)
      || entry.path.split("/").some((part) => !part || part === "." || part === "..") || seen.has(entry.path)
      || seenFolded.has(entry.path.toLocaleLowerCase("en-US"))
      || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0 || !SHA256.test(entry.sha256 ?? "")) {
      return { passed: false, reason: "invalid-or-duplicate-input-entry" };
    }
    const target = resolve(appRoot, entry.path);
    const relation = relative(appRoot, target);
    if (relation.startsWith("..") || isAbsolute(relation)) return { passed: false, reason: "input-escaped-app-root" };
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) return { passed: false, reason: "input-not-regular-file" };
      const bytes = await readFile(target);
      const currentSha256 = sha256(bytes);
      if (bytes.length !== entry.bytes || currentSha256 !== entry.sha256) return {
        passed: false,
        reason: "stale-input",
        path: entry.path,
        receipt: { bytes: Number(entry.bytes), sha256: entry.sha256! },
        current: { bytes: bytes.length, sha256: currentSha256 },
      };
    } catch {
      return { passed: false, reason: "missing-input" };
    }
    seen.add(entry.path);
    seenFolded.add(entry.path.toLocaleLowerCase("en-US"));
    parsed.push(entry as ReceiptInput);
  }
  parsed.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    const parsedPaths = new Set(parsed.map((entry) => entry.path));
    const expectedPaths = new Set(expected.map((entry) => entry.path));
    return {
      passed: false,
      reason: "incomplete-or-extra-input-inventory",
      missing: [...expectedPaths].filter((path) => !parsedPaths.has(path)).sort(),
      extra: [...parsedPaths].filter((path) => !expectedPaths.has(path)).sort(),
    };
  }
  return { passed: true, reason: "current-closed-world", identity: aggregateIdentity(parsed) };
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    await assertNoSymlinkAncestry(appRoot, path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

async function runtimeCopiesFresh(
  runtimeRoot: string,
  sources: Readonly<Record<string, string>>,
): Promise<{ passed: boolean; missingSource: string[]; missingStaged: string[]; mismatched: string[] }> {
  const missingSource: string[] = [];
  const missingStaged: string[] = [];
  const mismatched: string[] = [];
  for (const [destination, source] of Object.entries(sources)) {
    const [sourceBytes, stagedBytes] = await Promise.all([
      readOptional(resolve(appRoot, source)),
      readOptional(resolve(runtimeRoot, destination)),
    ]);
    if (!sourceBytes) missingSource.push(source);
    if (!stagedBytes) missingStaged.push(destination);
    if (sourceBytes && stagedBytes && !sourceBytes.equals(stagedBytes)) mismatched.push(destination);
  }
  return {
    passed: missingSource.length === 0 && missingStaged.length === 0 && mismatched.length === 0,
    missingSource: missingSource.sort(), missingStaged: missingStaged.sort(), mismatched: mismatched.sort(),
  };
}

async function ownedRuntimeResearchFindings(
  runtimeRoot: string,
  surfaces: readonly string[],
): Promise<Array<{ path: string; markers: string[] }>> {
  const findings: Array<{ path: string; markers: string[] }> = [];
  for (const path of surfaces) {
    const bytes = await readOptional(resolve(runtimeRoot, path));
    const markers = bytes ? markerFindings(bytes, PRODUCT_RESEARCH_MARKERS) : ["missing"];
    if (markers.length) findings.push({ path, markers });
  }
  return findings;
}

async function inspectReceipt(path: string): Promise<Record<string, any> | undefined> {
  try {
    const bytes = await readFile(path);
    const value = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasNoResearchFeatureArgs(args: unknown, requireEmbeddedFrontend = false): boolean {
  if (!Array.isArray(args) || !args.every((argument) => typeof argument === "string") || !args.includes("--no-default-features")) return false;
  let embeddedFeatures = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (requireEmbeddedFrontend && argument === "--features" && args[index + 1] === "tauri/custom-protocol") {
      embeddedFeatures += 1;
      index += 1;
      continue;
    }
    if (/^--(?:all-)?features(?:=|$)/.test(argument) || /^-F(?:=|$|[^-])/.test(argument)
      || argument.includes("auto-roto-research")) return false;
  }
  return requireEmbeddedFrontend ? embeddedFeatures === 1 : embeddedFeatures === 0;
}

function parseCandidateRuntimeArgs(args: string[]): { artifactRoot: string; desktop: string } {
  const result: { artifactRoot?: string; desktop?: string } = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--artifact-root" && flag !== "--desktop-candidate-runtime") || !value || value.startsWith("--")) {
      throw new Error("Freshness gate requires --artifact-root <candidate-release> and --desktop-candidate-runtime <same-generation-runtime>");
    }
    const key = flag === "--artifact-root" ? "artifactRoot" : "desktop";
    if (result[key]) throw new Error(`Freshness gate rejects duplicate ${flag}`);
    result[key] = value;
  }
  if (!result.artifactRoot) throw new Error("Freshness gate requires one explicit --artifact-root");
  if (!result.desktop) throw new Error("Freshness gate requires one explicit --desktop-candidate-runtime; canonical fallback is forbidden");
  return result as { artifactRoot: string; desktop: string };
}

async function runSelfTest(): Promise<void> {
  const clean = Buffer.from("editkin-native-color-temporal-roto/v1");
  const research = Buffer.from(`product ${SERVICE_RESEARCH_MARKERS[0]}`);
  const valid: FactSet = {
    productImportGraphClosed: true,
    expectedServiceResearchFree: true,
    desktopServiceFreshAndResearchFree: true,
    tauriStagedServiceFreshAndResearchFree: true,
    tauriRuntimeClosedWorld: true,
    desktopRuntimeClosedWorld: true,
    desktopCandidateEnvelopeFresh: true,
    tauriRuntimeBytesFresh: true,
    desktopRuntimeBytesFresh: true,
    tauriOwnedRuntimeResearchFree: true,
    desktopOwnedRuntimeResearchFree: true,
    releaseManifestProductScoped: true,
    stagedManifestsFresh: true,
    stagedNativeCopiesFresh: true,
    tauriReceiptFreshNoDefaultFeatures: true,
    tauriBinaryResearchFree: true,
    nativeReceiptFreshNoDefaultFeatures: true,
    nativeBinaryResearchFree: true,
  };
  if (evaluateFacts(valid) !== "GREEN_NATIVE_PRODUCT_ARTIFACT_FRESH") throw new Error("valid freshness fixture rejected");
  const factMutations = (Object.keys(valid) as Array<keyof FactSet>).map((key) => {
    if (evaluateFacts({ ...valid, [key]: false }) !== "FAIL") throw new Error(`freshness evaluator missed ${key}`);
    return key;
  });
  const cleanServiceAccepted = serviceArtifactFresh(clean, clean);
  const staleServiceRejected = !serviceArtifactFresh(clean, Buffer.from(`${clean.toString()}-stale`));
  const researchMarkerRejected = !serviceArtifactFresh(research, research);
  const expected = ["service.mjs", "hao-core.exe"];
  const exact = evaluateClosedWorldInventory(expected.map((path) => ({ path, kind: "file" as const })), expected);
  const extra = evaluateClosedWorldInventory([...expected.map((path) => ({ path, kind: "file" as const })), { path: "sam2.pt", kind: "file" }], expected);
  const symlink = evaluateClosedWorldInventory([...expected.map((path) => ({ path, kind: "file" as const })), { path: "research-link", kind: "symlink" }], expected);
  const featureArgMutationsRejected = [
    ["build", "--no-default-features", "--features", "auto-roto-research"],
    ["build", "--no-default-features", "--features=auto-roto-research"],
    ["build", "--no-default-features", "--all-features"],
    ["build", "--no-default-features", "-F", "auto-roto-research"],
    ["build", "--no-default-features", "-Fauto-roto-research"],
  ].every((args) => !hasNoResearchFeatureArgs(args));
  const standaloneArgs = ["build", "--locked", "--release", "--no-default-features", "--features", "tauri/custom-protocol", "--manifest-path", "src-tauri/Cargo.toml"];
  const standaloneFrontendAccepted = hasNoResearchFeatureArgs(standaloneArgs, true) && !hasNoResearchFeatureArgs(standaloneArgs);
  const standaloneFeatureMutations = [
    ["build", "--no-default-features"],
    [...standaloneArgs, "--features", "tauri/custom-protocol"],
    [...standaloneArgs, "--features", "auto-roto-research"],
    [...standaloneArgs, "--features=auto-roto-research"],
    [...standaloneArgs, "--all-features"],
    [...standaloneArgs, "-Fauto-roto-research"],
    standaloneArgs.map((argument) => argument === "tauri/custom-protocol" ? "tauri/custom-protocol,auto-roto-research" : argument),
    standaloneArgs.map((argument) => argument === "tauri/custom-protocol" ? "custom-protocol" : argument),
  ];
  const standaloneFeatureMutationsRejected = standaloneFeatureMutations.every((args) => !hasNoResearchFeatureArgs(args, true));
  const parsedCandidates = parseCandidateRuntimeArgs([
    "--artifact-root", "src-tauri/product-release-candidates/candidate-0123/release",
    "--desktop-candidate-runtime", ".desktop-product-release-candidates/candidate-0123/runtime",
  ]);
  const candidateArgMutations = [
    [],
    ["--artifact-root"],
    ["--artifact-root", "src-tauri/product-release-candidates/candidate-0123/release"],
    ["--desktop-candidate-runtime"],
    ["--unknown", "candidate/runtime"],
    ["--artifact-root", "one", "--artifact-root", "two"],
    ["--desktop-candidate-runtime", "one", "--desktop-candidate-runtime", "two"],
  ];
  const candidateArgsRejected = candidateArgMutations.every((args) => {
    try { parseCandidateRuntimeArgs(args); return false; } catch { return true; }
  });

  const nativeInputs = await collectInputInventory(NATIVE_CORE_BUILD_INPUT_ROOTS);
  const freshNativeInputs = await receiptInputsCurrent(nativeInputs, nativeInputs);
  const requiredNativeHelpers = [...NATIVE_SHARED_PROCESS_INPUTS,
    "scripts/lib/cargo-artifact-path.mjs", "scripts/lib/native-shared-inputs.mjs"];
  for (const path of requiredNativeHelpers) {
    if (!nativeInputs.some((entry) => entry.path === path)) throw new Error(`native input closure omitted ${path}`);
    const missing = await receiptInputsCurrent(nativeInputs.filter((entry) => entry.path !== path), nativeInputs);
    if (missing.passed || !missing.missing?.includes(path)) throw new Error(`native input evaluator accepted omitted ${path}`);
  }
  const unexpectedInputs = await collectInputInventory(["src/service/cli.ts"]);
  const extraNativeInputs = await receiptInputsCurrent([...nativeInputs, ...unexpectedInputs], nativeInputs);
  const changedNativeInputs = await receiptInputsCurrent(nativeInputs.map((entry, index) => index === 0
    ? { ...entry, bytes: entry.bytes + 1 } : entry), nativeInputs);
  const duplicateNativeInputs = await receiptInputsCurrent([...nativeInputs, nativeInputs[0]], nativeInputs);
  const traversingNativeInputs = await receiptInputsCurrent([{ ...nativeInputs[0], path: "../outside.rs" }], nativeInputs);
  if (!freshNativeInputs.passed || !freshNativeInputs.identity || extraNativeInputs.passed
    || changedNativeInputs.passed || duplicateNativeInputs.passed || traversingNativeInputs.passed) {
    throw new Error("native closed-world input controls are not calibrated");
  }

  resolveDesktopCandidateForTauriArtifact(appRoot, parsedCandidates.artifactRoot, parsedCandidates.desktop);
  const wrongDesktopCandidates = [
    ".desktop-resources/runtime",
    ".desktop-product-release-candidates/wrong-generation/runtime",
    ".desktop-product-release-candidates/wrong/../candidate-0123/runtime",
  ];
  for (const runtime of wrongDesktopCandidates) {
    let rejected = false;
    try { resolveDesktopCandidateForTauriArtifact(appRoot, parsedCandidates.artifactRoot, runtime); }
    catch { rejected = true; }
    if (!rejected) throw new Error(`freshness evaluator accepted an unpaired desktop candidate: ${runtime}`);
  }
  if (!cleanServiceAccepted || !staleServiceRejected || !researchMarkerRejected || !exact.passed || extra.passed || symlink.passed
    || !featureArgMutationsRejected || !standaloneFrontendAccepted || !standaloneFeatureMutationsRejected
    || !parsedCandidates.artifactRoot || !parsedCandidates.desktop || !candidateArgsRejected) {
    throw new Error("freshness negative controls are not calibrated");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN_SELF_TEST", scope: "evaluator-controls-only", factMutations: factMutations.length, cleanServiceAccepted, staleServiceRejected, researchMarkerRejected, extraRejected: !extra.passed, symlinkRejected: !symlink.passed, featureArgMutationsRejected, standaloneFrontendAccepted, standaloneFeatureMutationsRejected: standaloneFeatureMutations.length, candidateArgMutationsRejected: candidateArgMutations.length, wrongDesktopCandidatesRejected: wrongDesktopCandidates.length, missingNativeHelpersRejected: requiredNativeHelpers.length, nativeInputMutationControls: 4, nativeReceiptInputIdentity: freshNativeInputs.identity, productFreshness: "NOT_RUN" })}\n`);
}

const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--self-test")) {
  if (cliArgs.length !== 1) throw new Error("Freshness self-test does not accept additional arguments");
  await runSelfTest();
  process.exit(0);
}
const candidateArgs = parseCandidateRuntimeArgs(cliArgs);
const candidate = resolveTauriCandidateArtifactRoot(appRoot, candidateArgs.artifactRoot);
await assertTauriCandidateArtifactRoot(candidate, "inspect");
const desktopCandidateStage = resolveDesktopCandidateForTauriArtifact(appRoot, candidateArgs.artifactRoot, candidateArgs.desktop);
const tauriRuntimeRoot = resolve(candidate.artifactRoot, "runtime");

const serviceBuild = await build({
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
  metafile: true,
  logLevel: "silent",
  define: { __EDITKIN_AUTO_ROTO_SERVICE_ARTIFACT_KIND__: JSON.stringify("product") },
});
if (serviceBuild.outputFiles.length !== 1 || !serviceBuild.metafile) throw new Error("Expected one product service output and an esbuild metafile");
const nativeEngineBuild = await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/application/autoRotoNativeProduct.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  write: false,
  metafile: true,
  logLevel: "silent",
});
if (!nativeEngineBuild.metafile) throw new Error("Expected a self-authored native Auto Roto engine metafile");
const expectedService = Buffer.from(serviceBuild.outputFiles[0].contents);
const importGraph = Object.keys(serviceBuild.metafile.inputs).map((path) => normalize(path)).sort();
const autoRotoImports = importGraph.filter((path) => /(?:^|\/)autoRoto[^/]*\.ts$/i.test(path));
const unexpectedAutoRotoImports = autoRotoImports.filter((path) => !PRODUCT_AUTO_ROTO_MODULES.has(path));
const nativeEngineImportGraph = Object.keys(nativeEngineBuild.metafile.inputs).map((path) => normalize(path)).sort();
const nativeEngineProductModules = nativeEngineImportGraph.filter((path) => path.startsWith("src/"));
const nativeEngineUnexpectedModules = nativeEngineProductModules.filter((path) => !PRODUCT_NATIVE_ENGINE_MODULES.has(path));
const nativeEngineMissingModules = [...PRODUCT_NATIVE_ENGINE_MODULES].filter((path) => !nativeEngineProductModules.includes(path));
const expectedServiceResearchMarkers = markerFindings(expectedService, SERVICE_RESEARCH_MARKERS);

const desktopServicePath = resolve(appRoot, "desktop-dist/service.mjs");
const tauriServicePath = resolve(tauriRuntimeRoot, "service.mjs");
const desktopService = await readOptional(desktopServicePath);
const tauriService = await readOptional(tauriServicePath);
const desktopServiceResearchMarkers = desktopService ? markerFindings(desktopService, SERVICE_RESEARCH_MARKERS) : ["missing"];
const tauriServiceResearchMarkers = tauriService ? markerFindings(tauriService, SERVICE_RESEARCH_MARKERS) : ["missing"];

const desktopRuntimeRoot = desktopCandidateStage.targetRoot;
let tauriRuntimeInventory: InventoryEntry[] = [];
let desktopRuntimeInventory: InventoryEntry[] = [];
let tauriRuntimeError: string | undefined;
let desktopRuntimeError: string | undefined;
try { tauriRuntimeInventory = await inventoryTree(tauriRuntimeRoot); } catch (error) { tauriRuntimeError = String(error); }
try { desktopRuntimeInventory = await inventoryTree(desktopRuntimeRoot); } catch (error) { desktopRuntimeError = String(error); }
const tauriRuntimeClosed = evaluateClosedWorldInventory(tauriRuntimeInventory, TAURI_RUNTIME_FILES);
const desktopRuntimeClosed = evaluateClosedWorldInventory(desktopRuntimeInventory, DESKTOP_RUNTIME_FILES);
const tauriRuntimeFresh = await runtimeCopiesFresh(tauriRuntimeRoot, TAURI_RUNTIME_SOURCES);
const desktopRuntimeFresh = await runtimeCopiesFresh(desktopRuntimeRoot, DESKTOP_RUNTIME_SOURCES);
const desktopCandidateEnvelope = await inspectDesktopCandidateEnvelope(desktopCandidateStage.envelopeRoot);
const tauriOwnedRuntimeResearchFindings = await ownedRuntimeResearchFindings(tauriRuntimeRoot, TAURI_OWNED_RESEARCH_SURFACES);
const desktopOwnedRuntimeResearchFindings = await ownedRuntimeResearchFindings(desktopRuntimeRoot, DESKTOP_OWNED_RESEARCH_SURFACES);

const releaseManifest = await readOptional(resolve(appRoot, ".release-input-manifest.json"));
let parsedReleaseManifest: unknown;
let releaseManifestParseError: string | undefined;
try {
  parsedReleaseManifest = releaseManifest ? JSON.parse(releaseManifest.toString("utf8")) : undefined;
  if (!parsedReleaseManifest) releaseManifestParseError = "missing-release-manifest";
} catch (error) {
  releaseManifestParseError = String(error);
}
const releaseManifestPolicyFindings = parsedReleaseManifest
  ? productReleaseManifestFindings(parsedReleaseManifest)
  : [{ code: "manifest-unreadable", detail: releaseManifestParseError ?? "missing-release-manifest" }];
const tauriManifest = await readOptional(resolve(tauriRuntimeRoot, "BUILD-MANIFEST.json"));
const desktopManifest = await readOptional(resolve(desktopRuntimeRoot, "BUILD-MANIFEST.json"));
const promotedNativePath = resolve(appRoot, "native/bin/win32-x64/hao-core.exe");
const promotedNative = await readOptional(promotedNativePath);
const tauriStagedNative = await readOptional(resolve(tauriRuntimeRoot, "hao-core.exe"));
const desktopStagedNative = await readOptional(resolve(desktopRuntimeRoot, "hao-core.exe"));

let expectedTauriReceiptInputs: ReceiptInput[] | undefined;
let expectedNativeReceiptInputs: ReceiptInput[] | undefined;
let tauriInputInventoryError: string | undefined;
let nativeInputInventoryError: string | undefined;
try {
  expectedTauriReceiptInputs = await collectInputInventory([
    "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/src",
    "src-tauri/remote-relay.json", "src-tauri/tauri.conf.json", "src-tauri/tauri.android.conf.json",
    "src-tauri/tauri.existing-dev-server.conf.json", "src-tauri/tauri.ios.conf.json",
    "src-tauri/tauri.macos.conf.json", "src-tauri/tauri.windows.conf.json", "src-tauri/capabilities",
    "src-tauri/icons", "src/shared/agentSetupContract.json",
    ".release-input-manifest.json", "scripts/build-tauri-product-binary.mjs",
    "scripts/lib/tauri-product-feature-policy.mjs", "dist",
  ]);
} catch (error) { tauriInputInventoryError = String(error); }
try {
  expectedNativeReceiptInputs = await collectInputInventory(NATIVE_CORE_BUILD_INPUT_ROOTS);
} catch (error) { nativeInputInventoryError = String(error); }

const tauriReceipt = await inspectReceipt(resolve(candidate.artifactRoot, ".editkin-build-receipt.json"));
const tauriReceiptInputs = {
  checked: false,
  sourceInventoryAvailable: Boolean(expectedTauriReceiptInputs),
  expected: expectedTauriReceiptInputs?.length ?? 0,
  reason: "candidate-receipt-binds-release-manifest-not-legacy-input-list",
};
const tauriBuildGenerationCleaned = false;
const tauriBinaryPath = resolve(candidate.artifactRoot, process.platform === "win32" ? "editkin.exe" : "editkin");
const tauriBinary = await readOptional(tauriBinaryPath);
const tauriBinaryMarkers = tauriBinary ? markerFindings(tauriBinary, TAURI_RESEARCH_MARKERS) : ["missing"];
const candidateArtifactTarget = await inspectWindowsTauriCandidatePrimaryArtifacts(candidate, JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8")).version);
let tauriReceiptTargetBound = false;
try {
  tauriReceiptTargetBound = assertTauriArtifactTargetBinding(candidate, tauriReceipt?.artifactTarget, candidateArtifactTarget);
} catch { /* fact remains false */ }
const sourceReleaseManifestIdentity = releaseManifest ? { bytes: releaseManifest.length, sha256: sha256(releaseManifest) } : undefined;
const tauriReceiptFresh = tauriReceipt?.schema === "editkin.tauri-candidate-build-receipt/v1"
  && tauriReceipt?.callerEnvironmentPolicy === "reject-rust-cargo-toolchain-feature-and-target-injection"
  && tauriReceipt?.cargoTargetDir === candidate.cargoTargetDir
  && tauriReceipt?.desktopCandidateRuntime === desktopCandidateStage.relativeRuntime
  && hasNoResearchFeatureArgs(tauriReceipt?.command?.args)
  && tauriReceiptTargetBound
  && JSON.stringify(tauriReceipt?.releaseManifest) === JSON.stringify(sourceReleaseManifestIdentity)
  && JSON.stringify(tauriReceipt?.stagedReleaseManifest) === JSON.stringify(sourceReleaseManifestIdentity)
  && Boolean(tauriBinary);

const nativeReceipt = await inspectReceipt(resolve(appRoot, ".rd/benchmarks/editkin-native-core-build-receipt.json"));
const nativeReceiptInputs = await receiptInputsCurrent(nativeReceipt?.inputs?.files, expectedNativeReceiptInputs);
const nativeBinaryMarkers = promotedNative ? markerFindings(promotedNative, NATIVE_RESEARCH_MARKERS) : ["missing"];
const nativeReceiptPromotedPath = typeof nativeReceipt?.promoted?.path === "string" ? resolve(appRoot, nativeReceipt.promoted.path) : "";
const nativeReceiptFresh = nativeReceipt?.schema === "editkin.native-core-build-receipt/v1"
  && nativeReceipt?.productMode === "no-default-features-self-authored-auto-roto"
  && hasNoResearchFeatureArgs(nativeReceipt?.command)
  && nativeReceipt?.dependencyClosure?.ortPresent === false
  && nativeReceiptInputs.passed && nativeReceiptInputs.identity?.sha256 === nativeReceipt?.inputs?.aggregateSha256
  && nativeReceiptPromotedPath === promotedNativePath
  && Boolean(promotedNative) && nativeReceipt?.promoted?.bytes === promotedNative?.length
  && nativeReceipt?.promoted?.sha256 === (promotedNative ? sha256(promotedNative) : "");

const facts: FactSet = {
  productImportGraphClosed: autoRotoImports.includes("src/application/autoRotoNativeProduct.ts")
    && unexpectedAutoRotoImports.length === 0
    && nativeEngineUnexpectedModules.length === 0
    && nativeEngineMissingModules.length === 0,
  expectedServiceResearchFree: expectedServiceResearchMarkers.length === 0,
  desktopServiceFreshAndResearchFree: serviceArtifactFresh(expectedService, desktopService),
  tauriStagedServiceFreshAndResearchFree: serviceArtifactFresh(expectedService, tauriService),
  tauriRuntimeClosedWorld: !tauriRuntimeError && tauriRuntimeClosed.passed,
  desktopRuntimeClosedWorld: !desktopRuntimeError && desktopRuntimeClosed.passed,
  desktopCandidateEnvelopeFresh: desktopCandidateEnvelope.passed,
  tauriRuntimeBytesFresh: tauriRuntimeFresh.passed,
  desktopRuntimeBytesFresh: desktopRuntimeFresh.passed,
  tauriOwnedRuntimeResearchFree: tauriOwnedRuntimeResearchFindings.length === 0,
  desktopOwnedRuntimeResearchFree: desktopOwnedRuntimeResearchFindings.length === 0,
  releaseManifestProductScoped: releaseManifestPolicyFindings.length === 0,
  stagedManifestsFresh: Boolean(releaseManifest && tauriManifest?.equals(releaseManifest) && desktopManifest?.equals(releaseManifest)),
  stagedNativeCopiesFresh: Boolean(promotedNative && tauriStagedNative?.equals(promotedNative) && desktopStagedNative?.equals(promotedNative)),
  tauriReceiptFreshNoDefaultFeatures: Boolean(tauriReceiptFresh),
  tauriBinaryResearchFree: Boolean(tauriBinary) && tauriBinaryMarkers.length === 0,
  nativeReceiptFreshNoDefaultFeatures: Boolean(nativeReceiptFresh),
  nativeBinaryResearchFree: Boolean(promotedNative) && nativeBinaryMarkers.length === 0,
};
const canonicalStatus = evaluateFacts(facts);
const usingCandidate = true;
const status = canonicalStatus === "FAIL"
  ? "FAIL"
  : usingCandidate
    ? "GREEN_NATIVE_PRODUCT_CANDIDATE_ARTIFACT_FRESH_NOT_ACTIVATED"
    : canonicalStatus;
const report = {
  schema: "editkin.auto-roto-native-product-artifact-freshness-gate/v1",
  status,
  generatedAt: new Date().toISOString(),
  activation: {
    mode: usingCandidate ? "candidate-not-activated" : "canonical-release-runtime",
    tauri: "candidate-not-activated",
    desktop: "candidate-not-activated",
    canonicalRuntimeLockedOrUnverified: {
      tauri: true,
      desktop: true,
    },
  },
  checks: facts,
  service: {
    expected: { bytes: expectedService.length, sha256: sha256(expectedService), researchMarkers: expectedServiceResearchMarkers },
    importGraph: {
      inputs: importGraph,
      autoRotoImports,
      unexpectedAutoRotoImports,
      nativeEngineInputs: nativeEngineImportGraph,
      nativeEngineProductModules,
      nativeEngineUnexpectedModules,
      nativeEngineMissingModules,
    },
    desktop: desktopService ? { path: normalize(relative(appRoot, desktopServicePath)), bytes: desktopService.length, sha256: sha256(desktopService), researchMarkers: desktopServiceResearchMarkers } : null,
    tauriStaged: tauriService ? { path: normalize(relative(appRoot, tauriServicePath)), bytes: tauriService.length, sha256: sha256(tauriService), researchMarkers: tauriServiceResearchMarkers } : null,
  },
  staging: {
    tauri: { root: normalize(relative(appRoot, tauriRuntimeRoot)), error: tauriRuntimeError ?? null, result: tauriRuntimeClosed, freshness: tauriRuntimeFresh, researchFindings: tauriOwnedRuntimeResearchFindings, inventory: tauriRuntimeInventory },
    desktop: { root: normalize(relative(appRoot, desktopRuntimeRoot)), error: desktopRuntimeError ?? null, result: desktopRuntimeClosed, freshness: desktopRuntimeFresh, candidateEnvelope: desktopCandidateEnvelope, researchFindings: desktopOwnedRuntimeResearchFindings, inventory: desktopRuntimeInventory },
    releaseManifest: {
      sha256: releaseManifest ? sha256(releaseManifest) : null,
      parseError: releaseManifestParseError ?? null,
      policyFindings: releaseManifestPolicyFindings,
    },
  },
  binaries: {
    tauri: { path: normalize(relative(appRoot, tauriBinaryPath)), researchMarkers: tauriBinaryMarkers, inputInventoryError: tauriInputInventoryError ?? null, buildGenerationCleaned: tauriBuildGenerationCleaned, receiptInputs: tauriReceiptInputs, receipt: tauriReceipt ?? null },
    native: { path: normalize(relative(appRoot, promotedNativePath)), researchMarkers: nativeBinaryMarkers, inputInventoryError: nativeInputInventoryError ?? null, receiptInputs: nativeReceiptInputs, receipt: nativeReceipt ?? null },
  },
  claimBoundary: usingCandidate
    ? "Proves only that the selected non-activated Tauri candidate and same-generation desktop staging are byte-current, closed-world and free of enumerated research execution markers. It explicitly does not inspect or switch either canonical runtime, nor prove installer replay, signing, quality, or competitor superiority."
    : "Proves only that freshly derived internal product service/native/Tauri artifacts and the two canonical local staged runtime trees are byte-current, closed-world and free of enumerated SAM/ONNX/custom research execution markers. Research benchmark history remains untouched. This is not public-installer replay, signing, quality, or competitor-superiority evidence.",
};
await mkdir(dirname(reportPath), { recursive: true });
const temporary = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rm(reportPath, { force: true });
  await rename(temporary, reportPath);
} finally {
  await rm(temporary, { force: true });
}
process.stdout.write(`AUTO_ROTO_NATIVE_PRODUCT_FRESHNESS status=${status} report=${reportPath}\n`);
if (status === "FAIL") process.exitCode = 1;
