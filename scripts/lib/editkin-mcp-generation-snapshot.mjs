import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  assertExactKeys,
  assertSha256,
  assertStrictDescendant,
  canonicalJson,
  createSnapshotManifest,
  EDITKIN_APP_ROOT,
  EDITKIN_VENDOR_NODE,
  GENERATION_COMMIT_NAME,
  GENERATION_CONTENT_DIRECTORY,
  GENERATION_MANIFEST_NAME,
  hashBytes,
  isPathInside,
  MAX_COMMIT_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_MCP_BYTES,
  McpGenerationPreflightTimeoutError,
  NODE_MANIFEST_KEYS,
  normalizeManifestPath,
  resolveCandidateEnvelope,
  sameFilesystemPath,
  SNAPSHOT_RUNTIME_BINDINGS,
  SNAPSHOT_TOP_LEVEL_DIRECTORIES,
  sortManifestPaths,
  validateGenerationCommit,
  validateGenerationDirectoryName,
  validateSnapshotManifest,
} from "./editkin-mcp-generation-contract.mjs";

const MAX_NODE_MANIFEST_BYTES = 16 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
export const SNAPSHOT_HASH_CONCURRENCY = 8;
export const PRECHECK_MAX_DURATION_MS = 5 * 60 * 1000;
const PREFLIGHT_DEADLINES = new WeakMap();

function timeoutReason(signal, phase) {
  if (signal?.reason?.code === "EDITKIN_MCP_PREFLIGHT_TIMEOUT") return signal.reason;
  return new McpGenerationPreflightTimeoutError(`Editkin MCP candidate preflight timed out during ${phase}`);
}

function throwIfPreflightAborted(signal, phase) {
  const deadline = signal && PREFLIGHT_DEADLINES.get(signal);
  if (deadline && !signal.aborted && performance.now() >= deadline.expiresAt) {
    deadline.controller.abort(deadline.reason);
  }
  if (signal?.aborted) throw timeoutReason(signal, phase);
}

function raceWithAbort(operation, signal, phase, onLateValue) {
  if (!signal) return operation;
  throwIfPreflightAborted(signal, phase);
  return new Promise((resolveRace, rejectRace) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectRace(timeoutReason(signal, phase));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        if (settled) {
          Promise.resolve(onLateValue?.(value)).catch(() => {});
          return;
        }
        settled = true;
        cleanup();
        resolveRace(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectRace(error);
      },
    );
  });
}

async function abortableCall(action, signal, phase) {
  throwIfPreflightAborted(signal, phase);
  const value = await raceWithAbort(Promise.resolve().then(action), signal, phase);
  throwIfPreflightAborted(signal, phase);
  return value;
}

