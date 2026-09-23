import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 3;
const MANIFEST_KIND = "editkin-product-mcp-generation";
const POINTER_KIND = "editkin-product-mcp-pointer";
const POINTER_NAME = "ACTIVE-GENERATION.json";
const MANIFEST_NAME = "GENERATION-MANIFEST.json";
const STATE_DIRECTORY_NAME = "agent-runtime-v3";
const MAX_POINTER_BYTES = 8 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ENTRYPOINT_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION_DIRECTORY = /^([a-f0-9]{64})--([a-f0-9]{32})$/u;
const SELECTION_REVISION = /^[a-f0-9]{32}$/u;

export const PRODUCT_AGENT_FILE_ROLES = Object.freeze([
  "embeddedContract",
  "entrypoint",
  "entrypointIdentity",
  "ffmpeg",
  "ffprobe",
  "gpuCompositor",
  "launcher",
  "nativeCore",
  "node",
  "nodeManifest",
  "whisper",
]);

export const PRODUCT_AGENT_DIRECTORY_ROLES = Object.freeze([
  "color",
  "creativePack",
  "fonts",
  "personalMusic",
  "personalVisual",
  "plugins",
  "resourceRoot",
]);

function normalizedPath(value) {
  const absolute = resolve(value);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function pathInside(root, candidate) {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unexpected closed-world field set`);
  }
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJsonValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortedJsonValue(value), null, 2)}\n`;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeText(value, label) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC")
    || [...value].some((character) => character.charCodeAt(0) < 0x20)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertAbsolutePath(value, label) {
  assertSafeText(value, label);
  if (!isAbsolute(value) || !samePath(value, resolve(value))) throw new Error(`${label} must be an absolute normalized path`);
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function assertExactRoleSet(records, roles, label) {
  if (!Array.isArray(records)) throw new Error(`${label} must be an array`);
  const actual = records.map(({ role } = {}) => role);
  if (actual.length !== roles.length || actual.some((role, index) => role !== roles[index])) {
    throw new Error(`${label} role set or order drifted`);
  }
}

export function generationIdForRecords(files, directories) {
  const hash = createHash("sha256").update(`${MANIFEST_KIND}/v${SCHEMA_VERSION}\n`);
  for (const record of directories) hash.update(`D\0${record.role}\0${record.path}\n`);
  for (const record of files) hash.update(`F\0${record.role}\0${record.path}\0${record.bytes}\0${record.sha256}\n`);
  return hash.digest("hex");
}

function validateManifest(value) {
  assertExactKeys(value, ["directories", "files", "generationId", "kind", "schemaVersion"], "Product MCP generation manifest");
  if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== MANIFEST_KIND) {
    throw new Error("Product MCP generation manifest schema or kind is unsupported");
  }
  assertExactRoleSet(value.files, PRODUCT_AGENT_FILE_ROLES, "Product MCP file bindings");
  assertExactRoleSet(value.directories, PRODUCT_AGENT_DIRECTORY_ROLES, "Product MCP directory bindings");
  const seenPaths = new Set();
  for (const record of value.files) {
    assertExactKeys(record, ["bytes", "path", "role", "sha256"], `Product MCP file binding ${record?.role ?? "unknown"}`);
    assertAbsolutePath(record.path, `Product MCP file ${record.role}`);
    if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0) throw new Error(`Product MCP file ${record.role} has an invalid size`);
    assertSha256(record.sha256, `Product MCP file ${record.role}`);
    const key = normalizedPath(record.path);
    if (seenPaths.has(key)) throw new Error("Product MCP file bindings contain a duplicate path");
    seenPaths.add(key);
  }
  for (const record of value.directories) {
    assertExactKeys(record, ["path", "role"], `Product MCP directory binding ${record?.role ?? "unknown"}`);
    assertAbsolutePath(record.path, `Product MCP directory ${record.role}`);
  }
  const directories = Object.fromEntries(value.directories.map((record) => [record.role, record.path]));
  for (const record of [...value.files, ...value.directories.filter(({ role }) => !["personalVisual", "resourceRoot"].includes(role))]) {
    if (!pathInside(directories.resourceRoot, record.path)) throw new Error(`${record.role} escaped the generation resource root`);
  }
  assertSha256(value.generationId, "Product MCP generation ID");
  if (generationIdForRecords(value.files, value.directories) !== value.generationId) {
    throw new Error("Product MCP generation ID does not match its closed-world bindings");
  }
  return value;
}

function validatePointer(value) {
  assertExactKeys(value, [
    "generationDirectoryName", "generationId", "kind", "manifestSha256", "schemaVersion", "selectionRevision",
  ], "Product MCP active pointer");
  if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== POINTER_KIND) {
    throw new Error("Product MCP active pointer schema or kind is unsupported");
  }
  assertSha256(value.generationId, "Product MCP active generation ID");
  assertSha256(value.manifestSha256, "Product MCP active manifest identity");
  if (typeof value.selectionRevision !== "string" || !SELECTION_REVISION.test(value.selectionRevision)) {
    throw new Error("Product MCP selection revision is invalid");
  }
  const match = typeof value.generationDirectoryName === "string"
    ? GENERATION_DIRECTORY.exec(value.generationDirectoryName)
    : null;
  if (!match || match[1] !== value.generationId) throw new Error("Product MCP generation directory is invalid");
  return value;
}

