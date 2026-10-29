import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { REPO_TMP, useTempRoots } from "../../src/test/tempRoot.mjs";
import { captureModuleMetadataValidationInputs } from "./module-metadata-validation-inputs.mjs";
import { PRODUCT_REQUIRED_INPUT_PATHS, productInputExclusionReason } from "./build-input-identity.mjs";
import inputContract from "./module-metadata-input-contract-v3.cjs";

const require = createRequire(import.meta.url);
const { renderGeneratedModuleMetadataV3, generatedModuleMetadataIdentitiesV3, checkGeneratedModuleMetadataV3 } = require("./module-metadata-format-v3.cjs");
const { checkModuleMetadataV2 } = require("../refresh-module-metadata-v2.cjs");
const { MODULE_METADATA_TOOL_SOURCES_V3, MODULE_METADATA_JSON_SOURCES_V3, moduleMetadataSourcePathV3 } = inputContract;
const temp = useTempRoots(after), sha = bytes => createHash("sha256").update(bytes).digest("hex");
const DATA = "src/modules/moduleMetadataV2.data.json", FACADE = "src/modules/moduleMetadataV2.generated.ts", BINDING = "scripts/module-metadata-v2.sources.json";
const FORMATTER = "scripts/lib/module-metadata-format-v3.cjs", TYPES = "src/modules/moduleTypes.ts", GENERATOR = "scripts/refresh-module-metadata-v2.cjs";
const CONTRACT = "scripts/lib/module-metadata-input-contract-v3.cjs";
const envelope = JSON.parse(await readFile(new URL("../../src/modules/moduleMetadataV2.data.json", import.meta.url), "utf8"));

async function fixture(v2 = false) {
  const workspace = await temp.create("metadata-v3-owned-", { parent: REPO_TMP }), root = resolve(workspace, "apps/editor");
  const sources = v2 ? [GENERATOR, "src/modules/moduleManifestCatalogSourceV2.ts"]
    : [...MODULE_METADATA_TOOL_SOURCES_V3, "src/modules/moduleManifestCatalogSourceV2.ts", ...MODULE_METADATA_JSON_SOURCES_V3];
  for (const name of sources) { const file = moduleMetadataSourcePathV3(root, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, `source fixture: ${name}`); }
  const docs = renderGeneratedModuleMetadataV3(envelope.metadata, envelope.constants);
  await mkdir(resolve(root, "src/modules"), { recursive: true });
  await writeFile(resolve(root, FACADE), v2 ? "legacy generated literal fixture" : docs.text);
  if (!v2) await writeFile(resolve(root, DATA), docs.data);
  const binding = { schema: `editkin.module-metadata-source-binding/${v2 ? "v2" : "v3"}`,
    generatedSha256: sha(v2 ? "legacy generated literal fixture" : docs.text),
    ...(v2 ? {} : { generatedFiles: generatedModuleMetadataIdentitiesV3(docs) }),
    sources: await Promise.all(sources.map(async file => ({ file, sha256: sha(await readFile(moduleMetadataSourcePathV3(root, file))) }))) };
  await writeFile(resolve(root, BINDING), JSON.stringify(binding));
  return { root, binding, docs };
}
async function saveBinding(input) { await writeFile(resolve(input.root, BINDING), JSON.stringify(input.binding)); }
async function rebindArtifacts(input, link = true) {
  const data = await readFile(resolve(input.root, DATA));
  let text = await readFile(resolve(input.root, FACADE), "utf8");
  if (link) text = text.replace(/Registry data SHA-256: [a-f0-9]{64}/u, `Registry data SHA-256: ${sha(data)}`);
  await writeFile(resolve(input.root, FACADE), text);
  input.binding.generatedSha256 = sha(text);
  input.binding.generatedFiles = [{ file: FACADE, bytes: Buffer.byteLength(text), sha256: sha(text) }, { file: DATA, bytes: data.length, sha256: sha(data) }];
  await saveBinding(input);
}