async function openPreflightHandle(path, signal, io, label) {
  const defaultOpen = () => open(path, "r");
  const operation = Promise.resolve().then(() => io?.open?.({ path, flags: "r", defaultOpen, label }) ?? defaultOpen());
  const handle = await raceWithAbort(operation, signal, `${label} open`, (lateHandle) => lateHandle.close());
  try {
    throwIfPreflightAborted(signal, `${label} open`);
    await io?.onHandleOpened?.({ handle, path, label });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function closePreflightHandle(handle, path, io, label) {
  try {
    const defaultClose = () => handle.close();
    await (io?.close?.({ handle, path, label, defaultClose }) ?? defaultClose());
  } finally {
    await io?.onHandleClosed?.({ handle, path, label });
  }
}

async function consumeOpenFile(path, expectedBytes, { signal, io, label, onChunk }) {
  const handle = await openPreflightHandle(path, signal, io, label);
  let position = 0;
  try {
    const before = await abortableCall(() => handle.stat(), signal, `${label} pre-read fstat`);
    if (!before.isFile() || before.size !== expectedBytes) throw new Error(`${label} changed before reading`);
    while (position < expectedBytes) {
      throwIfPreflightAborted(signal, `${label} read`);
      const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, expectedBytes - position));
      const defaultRead = () => handle.read(buffer, 0, buffer.length, position);
      const read = await raceWithAbort(
        Promise.resolve().then(() => io?.read?.({ handle, buffer, position, path, label, defaultRead }) ?? defaultRead()),
        signal,
        `${label} read`,
      );
      throwIfPreflightAborted(signal, `${label} read`);
      if (!Number.isSafeInteger(read?.bytesRead) || read.bytesRead <= 0 || read.bytesRead > buffer.length) {
        throw new Error(`${label} returned an invalid or premature read`);
      }
      onChunk(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await abortableCall(() => handle.stat(), signal, `${label} post-read fstat`);
    if (!after.isFile() || after.size !== expectedBytes) throw new Error(`${label} changed during reading`);
  } finally {
    await closePreflightHandle(handle, path, io, label);
  }
  throwIfPreflightAborted(signal, `${label} handle cleanup`);
}

export async function hashFile(path, { signal, io, owningRoot = dirname(path), label = "File" } = {}) {
  const details = await assertCanonicalRegularFile(path, owningRoot, label, { signal });
  const hash = createHash("sha256");
  await consumeOpenFile(path, details.size, { signal, io, label, onChunk: (chunk) => hash.update(chunk) });
  const after = await assertCanonicalRegularFile(path, owningRoot, label, { signal });
  if (after.size !== details.size) throw new Error(`${label} changed after hashing`);
  return hash.digest("hex");
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

export async function readBoundedRegularFile(
  path,
  maximumBytes,
  label,
  owningRoot,
  { signal, io, rejectHardlinks = false } = {},
) {
  const details = await assertCanonicalRegularFile(path, owningRoot, label, { signal, rejectHardlinks });
  if (details.size <= 0 || details.size > maximumBytes) {
    throw new Error(`${label} has an invalid byte size`);
  }
  const chunks = [];
  await consumeOpenFile(path, details.size, { signal, io, label, onChunk: (chunk) => chunks.push(Buffer.from(chunk)) });
  const bytes = Buffer.concat(chunks, details.size);
  const after = await assertCanonicalRegularFile(path, owningRoot, label, { signal, rejectHardlinks });
  if (bytes.length !== details.size || after.size !== details.size) throw new Error(`${label} changed while it was being read`);
  return bytes;
}

export async function readCanonicalJson(path, maximumBytes, label, owningRoot, options = {}) {
  const bytes = await readBoundedRegularFile(path, maximumBytes, label, owningRoot, options);
  const text = decodeUtf8(bytes, label);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (canonicalJson(parsed) !== text) throw new Error(`${label} is not canonical JSON`);
  return { bytes, parsed };
}

export async function assertCanonicalDirectory(path, owningRoot, label, { signal } = {}) {
  const absolute = resolve(path);
  const owner = resolve(owningRoot);
  const details = await abortableCall(() => lstat(absolute), signal, `${label} lstat`);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory, not a link or reparse entry`);
  }
  const [canonical, canonicalOwner] = await Promise.all([
    abortableCall(() => realpath(absolute), signal, `${label} realpath`),
    abortableCall(() => realpath(owner), signal, `${label} owner realpath`),
  ]);
  if (!sameFilesystemPath(canonical, absolute)) {
    throw new Error(`${label} cannot traverse a symlink, junction, or reparse point`);
  }
  if (!sameFilesystemPath(absolute, owner)) assertStrictDescendant(canonicalOwner, canonical, label);
  return canonical;
}

export async function assertCanonicalRegularFile(path, owningRoot, label, { signal, rejectHardlinks = false } = {}) {
  const absolute = resolve(path);
  const owner = resolve(owningRoot);
  const details = await abortableCall(() => lstat(absolute), signal, `${label} lstat`);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a link or reparse entry`);
  }
  if (rejectHardlinks && details.nlink !== 1) {
    throw new Error(`${label} must not be a multiply-linked file`);
  }
  const [canonical, canonicalOwner] = await Promise.all([
    abortableCall(() => realpath(absolute), signal, `${label} realpath`),
    abortableCall(() => realpath(owner), signal, `${label} owner realpath`),
  ]);
  if (!sameFilesystemPath(canonical, absolute)) {
    throw new Error(`${label} cannot traverse a symlink, junction, or reparse point`);
  }
  assertStrictDescendant(canonicalOwner, canonical, label);
  return details;
}

function relativeManifestPath(root, absolute) {
  const relationOnDisk = relative(resolve(root), resolve(absolute));
  if (!relationOnDisk || relationOnDisk.startsWith("..") || isAbsolute(relationOnDisk)) {
    throw new Error("Snapshot inventory path escaped its closed-world root");
  }
  const relation = relationOnDisk.split(sep).join("/");
  return normalizeManifestPath(relation);
}

async function assertInventoryDirectory(path, root, canonicalRoot, label, signal) {
  const details = await abortableCall(() => lstat(path), signal, `${label} lstat`);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory, not a link or reparse entry`);
  }
  const canonical = await abortableCall(() => realpath(path), signal, `${label} realpath`);
  if (!sameFilesystemPath(canonical, path)) throw new Error(`${label} cannot traverse a symlink, junction, or reparse point`);
  if (!sameFilesystemPath(path, root)) assertStrictDescendant(canonicalRoot, canonical, label);
}

async function assertInventoryFile(path, canonicalRoot, label, signal, rejectHardlinks) {
  const details = await abortableCall(() => lstat(path), signal, `${label} lstat`);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a link or reparse entry`);
  }
  if (rejectHardlinks && details.nlink !== 1) {
    throw new Error(`${label} must not be a multiply-linked file`);
  }
  const canonical = await abortableCall(() => realpath(path), signal, `${label} realpath`);
  if (!sameFilesystemPath(canonical, path)) throw new Error(`${label} cannot traverse a symlink, junction, or reparse point`);
  assertStrictDescendant(canonicalRoot, canonical, label);
  return details;
}

