const { registerHooks } = require("node:module");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { createModuleMetadataSyncReaderV3 } = require("./module-metadata-sync-read-v3.cjs");
const { MODULE_METADATA_JSON_SOURCES_V3, moduleMetadataSourcePathV3 } = require("./module-metadata-input-contract-v3.cjs");

const key = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
function filePath(url) {
  return typeof url === "string" && url.startsWith("file:") ? fileURLToPath(url) : undefined;
}
function requestedFile(specifier, parentURL) {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (path.isAbsolute(specifier)) return specifier;
  const parent = filePath(parentURL);
  return parent && specifier.startsWith(".") ? path.resolve(path.dirname(parent), specifier) : undefined;
}

/**
 * Synchronous authoring window. Only the six declared source JSON files receive
 * supplied bytes. Other JSON, node_modules, JS and TS use the existing loader.
 * This is an encoded-input budget, not a JavaScript heap or security sandbox.
 */
function withModuleMetadataSourcesV3(root, operation, { reader = createModuleMetadataSyncReaderV3(), admitAll = true } = {}) {
  const sources = new Map(MODULE_METADATA_JSON_SOURCES_V3.map(name => {
    const target = moduleMetadataSourcePathV3(root, name);
    return [key(target), { target, admitted: admitAll ? reader.admit(target) : undefined }];
  }));
  const admission = declared => declared.admitted ??= reader.admit(declared.target);
  const readSource = target => {
    const declared = sources.get(key(target));
    return reader.read(declared?.target ?? target, declared ? admission(declared) : undefined);
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const requested = requestedFile(specifier, context.parentURL);
      const declared = requested && sources.get(key(requested));
      if (declared) reader.assertSame(admission(declared), reader.admit(declared.target));
      const result = next(specifier, context);
      if (declared) {
        const resolved = filePath(result.url);
        if (!resolved || key(resolved) !== key(declared.target)) throw Error("MODULE_METADATA_JSON_RESOLUTION_CHANGED");
      }
      return result;
    },
    load(url, context, next) {
      const target = filePath(url), declared = target && sources.get(key(target));
      if (!declared) return next(url, context);
      return { format: "json", source: readSource(declared.target), shortCircuit: true };
    },
  });
  try {
    const result = operation(readSource);
    if (result && typeof result.then === "function") throw Error("MODULE_METADATA_SOURCE_LOADER_REQUIRES_SYNC_OPERATION");
    for (const declared of sources.values()) {
      if (declared.admitted) reader.assertSame(declared.admitted, reader.admit(declared.target));
    }
    return result;
  } finally {
    hooks.deregister();
  }
}

module.exports = { withModuleMetadataSourcesV3 };
