import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolveTauriCandidateArtifactRoot } from "./tauri-candidate-artifact-root.mjs";

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function resolveDesktopStageTarget(appRootInput, targetInput = ".desktop-resources/runtime") {
  const appRoot = resolve(appRootInput);
  const targetRoot = resolve(appRoot, targetInput);
  const targetRelation = relative(appRoot, targetRoot);
  const canonicalTargetRoot = resolve(appRoot, ".desktop-resources/runtime");
  const candidateParent = resolve(appRoot, ".desktop-product-release-candidates");
  const envelopeRoot = dirname(targetRoot);
  const candidateRelation = relative(candidateParent, envelopeRoot);
  const candidateTarget = Boolean(candidateRelation)
    && !candidateRelation.startsWith("..")
    && !isAbsolute(candidateRelation)
    && !candidateRelation.includes(sep)
    && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(basename(envelopeRoot))
    && targetRoot === resolve(envelopeRoot, "runtime");
  if (targetRelation.startsWith("..") || isAbsolute(targetRelation) || basename(targetRoot) !== "runtime"
    || (targetRoot !== canonicalTargetRoot && !candidateTarget)) {
    throw new Error(`Desktop product resource target escapes the approved release roots or is not a runtime directory: ${targetRoot}`);
  }
  return { appRoot, targetRoot, envelopeRoot, candidateTarget };
}

export function resolveDesktopCandidateForTauriArtifact(appRootInput, artifactRootInput, runtimeInput) {
  const tauri = resolveTauriCandidateArtifactRoot(appRootInput, artifactRootInput);
  const relativeRuntime = `.desktop-product-release-candidates/${tauri.candidateId}/runtime`;
  if (runtimeInput !== undefined && (typeof runtimeInput !== "string" || !runtimeInput.trim()
    || runtimeInput.includes("\0") || runtimeInput.split(/[\\/]+/u).some((part) => part === "." || part === ".."))) {
    throw new Error("Paired desktop candidate rejects invalid or traversing runtime paths");
  }
  const stage = resolveDesktopStageTarget(tauri.appRoot, runtimeInput ?? relativeRuntime);
  if (!stage.candidateTarget || stage.targetRoot !== resolve(tauri.appRoot, relativeRuntime)) {
    throw new Error("Desktop runtime must belong to the same isolated Tauri candidate generation");
  }
  return Object.freeze({ ...stage, candidateId: tauri.candidateId, relativeRuntime });
}

export function assertDesktopStageReplacementTarget(envelopeRootInput, targetInput) {
  const envelopeRoot = resolve(envelopeRootInput);
  const target = resolve(targetInput);
  const relation = relative(envelopeRoot, target);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`Desktop staged replacement escaped its release envelope: ${target}`);
  }
}

export async function assertIsolatedDesktopCandidateAvailable(stageTarget) {
  if (!stageTarget?.candidateTarget) throw new Error("Isolated desktop candidate creation requires an approved candidate target");
  const { appRoot, envelopeRoot } = stageTarget;
  const resolved = resolveDesktopStageTarget(appRoot, stageTarget.targetRoot);
  if (!resolved.candidateTarget || resolved.envelopeRoot !== envelopeRoot) {
    throw new Error("Desktop candidate selection does not match its approved envelope");
  }
  const candidateParent = resolve(appRoot, ".desktop-product-release-candidates");
  const appInfo = await lstat(appRoot);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) throw new Error("Desktop candidate app root must be a real directory");
  const canonicalApp = await realpath(appRoot);
  try {
    const parentInfo = await lstat(candidateParent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Desktop candidate parent must be a real directory");
    const canonicalParent = await realpath(candidateParent);
    if (!isInside(canonicalApp, canonicalParent)) throw new Error("Desktop candidate parent canonical path escaped the app root");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await lstat(envelopeRoot);
    throw new Error(`Isolated desktop release candidate envelope must not already exist: ${envelopeRoot}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function createIsolatedDesktopCandidateEnvelope(stageTarget) {
  await assertIsolatedDesktopCandidateAvailable(stageTarget);
  const { appRoot, envelopeRoot } = stageTarget;
  const candidateParent = resolve(appRoot, ".desktop-product-release-candidates");
  try { await mkdir(candidateParent); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  // Revalidate the shared parent after creation and before any candidate write.
  await assertIsolatedDesktopCandidateAvailable(stageTarget);
  const canonicalParent = await realpath(candidateParent);
  await mkdir(envelopeRoot);
  const [envelopeInfo, canonicalEnvelope] = await Promise.all([lstat(envelopeRoot), realpath(envelopeRoot)]);
  if (!envelopeInfo.isDirectory() || envelopeInfo.isSymbolicLink() || !isInside(canonicalParent, canonicalEnvelope)) {
    throw new Error("Desktop candidate envelope must be a real direct child of the approved parent");
  }
}
