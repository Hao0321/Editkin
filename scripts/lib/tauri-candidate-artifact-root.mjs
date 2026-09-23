import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, realpath, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const CANDIDATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function inside(parent, child) {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function normalize(path) {
  return path.split(sep).join("/");
}

export function resolveTauriCandidateArtifactRoot(appRootInput, artifactRootInput) {
  if (typeof artifactRootInput !== "string" || !artifactRootInput.trim() || artifactRootInput.includes("\0")) {
    throw new Error("A formal Tauri build/gate requires one explicit --artifact-root");
  }
  if (artifactRootInput.split(/[\\/]+/u).some((part) => part === "." || part === "..")) {
    throw new Error("Tauri candidate artifact root rejects traversal segments");
  }
  const appRoot = resolve(appRootInput);
  const candidateParent = resolve(appRoot, "src-tauri/product-release-candidates");
  const canonicalReleaseRoot = resolve(appRoot, "src-tauri/target/release");
  const artifactRoot = resolve(appRoot, artifactRootInput);
  const relation = relative(candidateParent, artifactRoot);
  const parts = relation.split(sep);
  if (parts.length !== 2 || !CANDIDATE_ID.test(parts[0]) || parts[1] !== "release"
    || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("Tauri candidate artifact root must be src-tauri/product-release-candidates/<candidate-id>/release");
  }
  if (inside(canonicalReleaseRoot, artifactRoot) || inside(artifactRoot, canonicalReleaseRoot)) {
    throw new Error("Tauri candidate artifact root aliases the canonical release root");
  }
  return Object.freeze({
    appRoot,
    candidateParent,
    candidateId: parts[0],
    cargoTargetDir: dirname(artifactRoot),
    artifactRoot,
    canonicalReleaseRoot,
    relativeArtifactRoot: normalize(relative(appRoot, artifactRoot)),
  });
}

export function validateTauriCandidateArtifactSnapshot(layout, snapshot, mode) {
  if (mode !== "build" && mode !== "prepared" && mode !== "inspect") throw new Error("Unknown Tauri artifact-root validation mode");
  const requiredExisting = mode === "build"
    ? [layout.appRoot, resolve(layout.appRoot, "src-tauri"), layout.candidateParent]
    : mode === "prepared"
      ? [layout.appRoot, resolve(layout.appRoot, "src-tauri"), layout.candidateParent, layout.cargoTargetDir]
      : [layout.appRoot, resolve(layout.appRoot, "src-tauri"), layout.candidateParent, layout.cargoTargetDir, layout.artifactRoot];
  for (const path of requiredExisting) {
    const item = snapshot.get(resolve(path));
    if (!item?.exists || !item.isDirectory) throw new Error(`Tauri artifact-root ancestor is missing or not a directory: ${path}`);
    if (item.isSymbolicLink || item.isReparsePoint) throw new Error(`Tauri artifact-root ancestry contains a symlink/junction/reparse point: ${path}`);
  }
  const generation = snapshot.get(resolve(layout.cargoTargetDir));
  if (mode === "build" && generation?.exists) {
    throw new Error(`Tauri candidate Cargo target must not already exist: ${layout.cargoTargetDir}`);
  }
  const canonicalApp = snapshot.get(resolve(layout.appRoot))?.realPath;
  const canonicalParent = snapshot.get(resolve(layout.candidateParent))?.realPath;
  if (!canonicalApp || !canonicalParent || !inside(canonicalApp, canonicalParent)
    || !samePath(canonicalParent, resolve(canonicalApp, "src-tauri/product-release-candidates"))) {
    throw new Error("Tauri candidate parent canonical identity escaped the app root");
  }
  const canonicalRelease = snapshot.get(resolve(layout.canonicalReleaseRoot))?.realPath;
  const canonicalCargoTarget = snapshot.get(resolve(layout.cargoTargetDir))?.realPath;
  const canonicalArtifact = snapshot.get(resolve(layout.artifactRoot))?.realPath;
  if (mode !== "build" && (!canonicalCargoTarget
    || !samePath(canonicalCargoTarget, resolve(canonicalParent, layout.candidateId)))) {
    throw new Error("Tauri candidate Cargo target canonical identity does not match the requested candidate");
  }
  if (mode === "inspect") {
    if (!canonicalArtifact || !inside(canonicalParent, canonicalArtifact)
      || !samePath(canonicalArtifact, resolve(canonicalParent, layout.candidateId, "release"))) {
      throw new Error("Tauri candidate artifact canonical identity escaped its candidate parent");
    }
    const canonicalRelation = relative(canonicalParent, canonicalArtifact).split(sep);
    if (canonicalRelation.length !== 2 || canonicalRelation[0] !== layout.candidateId || canonicalRelation[1] !== "release") {
      throw new Error("Tauri candidate artifact canonical identity does not match the requested candidate");
    }
    if (canonicalRelease && (inside(canonicalRelease, canonicalArtifact) || inside(canonicalArtifact, canonicalRelease))) {
      throw new Error("Tauri candidate artifact canonical identity aliases the live canonical release");
    }
  }
  return layout;
}

async function snapshotPath(path) {
  try {
    const details = await lstat(path);
    return {
      exists: true,
      isDirectory: details.isDirectory(),
      isSymbolicLink: details.isSymbolicLink(),
      // On Windows, junctions are exposed as symbolic links. A canonical-path
      // mismatch below is the second fail-closed control for other reparse kinds.
      isReparsePoint: details.isSymbolicLink(),
      realPath: await realpath(path),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, isDirectory: false, isSymbolicLink: false, isReparsePoint: false };
    throw error;
  }
}

export async function assertTauriCandidateArtifactRoot(layout, mode) {
  const paths = new Set([
    layout.appRoot,
    resolve(layout.appRoot, "src-tauri"),
    layout.candidateParent,
    layout.cargoTargetDir,
    layout.artifactRoot,
    layout.canonicalReleaseRoot,
  ].map((path) => resolve(path)));
  const snapshot = new Map(await Promise.all([...paths].map(async (path) => [path, await snapshotPath(path)])));
  return validateTauriCandidateArtifactSnapshot(layout, snapshot, mode);
}

export async function prepareTauriCandidateCargoTarget(layout) {
  await assertTauriCandidateArtifactRoot(layout, "build");
  await mkdir(layout.cargoTargetDir);
  await assertTauriCandidateArtifactRoot(layout, "prepared");
  return layout;
}

async function regularFileIdentity(path, label) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0) throw new Error(`${label} is not a non-empty regular file`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return { bytes: details.size, sha256: hash.digest("hex") };
}

