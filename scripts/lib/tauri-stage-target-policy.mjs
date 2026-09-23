import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function resolveTauriStageTarget(appRootInput, targetInput = "src-tauri/target/release/runtime") {
  const appRoot = resolve(appRootInput);
  const targetRoot = resolve(appRoot, targetInput);
  const targetRelation = relative(appRoot, targetRoot);
  const canonicalTargetRoot = resolve(appRoot, "src-tauri/target/release/runtime");
  const candidateParent = resolve(appRoot, "src-tauri/product-release-candidates");
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
    throw new Error(`Tauri product resource target escapes the approved release roots or is not a runtime directory: ${targetRoot}`);
  }
  return { appRoot, targetRoot, envelopeRoot, candidateTarget };
}

export function assertTauriStageReplacementTarget(envelopeRootInput, targetInput) {
  const envelopeRoot = resolve(envelopeRootInput);
  const target = resolve(targetInput);
  const relation = relative(envelopeRoot, target);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`Tauri staged replacement escaped its release envelope: ${target}`);
  }
}
