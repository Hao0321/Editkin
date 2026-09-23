import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compareFileMaps, compareNsisExecutableBytes, embeddedBuildIdentity, evaluateBuildManifest, productVersionMatches, validateArchiveEntries, verifyToolIdentity } from "./lib/artifact-lifecycle.mjs";
import { createDeterministicZip } from "./lib/deterministic-zip.mjs";
import { PRODUCT_RELEASE_SCOPE, buildManifestIdentityMatches } from "./lib/build-input-identity.mjs";

const root = await mkdtemp(join(tmpdir(), "editkin-artifact-self-test-"));
try {
  const source = join(root, "pack");
  await mkdir(join(source, "nested"), { recursive: true });
  await writeFile(join(source, "manifest.json"), "stable\n");
  await writeFile(join(source, "nested/asset.bin"), Buffer.from([0, 1, 2, 3]));
  const first = await createDeterministicZip({ sourceRoot: source, archiveRootName: "pack", outputPath: join(root, "a.zip") });
  const second = await createDeterministicZip({ sourceRoot: source, archiveRootName: "pack", outputPath: join(root, "b.zip") });
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.bytes, second.bytes);
  const listing = spawnSync("tar", ["-tf", first.output], { encoding: "utf8", windowsHide: true });
  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /pack\/manifest\.json/);
  await writeFile(join(source, "manifest.json"), "changed\n");
  const changed = await createDeterministicZip({ sourceRoot: source, archiveRootName: "pack", outputPath: join(root, "changed.zip") });
  assert.notEqual(changed.sha256, first.sha256);

  const id = (value) => ({ bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") });
  const expected = { "a.txt": id("a"), "b.txt": id("b") };
  assert.deepEqual(compareFileMaps(expected, { ...expected }), []);
  const missing = compareFileMaps(expected, { "a.txt": expected["a.txt"] });
  const tampered = compareFileMaps(expected, { ...expected, "b.txt": id("x") });
  const orphan = compareFileMaps(expected, { ...expected, "extra.txt": id("x") });
  assert(missing.some((item) => item.code === "missing-file"));
  assert(tampered.some((item) => item.code === "identity-mismatch"));
  assert(orphan.some((item) => item.code === "unexpected-file"));
  assert(validateArchiveEntries(["pack/manifest.json", "../escape"], "pack").some((item) => item.code === "unsafe-entry"));
  assert(validateArchiveEntries(["pack/A.txt", "pack/a.txt"], "pack").some((item) => item.code === "duplicate-entry"));
  const receipt = { schemaVersion: 1, sevenZip: { packageVersion: "1", bytes: 2, sha256: "a" } };
  assert.equal(verifyToolIdentity(receipt, { packageVersion: "1", bytes: 2, sha256: "a" }).length, 0);
  assert(verifyToolIdentity(receipt, { packageVersion: "1", bytes: 2, sha256: "b" }).some((item) => item.code === "tool-sha256"));
  assert.equal(productVersionMatches("0.6.0", "0.6.0"), true);
  assert.equal(productVersionMatches("0.6.0.0", "0.6.0"), true);
  assert.equal(productVersionMatches("0.6", "0.6.0"), false);
  assert.equal(productVersionMatches("0.6.1", "0.6.0"), false);
  const inputIdentity = { files: 2, bytes: 3, sha256: "input" };
  const outputIdentity = { files: 4, bytes: 5, sha256: "output" };
  const manifest = { schemaVersion: 2, product: "Editkin", productVersion: "1.2.3", scope: PRODUCT_RELEASE_SCOPE, inputIdentity, outputIdentity };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const embeddedExecutable = Buffer.concat([Buffer.from("binary-prefix"), embeddedBuildIdentity(manifest, manifestBytes), Buffer.from("binary-suffix")]);
  const evaluate = (changes = {}) => evaluateBuildManifest({
    manifest,
    manifestBytes,
    deliveredExecutableBytes: embeddedExecutable,
    currentInputIdentity: inputIdentity,
    currentOutputIdentity: outputIdentity,
    expectedVersion: "1.2.3",
    expectedProductName: "Editkin",
    ...changes,
  });
  assert.deepEqual(evaluate(), []);
  assert(evaluate({ currentInputIdentity: { ...inputIdentity, sha256: "new-input" } }).some((item) => item.code === "stale-build-inputs"));
  assert(evaluate({ currentOutputIdentity: { ...outputIdentity, sha256: "new-output" } }).some((item) => item.code === "stale-build-outputs"));
  assert(evaluate({ deliveredExecutableBytes: Buffer.from("no manifest here") }).some((item) => item.code === "executable-missing-build-manifest"));
  assert(evaluate({ manifestBytes: Buffer.concat([manifestBytes, Buffer.from("\n")]) }).some((item) => item.code === "executable-missing-build-manifest"));
  assert(evaluate({ deliveredExecutableBytes: Buffer.concat([Buffer.from("binary-prefix"), manifestBytes]) }).some((item) => item.code === "executable-missing-build-manifest"));
  const standalone = Buffer.from("prefix__TAURI_BUNDLE_TYPE_VAR_UNKsuffix");
  const installed = Buffer.from("prefix__TAURI_BUNDLE_TYPE_VAR_NSSsuffix");
  assert.equal(compareNsisExecutableBytes(standalone, installed), true);
  assert.equal(compareNsisExecutableBytes(installed, installed), true);
  assert.equal(compareNsisExecutableBytes(standalone, standalone), false);
  assert.equal(compareNsisExecutableBytes(standalone, Buffer.from("Prefix__TAURI_BUNDLE_TYPE_VAR_NSSsuffix")), false);
  assert.equal(compareNsisExecutableBytes(standalone, Buffer.from("prefix__TAURI_BUNDLE_TYPE_VAR_NSXsuffix")), false);
  assert.equal(compareNsisExecutableBytes(Buffer.concat([standalone, standalone]), Buffer.concat([installed, installed])), false);
  assert(evaluate({ expectedVersion: "1.2.4" }).some((item) => item.code === "build-manifest-product-identity"));
  const reorderedManifest = { outputIdentity: { sha256: "output", bytes: 5, files: 4 }, productVersion: "1.2.3", product: "Editkin", schemaVersion: 2, scope: PRODUCT_RELEASE_SCOPE, inputIdentity: { sha256: "input", bytes: 3, files: 2 } };
  assert.equal(buildManifestIdentityMatches(reorderedManifest, manifest), true);
  assert.equal(buildManifestIdentityMatches({ ...reorderedManifest, productVersion: "1.2.4" }, manifest), false);
  process.stdout.write(`${JSON.stringify({ status: "GREEN", deterministicZip: true, semanticManifestIdentity: true, detected: ["missing-file", "identity-mismatch", "unexpected-file", "unsafe-entry", "duplicate-entry", "tool-sha256", "executable-version-exact", "executable-version-four-part", "executable-version-truncated", "executable-version-drift", "stale-build-inputs", "stale-build-outputs", "executable-missing-build-manifest", "build-manifest-product-identity", "semantic-manifest-version"] })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
