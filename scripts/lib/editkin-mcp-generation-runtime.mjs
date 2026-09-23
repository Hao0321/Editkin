import { randomBytes, randomUUID } from "node:crypto";
import { importVerifiedMaterialColorGeneration } from "./material-color-generation-bridge.mjs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import {
  ACTIVE_POINTER_NAME,
  ACTIVATION_LOCK_NAME,
  assertSha256,
  assertStrictDescendant,
  canonicalJson,
  EDITKIN_APP_ROOT,
  EDITKIN_MCP_COMMIT_KIND,
  EDITKIN_MCP_GENERATION_SCHEMA,
  EDITKIN_MCP_POINTER_KIND,
  EDITKIN_MCP_STATE_ROOT,
  GENERATION_COMMIT_NAME,
  GENERATIONS_DIRECTORY,
  hashBytes,
  MAX_COMMIT_BYTES,
  MAX_POINTER_BYTES,
  McpGenerationConflictError,
  McpGenerationLockedError,
  SNAPSHOT_RUNTIME_BINDINGS,
  sameFilesystemPath,
  TRANSIENT_RENAME_CODES,
  validateGenerationDirectoryName,
  validateGenerationCommit,
  validatePointer,
} from "./editkin-mcp-generation-contract.mjs";
import {
  assertCanonicalDirectory,
  assertCanonicalRegularFile,
  materializeCandidateSnapshot,
  readCanonicalJson,
  resolveSnapshotPluginRoots,
  verifySnapshotGeneration,
  verifyVendorNodeIdentity,
  writeDurableExclusive,
} from "./editkin-mcp-generation-snapshot.mjs";
import { inspectMcpGenerationCandidate } from "./editkin-mcp-generation-preflight.mjs";

export {
  EDITKIN_APP_ROOT,
  EDITKIN_MCP_STATE_ROOT,
  EDITKIN_RELEASE_RUNTIME_FILES,
  EDITKIN_VENDOR_NODE,
  resolveCandidateEnvelope,
} from "./editkin-mcp-generation-contract.mjs";
export { inspectMcpGenerationCandidate } from "./editkin-mcp-generation-preflight.mjs";
export { verifyVendorNodeIdentity } from "./editkin-mcp-generation-snapshot.mjs";

function generationRootFor(stateRoot, generationDirectoryName, expectedGenerationId) {
  const generationsRoot = resolve(stateRoot, GENERATIONS_DIRECTORY);
  validateGenerationDirectoryName(generationDirectoryName, expectedGenerationId);
  const generationRoot = resolve(generationsRoot, generationDirectoryName);
  assertStrictDescendant(generationsRoot, generationRoot, "MCP generation snapshot");
  return generationRoot;
}

async function ensureCanonicalStateRoot(stateRootInput, appRoot) {
  const stateRoot = resolve(stateRootInput);
  assertStrictDescendant(appRoot, stateRoot, "MCP generation state root");
  await assertCanonicalDirectory(appRoot, appRoot, "MCP application root");
  const directories = [];
  for (let path = resolve(stateRoot, GENERATIONS_DIRECTORY); !sameFilesystemPath(path, appRoot); path = dirname(path)) {
    directories.unshift(path);
  }
  // Validate existing ancestors before any mkdir. Recursive mkdir would write
  // through a junction before a later realpath check could reject that path.
  for (const directory of directories) {
    await assertCanonicalDirectory(dirname(directory), appRoot, "MCP state parent directory");
    try {
      await assertCanonicalDirectory(directory, appRoot, "MCP state directory");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(directory, { recursive: false });
      } catch (creationError) {
        if (creationError?.code !== "EEXIST") throw creationError;
      }
      await assertCanonicalDirectory(directory, appRoot, "MCP state directory");
    }
  }
  return stateRoot;
}

