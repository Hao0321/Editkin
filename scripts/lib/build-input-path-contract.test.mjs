import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as current from "./build-input-identity.mjs";
import * as paths from "./build-input-path-contract.mjs";
import { FRONTEND_QUALITY_GATES } from "./frontend-quality-preflight.mjs";
import temp from "../test/module-test-temp.cjs";

const product = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = paths.BUILD_INPUT_PATH_CONTRACT_FILE;
const include = temp.selectedTestGroups(["parity", "manifest", "collector-edge", "collector-hash"]);
const sha = value => createHash("sha256").update(value).digest("hex");
const local = createRequire(import.meta.url);
const oracleBytes = await readFile(local.resolve("../fixtures/build-input-path-contract-v1.json"));
assert.equal(sha(oracleBytes), "544bed86a7acb8fdd813303042935686815531cc280c99ccf474aa7a76a79714", "path contract oracle bytes changed; review its provenance before updating the hash");
const expected = JSON.parse(oracleBytes);
const RAW = "workspace/community/hao-motion-kit/expansion_2026_wave2/hao-core-pack-wave2-additions.json";
const PRIVATE_LISTS = ["APP_INPUT_ROOTS", "PRODUCT_MODULE_ENTRYPOINTS", "PRODUCT_PIPELINE_SCRIPT_ENTRYPOINTS", "WORKSPACE_INPUT_ROOTS", "RESEARCH_ONLY_EXACT_PATHS", "EVIDENCE_ONLY_EXACT_PATHS"];

function manifest(inputPaths = current.PRODUCT_REQUIRED_INPUT_PATHS) {
  const rows = names => [...new Set(names)].sort((left, right) => left.localeCompare(right, "en"))
    .map(path => ({ path, bytes: 1, sha256: sha(path) }));
  const inputs = rows([...inputPaths, RAW]);
  const outputs = rows([...current.PRODUCT_REQUIRED_OUTPUT_PATHS, "dist/fixture.js"]);
  return { schemaVersion: 2, scope: current.PRODUCT_RELEASE_SCOPE, inputs, outputs,
    inputIdentity: current.aggregateBuildFiles(inputs), outputIdentity: current.aggregateBuildFiles(outputs) };
}

async function fixture(t) {
  const workspace = temp.createOwnedTestRoot(t, "build-paths-");
  const root = resolve(workspace, "apps/editor"), source = label => resolve(root, label);
  const write = async (label, bytes) => {
    const file = source(label), relation = relative(workspace, file);
    assert(!isAbsolute(relation) && !relation.split(/[\\/]/u).includes(".."));
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
  };
  const makeRoot = async label => {
    if (extname(label)) await write(label, "fixture resource bytes");
    else await mkdir(source(label), { recursive: true });
  };
  for (const label of paths.APP_INPUT_ROOTS) await makeRoot(label);
  for (const label of paths.WORKSPACE_INPUT_ROOTS) await makeRoot("../../" + label);
  // Deliberate import-free entrypoints prove the explicit helper root is enough.
  for (const label of [...paths.PRODUCT_MODULE_ENTRYPOINTS, ...paths.PRODUCT_PIPELINE_SCRIPT_ENTRYPOINTS, ...FRONTEND_QUALITY_GATES.map(gate => gate.script)]) await write(label, "// fixture dependency leaf\n");
  for (const label of paths.outputPaths()) await makeRoot(label);
  for (const label of current.PRODUCT_REQUIRED_OUTPUT_PATHS) await write(label, "fixture shipping bytes");
  await write("dist/fixture.js", "// fixture output\n");
  await write(SELF, await readFile(resolve(product, SELF)));
  await write("../../" + RAW.slice("workspace/".length), '{"fixture":"PRIVATE_SOURCE_FIXTURE"}');
  return { root, source, raw: resolve(workspace, RAW.slice("workspace/".length)) };
}

