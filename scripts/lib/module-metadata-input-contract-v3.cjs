/** Fixed build-time namespace contract; no source content, filesystem reads or runtime adapters. */
const { resolve } = require("node:path");
const MODULE_METADATA_TOOL_SOURCES_V3 = Object.freeze([
  "scripts/refresh-module-metadata-v2.cjs",
  "scripts/lib/module-metadata-format-v3.cjs",
  "scripts/lib/module-metadata-input-contract-v3.cjs",
  "scripts/lib/module-metadata-sync-read-v3.cjs",
  "scripts/lib/module-metadata-source-loader-v3.cjs",
  "src/modules/moduleTypes.ts",
]);
const MODULE_METADATA_JSON_SOURCES_V3 = Object.freeze([
  "src/creative/editkinAestheticStandard.json",
  "src/creative/haoCorePack.json",
  "src/generated/fontAdvanceMetrics.json",
  "src/generated/fontFaceIndex.json",
  "src/generated/fontEmMetrics.json",
  "workspace/community/hao-motion-kit/expansion_2026_wave2/hao-core-pack-wave2-additions.json",
]);
function moduleMetadataSourcePathV3(rootInput, name) {
  if (name.startsWith("workspace/")) {
    if (!MODULE_METADATA_JSON_SOURCES_V3.includes(name)) throw Error("Module metadata workspace source is not declared");
    return resolve(rootInput, "../..", name.slice("workspace/".length));
  }
  return resolve(rootInput, name);
}
module.exports = { MODULE_METADATA_TOOL_SOURCES_V3, MODULE_METADATA_JSON_SOURCES_V3, moduleMetadataSourcePathV3 };