test("v3 normally binds JSON, facade and all declared source identities", async () => {
  const input = await fixture(), rows = await captureModuleMetadataValidationInputs(input.root);
  assert.equal(rows.length, 16);
  for (const name of [DATA, FACADE, BINDING, GENERATOR, FORMATTER, TYPES, CONTRACT, ...MODULE_METADATA_JSON_SOURCES_V3]) assert(rows.some(row => row.path === name));
  const normal = rows.find(row => row.path === DATA); assert.equal(normal.sha256, sha(input.docs.data));
});

for (const kind of ["missing-data", "missing-facade", "data-drift", "facade-drift", "descriptor-hash", "descriptor-size", "missing-descriptor", "duplicate-descriptor", "absolute-descriptor", "traversal-descriptor", "binary-descriptor", "unexpected-descriptor", "malformed-json", "wrong-envelope", "wrong-facade-data-link", "linked-ancestry", "oversized-data", "oversized-facade", "oversized-binding", "omitted-formatter", "omitted-types", "omitted-generator", "omitted-contract", "source-drift", "duplicate-source", "traversal-source", "absolute-source", "binary-source", "backslash-source", "generated-as-source", "unknown-script"]) {
  test(`v3 rejects ${kind}`, async () => {
    const input = await fixture(), at = name => resolve(input.root, name), binding = input.binding;
    if (kind === "missing-data") await rename(at(DATA), at(DATA + ".kept"));
    else if (kind === "missing-facade") await rename(at(FACADE), at(FACADE + ".kept"));
    else if (kind === "data-drift") await writeFile(at(DATA), input.docs.data + " ");
    else if (kind === "facade-drift") await writeFile(at(FACADE), input.docs.text + "// drift\n");
    else if (kind === "descriptor-hash") binding.generatedFiles[1].sha256 = "0".repeat(64);
    else if (kind === "descriptor-size") binding.generatedFiles[1].bytes++;
    else if (kind === "missing-descriptor") binding.generatedFiles.pop();
    else if (kind === "duplicate-descriptor") binding.generatedFiles[1] = { ...binding.generatedFiles[0] };
    else if (kind === "absolute-descriptor") binding.generatedFiles[1].file = "C:/outside.json";
    else if (kind === "traversal-descriptor") binding.generatedFiles[1].file = "src/../outside.json";
    else if (kind === "binary-descriptor") binding.generatedFiles[1].file = "src/model.onnx";
    else if (kind === "unexpected-descriptor") binding.generatedFiles.push({ ...binding.generatedFiles[1], file: "src/extra.json" });
    else if (kind === "malformed-json") { await writeFile(at(DATA), "{invalid"); await rebindArtifacts(input); }
    else if (kind === "wrong-envelope") { await writeFile(at(DATA), JSON.stringify({ ...envelope, schema: "wrong" })); await rebindArtifacts(input); }
    else if (kind === "wrong-facade-data-link") { await writeFile(at(FACADE), input.docs.text.replace(/Registry data SHA-256: [a-f0-9]{64}/u, `Registry data SHA-256: ${"0".repeat(64)}`)); await rebindArtifacts(input, false); }
    else if (kind === "linked-ancestry") { const folder = at("src/modules"); await rename(folder, folder + ".kept"); await symlink(folder + ".kept", folder, process.platform === "win32" ? "junction" : "dir"); }
    else if (kind === "oversized-data") await writeFile(at(DATA), Buffer.alloc(2 * 1024 ** 2 + 1));
    else if (kind === "oversized-facade") await writeFile(at(FACADE), Buffer.alloc(2 * 1024 ** 2 + 1));
    else if (kind === "oversized-binding") await writeFile(at(BINDING), Buffer.alloc(2 * 1024 ** 2 + 1));
    else if (kind.startsWith("omitted-")) binding.sources = binding.sources.filter(row => row.file !== ({ "omitted-formatter": FORMATTER, "omitted-types": TYPES, "omitted-generator": GENERATOR, "omitted-contract": CONTRACT })[kind]);
    else if (kind === "source-drift") await writeFile(at(TYPES), "changed constants");
    else if (kind === "duplicate-source") binding.sources.push({ ...binding.sources[0] });
    else if (kind === "traversal-source") binding.sources[0].file = "src/../outside.ts";
    else if (kind === "absolute-source") binding.sources[0].file = "C:/outside.ts";
    else if (kind === "binary-source") binding.sources[0].file = "src/model.dll";
    else if (kind === "backslash-source") binding.sources[0].file = "src\\outside.ts";
    else if (kind === "generated-as-source") binding.sources.push({ file: DATA, sha256: sha(input.docs.data) });
    else if (kind === "unknown-script") binding.sources[0].file = "scripts/unknown.cjs";
    if (kind !== "oversized-binding") await saveBinding(input);
    await assert.rejects(captureModuleMetadataValidationInputs(input.root));
  });
}

