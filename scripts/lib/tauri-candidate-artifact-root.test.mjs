import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  assertTauriArtifactTargetBinding,
  resolveTauriCandidateArtifactRoot,
  validateTauriCandidateArtifactSnapshot,
} from "./tauri-candidate-artifact-root.mjs";

const appRoot = resolve("fixture-editkin");
const input = "src-tauri/product-release-candidates/build-20260905/release";
const layout = resolveTauriCandidateArtifactRoot(appRoot, input);

function snapshotFor(mode = "inspect") {
  const snapshot = new Map();
  const parent = resolve(appRoot, "src-tauri/product-release-candidates");
  const paths = [appRoot, resolve(appRoot, "src-tauri"), parent];
  if (mode !== "build") paths.push(layout.cargoTargetDir);
  if (mode === "inspect") paths.push(layout.artifactRoot);
  for (const path of paths) snapshot.set(resolve(path), {
    exists: true,
    isDirectory: true,
    isSymbolicLink: false,
    isReparsePoint: false,
    realPath: resolve(path),
  });
  snapshot.set(resolve(layout.canonicalReleaseRoot), {
    exists: true,
    isDirectory: true,
    isSymbolicLink: false,
    isReparsePoint: false,
    realPath: resolve(layout.canonicalReleaseRoot),
  });
  if (mode === "build") snapshot.set(resolve(layout.cargoTargetDir), {
    exists: false, isDirectory: false, isSymbolicLink: false, isReparsePoint: false,
  });
  return snapshot;
}

test("resolves one explicit isolated Cargo release artifact root", () => {
  assert.equal(layout.artifactRoot, resolve(appRoot, input));
  assert.equal(layout.cargoTargetDir, resolve(appRoot, "src-tauri/product-release-candidates/build-20260905"));
  assert.equal(layout.relativeArtifactRoot, input);
  assert.doesNotThrow(() => validateTauriCandidateArtifactSnapshot(layout, snapshotFor("build"), "build"));
  assert.doesNotThrow(() => validateTauriCandidateArtifactSnapshot(layout, snapshotFor("prepared"), "prepared"));
  assert.doesNotThrow(() => validateTauriCandidateArtifactSnapshot(layout, snapshotFor(), "inspect"));
});

test("rejects missing, canonical, traversal, source and nested roots", () => {
  for (const invalid of [
    "",
    "src-tauri/target/release",
    "src-tauri/product-release-candidates/../target/release",
    "src-tauri/src/release",
    "src-tauri/product-release-candidates/build/nested/release",
    "src-tauri/product-release-candidates/build/debug",
  ]) assert.throws(() => resolveTauriCandidateArtifactRoot(appRoot, invalid), /artifact-root|artifact root|traversal|must be/u, invalid);
});

test("rejects pre-existing build targets and symlink, junction or reparse ancestry", () => {
  const occupied = snapshotFor();
  assert.throws(() => validateTauriCandidateArtifactSnapshot(layout, occupied, "build"), /must not already exist/u);
  for (const flag of ["isSymbolicLink", "isReparsePoint"]) {
    const aliased = snapshotFor();
    aliased.get(resolve(layout.cargoTargetDir))[flag] = true;
    assert.throws(() => validateTauriCandidateArtifactSnapshot(layout, aliased, "inspect"), /symlink\/junction\/reparse/u);
  }
  const canonicalAlias = snapshotFor();
  canonicalAlias.get(resolve(layout.artifactRoot)).realPath = resolve(layout.canonicalReleaseRoot);
  assert.throws(() => validateTauriCandidateArtifactSnapshot(layout, canonicalAlias, "inspect"), /escaped|aliases/u);
});

test("rejects artifact evidence from another candidate or changed bytes", () => {
  const observed = {
    schema: "editkin.tauri-candidate-artifact-target/v1",
    root: layout.relativeArtifactRoot,
    candidateId: layout.candidateId,
    executable: { path: "editkin.exe", bytes: 10, sha256: "a".repeat(64) },
    installer: { path: "bundle/nsis/Editkin_0.15.0_x64-setup.exe", bytes: 20, sha256: "b".repeat(64) },
  };
  assert.equal(assertTauriArtifactTargetBinding(layout, observed, observed), true);
  assert.throws(() => assertTauriArtifactTargetBinding(layout, { ...observed, candidateId: "other" }, observed), /different candidate/u);
  assert.throws(() => assertTauriArtifactTargetBinding(layout, { ...observed, executable: { ...observed.executable, sha256: "c".repeat(64) } }, observed), /identity/u);
});
