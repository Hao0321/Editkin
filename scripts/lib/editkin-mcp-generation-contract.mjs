import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export const EDITKIN_MCP_GENERATION_SCHEMA = 3;
export const EDITKIN_MCP_GENERATION_KIND = "editkin-mcp-runtime-snapshot";
export const EDITKIN_MCP_POINTER_KIND = "editkin-mcp-runtime-pointer";
export const EDITKIN_MCP_COMMIT_KIND = "editkin-mcp-runtime-commit";
export const EDITKIN_MCP_RUNTIME_BINDINGS_VERSION = 2;
export const EDITKIN_APP_ROOT = resolve(import.meta.dirname, "../..");
export const EDITKIN_MCP_STATE_ROOT = resolve(
  EDITKIN_APP_ROOT,
  "src-tauri/target-product-generations/editkin-mcp-runtime-v3",
);
export const EDITKIN_VENDOR_NODE = resolve(EDITKIN_APP_ROOT, "vendor/node/win32-x64/node.exe");

export const ACTIVE_POINTER_NAME = "ACTIVE-GENERATION.json";
export const ACTIVATION_LOCK_NAME = "ACTIVATION.lock";
export const GENERATION_COMMIT_NAME = "GENERATION-COMMITTED.json";
export const GENERATION_MANIFEST_NAME = "GENERATION-MANIFEST.json";
export const GENERATION_CONTENT_DIRECTORY = "content";
export const GENERATIONS_DIRECTORY = "generations";
export const MAX_POINTER_BYTES = 4 * 1024;
export const MAX_COMMIT_BYTES = 4 * 1024;
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_MCP_BYTES = 128 * 1024 * 1024;
export const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANDIDATE_ID_PATTERN = /^candidate-[a-f0-9]{16}$/u;
const GENERATION_DIRECTORY_PATTERN = /^([a-f0-9]{64})--([a-f0-9]{32})$/u;
const SELECTION_REVISION_PATTERN = /^[a-f0-9]{32}$/u;
const MANIFEST_PATH_PATTERN = /^[^\\/:*?"<>|\u0000-\u001f]+(?:\/[^\\/:*?"<>|\u0000-\u001f]+)*$/u;

export const SNAPSHOT_TOP_LEVEL_DIRECTORIES = Object.freeze([
  "color",
  "creative-packs",
  "font-packs",
  "personal-packs",
  "plugins",
  "runtime",
]);

export const EDITKIN_RELEASE_RUNTIME_FILES = Object.freeze([
  "BUILD-MANIFEST.json",
  "demo-source.mp4",
  "editkin-demo-preview.mp4",
  "editkin-gpu-compositor.exe",
  "editkin.spdx.json",
  "FFMPEG-LICENSE.txt",
  "ffmpeg.exe",
  "ffprobe.exe",
  "ggml-base.dll",
  "ggml-cpu.dll",
  "ggml.dll",
  "hao-core.exe",
  "mcp.mjs",
  "mcp.mjs.material-color-identity.json",
  "NODE-LICENSE.txt",
  "NODE-MANIFEST.json",
  "node.exe",
  "remote.mjs",
  "service.mjs",
  "THIRD_PARTY_NOTICES.md",
  "whisper-cli.exe",
  "WHISPER-LICENSE.txt",
  "WHISPER-MANIFEST.json",
  "whisper.dll",
].sort());

export const EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES = Object.freeze([
  "BUILD-MANIFEST.json",
  "demo-source.mp4",
  "editkin-demo-preview.mp4",
  "FFMPEG-LICENSE.txt",
  "FFMPEG-MANIFEST.json",
  "ffmpeg.exe",
  "ffprobe.exe",
  "ggml-base.dll",
  "ggml-cpu.dll",
  "ggml.dll",
  "hao-core.exe",
  "whisper-cli.exe",
  "WHISPER-LICENSE.txt",
  "WHISPER-MANIFEST.json",
  "whisper.dll",
].sort());