async function inspectCanonicalStateRoot(stateRootInput, appRoot) {
  const stateRoot = resolve(stateRootInput);
  assertStrictDescendant(appRoot, stateRoot, "MCP generation state root");
  await assertCanonicalDirectory(stateRoot, appRoot, "MCP generation state root");
  await assertCanonicalDirectory(resolve(stateRoot, GENERATIONS_DIRECTORY), stateRoot, "MCP generations directory");
  return stateRoot;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function renameWithBoundedRetry(renamePath, source, target, retries, retryDelayMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await renamePath(source, target);
    } catch (error) {
      if (attempt >= retries || !TRANSIENT_RENAME_CODES.has(error?.code)) throw error;
      await wait(Math.min(500, retryDelayMs * (attempt + 1)));
    }
  }
}

async function readActivePointer(stateRoot, { optional = false } = {}) {
  const pointerPath = resolve(stateRoot, ACTIVE_POINTER_NAME);
  try {
    const { bytes, parsed } = await readCanonicalJson(pointerPath, MAX_POINTER_BYTES, "MCP active generation pointer", stateRoot);
    return { pointerBytes: bytes, pointerPath, pointer: validatePointer(parsed), pointerSha256: hashBytes(bytes) };
  } catch (error) {
    if (optional && error?.code === "ENOENT") {
      return { pointerBytes: null, pointerPath, pointer: null, pointerSha256: null };
    }
    throw error;
  }
}

function normalizeExpectedPointerIdentity(value) {
  if (value === null) return null;
  if (value === undefined) throw new Error("Activation requires an explicit expected-current pointer identity (or none)");
  assertSha256(value, "Expected current MCP pointer identity");
  return value;
}

function assertCompareAndSwap(expected, actual, phase) {
  const actualIdentity = actual?.pointerSha256 ?? null;
  if (actualIdentity !== expected) {
    throw new McpGenerationConflictError(`MCP active generation changed during ${phase}`, {
      expectedPointerIdentity: expected,
      actualPointerIdentity: actualIdentity,
    });
  }
}

