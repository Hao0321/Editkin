import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertIsolatedDesktopCandidateAvailable,
  createIsolatedDesktopCandidateEnvelope,
  resolveDesktopCandidateForTauriArtifact,
  resolveDesktopStageTarget,
} from "./desktop-stage-target-policy.mjs";

const artifact = "src-tauri/product-release-candidates/paired-test/release";
const runtime = ".desktop-product-release-candidates/paired-test/runtime";

test("paired desktop staging derives the exact same Tauri generation", () => {
  const app = resolve("fixture-app");
  const derived = resolveDesktopCandidateForTauriArtifact(app, artifact);
  assert.equal(derived.candidateId, "paired-test");
  assert.equal(derived.relativeRuntime, runtime);
  assert.equal(derived.targetRoot, resolve(app, runtime));
  assert.deepEqual(resolveDesktopCandidateForTauriArtifact(app, artifact, runtime), derived);
  assert.deepEqual(resolveDesktopCandidateForTauriArtifact(app, artifact, resolve(app, runtime)), derived);
});

test("paired staging rejects canonical, sibling, nested, traversal and malformed targets", () => {
  const app = resolve("fixture-app");
  for (const invalid of [
    ".desktop-resources/runtime",
    ".desktop-product-release-candidates/sibling/runtime",
    ".desktop-product-release-candidates/paired-test/nested/runtime",
    ".desktop-product-release-candidates/sibling/../paired-test/runtime",
    "../outside/runtime", "", null, "\0",
  ]) {
    assert.throws(() => resolveDesktopCandidateForTauriArtifact(app, artifact, invalid), undefined, String(invalid));
  }
  assert.throws(() => resolveDesktopCandidateForTauriArtifact(app, "src-tauri/target/release", runtime));
});

test("availability preflight is read-only; isolated creation never alters canonical bytes", async () => {
  const app = await mkdtemp(join(tmpdir(), "editkin-paired-stage-policy-"));
  try {
    const canonical = resolve(app, ".desktop-resources/runtime");
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, "sentinel.txt"), "protected canonical bytes");
    const stage = resolveDesktopCandidateForTauriArtifact(app, artifact);
    const before = await readdir(app);
    await assertIsolatedDesktopCandidateAvailable(stage);
    assert.deepEqual(await readdir(app), before, "preflight created a staging directory");
    await createIsolatedDesktopCandidateEnvelope(stage);
    assert.deepEqual(await readdir(stage.envelopeRoot), []);
    await assert.rejects(assertIsolatedDesktopCandidateAvailable(stage), /must not already exist/u);
    await assert.rejects(createIsolatedDesktopCandidateEnvelope(stage), /must not already exist/u);
    assert.equal(await readFile(join(canonical, "sentinel.txt"), "utf8"), "protected canonical bytes");
    await assert.rejects(assertIsolatedDesktopCandidateAvailable(resolveDesktopStageTarget(app)), /approved candidate/u);
    await assert.rejects(assertIsolatedDesktopCandidateAvailable({ ...stage, envelopeRoot: resolve(app, "outside") }), /does not match/u);
  } finally {
    // Only this test's freshly allocated fixture root, never a release/canonical root.
    await rm(app, { recursive: true, force: true });
  }
});

test("availability rejects linked candidate parents before writing an envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "editkin-paired-stage-link-"));
  try {
    const app = join(root, "app");
    const outside = join(root, "outside");
    await mkdir(app);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "outside stays untouched");
    await symlink(outside, join(app, ".desktop-product-release-candidates"), process.platform === "win32" ? "junction" : "dir");
    const stage = resolveDesktopCandidateForTauriArtifact(app, artifact);
    await assert.rejects(assertIsolatedDesktopCandidateAvailable(stage), /real directory/u);
    await assert.rejects(createIsolatedDesktopCandidateEnvelope(stage), /real directory/u);
    assert.deepEqual(await readdir(outside), ["sentinel.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