export function assertExactReleaseRuntimeFileSet(actualNames, expectedNames, label = "Release runtime") {
  if (!Array.isArray(actualNames) || !Array.isArray(expectedNames)
    || actualNames.some((name) => typeof name !== "string") || expectedNames.some((name) => typeof name !== "string")) {
    throw new Error(`${label} file set is invalid`);
  }
  const actual = [...actualNames].sort();
  const expected = [...expectedNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${label} file set drifted from the closed-world contract`);
  }
  return actual;
}

export const SNAPSHOT_RUNTIME_BINDINGS = Object.freeze({
  creativePack: "creative-packs/hao-creator-library",
  personalMusic: "personal-packs/hao-music-library",
  fonts: "font-packs/editkin-open-fonts",
  color: "color/aces2",
  plugins: "plugins",
  ffmpeg: "runtime/ffmpeg.exe",
  ffprobe: "runtime/ffprobe.exe",
  whisper: "runtime/whisper-cli.exe",
  nativeCore: "runtime/hao-core.exe",
  gpuCompositor: "runtime/editkin-gpu-compositor.exe",
  entrypoint: "runtime/mcp.mjs",
});

export const NODE_MANIFEST_KEYS = Object.freeze([
  "archiveSha256",
  "licenseSha256",
  "nodeExeSha256",
  "source",
  "version",
]);

export class McpGenerationConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "McpGenerationConflictError";
    this.code = "EDITKIN_MCP_GENERATION_CONFLICT";
    this.details = details;
  }
}

export class McpGenerationLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpGenerationLockedError";
    this.code = "EDITKIN_MCP_GENERATION_LOCKED";
  }
}

export class McpGenerationPreflightTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "McpGenerationPreflightTimeoutError";
    this.code = "EDITKIN_MCP_PREFLIGHT_TIMEOUT";
    this.details = details;
  }
}

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain JSON object`);
  }
}

export function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} has an unexpected closed-world field set`);
  }
}

export function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

export function validateGenerationDirectoryName(value, expectedGenerationId) {
  if (typeof value !== "string" || value !== value.normalize("NFC")) {
    throw new Error("MCP generation directory name is invalid");
  }
  const match = GENERATION_DIRECTORY_PATTERN.exec(value);
  if (!match || (expectedGenerationId && match[1] !== expectedGenerationId)) {
    throw new Error("MCP generation directory name does not match its generation ID");
  }
  return value;
}

export function normalizeManifestPath(value, label = "Snapshot path") {
  if (typeof value !== "string" || value !== value.normalize("NFC") || !MANIFEST_PATH_PATTERN.test(value)) {
    throw new Error(`${label} is not a normalized relative manifest path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || !segment)) {
    throw new Error(`${label} contains a traversal or empty segment`);
  }
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  if (segments.some((segment) => /[. ]$/u.test(segment) || reserved.test(segment))) {
    throw new Error(`${label} contains a Windows-ambiguous segment`);
  }
  return value;
}