if (include("parity")) {
  test("public exports and aggregate behavior match the pinned contract oracle", () => {
    assert.deepEqual(Object.keys(current).sort(), expected.publicNames);
    assert.deepEqual(current.aggregateBuildFiles(expected.aggregate.rows), expected.aggregate.identity);
    assert.deepEqual(current.aggregateBuildFiles([]), expected.aggregate.emptyIdentity);
  });
  test("ordered path lists and sets match the oracle with exactly one helper self-path", () => {
    for (const name of PRIVATE_LISTS) assert.deepEqual([...paths[name]], expected.lists[name], name);
    assert.deepEqual(current.PRODUCT_REQUIRED_INPUT_PATHS, expected.lists.PRODUCT_REQUIRED_INPUT_PATHS);
    assert.deepEqual(current.PRODUCT_REQUIRED_OUTPUT_PATHS, expected.lists.PRODUCT_REQUIRED_OUTPUT_PATHS);
    assert.equal(paths.APP_INPUT_ROOTS.filter(path => path === SELF).length, 1);
    assert.equal(current.PRODUCT_REQUIRED_INPUT_PATHS.filter(path => path === SELF).length, 1);
    assert.equal(paths.APP_INPUT_ROOTS.at(-1), SELF); assert.equal(current.PRODUCT_REQUIRED_INPUT_PATHS.at(-1), SELF);
    assert.deepEqual(paths.outputPaths(), expected.outputPaths[process.platform === "win32" ? "win32" : "other"]);
  });
  test("release scope, policy digest and frozen public arrays stay exact", () => {
    assert.deepEqual(current.PRODUCT_RELEASE_SCOPE, expected.releaseScope);
    assert(Object.isFrozen(current.PRODUCT_REQUIRED_INPUT_PATHS)); assert(Object.isFrozen(current.PRODUCT_REQUIRED_OUTPUT_PATHS));
    assert.equal(current.PRODUCT_REQUIRED_INPUT_PATHS, paths.PRODUCT_REQUIRED_INPUT_PATHS);
    assert.equal(current.PRODUCT_REQUIRED_OUTPUT_PATHS, paths.PRODUCT_REQUIRED_OUTPUT_PATHS);
  });
  test("workspace originals and exclusion classes retain their input-only roles", () => {
    for (const row of expected.exclusions) assert.equal(current.productInputExclusionReason(row.path) ?? null, row.reason, row.path);
    assert.equal(current.productInputExclusionReason(RAW), undefined);
    assert(!current.PRODUCT_REQUIRED_OUTPUT_PATHS.some(path => path.startsWith("workspace/") || path === SELF));
    assert(!paths.outputPaths().some(path => path.startsWith("workspace/") || path.startsWith("scripts/")));
  });
}

if (include("manifest")) {
  test("actual manifest checker accepts the complete path-contract fixture", () => {
    assert.deepEqual(current.productReleaseManifestFindings(manifest()), []);
  });
  test("missing helper with recomputed aggregates is rejected by the required edge", () => {
    const input = manifest(current.PRODUCT_REQUIRED_INPUT_PATHS.filter(path => path !== SELF));
    assert.deepEqual(current.productReleaseManifestFindings(input), [{ code: "missing-required-product-input", paths: [SELF] }]);
  });
  test("helper on the output side cannot satisfy its mandatory input role", () => {
    const input = manifest(current.PRODUCT_REQUIRED_INPUT_PATHS.filter(path => path !== SELF));
    input.outputs.push({ path: SELF, bytes: 1, sha256: sha(SELF) }); input.outputs.sort((a, b) => a.path.localeCompare(b.path, "en"));
    input.outputIdentity = current.aggregateBuildFiles(input.outputs);
    assert.deepEqual(current.productReleaseManifestFindings(input), [{ code: "missing-required-product-input", paths: [SELF] }]);
  });
}

