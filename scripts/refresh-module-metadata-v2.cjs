/** Build/check only. Importing the formatter/checker does not load tsx or the source catalog. */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createModuleMetadataSyncReaderV3 } = require("./lib/module-metadata-sync-read-v3.cjs");
const { withModuleMetadataSourcesV3 } = require("./lib/module-metadata-source-loader-v3.cjs");
const { createHash } = require("node:crypto");
const { renderGeneratedModuleMetadataV3, generatedModuleMetadataIdentitiesV3, checkGeneratedModuleMetadataV3 } = require("./lib/module-metadata-format-v3.cjs");
const { MODULE_METADATA_TOOL_SOURCES_V3, MODULE_METADATA_JSON_SOURCES_V3, moduleMetadataSourcePathV3 } = require("./lib/module-metadata-input-contract-v3.cjs");
const productRoot = path.resolve(__dirname, "..");
const generatedPath = path.join(productRoot, "src/modules/moduleMetadataV2.generated.ts");
const dataPath = path.join(productRoot, "src/modules/moduleMetadataV2.data.json");
const bindingPath = path.join(productRoot, "scripts/module-metadata-v2.sources.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function createModuleMetadataGeneratorV3(rootInput = productRoot, { reader = createModuleMetadataSyncReaderV3() } = {}) {
  const productRoot = path.resolve(rootInput);
  const localRequire = createRequire(path.join(productRoot, "scripts/refresh-module-metadata-v2.cjs"));
  function sourceRuntime() {
    localRequire("tsx/cjs");
    const types = localRequire("../src/modules/moduleTypes");
    const { canonicalJson } = localRequire("../src/shared/canonicalJson");
    return { canonicalJson, constants: { registrySchema: types.EDITKIN_MODULE_REGISTRY_SCHEMA, moduleSchema: types.EDITKIN_MODULE_SCHEMA,
      indexSchema: types.EDITKIN_MODULE_INDEX_SCHEMA, kinds: types.MODULE_KINDS, statuses: types.MODULE_STATUSES, formats: types.MODULE_FORMATS } };
  }

  function renderDocuments(manifests) {
    const { canonicalJson, constants } = sourceRuntime();
    const rows = manifests.map(manifest => [manifest.id, hash(canonicalJson(manifest))]);
    const identity = { schema: constants.registrySchema, sha256: hash(canonicalJson(rows)), moduleCount: manifests.length,
      variantCount: manifests.reduce((sum, manifest) => sum + manifest.variants.length, 0) };
    return renderGeneratedModuleMetadataV3({ identity, manifests }, constants);
  }

  /** Compatibility API: still returns executable TypeScript text, now a short hash-bound facade. */
  function renderModuleMetadataV2(manifests) { return withModuleMetadataSourcesV3(productRoot, () => renderDocuments(manifests).text, { reader, admitAll: false }); }
  function renderModuleMetadataDataV3(manifests) { return withModuleMetadataSourcesV3(productRoot, () => renderDocuments(manifests).data, { reader, admitAll: false }); }

  function buildModuleMetadataV2() {
    return withModuleMetadataSourcesV3(productRoot, readSource => {
      sourceRuntime();
      const sourcePath = localRequire.resolve("../src/modules/moduleManifestCatalogSourceV2");
      const { moduleManifestCatalogSourceV2 } = localRequire(sourcePath);
      const manifests = moduleManifestCatalogSourceV2().map(({ manifest }) => ({ schema: "editkin.module/v1", ...manifest }));
      const documents = renderDocuments(manifests), visited = new Set(), sources = new Map();
      function visit(module) {
        if (!module || visited.has(module.id)) return;
        visited.add(module.id);
        const file = module.filename;
        if (file && /\.(?:tsx?|json)$/.test(file) && !file.includes(`${path.sep}node_modules${path.sep}`)) {
          const relative = [productRoot, process.cwd()].map(root => path.relative(root, file)).find(value => value.startsWith(`src${path.sep}`));
          if (relative) sources.set(relative.split(path.sep).join("/"), hash(readSource(file)));
          else if (/\.json$/u.test(file)) {
            const declared = MODULE_METADATA_JSON_SOURCES_V3.find(name => name.startsWith("workspace/")
              && [productRoot, process.cwd()].some(root => path.resolve(moduleMetadataSourcePathV3(root, name)) === path.resolve(file)));
            if (!declared) throw Error(`MODULE_METADATA_JSON_SOURCE_OUTSIDE_DECLARED_ROOT:${file}`);
            sources.set(declared, hash(readSource(file)));
          }
        }
        for (const child of module.children) visit(child);
      }
      visit(localRequire.cache[sourcePath]);
      for (const name of MODULE_METADATA_TOOL_SOURCES_V3) {
        const file = name.startsWith("scripts/") ? path.join(productRoot, name) : localRequire.resolve("../src/modules/moduleTypes");
        sources.set(name, hash(readSource(file)));
      }
      for (const name of MODULE_METADATA_JSON_SOURCES_V3) if (!sources.has(name)) throw Error(`MODULE_METADATA_SOURCE_CLOSURE_MISSING:${name}`);
      const generatedFiles = generatedModuleMetadataIdentitiesV3(documents);
      const binding = JSON.stringify({ schema: "editkin.module-metadata-source-binding/v3", generatedSha256: generatedFiles[0].sha256, generatedFiles,
        sources: [...sources].sort(([a], [b]) => a.localeCompare(b, "en")).map(([file, sha256]) => ({ file, sha256 })) }, null, 2) + "\n";
      return { ...documents, binding, manifestCount: manifests.length, sourceCount: sources.size };
    }, { reader });
  }

  function readGeneratedModuleMetadataV3() {
    const read = name => {
      const file = path.join(productRoot, name);
      return fs.existsSync(file) ? reader.read(file).toString("utf8") : "";
    };
    return { text: read("src/modules/moduleMetadataV2.generated.ts"), data: read("src/modules/moduleMetadataV2.data.json"),
      binding: read("scripts/module-metadata-v2.sources.json") };
  }
  return { buildModuleMetadataV2, renderModuleMetadataV2, renderModuleMetadataDataV3, readGeneratedModuleMetadataV3, checkModuleMetadataV2 };
}

function checkModuleMetadataV2(expected, actual) { return checkGeneratedModuleMetadataV3(expected, actual); }

const defaultGenerator = createModuleMetadataGeneratorV3();

if (require.main === module) {
  try {
    const flags = process.argv.slice(2);
    if (flags.length > 1 || flags.some(flag => !["--check", "--write"].includes(flag))) throw Error("Usage: refresh-module-metadata-v2.cjs [--check|--write]");
    const expected = defaultGenerator.buildModuleMetadataV2();
    if (flags[0] === "--write") {
      fs.writeFileSync(generatedPath, expected.text); fs.writeFileSync(dataPath, expected.data); fs.writeFileSync(bindingPath, expected.binding);
    } else checkModuleMetadataV2(expected, defaultGenerator.readGeneratedModuleMetadataV3());
    console.log(JSON.stringify({ status: flags[0] === "--write" ? "GENERATED" : "FRESH", manifestCount: expected.manifestCount,
      sourceCount: expected.sourceCount, generatedFiles: generatedModuleMetadataIdentitiesV3(expected) }));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = { ...defaultGenerator, createModuleMetadataGeneratorV3 };