for (const name of MODULE_METADATA_JSON_SOURCES_V3) {
  test(`v3 rejects omitted JSON source ${name}`, async () => {
    const input = await fixture(); input.binding.sources = input.binding.sources.filter(row => row.file !== name); await saveBinding(input);
    await assert.rejects(captureModuleMetadataValidationInputs(input.root), /does not cover/u);
  });
}

test("legacy v2 stays valid and cannot downgrade a JSON facade to an unbound data file", async () => {
  const input = await fixture(true); assert.equal((await captureModuleMetadataValidationInputs(input.root)).length, 4);
  await writeFile(resolve(input.root, FACADE), 'import data from "./moduleMetadataV2.data.json";');
  input.binding.generatedSha256 = sha(await readFile(resolve(input.root, FACADE))); await saveBinding(input);
  await assert.rejects(captureModuleMetadataValidationInputs(input.root), /requires v3 data binding/u);
});

test("pure formatter and both generator checks bind exact data and facade bytes without tsx imports", () => {
  const docs = renderGeneratedModuleMetadataV3(envelope.metadata, envelope.constants), expected = { ...docs, binding: "binding bytes" };
  assert.deepEqual(JSON.parse(docs.data).metadata, envelope.metadata);
  assert.equal(envelope.metadata.identity.moduleCount, 31); assert.equal(envelope.metadata.identity.variantCount, 303);
  assert(checkGeneratedModuleMetadataV3(expected, { ...expected })); assert(checkModuleMetadataV2(expected, { ...expected }));
  for (const actual of [{ ...expected, data: undefined }, { ...expected, data: docs.data + " " }, { ...expected, text: docs.text + " " }, { ...expected, binding: "changed" }]) assert.throws(() => checkModuleMetadataV2(expected, actual), /MODULE_METADATA_STALE/u);
  const changed = structuredClone(envelope.metadata); changed.manifests[0].name += " changed";
  assert.notEqual(renderGeneratedModuleMetadataV3(changed, envelope.constants).text, docs.text);
  assert(!Object.keys(require.cache).some(file => /[\\/]tsx[\\/]/u.test(file)));
});

test("all generated/data/formatter bytes are mandatory non-excluded product inputs", () => {
  for (const name of [BINDING, FACADE, DATA, FORMATTER, GENERATOR, CONTRACT, ...MODULE_METADATA_TOOL_SOURCES_V3.filter(name => name.endsWith(".cjs"))]) { assert(PRODUCT_REQUIRED_INPUT_PATHS.includes(name)); assert.equal(productInputExclusionReason(name), undefined); }
});

for (const name of ["scripts/lib/module-metadata-sync-read-v3.cjs", "scripts/lib/module-metadata-source-loader-v3.cjs"]) {
  test(`v3 rejects omitted authoring boundary source ${name}`, async () => {
    const input = await fixture(); input.binding.sources = input.binding.sources.filter(row => row.file !== name); await saveBinding(input);
    await assert.rejects(captureModuleMetadataValidationInputs(input.root), /does not cover/u);
  });
}