async function inventoryDirectory(root, canonicalRoot, directory, directories, pendingFiles, signal, rejectHardlinks) {
  await assertInventoryDirectory(
    directory,
    root,
    canonicalRoot,
    `Snapshot directory ${relativeManifestPath(root, directory)}`,
    signal,
  );
  const entries = await abortableCall(
    () => readdir(directory, { withFileTypes: true }),
    signal,
    `Snapshot directory ${relativeManifestPath(root, directory)} read`,
  );
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const relation = relativeManifestPath(root, absolute);
    throwIfPreflightAborted(signal, `Snapshot entry ${relation} walk`);
    const details = await abortableCall(() => lstat(absolute), signal, `Snapshot entry ${relation} lstat`);
    if (details.isSymbolicLink()) throw new Error(`Snapshot entry is a symlink, junction, or reparse point: ${relation}`);
    if (details.isDirectory()) {
      directories.push(relation);
      await inventoryDirectory(root, canonicalRoot, absolute, directories, pendingFiles, signal, rejectHardlinks);
      continue;
    }
    if (!details.isFile()) throw new Error(`Snapshot entry is not a regular file or directory: ${relation}`);
    const validated = await assertInventoryFile(
      absolute,
      canonicalRoot,
      `Snapshot file ${relation}`,
      signal,
      rejectHardlinks,
    );
    if (validated.size !== details.size) throw new Error(`Snapshot file changed during validation: ${relation}`);
    pendingFiles.push({ absolute, path: relation, bytes: details.size });
  }
}

async function hashInventoryFile(file, canonicalRoot, signal, io, rejectHardlinks) {
  const label = `Snapshot file ${file.path}`;
  const hash = createHash("sha256");
  await consumeOpenFile(file.absolute, file.bytes, {
    signal,
    io,
    label,
    onChunk: (chunk) => hash.update(chunk),
  });
  const pathAfter = await assertInventoryFile(file.absolute, canonicalRoot, label, signal, rejectHardlinks);
  if (pathAfter.size !== file.bytes) throw new Error(`${label} changed after hashing`);
  return { path: file.path, bytes: file.bytes, sha256: hash.digest("hex") };
}