if (include("collector-edge")) {
  test("real collector resolves dotted generated module basenames to the actual TypeScript file", async t => {
    const input = await fixture(t);
    await writeFile(input.source("scripts/build-release-input-manifest.mjs"), 'import data from "./registry.generated";\n');
    const file = input.source("scripts/registry.generated.ts");
    await writeFile(file, "export default { value: 1 };\n");
    const receipt = await current.computeBuildReceipt(input.root);
    const row = receipt.inputs.find(row => row.path === "scripts/registry.generated.ts");
    assert(row); assert.equal(row.sha256, sha(await readFile(file)));
    await rename(file, file + ".kept");
    await assert.rejects(current.computeBuildInputIdentity(input.root), /Unable to resolve local product dependency .\/registry.generated/);
  });
  test("explicit JSON imports cannot be satisfied by a similarly named TypeScript file", async t => {
    const input = await fixture(t);
    await writeFile(input.source("scripts/build-release-input-manifest.mjs"), 'import data from "./missing.json";\n');
    await writeFile(input.source("scripts/missing.json.ts"), "export default {};\n");
    await assert.rejects(current.computeBuildInputIdentity(input.root), /Unable to resolve local product dependency .\/missing.json/);
  });
  test("real collector ignores generated import text, binds real dependencies and refuses a missing real file", async t => {
    const input = await fixture(t);
    const entry = input.source("scripts/build-release-input-manifest.mjs");
    const dependency = input.source("scripts/collector-real.mjs");
    await writeFile(entry, `const generated = 'import data from "./phantom.json";';\nexport { value } from "./collector-real.mjs";\n`);
    await writeFile(dependency, "export const value = 1;\n");
    const before = await current.computeBuildReceipt(input.root);
    assert(before.inputs.some(row => row.path === "scripts/collector-real.mjs"));
    assert(!before.inputs.some(row => row.path.endsWith("/phantom.json")));
    await writeFile(dependency, "export const value = 2;\n");
    const after = await current.computeBuildReceipt(input.root);
    assert.notDeepEqual(after.inputIdentity, before.inputIdentity);
    assert.deepEqual(after.outputIdentity, before.outputIdentity);
    await rename(dependency, dependency + ".kept");
    await assert.rejects(current.computeBuildInputIdentity(input.root), /Unable to resolve local product dependency .\/collector-real.mjs/);
  });
  test("real build receipt captures the helper even without a graph import edge", async t => {
    const input = await fixture(t), receipt = await current.computeBuildReceipt(input.root);
    const row = receipt.inputs.find(row => row.path === SELF); assert(row);
    assert.equal(row.sha256, sha(await readFile(input.source(SELF))));
    assert(!receipt.outputs.some(row => row.path === SELF));
    assert.deepEqual(receipt.scope, expected.releaseScope);
    console.log(JSON.stringify({ realCollector: "helper-required-root", helperBytes: row.bytes, currentInputs: receipt.inputs.length, graphImportEdge: false, syntheticFilesystemOnly: true }));
  });
  test("real input collection rejects a missing mandatory helper", async t => {
    const input = await fixture(t);
    assert((await current.computeBuildInputIdentity(input.root)).sha256);
    await rename(input.source(SELF), input.source(SELF) + ".kept");
    await assert.rejects(current.computeBuildInputIdentity(input.root), error => error.code === "ENOENT");
  });
}

if (include("collector-hash")) {
  test("helper bytes change the actual input identity without changing outputs", async t => {
    const input = await fixture(t), before = await current.computeBuildReceipt(input.root);
    await writeFile(input.source(SELF), (await readFile(input.source(SELF), "utf8")) + "\n// changed fixture bytes\n");
    const after = await current.computeBuildReceipt(input.root);
    assert.notDeepEqual(after.inputIdentity, before.inputIdentity);
    assert.equal(after.inputs.length, before.inputs.length); assert.deepEqual(after.outputIdentity, before.outputIdentity);
  });
  test("workspace raw JSON affects actual inputs and never shipping outputs", async t => {
    const input = await fixture(t), before = await current.computeBuildReceipt(input.root);
    assert(before.inputs.some(row => row.path === RAW)); assert(!before.outputs.some(row => row.path === RAW));
    await writeFile(input.raw, '{"fixture":"CHANGED_PRIVATE_SOURCE_FIXTURE"}');
    const after = await current.computeBuildReceipt(input.root);
    assert.notDeepEqual(after.inputIdentity, before.inputIdentity); assert.deepEqual(after.outputIdentity, before.outputIdentity);
    assert(!JSON.stringify(after).includes("CHANGED_PRIVATE_SOURCE_FIXTURE"));
    console.log(JSON.stringify({ realCollector: "workspace-source-only", inputChanged: true, outputChanged: false, rawContentReturned: false }));
  });
}