async function acquireActivationLock(stateRoot) {
  const lockPath = resolve(stateRoot, ACTIVATION_LOCK_NAME);
  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(canonicalJson({ pid: process.pid, token }));
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") throw new McpGenerationLockedError("Another Editkin MCP activation owns the exclusive lock");
    throw error;
  }
  return {
    lockPath,
    async release() {
      await handle.close();
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8"));
        if (current?.token === token) await unlink(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

async function writeAtomicSmallJson(
  directory,
  targetName,
  temporaryPrefix,
  value,
  maximumBytes,
  renamePath,
  retries,
  retryDelayMs,
) {
  const targetPath = resolve(directory, targetName);
  const temporaryPath = resolve(directory, `.${temporaryPrefix}-${process.pid}-${randomUUID()}.tmp`);
  if (!sameFilesystemPath(dirname(targetPath), directory)
    || !sameFilesystemPath(dirname(temporaryPath), directory)) {
    throw new Error("Atomic MCP JSON replacement must stay within one canonical parent directory");
  }
  const bytes = canonicalJson(value);
  if (Buffer.byteLength(bytes) <= 0 || Buffer.byteLength(bytes) > maximumBytes) {
    throw new Error("Atomic MCP JSON replacement exceeds its bounded small-file contract");
  }
  await writeDurableExclusive(temporaryPath, bytes);
  try {
    const details = await assertCanonicalRegularFile(
      temporaryPath,
      directory,
      "Atomic MCP JSON temporary file",
      { rejectHardlinks: true },
    );
    if (details.size !== Buffer.byteLength(bytes)) {
      throw new Error("Atomic MCP JSON temporary file changed before publication");
    }
    await renameWithBoundedRetry(renamePath, temporaryPath, targetPath, retries, retryDelayMs);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return targetPath;
}

async function writeActivePointer(stateRoot, pointer, renamePath, retries, retryDelayMs) {
  return writeAtomicSmallJson(
    stateRoot,
    ACTIVE_POINTER_NAME,
    "active",
    pointer,
    MAX_POINTER_BYTES,
    renamePath,
    retries,
    retryDelayMs,
  );
}

export async function verifyActiveMcpGeneration({
  appRoot = EDITKIN_APP_ROOT,
  stateRoot = EDITKIN_MCP_STATE_ROOT,
} = {}) {
  const canonicalStateRoot = await inspectCanonicalStateRoot(stateRoot, appRoot);
  const pointerRecord = await readActivePointer(canonicalStateRoot);
  const { pointerPath, pointer } = pointerRecord;
  const generationRoot = generationRootFor(
    canonicalStateRoot,
    pointer.generationDirectoryName,
    pointer.generationId,
  );
  const snapshot = await verifySnapshotGeneration(generationRoot, {
    expectedCommitSha256: pointer.commitSha256,
    expectedDirectoryName: pointer.generationDirectoryName,
    expectedGenerationId: pointer.generationId,
    expectedManifestSha256: pointer.generationManifestSha256,
  });
  return { stateRoot: canonicalStateRoot, ...pointerRecord, ...snapshot };
}

async function findReusableGeneration(candidate, generationsRoot) {
  const entries = await readdir(generationsRoot, { withFileTypes: true });
  const prefix = `${candidate.manifest.generationId}--`;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    try {
      validateGenerationDirectoryName(entry.name, candidate.manifest.generationId);
      const generationRoot = resolve(generationsRoot, entry.name);
      assertStrictDescendant(generationsRoot, generationRoot, "Reusable MCP generation snapshot");
      const existing = await verifySnapshotGeneration(generationRoot, {
        expectedDirectoryName: entry.name,
        expectedGenerationId: candidate.manifest.generationId,
      });
      if (existing.manifestSha256 !== candidate.manifestSha256
        || canonicalJson(existing.manifest) !== canonicalJson(candidate.manifest)) {
        continue;
      }
      return {
        commitSha256: existing.commitSha256,
        generationDirectoryName: entry.name,
        generationRoot,
        manifestSha256: existing.manifestSha256,
      };
    } catch {
      // An incomplete, malformed, linked, or tampered instance is never reusable.
    }
  }
  return null;
}

async function installGeneration(candidate, stateRoot, options) {
  const generationsRoot = resolve(stateRoot, GENERATIONS_DIRECTORY);
  const reusable = await findReusableGeneration(candidate, generationsRoot);
  if (reusable) return { generationCreated: false, ...reusable };

  const generationDirectoryName = `${candidate.manifest.generationId}--${randomBytes(16).toString("hex")}`;
  const generationRoot = generationRootFor(stateRoot, generationDirectoryName, candidate.manifest.generationId);
  await materializeCandidateSnapshot(candidate, generationRoot, { hooks: options.hooks });
  const commit = {
    schemaVersion: EDITKIN_MCP_GENERATION_SCHEMA,
    kind: EDITKIN_MCP_COMMIT_KIND,
    contentBytes: candidate.manifest.files.reduce((total, file) => total + file.bytes, 0),
    contentFileCount: candidate.manifest.files.length,
    generationDirectoryName,
    generationId: candidate.manifest.generationId,
    generationManifestSha256: candidate.manifestSha256,
  };
  validateGenerationCommit(commit);
  const commitSha256 = hashBytes(canonicalJson(commit));
  await options.hooks.beforeCommitMarker?.({ candidate, commit, generationDirectoryName, generationRoot });
  const commitPath = await writeAtomicSmallJson(
    generationRoot,
    GENERATION_COMMIT_NAME,
    "commit",
    commit,
    MAX_COMMIT_BYTES,
    options.renamePath,
    options.renameRetries,
    options.retryDelayMs,
  );
  await options.hooks.afterCommitMarker?.({ candidate, commit, commitPath, generationDirectoryName, generationRoot });
  await verifySnapshotGeneration(generationRoot, {
    expectedCommitSha256: commitSha256,
    expectedDirectoryName: generationDirectoryName,
    expectedGenerationId: candidate.manifest.generationId,
    expectedManifestSha256: candidate.manifestSha256,
  });
  return {
    generationCreated: true,
    generationDirectoryName,
    generationRoot,
    commitSha256,
    manifestSha256: candidate.manifestSha256,
  };
}

export async function activateMcpGeneration(candidateId, {
  expectedCurrentPointerIdentity,
  appRoot = EDITKIN_APP_ROOT,
  stateRoot = EDITKIN_MCP_STATE_ROOT,
  renamePath = rename,
  renameRetries = 8,
  retryDelayMs = 50,
  preflightTimeoutMs,
  preflightFault,
  preflightSupervisorHooks,
  hooks = {},
} = {}) {
  const expected = normalizeExpectedPointerIdentity(expectedCurrentPointerIdentity);
  const canonicalStateRoot = await ensureCanonicalStateRoot(stateRoot, appRoot);
  const beforePreparation = await readActivePointer(canonicalStateRoot, { optional: true });
  assertCompareAndSwap(expected, beforePreparation, "activation preparation");
  if (beforePreparation.pointer) {
    const verifiedBefore = await verifyActiveMcpGeneration({ appRoot, stateRoot: canonicalStateRoot });
    assertCompareAndSwap(expected, verifiedBefore, "active snapshot verification");
  }
  const candidate = await inspectMcpGenerationCandidate(candidateId, {
    appRoot,
    preflightTimeoutMs,
    preflightFault,
    supervisorHooks: preflightSupervisorHooks,
  });
  const installed = await installGeneration(candidate, canonicalStateRoot, {
    renamePath,
    renameRetries,
    retryDelayMs,
    hooks,
  });

  // Snapshot preparation is intentionally outside this lock. The lock protects
  // only the exact prior-pointer CAS and the small atomic pointer replacement.
  const lock = await acquireActivationLock(canonicalStateRoot);
  let pointerPath;
  let pointer;
  let pointerIdentity;
  let pointerReplacementCompleted = false;
  try {
    await hooks.afterLock?.({ stateRoot: canonicalStateRoot, lockPath: lock.lockPath });
    const precommit = await readActivePointer(canonicalStateRoot, { optional: true });
    assertCompareAndSwap(expected, precommit, "activation commit");
    pointer = {
      schemaVersion: EDITKIN_MCP_GENERATION_SCHEMA,
      kind: EDITKIN_MCP_POINTER_KIND,
      commitSha256: installed.commitSha256,
      generationDirectoryName: installed.generationDirectoryName,
      generationId: candidate.manifest.generationId,
      generationManifestSha256: installed.manifestSha256,
      selectionRevision: randomBytes(16).toString("hex"),
    };
    validatePointer(pointer);
    pointerIdentity = hashBytes(canonicalJson(pointer));
    pointerPath = await writeActivePointer(canonicalStateRoot, pointer, renamePath, renameRetries, retryDelayMs);
    pointerReplacementCompleted = true;
    try {
      await hooks.afterPointerWrite?.({ pointer, pointerPath, candidate });
      const selected = await readActivePointer(canonicalStateRoot);
      if (selected.pointerSha256 !== pointerIdentity) {
        throw new Error(`Read-back selected ${selected.pointerSha256} instead of ${pointerIdentity}`);
      }
    } catch (cause) {
      throw new McpGenerationConflictError(
        "MCP pointer replacement completed, but its linearization read-back failed",
        {
          pointerReplacementCompleted: true,
          requestedPointerIdentity: pointerIdentity,
          cause: String(cause?.message ?? cause),
        },
      );
    }
  } finally {
    try {
      await lock.release();
    } catch (cause) {
      if (!pointerReplacementCompleted) throw cause;
      throw new McpGenerationConflictError(
        "MCP pointer replacement completed, but activation-lock cleanup failed",
        {
          pointerReplacementCompleted: true,
          requestedPointerIdentity: pointerIdentity,
          cause: String(cause?.message ?? cause),
        },
      );
    }
  }

  // Re-verify the exact committed instance, never a mutable candidate. A later
  // activation may legitimately select another instance after our short CAS.
  try {
    await verifySnapshotGeneration(installed.generationRoot, {
      expectedCommitSha256: installed.commitSha256,
      expectedDirectoryName: installed.generationDirectoryName,
      expectedGenerationId: candidate.manifest.generationId,
      expectedManifestSha256: installed.manifestSha256,
    });
  } catch (cause) {
    throw new McpGenerationConflictError(
      "MCP pointer replacement completed, but the selected instance postcheck failed",
      {
        pointerReplacementCompleted: true,
        requestedPointerIdentity: pointerIdentity,
        cause: String(cause?.message ?? cause),
      },
    );
  }
  return {
    status: "GREEN_ACTIVE_GENERATION",
    generationCreated: installed.generationCreated,
    candidateId,
    generationId: candidate.manifest.generationId,
    generationDirectoryName: installed.generationDirectoryName,
    generationRoot: installed.generationRoot,
    commitSha256: installed.commitSha256,
    pointerIdentity,
    pointerPath,
    selectionRevision: pointer.selectionRevision,
    fileCount: candidate.manifest.files.length,
    vendorNode: candidate.vendorNode,
  };
}

function boundPath(contentRoot, relation) {
  return resolve(contentRoot, ...relation.split("/"));
}

export async function applySnapshotRuntimeBindings(snapshot, {
  appRoot = EDITKIN_APP_ROOT,
  externalPluginRoots = process.env.EDITKIN_PLUGIN_ROOTS ?? "",
} = {}) {
  const runtimePath = (name) => boundPath(snapshot.contentRoot, SNAPSHOT_RUNTIME_BINDINGS[name]);
  process.env.HAO_FFMPEG_PATH = runtimePath("ffmpeg");
  process.env.EDITKIN_FFMPEG_PATH = runtimePath("ffmpeg");
  process.env.HAO_FFPROBE_PATH = runtimePath("ffprobe");
  process.env.EDITKIN_FFPROBE_PATH = runtimePath("ffprobe");
  process.env.EDITKIN_WHISPER_CLI_PATH = runtimePath("whisper");
  process.env.HAO_NATIVE_CORE_PATH = runtimePath("nativeCore");
  process.env.EDITKIN_GPU_COMPOSITOR_PATH = runtimePath("gpuCompositor");
  process.env.EDITKIN_CREATIVE_PACK_ROOT = runtimePath("creativePack");
  process.env.EDITKIN_PERSONAL_MUSIC_ROOT = runtimePath("personalMusic");
  process.env.EDITKIN_FONT_ROOT = runtimePath("fonts");
  process.env.EDITKIN_COLOR_ROOT = runtimePath("color");
  const plugins = await resolveSnapshotPluginRoots({ appRoot, contentRoot: snapshot.contentRoot, externalRoots: externalPluginRoots });
  process.env.EDITKIN_PLUGIN_ROOTS = plugins.roots.join(delimiter);
  return plugins;
}

export async function launchActiveMcpGeneration({
  appRoot = EDITKIN_APP_ROOT,
  stateRoot = EDITKIN_MCP_STATE_ROOT,
  execPath = process.execPath,
  importModule = (url) => import(url),
  hooks = {},
} = {}) {
  const vendorNode = await verifyVendorNodeIdentity({ appRoot, execPath });
  const externalPluginRoots = process.env.EDITKIN_PLUGIN_ROOTS ?? "";
  const snapshot = await verifyActiveMcpGeneration({ appRoot, stateRoot });
  const plugins = await applySnapshotRuntimeBindings(snapshot, { appRoot, externalPluginRoots });
  const verifiedEntrypointBytes = Buffer.from(snapshot.entrypointBytes);
  await hooks.afterVerification?.({ snapshot, verifiedEntrypointBytes });
  await importVerifiedMaterialColorGeneration({ ...snapshot, entrypointBytes: verifiedEntrypointBytes }, importModule);
  return {
    status: "GREEN_MCP_GENERATION_STARTED",
    generationId: snapshot.manifest.generationId,
    candidateId: snapshot.manifest.sourceCandidateId,
    pluginRoots: plugins.roots,
    rejectedPluginRoots: plugins.rejected,
    vendorNode,
  };
}