async function mapWithBoundedConcurrency(items, maximum, mapper, signal) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let failure;
  async function worker() {
    while (!failure) {
      try {
        throwIfPreflightAborted(signal, "snapshot hash worker dispatch");
      } catch (error) {
        failure ??= error;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  const workerCount = Math.min(maximum, Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failure) throw failure;
  return results;
}

export async function inventorySnapshotTree(rootInput, { signal, io, rejectHardlinks = false } = {}) {
  const root = resolve(rootInput);
  const canonicalRoot = await assertCanonicalDirectory(root, root, "Snapshot content root", { signal });
  const entries = await abortableCall(
    () => readdir(root, { withFileTypes: true }),
    signal,
    "Snapshot content root read",
  );
  const names = entries.map(({ name }) => name).sort();
  if (names.length !== SNAPSHOT_TOP_LEVEL_DIRECTORIES.length
    || names.some((name, index) => name !== SNAPSHOT_TOP_LEVEL_DIRECTORIES[index])) {
    throw new Error("Snapshot top-level entry set drifted from the closed-world contract");
  }
  if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error("Every snapshot top-level entry must be a regular directory");
  }
  const directories = [];
  const pendingFiles = [];
  for (const relation of SNAPSHOT_TOP_LEVEL_DIRECTORIES) {
    const directory = resolve(root, relation);
    directories.push(relation);
    await inventoryDirectory(root, canonicalRoot, directory, directories, pendingFiles, signal, rejectHardlinks);
  }
  const files = await mapWithBoundedConcurrency(
    pendingFiles,
    SNAPSHOT_HASH_CONCURRENCY,
    (file) => hashInventoryFile(file, canonicalRoot, signal, io, rejectHardlinks),
    signal,
  );
  return {
    directories: sortManifestPaths(directories),
    files: [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
}

function validateNodeManifest(manifest, label) {
  assertExactKeys(manifest, NODE_MANIFEST_KEYS, label);
  if (typeof manifest.version !== "string" || !/^22\.[0-9]+\.[0-9]+$/u.test(manifest.version)) {
    throw new Error(`${label} version is outside the supported Node 22 line`);
  }
  if (typeof manifest.source !== "string" || !manifest.source.startsWith("https://nodejs.org/dist/")) {
    throw new Error(`${label} source is not the official Node distribution`);
  }
  for (const key of ["archiveSha256", "nodeExeSha256", "licenseSha256"]) {
    assertSha256(manifest[key], `${label} ${key}`);
  }
  return manifest;
}

function createPreflightDeadline(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PRECHECK_MAX_DURATION_MS) {
    throw new Error(`Candidate preflight timeout must be between 1 and ${PRECHECK_MAX_DURATION_MS}ms`);
  }
  const controller = new AbortController();
  const reason = new McpGenerationPreflightTimeoutError(
    `Editkin MCP candidate preflight exceeded its ${timeoutMs}ms deadline`,
    { timeoutMs },
  );
  const timer = setTimeout(() => controller.abort(reason), timeoutMs);
  PREFLIGHT_DEADLINES.set(controller.signal, {
    controller,
    expiresAt: performance.now() + timeoutMs,
    reason,
  });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      PREFLIGHT_DEADLINES.delete(controller.signal);
    },
  };
}

export async function verifyVendorNodeIdentity({
  appRoot = EDITKIN_APP_ROOT,
  execPath = process.execPath,
  signal,
  io,
} = {}) {
  const vendorRoot = resolve(appRoot, "vendor/node/win32-x64");
  const expectedNode = resolve(vendorRoot, "node.exe");
  const manifestPath = resolve(vendorRoot, "manifest.json");
  await assertCanonicalDirectory(vendorRoot, appRoot, "Pinned Editkin Node directory", { signal });
  const actualNode = await abortableCall(() => realpath(execPath), signal, "Pinned launcher executable realpath");
  const canonicalExpectedNode = await abortableCall(() => realpath(expectedNode), signal, "Pinned Node executable realpath");
  if (!sameFilesystemPath(actualNode, canonicalExpectedNode)) {
    throw new Error("Editkin MCP launcher must run through the pinned vendor Node executable");
  }
  const { parsed } = await readCanonicalJson(
    manifestPath,
    MAX_NODE_MANIFEST_BYTES,
    "Pinned Node manifest",
    vendorRoot,
    { signal, io },
  );
  const manifest = validateNodeManifest(parsed, "Pinned Node manifest");
  const details = await assertCanonicalRegularFile(expectedNode, vendorRoot, "Pinned Editkin Node runtime", { signal });
  const sha256 = await hashFile(expectedNode, {
    signal,
    io,
    owningRoot: vendorRoot,
    label: "Pinned Editkin Node runtime",
  });
  if (sha256 !== manifest.nodeExeSha256) throw new Error("Pinned vendor Node hash does not match its manifest");
  return { path: expectedNode, version: manifest.version, bytes: details.size, sha256, manifest };
}

