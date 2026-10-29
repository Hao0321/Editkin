import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  PRODUCT_RELEASE_SCOPE,
  PRODUCT_REQUIRED_INPUT_PATHS,
  PRODUCT_REQUIRED_OUTPUT_PATHS,
  aggregateBuildFiles,
  computeBuildReceipt,
  productDependencyBoundary,
  productReleaseManifestFindings,
} from "./lib/build-input-identity.mjs";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, ".release-input-manifest.json");
const reportPath = resolve(root, ".rd/benchmarks/editkin-product-release-manifest-policy/report.json");
const forbiddenManifestMarkers = [
  "auto-roto-sam21",
  "auto_roto_onnx",
  "autoRotoModelRouter",
  "autoRotoVideoModel",
  "autoRotoVideoPack",
  "self-authored-auto-roto-vs-sam",
  "editkin-sam21-video-memory-roto",
  "editkin-native-onnx-assisted-roto",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalized = (path) => path.split(sep).join("/");

function fixtureEntry(path) {
  const bytes = Buffer.from(`fixture:${path}`);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}

function fixtureManifest() {
  const inputs = [...PRODUCT_REQUIRED_INPUT_PATHS, "package.json"].map(fixtureEntry).sort((a, b) => a.path.localeCompare(b.path, "en"));
  const outputs = [...PRODUCT_REQUIRED_OUTPUT_PATHS, "dist/assets/index.js"].map(fixtureEntry).sort((a, b) => a.path.localeCompare(b.path, "en"));
  return {
    schemaVersion: 2,
    product: "Editkin",
    productVersion: "0.0.0-fixture",
    scope: { ...PRODUCT_RELEASE_SCOPE },
    inputs,
    outputs,
    inputIdentity: aggregateBuildFiles(inputs),
    outputIdentity: aggregateBuildFiles(outputs),
  };
}

function refreshIdentities(value) {
  value.inputs.sort((a, b) => a.path.localeCompare(b.path, "en"));
  value.outputs.sort((a, b) => a.path.localeCompare(b.path, "en"));
  value.inputIdentity = aggregateBuildFiles(value.inputs);
  value.outputIdentity = aggregateBuildFiles(value.outputs);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function selfTest() {
  const valid = fixtureManifest();
  assert.deepEqual(productReleaseManifestFindings(valid), []);
  const mutations = [
    (value) => { value.schemaVersion = 1; },
    (value) => { value.scope.id = "legacy"; },
    (value) => { value.scope.productMode = "research"; },
    (value) => { value.scope.inputBoundary = "all-repository-files"; },
    (value) => { value.scope.researchBoundary = "bundled"; },
    (value) => { value.scope.policySha256 = "0".repeat(64); },
    (value) => { value.inputIdentity.sha256 = "0".repeat(64); },
    (value) => { value.outputIdentity.bytes += 1; },
    (value) => { value.inputs.push(fixtureEntry("src/application/autoRotoModelRouter.ts")); refreshIdentities(value); },
    (value) => { value.inputs.push(fixtureEntry("src/application/autoRotoVideoModel.ts")); refreshIdentities(value); },
    (value) => { value.inputs.push(fixtureEntry("src/application/autoRotoVideoPack.ts")); refreshIdentities(value); },
    (value) => { value.inputs.push(fixtureEntry("native/hao-core/src/engine/auto_roto_onnx.rs")); refreshIdentities(value); },
    (value) => { value.inputs.push(fixtureEntry("scripts/auto-roto-sam21-video-host.py")); refreshIdentities(value); },
    (value) => { value.inputs.push(fixtureEntry("src/application/autoRotoNativeProduct.test.ts")); refreshIdentities(value); },
    (value) => { value.inputs.push({ ...value.inputs[0] }); },
    (value) => { value.inputs[0].path = "../escaped.ts"; },
    (value) => { value.inputs[0].sha256 = "A".repeat(64); },
    (value) => { value.outputs = value.outputs.filter((entry) => entry.path !== "desktop-dist/service.mjs"); refreshIdentities(value); },
    (value) => { value.inputs.push(fixtureEntry("workspace/assets/broll/transitions/unlisted.mp4")); refreshIdentities(value); },
    (value) => { value.inputs.push(fixtureEntry(".personal-packs/hao-visual-library/editkin-personal-visual.json")); refreshIdentities(value); },
    (value) => { value.outputs.push(fixtureEntry(".personal-packs/hao-visual-library/assets/renamed.mp4")); refreshIdentities(value); },
    ...PRODUCT_REQUIRED_OUTPUT_PATHS.map((path) => (value) => {
      value.outputs = value.outputs.filter((entry) => entry.path !== path);
      refreshIdentities(value);
    }),
    ...PRODUCT_REQUIRED_INPUT_PATHS.map((path) => (value) => {
      value.inputs = value.inputs.filter((entry) => entry.path !== path);
      refreshIdentities(value);
    }),
  ];
  for (const mutate of mutations) {
    const value = clone(valid);
    mutate(value);
    assert(productReleaseManifestFindings(value).length > 0, "product release policy accepted a mutation");
  }
  const workspaceRoot = resolve(root, "../..");
  assert.equal(productDependencyBoundary(root, workspaceRoot, resolve(root, "src/main.tsx")), root);
  assert.equal(
    productDependencyBoundary(root, workspaceRoot, resolve(workspaceRoot, "community/hao-motion-kit/pack.json")),
    resolve(workspaceRoot, "community/hao-motion-kit"),
  );
  assert.equal(
    productDependencyBoundary(root, workspaceRoot, resolve(workspaceRoot, "assets/bgm/music.mp3")),
    resolve(workspaceRoot, "assets/bgm"),
  );
  assert.throws(
    () => productDependencyBoundary(root, workspaceRoot, resolve(workspaceRoot, "private/unlisted.json")),
    /escaped the declared app\/workspace input roots/u,
  );
  process.stdout.write(`${JSON.stringify({
    status: "GREEN_SELF_TEST",
    mutationsRejected: mutations.length,
    dependencyBoundaryControls: 4,
    scope: PRODUCT_RELEASE_SCOPE,
    syntheticFixtureIsPolicyOnly: true,
  })}\n`);
}

if (process.argv.includes("--self-test")) {
  await selfTest();
  process.exit(0);
}

let manifest;
let manifestBytes;
const failures = [];
try {
  manifestBytes = await readFile(manifestPath);
  manifest = JSON.parse(manifestBytes.toString("utf8"));
} catch (error) {
  failures.push({ code: "manifest-unreadable", detail: String(error) });
}
if (manifest) failures.push(...productReleaseManifestFindings(manifest));
const markerFindings = manifestBytes
  ? forbiddenManifestMarkers.filter((marker) => manifestBytes.includes(Buffer.from(marker)))
  : ["manifest-unreadable"];
if (markerFindings.length) failures.push({ code: "research-path-marker-in-formal-manifest", markers: markerFindings });

let current;
try {
  current = await computeBuildReceipt(root);
  if (manifest && JSON.stringify(manifest.scope) !== JSON.stringify(current.scope)) failures.push({ code: "stale-scope" });
  if (manifest && JSON.stringify(manifest.inputs) !== JSON.stringify(current.inputs)) failures.push({ code: "stale-or-non-closed-inputs" });
  if (manifest && JSON.stringify(manifest.outputs) !== JSON.stringify(current.outputs)) failures.push({ code: "stale-or-non-closed-outputs" });
} catch (error) {
  failures.push({ code: "current-receipt-unavailable", detail: String(error) });
}
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (manifest?.product !== packageJson.productName || manifest?.productVersion !== packageJson.version) failures.push({ code: "product-identity" });

const report = {
  schema: "editkin.product-release-manifest-policy-gate/v1",
  status: failures.length ? "BLOCK" : "GREEN_PRODUCT_SCOPED_RELEASE_MANIFEST",
  manifest: manifestBytes ? { path: normalized(relative(root, manifestPath)), bytes: manifestBytes.length, sha256: sha256(manifestBytes) } : null,
  scope: manifest?.scope ?? null,
  inventory: manifest ? { inputs: manifest.inputs?.length ?? 0, outputs: manifest.outputs?.length ?? 0 } : null,
  markerFindings,
  failures,
  claimBoundary: "Proves only that the local release manifest is current, closed to the declared product module/pipeline/resource scope, and does not list tests or isolated Auto Roto research paths. Research sources and provenance remain in the repository/evidence systems. Installer extraction, signing and quality require separate evidence.",
};
await mkdir(dirname(reportPath), { recursive: true });
const temporary = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rm(reportPath, { force: true });
  await rename(temporary, reportPath);
} finally {
  await rm(temporary, { force: true });
}
process.stdout.write(`PRODUCT_RELEASE_MANIFEST_POLICY status=${report.status} report=${reportPath}\n`);
if (failures.length) process.exitCode = 1;