async function readCanonicalJson(path, maximumBytes, label) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > maximumBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  if (!samePath(await realpath(path), path)) throw new Error(`${label} traverses a link or junction`);
  const bytes = await readFile(path);
  const value = JSON.parse(bytes.toString("utf8"));
  if (canonicalJson(value) !== bytes.toString("utf8")) throw new Error(`${label} is not canonical closed-world JSON`);
  return { bytes, value };
}

async function assertCanonicalDirectory(path, owningRoot, label) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is not a regular directory`);
  const canonical = await realpath(path);
  if (!samePath(canonical, path) || (owningRoot && !pathInside(owningRoot, canonical))) {
    throw new Error(`${label} traverses a link, junction, or owning root`);
  }
  return canonical;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyFileRecord(record, resourceRoot) {
  const details = await lstat(record.path);
  if (!details.isFile() || details.isSymbolicLink() || details.size !== record.bytes) {
    throw new Error(`Product MCP file ${record.role} changed or is not regular`);
  }
  const canonical = await realpath(record.path);
  if (!samePath(canonical, record.path) || !pathInside(resourceRoot, canonical)) {
    throw new Error(`Product MCP file ${record.role} traverses a link or generation root`);
  }
  if (await hashFile(record.path) !== record.sha256) throw new Error(`Product MCP file ${record.role} failed SHA-256 verification`);
}

async function readVerifiedRecord(record, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const bytes = await readFile(record.path);
  if (bytes.length !== record.bytes || bytes.length > maximumBytes || sha256Bytes(bytes) !== record.sha256) {
    throw new Error(`Product MCP file ${record.role} changed between verification and readback`);
  }
  return bytes;
}

function roleMap(records) {
  return Object.fromEntries(records.map((record) => [record.role, record]));
}

function verifyEntrypointIdentity(entrypoint, identityBytes) {
  const identity = JSON.parse(identityBytes.toString("utf8"));
  const bundle = identity?.bundle;
  if (!bundle || bundle.file !== basename(entrypoint.path)
    || bundle.size !== entrypoint.bytes || bundle.sha256 !== entrypoint.sha256) {
    throw new Error("Product MCP entrypoint identity sidecar does not bind the verified entrypoint");
  }
}

export function verifyNodeManifest(node, manifestBytes, runningExecutable) {
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const windowsRuntimeIdentity = manifest?.nodeExeSha256 === node.sha256
    && manifest?.version === process.versions.node;
  const macRuntimeIdentity = manifest?.schemaVersion === 2
    && manifest?.nodeVersion === process.versions.node
    && manifest?.files?.node === node.sha256;
  if (!windowsRuntimeIdentity && !macRuntimeIdentity) {
    throw new Error("Product MCP Node manifest does not bind the running Node runtime");
  }
  if (!samePath(node.path, runningExecutable)) {
    throw new Error("Product MCP launcher is not running through the generation-selected Node path");
  }
  return hashFile(runningExecutable).then((identity) => {
    if (identity !== node.sha256) throw new Error("Product MCP launcher is running through an unowned Node runtime");
  });
}

async function resolvePluginRoots(resourceRoot, builtin, configured) {
  const roots = [builtin];
  const rejected = [];
  const seen = new Set([normalizedPath(builtin)]);
  for (const raw of configured.split(delimiter).map((value) => value.trim()).filter(Boolean)) {
    try {
      if (!isAbsolute(raw) || pathInside(resourceRoot, raw)) throw new Error("app-owned");
      const canonical = await assertCanonicalDirectory(resolve(raw), undefined, "External plugin root");
      const key = normalizedPath(canonical);
      if (!seen.has(key)) {
        seen.add(key);
        roots.push(canonical);
      }
    } catch {
      rejected.push(raw);
    }
  }
  return { roots, rejected };
}

export function assertLauncherArguments(args) {
  if (!Array.isArray(args) || args.length !== 2) {
    throw new Error("Editkin product MCP generation launcher accepts no runtime or entrypoint arguments");
  }
}

export async function launchProductMcpGeneration({
  stateRoot = process.env.EDITKIN_AGENT_STATE_ROOT,
  runningExecutable = process.execPath,
  selfPath = fileURLToPath(import.meta.url),
  importModule = (url) => import(url),
} = {}) {
  const mcpMode = process.env.EDITKIN_MCP_MODE;
  if (mcpMode !== undefined && mcpMode !== "" && mcpMode !== "remote-only") {
    throw new Error("EDITKIN_MCP_MODE is not a supported closed-world mode");
  }
  const remoteOnly = mcpMode === "remote-only";
  assertAbsolutePath(stateRoot, "EDITKIN_AGENT_STATE_ROOT");
  if (basename(stateRoot) !== STATE_DIRECTORY_NAME) throw new Error("Editkin Agent state root has the wrong closed-world directory name");
  const canonicalState = await assertCanonicalDirectory(stateRoot, dirname(stateRoot), "Editkin Agent state root");
  const pointerRecord = await readCanonicalJson(resolve(canonicalState, POINTER_NAME), MAX_POINTER_BYTES, "Product MCP active pointer");
  const pointer = validatePointer(pointerRecord.value);
  const generationRoot = resolve(canonicalState, "generations", pointer.generationDirectoryName);
  if (!pathInside(resolve(canonicalState, "generations"), generationRoot)) throw new Error("Product MCP generation escaped the state root");
  await assertCanonicalDirectory(generationRoot, canonicalState, "Product MCP generation directory");
  const manifestRecord = await readCanonicalJson(resolve(generationRoot, MANIFEST_NAME), MAX_MANIFEST_BYTES, "Product MCP generation manifest");
  if (sha256Bytes(manifestRecord.bytes) !== pointer.manifestSha256) throw new Error("Product MCP active manifest hash does not match its pointer");
  const manifest = validateManifest(manifestRecord.value);
  if (manifest.generationId !== pointer.generationId) throw new Error("Product MCP active manifest generation differs from its pointer");
  const files = roleMap(manifest.files);
  const directories = roleMap(manifest.directories);
  const resourceRoot = await assertCanonicalDirectory(directories.resourceRoot.path, undefined, "Product MCP resource root");
  for (const directory of manifest.directories.filter(({ role }) => !["personalVisual", "resourceRoot"].includes(role))) {
    await assertCanonicalDirectory(directory.path, resourceRoot, `Product MCP directory ${directory.role}`);
  }
  await assertCanonicalDirectory(directories.personalVisual.path, dirname(canonicalState), "Product MCP personal visual directory");
  for (const file of manifest.files) await verifyFileRecord(file, resourceRoot);
  if (!samePath(files.launcher.path, selfPath)) throw new Error("Host configuration did not select the generation-bound stable launcher");
  await verifyNodeManifest(files.node, await readVerifiedRecord(files.nodeManifest), runningExecutable);
  const entrypointBytes = await readVerifiedRecord(files.entrypoint, MAX_ENTRYPOINT_BYTES);
  verifyEntrypointIdentity(files.entrypoint, await readVerifiedRecord(files.entrypointIdentity));

  let rejectedPluginRoots = [];
  if (remoteOnly) {
    for (const key of [
      "HAO_FFMPEG_PATH", "EDITKIN_FFMPEG_PATH", "HAO_FFPROBE_PATH", "EDITKIN_FFPROBE_PATH",
      "EDITKIN_WHISPER_CLI_PATH", "HAO_NATIVE_CORE_PATH", "EDITKIN_GPU_COMPOSITOR_PATH",
      "EDITKIN_CREATIVE_PACK_ROOT", "EDITKIN_PERSONAL_MUSIC_ROOT", "EDITKIN_PERSONAL_VISUAL_ROOT",
      "EDITKIN_FONT_ROOT", "EDITKIN_COLOR_ROOT", "EDITKIN_PLUGIN_ROOTS", "EDITKIN_MODEL_ROOT",
      "EDITKIN_CACHE_ROOT", "EDITKIN_VIDEO_AUTOPILOT_SKILL", "EDITKIN_WORKFLOW_PROFILE_PATH",
    ]) delete process.env[key];
  } else {
    process.env.HAO_FFMPEG_PATH = files.ffmpeg.path;
    process.env.EDITKIN_FFMPEG_PATH = files.ffmpeg.path;
    process.env.HAO_FFPROBE_PATH = files.ffprobe.path;
    process.env.EDITKIN_FFPROBE_PATH = files.ffprobe.path;
    process.env.EDITKIN_WHISPER_CLI_PATH = files.whisper.path;
    process.env.HAO_NATIVE_CORE_PATH = files.nativeCore.path;
    process.env.EDITKIN_GPU_COMPOSITOR_PATH = files.gpuCompositor.path;
    process.env.EDITKIN_CREATIVE_PACK_ROOT = directories.creativePack.path;
    process.env.EDITKIN_PERSONAL_MUSIC_ROOT = directories.personalMusic.path;
    process.env.EDITKIN_PERSONAL_VISUAL_ROOT = directories.personalVisual.path;
    process.env.EDITKIN_FONT_ROOT = directories.fonts.path;
    process.env.EDITKIN_COLOR_ROOT = directories.color.path;
    const plugins = await resolvePluginRoots(resourceRoot, directories.plugins.path, process.env.EDITKIN_PLUGIN_ROOTS ?? "");
    process.env.EDITKIN_PLUGIN_ROOTS = plugins.roots.join(delimiter);
    rejectedPluginRoots = plugins.rejected;
  }

  await importModule(`data:text/javascript;base64,${entrypointBytes.toString("base64")}`);
  return {
    status: "GREEN_PRODUCT_MCP_GENERATION_STARTED",
    generationId: manifest.generationId,
    selectionRevision: pointer.selectionRevision,
    rejectedPluginRoots,
  };
}

const launchedAsMain = process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (launchedAsMain) {
  assertLauncherArguments(process.argv);
  await launchProductMcpGeneration();
}