function findFile(files, path) {
  const record = files.find((file) => file.path === path);
  if (!record) throw new Error(`Snapshot inventory is missing ${path}`);
  return record;
}

async function verifyCandidateNode(candidateRoot, inventory, vendorNode, { signal, io } = {}) {
  const manifestPath = resolve(candidateRoot, "runtime/NODE-MANIFEST.json");
  const { parsed } = await readCanonicalJson(
    manifestPath,
    MAX_NODE_MANIFEST_BYTES,
    "Candidate Node manifest",
    candidateRoot,
    { signal, io },
  );
  const candidateManifest = validateNodeManifest(parsed, "Candidate Node manifest");
  if (canonicalJson(candidateManifest) !== canonicalJson(vendorNode.manifest)) {
    throw new Error("Release candidate Node manifest drifted from the stable vendor Node manifest");
  }
  const nodeRecord = findFile(inventory.files, "runtime/node.exe");
  if (nodeRecord.sha256 !== vendorNode.sha256 || nodeRecord.bytes !== vendorNode.bytes) {
    throw new Error("Release candidate Node identity drifted from the stable vendor Node runtime");
  }
}

export async function inspectMcpGenerationCandidateInProcess(candidateId, {
  appRoot = EDITKIN_APP_ROOT,
  execPath = process.execPath,
  preflightTimeoutMs = PRECHECK_MAX_DURATION_MS,
  preflightIo,
} = {}) {
  const startedAt = performance.now();
  const deadline = createPreflightDeadline(preflightTimeoutMs);
  try {
    const { signal } = deadline;
    const vendorNode = await verifyVendorNodeIdentity({ appRoot, execPath, signal, io: preflightIo });
    if (sameFilesystemPath(await realpath(process.execPath), vendorNode.path)
      && process.versions.node !== vendorNode.version) {
      throw new Error("Editkin MCP worker Node version differs from the pinned vendor manifest");
    }
    const candidate = resolveCandidateEnvelope(appRoot, candidateId);
    await assertCanonicalDirectory(
      candidate.candidatesRoot,
      candidate.candidatesRoot,
      "Product release candidates root",
      { signal },
    );
    await assertCanonicalDirectory(candidate.envelopeRoot, candidate.candidatesRoot, "MCP candidate envelope", { signal });
    const inventory = await inventorySnapshotTree(candidate.envelopeRoot, { signal, io: preflightIo });
    throwIfPreflightAborted(signal, "candidate manifest construction");
    const manifest = validateSnapshotManifest(createSnapshotManifest(candidateId, inventory.directories, inventory.files));
    await verifyCandidateNode(candidate.envelopeRoot, inventory, vendorNode, { signal, io: preflightIo });
    const entrypoint = findFile(manifest.files, SNAPSHOT_RUNTIME_BINDINGS.entrypoint);
    if (entrypoint.bytes <= 0 || entrypoint.bytes > MAX_MCP_BYTES) {
      throw new Error("Candidate MCP entrypoint has an invalid byte size");
    }
    throwIfPreflightAborted(signal, "candidate preflight completion");
    return {
      status: "GREEN_MCP_GENERATION_CANDIDATE",
      candidateId,
      envelopeRoot: candidate.envelopeRoot,
      manifest,
      manifestSha256: hashBytes(canonicalJson(manifest)),
      entrypoint,
      preflightMs: Math.round(performance.now() - startedAt),
      vendorNode,
    };
  } finally {
    deadline.dispose();
  }
}

export async function writeDurableExclusive(path, bytes) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function inventoriesEqual(left, right) {
  return canonicalJson({ directories: left.directories, files: left.files })
    === canonicalJson({ directories: right.directories, files: right.files });
}