function normalizedFilesystemPath(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

export function sameFilesystemPath(left, right) {
  return normalizedFilesystemPath(left) === normalizedFilesystemPath(right);
}

export function isPathInside(root, path) {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function assertStrictDescendant(root, path, label) {
  if (sameFilesystemPath(root, path) || !isPathInside(root, path)) {
    throw new Error(`${label} escaped its closed-world root`);
  }
}

export function resolveCandidateEnvelope(appRootInput, candidateId) {
  const appRoot = resolve(appRootInput);
  assertCandidateId(candidateId);
  const candidatesRoot = resolve(appRoot, "src-tauri/product-release-candidates");
  const envelopeRoot = resolve(candidatesRoot, candidateId);
  assertStrictDescendant(candidatesRoot, envelopeRoot, "MCP release candidate");
  return { appRoot, candidatesRoot, envelopeRoot };
}

export function assertCandidateId(candidateId) {
  if (typeof candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error("Candidate ID must be candidate- followed by exactly 16 lowercase hexadecimal characters");
  }
  return candidateId;
}

function compareManifestPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortManifestPaths(values) {
  return [...values].sort(compareManifestPaths);
}

function assertSortedUniquePaths(values, label) {
  let previous = null;
  const caseFolded = new Set();
  for (const value of values) {
    normalizeManifestPath(value, label);
    if (previous !== null && compareManifestPaths(previous, value) >= 0) throw new Error(`${label} list is not strictly sorted`);
    const folded = value.toLowerCase();
    if (caseFolded.has(folded)) throw new Error(`${label} list has a case-insensitive duplicate`);
    caseFolded.add(folded);
    previous = value;
  }
}

function validateSnapshotFileRecords(files, directories) {
  const paths = [];
  const directorySet = new Set(directories);
  for (const file of files) {
    assertExactKeys(file, ["bytes", "path", "sha256"], "Snapshot file record");
    normalizeManifestPath(file.path, "Snapshot file path");
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error("Snapshot file byte size is invalid");
    assertSha256(file.sha256, "Snapshot file identity");
    const slash = file.path.lastIndexOf("/");
    if (slash < 1 || !directorySet.has(file.path.slice(0, slash))) {
      throw new Error("Snapshot file parent directory is absent from the manifest");
    }
    paths.push(file.path);
  }
  assertSortedUniquePaths(paths, "Snapshot file path");
}

export function snapshotIdentity(directories, files) {
  return {
    schemaVersion: EDITKIN_MCP_GENERATION_SCHEMA,
    kind: EDITKIN_MCP_GENERATION_KIND,
    entrypoint: SNAPSHOT_RUNTIME_BINDINGS.entrypoint,
    runtimeBindingsVersion: EDITKIN_MCP_RUNTIME_BINDINGS_VERSION,
    directories,
    files,
  };
}

export function generationIdForInventory(directories, files) {
  return hashBytes(canonicalJson(snapshotIdentity(directories, files)));
}

export function createSnapshotManifest(sourceCandidateId, directories, files) {
  const identity = snapshotIdentity(directories, files);
  return {
    ...identity,
    generationId: generationIdForInventory(directories, files),
    sourceCandidateId,
  };
}

export function validateSnapshotManifest(manifest) {
  assertExactKeys(manifest, [
    "directories", "entrypoint", "files", "generationId", "kind",
    "runtimeBindingsVersion", "schemaVersion", "sourceCandidateId",
  ], "MCP generation manifest");
  if (manifest.schemaVersion !== EDITKIN_MCP_GENERATION_SCHEMA || manifest.kind !== EDITKIN_MCP_GENERATION_KIND) {
    throw new Error("MCP generation manifest schema or kind is unsupported");
  }
  if (manifest.entrypoint !== SNAPSHOT_RUNTIME_BINDINGS.entrypoint
    || manifest.runtimeBindingsVersion !== EDITKIN_MCP_RUNTIME_BINDINGS_VERSION) {
    throw new Error("MCP generation runtime binding contract is unsupported");
  }
  assertCandidateId(manifest.sourceCandidateId);
  assertSha256(manifest.generationId, "MCP generation ID");
  if (!Array.isArray(manifest.directories) || !Array.isArray(manifest.files)) {
    throw new Error("MCP generation manifest inventories are missing");
  }
  assertSortedUniquePaths(manifest.directories, "Snapshot directory");
  const directorySet = new Set(manifest.directories);
  for (const directory of manifest.directories) {
    const slash = directory.lastIndexOf("/");
    if (slash > 0 && !directorySet.has(directory.slice(0, slash))) {
      throw new Error("Snapshot directory parent is absent from the manifest");
    }
  }
  for (const required of SNAPSHOT_TOP_LEVEL_DIRECTORIES) {
    if (!manifest.directories.includes(required)) throw new Error(`Snapshot is missing required directory: ${required}`);
  }
  const topLevel = manifest.directories.filter((path) => !path.includes("/"));
  if (topLevel.length !== SNAPSHOT_TOP_LEVEL_DIRECTORIES.length
    || topLevel.some((path, index) => path !== SNAPSHOT_TOP_LEVEL_DIRECTORIES[index])) {
    throw new Error("Snapshot top-level directory set drifted from the closed-world contract");
  }
  const fileBindingNames = new Set(["ffmpeg", "ffprobe", "whisper", "nativeCore", "gpuCompositor", "entrypoint"]);
  for (const [name, required] of Object.entries(SNAPSHOT_RUNTIME_BINDINGS)) {
    if (fileBindingNames.has(name) ? !manifest.files.some(({ path }) => path === required) : !directorySet.has(required)) {
      throw new Error(`Snapshot runtime binding is absent: ${required}`);
    }
  }
  validateSnapshotFileRecords(manifest.files, manifest.directories);
  const runtimeFiles = manifest.files.map(({ path }) => path).filter((path) => path.startsWith("runtime/"));
  if (runtimeFiles.some((path) => path.slice("runtime/".length).includes("/"))) {
    throw new Error("Release runtime cannot contain nested files");
  }
  const runtimeNames = runtimeFiles.map((path) => path.slice("runtime/".length)).sort();
  assertExactReleaseRuntimeFileSet(runtimeNames, EDITKIN_RELEASE_RUNTIME_FILES, "MCP snapshot release runtime");
  if (!manifest.files.some(({ path }) => path === manifest.entrypoint)) throw new Error("Snapshot entrypoint is absent");
  if (generationIdForInventory(manifest.directories, manifest.files) !== manifest.generationId) {
    throw new Error("MCP generation ID does not match the complete canonical snapshot inventory");
  }
  return manifest;
}

export function validatePointer(pointer) {
  assertExactKeys(pointer, [
    "commitSha256", "generationDirectoryName", "generationId", "generationManifestSha256",
    "kind", "schemaVersion", "selectionRevision",
  ], "MCP active pointer");
  if (pointer.schemaVersion !== EDITKIN_MCP_GENERATION_SCHEMA || pointer.kind !== EDITKIN_MCP_POINTER_KIND) {
    throw new Error("MCP active pointer schema or kind is unsupported");
  }
  assertSha256(pointer.generationId, "MCP active generation ID");
  assertSha256(pointer.generationManifestSha256, "MCP generation manifest identity");
  assertSha256(pointer.commitSha256, "MCP generation commit identity");
  if (typeof pointer.selectionRevision !== "string" || !SELECTION_REVISION_PATTERN.test(pointer.selectionRevision)) {
    throw new Error("MCP active pointer selection revision is invalid");
  }
  validateGenerationDirectoryName(pointer.generationDirectoryName, pointer.generationId);
  return pointer;
}

export function validateGenerationCommit(commit) {
  assertExactKeys(commit, [
    "contentBytes", "contentFileCount", "generationDirectoryName", "generationId",
    "generationManifestSha256", "kind", "schemaVersion",
  ], "MCP generation commit marker");
  if (commit.schemaVersion !== EDITKIN_MCP_GENERATION_SCHEMA || commit.kind !== EDITKIN_MCP_COMMIT_KIND) {
    throw new Error("MCP generation commit marker schema or kind is unsupported");
  }
  assertSha256(commit.generationId, "Committed MCP generation ID");
  assertSha256(commit.generationManifestSha256, "Committed MCP generation manifest identity");
  if (!Number.isSafeInteger(commit.contentFileCount) || commit.contentFileCount <= 0
    || !Number.isSafeInteger(commit.contentBytes) || commit.contentBytes <= 0) {
    throw new Error("MCP generation commit marker content totals are invalid");
  }
  validateGenerationDirectoryName(commit.generationDirectoryName, commit.generationId);
  return commit;
}