export async function inspectWindowsTauriCandidatePrimaryArtifacts(layout, version) {
  await assertTauriCandidateArtifactRoot(layout, "inspect");
  const executableName = "editkin.exe";
  const installerName = `Editkin_${version}_x64-setup.exe`;
  const executablePath = resolve(layout.artifactRoot, executableName);
  const nsisRoot = resolve(layout.artifactRoot, "bundle/nsis");
  const installerPath = resolve(nsisRoot, installerName);
  const [rootEntries, nsisEntries, executable, installer] = await Promise.all([
    readdir(layout.artifactRoot, { withFileTypes: true }),
    readdir(nsisRoot, { withFileTypes: true }),
    regularFileIdentity(executablePath, "Tauri candidate executable"),
    regularFileIdentity(installerPath, "Tauri candidate NSIS installer"),
  ]);
  const rootExecutables = rootEntries.filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase("en-US") === executableName);
  const installers = nsisEntries.filter((entry) => entry.isFile() && /_x64-setup\.exe$/iu.test(entry.name));
  if (rootExecutables.length !== 1 || installers.length !== 1 || installers[0].name !== installerName) {
    throw new Error("Tauri candidate root must contain exactly one primary executable and one version-bound NSIS installer");
  }
  return Object.freeze({
    schema: "editkin.tauri-candidate-artifact-target/v1",
    root: layout.relativeArtifactRoot,
    candidateId: layout.candidateId,
    executable: { path: executableName, ...executable },
    installer: { path: `bundle/nsis/${installerName}`, ...installer },
  });
}

export function assertTauriArtifactTargetBinding(layout, expected, observed) {
  const keys = Object.keys(expected ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["candidateId", "executable", "installer", "root", "schema"])) {
    throw new Error("Tauri artifact evidence has an unexpected target field set");
  }
  if (expected.schema !== "editkin.tauri-candidate-artifact-target/v1"
    || expected.root !== layout.relativeArtifactRoot || expected.candidateId !== layout.candidateId) {
    throw new Error("Tauri artifact evidence is bound to a different candidate root");
  }
  for (const name of ["executable", "installer"]) {
    if (expected[name]?.path !== observed[name]?.path || expected[name]?.bytes !== observed[name]?.bytes
      || expected[name]?.sha256 !== observed[name]?.sha256 || !SHA256.test(expected[name]?.sha256 ?? "")) {
      throw new Error(`Tauri artifact evidence ${name} identity does not match the selected candidate root`);
    }
  }
  return true;
}