export async function materializeCandidateSnapshot(candidate, generationRootInput, { hooks = {} } = {}) {
  const generationRoot = resolve(generationRootInput);
  const contentRoot = resolve(generationRoot, GENERATION_CONTENT_DIRECTORY);
  await mkdir(generationRoot, { recursive: false });
  await mkdir(contentRoot, { recursive: false });
  for (const relation of candidate.manifest.directories) {
    await mkdir(resolve(contentRoot, ...relation.split("/")), { recursive: false });
  }
  for (let index = 0; index < candidate.manifest.files.length; index += 1) {
    const record = candidate.manifest.files[index];
    const source = resolve(candidate.envelopeRoot, ...record.path.split("/"));
    const target = resolve(contentRoot, ...record.path.split("/"));
    const details = await assertCanonicalRegularFile(source, candidate.envelopeRoot, `Candidate file ${record.path}`);
    if (details.size !== record.bytes) throw new Error(`Candidate file changed before copy: ${record.path}`);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await hooks.afterSnapshotFileCopied?.({ candidate, contentRoot, generationRoot, index, record, target });
  }
  const manifestBytes = canonicalJson(candidate.manifest);
  await writeDurableExclusive(resolve(generationRoot, GENERATION_MANIFEST_NAME), manifestBytes);
  await hooks.afterCandidateCopied?.({ generationRoot, contentRoot, candidate });
  await verifyUncommittedSnapshotPayload(generationRoot, {
    expectedGenerationId: candidate.manifest.generationId,
    expectedManifestSha256: hashBytes(manifestBytes),
  });
  const sourceAfter = await inventorySnapshotTree(candidate.envelopeRoot);
  if (!inventoriesEqual(sourceAfter, candidate.manifest)) {
    throw new Error("Candidate changed while its generation snapshot was being materialized");
  }
  return { generationRoot, contentRoot };
}

function assertInventoryMatchesManifest(inventory, manifest) {
  if (!inventoriesEqual(inventory, manifest)) {
    throw new Error("Generation snapshot content does not match its complete manifest inventory");
  }
}

async function assertExactSnapshotRootEntries(generationRoot, expectedEntries) {
  await assertCanonicalDirectory(generationRoot, dirname(generationRoot), "MCP generation snapshot");
  const entries = await readdir(generationRoot, { withFileTypes: true });
  const names = entries.map(({ name }) => name).sort();
  if (names.length !== expectedEntries.length || names.some((name, index) => name !== expectedEntries[index])) {
    throw new Error("MCP generation snapshot contains an unexpected entry");
  }
}

async function verifySnapshotPayload(generationRootInput, {
  expectedGenerationId,
  expectedManifestSha256,
  expectedEntries,
  expectedContentBytes,
  expectedContentFileCount,
} = {}) {
  const generationRoot = resolve(generationRootInput);
  if (expectedEntries) await assertExactSnapshotRootEntries(generationRoot, expectedEntries);
  const manifestPath = resolve(generationRoot, GENERATION_MANIFEST_NAME);
  const { bytes: manifestBytes, parsed } = await readCanonicalJson(
    manifestPath,
    MAX_MANIFEST_BYTES,
    "MCP generation manifest",
    generationRoot,
    { rejectHardlinks: true },
  );
  const manifestSha256 = hashBytes(manifestBytes);
  if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256) {
    throw new Error("MCP generation manifest hash does not match the active pointer");
  }
  const manifest = validateSnapshotManifest(parsed);
  if (expectedGenerationId && manifest.generationId !== expectedGenerationId) {
    throw new Error("MCP generation descriptor path and manifest disagree");
  }
  const contentBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  if ((expectedContentFileCount !== undefined && manifest.files.length !== expectedContentFileCount)
    || (expectedContentBytes !== undefined && contentBytes !== expectedContentBytes)) {
    throw new Error("MCP generation commit marker content totals disagree with the manifest");
  }
  const contentRoot = resolve(generationRoot, GENERATION_CONTENT_DIRECTORY);
  const inventory = await inventorySnapshotTree(contentRoot, { rejectHardlinks: true });
  assertInventoryMatchesManifest(inventory, manifest);
  const entrypointRecord = findFile(manifest.files, manifest.entrypoint);
  const entrypoint = resolve(contentRoot, ...manifest.entrypoint.split("/"));
  const entrypointBytes = await readBoundedRegularFile(
    entrypoint,
    MAX_MCP_BYTES,
    "MCP snapshot entrypoint",
    contentRoot,
    { rejectHardlinks: true },
  );
  if (entrypointBytes.length !== entrypointRecord.bytes || hashBytes(entrypointBytes) !== entrypointRecord.sha256) {
    throw new Error("MCP snapshot entrypoint changed after complete snapshot verification");
  }
  return {
    generationRoot,
    contentRoot,
    manifestPath,
    manifestBytes,
    manifestSha256,
    manifest,
    entrypoint,
    entrypointBytes,
  };
}

export async function verifyUncommittedSnapshotPayload(generationRootInput, {
  expectedGenerationId,
  expectedManifestSha256,
} = {}) {
  return verifySnapshotPayload(generationRootInput, {
    expectedGenerationId,
    expectedManifestSha256,
    expectedEntries: [GENERATION_CONTENT_DIRECTORY, GENERATION_MANIFEST_NAME].sort(),
  });
}

export async function verifySnapshotGeneration(generationRootInput, {
  expectedCommitSha256,
  expectedDirectoryName,
  expectedGenerationId,
  expectedManifestSha256,
} = {}) {
  const generationRoot = resolve(generationRootInput);
  const directoryName = basename(generationRoot);
  validateGenerationDirectoryName(directoryName, expectedGenerationId);
  if (expectedDirectoryName && directoryName !== expectedDirectoryName) {
    throw new Error("MCP generation pointer selected the wrong instance directory");
  }
  await assertExactSnapshotRootEntries(
    generationRoot,
    [GENERATION_COMMIT_NAME, GENERATION_CONTENT_DIRECTORY, GENERATION_MANIFEST_NAME].sort(),
  );
  const commitPath = resolve(generationRoot, GENERATION_COMMIT_NAME);
  const { bytes: commitBytes, parsed } = await readCanonicalJson(
    commitPath,
    MAX_COMMIT_BYTES,
    "MCP generation commit marker",
    generationRoot,
    { rejectHardlinks: true },
  );
  const commit = validateGenerationCommit(parsed);
  const commitSha256 = hashBytes(commitBytes);
  if (expectedCommitSha256 && commitSha256 !== expectedCommitSha256) {
    throw new Error("MCP generation commit marker hash does not match the active pointer");
  }
  if (commit.generationDirectoryName !== directoryName
    || (expectedGenerationId && commit.generationId !== expectedGenerationId)) {
    throw new Error("MCP generation commit marker does not bind the selected snapshot instance");
  }
  if (expectedManifestSha256 && commit.generationManifestSha256 !== expectedManifestSha256) {
    throw new Error("MCP generation commit marker disagrees with the active pointer");
  }
  const payload = await verifySnapshotPayload(generationRoot, {
    expectedGenerationId: commit.generationId,
    expectedManifestSha256: commit.generationManifestSha256,
    expectedContentBytes: commit.contentBytes,
    expectedContentFileCount: commit.contentFileCount,
  });
  if (commit.generationId !== payload.manifest.generationId
    || commit.generationManifestSha256 !== payload.manifestSha256) {
    throw new Error("MCP generation commit marker does not bind the verified snapshot instance");
  }
  return { ...payload, commit, commitBytes, commitPath, commitSha256, generationDirectoryName: directoryName };
}

async function canonicalExternalPluginRoot(path) {
  if (!isAbsolute(path)) throw new Error("External plugin root is not absolute");
  const absolute = resolve(path);
  const details = await lstat(absolute);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("External plugin root is not a regular directory");
  const canonical = await realpath(absolute);
  if (!sameFilesystemPath(canonical, absolute)) throw new Error("External plugin root traverses a link or junction");
  return canonical;
}

export async function resolveSnapshotPluginRoots({
  appRoot = EDITKIN_APP_ROOT,
  contentRoot,
  externalRoots = process.env.EDITKIN_PLUGIN_ROOTS ?? "",
} = {}) {
  const builtin = resolve(contentRoot, SNAPSHOT_RUNTIME_BINDINGS.plugins);
  await assertCanonicalDirectory(builtin, contentRoot, "Snapshot built-in plugin root");
  const canonicalAppRoot = await realpath(appRoot);
  const roots = [builtin];
  const rejected = [];
  const seen = new Set([builtin.toLowerCase()]);
  for (const raw of externalRoots.split(delimiter).map((value) => value.trim()).filter(Boolean)) {
    try {
      const canonical = await canonicalExternalPluginRoot(raw);
      if (isPathInside(canonicalAppRoot, canonical)) {
        rejected.push({ path: raw, reason: "app-owned" });
        continue;
      }
      const key = canonical.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(canonical);
    } catch {
      rejected.push({ path: raw, reason: "invalid" });
    }
  }
  return { roots, rejected };
}
