import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { MODULE_METADATA_MAX_INPUT_BYTES_V3, readModuleMetadataFileV3 } from "./module-metadata-bounded-read-v3.mjs";
import inputContract from "./module-metadata-input-contract-v3.cjs";
const { MODULE_METADATA_TOOL_SOURCES_V3, MODULE_METADATA_JSON_SOURCES_V3, moduleMetadataSourcePathV3 } = inputContract;

const BINDING = "scripts/module-metadata-v2.sources.json", GENERATED = "src/modules/moduleMetadataV2.generated.ts";
const DATA = "src/modules/moduleMetadataV2.data.json", FORMATTER = "scripts/lib/module-metadata-format-v3.cjs", TYPES = "src/modules/moduleTypes.ts";
const MAX_BYTES = MODULE_METADATA_MAX_INPUT_BYTES_V3, HASH = /^[a-f0-9]{64}$/u;
const sha = value => createHash("sha256").update(value).digest("hex");

/** Build-validation identities only. v2 remains supported; v3 binds the data AND typed facade. */
export async function captureModuleMetadataValidationInputs(rootInput) {
  const root = resolve(rootInput);
  const checked = async name => {
    const boundary = name.startsWith("workspace/") ? resolve(root, "../..") : root;
    const target = moduleMetadataSourcePathV3(root, name), relation = relative(boundary, target);
    if (isAbsolute(relation) || relation.split(/[\\/]/u).includes("..")) throw Error("Module metadata validation path escaped its root");
    const raw = await readModuleMetadataFileV3(target);
    return { raw, row: { path: name, bytes: raw.byteLength, sha256: sha(raw) } };
  };
  const binding = await checked(BINDING), generated = await checked(GENERATED);
  const document = JSON.parse(binding.raw.toString("utf8"));
  const v3 = document?.schema === "editkin.module-metadata-source-binding/v3";
  if ((!v3 && document?.schema !== "editkin.module-metadata-source-binding/v2") || !HASH.test(document.generatedSha256)
    || document.generatedSha256 !== generated.row.sha256 || !Array.isArray(document.sources) || !document.sources.length || document.sources.length > 10000) {
    throw Error("MODULE_METADATA_STALE: invalid generated metadata/source binding; refresh and review before building");
  }
  const rows = [binding.row, generated.row], seen = new Set([BINDING.toLowerCase(), GENERATED.toLowerCase()]);
  if (v3) {
    if (!Array.isArray(document.generatedFiles) || document.generatedFiles.length !== 2) throw Error("MODULE_METADATA_STALE: facade and JSON must both be bound");
    const data = await checked(DATA), expected = [generated, data];
    for (const [index, name] of [GENERATED, DATA].entries()) {
      const descriptor = document.generatedFiles[index], actual = expected[index].row;
      if (descriptor?.file !== name || !HASH.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes)
        || descriptor.bytes < 0 || descriptor.bytes > MAX_BYTES || descriptor.bytes !== actual.bytes || descriptor.sha256 !== actual.sha256) {
        throw Error("MODULE_METADATA_STALE: generated facade/data descriptor changed");
      }
    }
    const envelope = JSON.parse(data.raw.toString("utf8"));
    if (envelope?.schema !== "editkin.module-metadata-data/v3" || !envelope.metadata?.identity || !Array.isArray(envelope.metadata.manifests) || !envelope.constants
      || !generated.raw.toString("utf8").includes(`// Registry data SHA-256: ${data.row.sha256}`)) throw Error("MODULE_METADATA_STALE: invalid registry data/facade link");
    rows.push(data.row); seen.add(DATA.toLowerCase());
  } else if (/moduleMetadataV2\.(?:data|generated)\.json/u.test(generated.raw.toString("utf8"))) {
    throw Error("MODULE_METADATA_STALE: JSON facade requires v3 data binding");
  }
  for (const source of document.sources) {
    const name = source?.file;
    const knownSource = v3 && (MODULE_METADATA_TOOL_SOURCES_V3.includes(name) || MODULE_METADATA_JSON_SOURCES_V3.includes(name));
    if (typeof name !== "string" || (!knownSource && !/^(?:src\/[a-z0-9._/-]+\.(?:tsx?|json|[cm]?js)|scripts\/refresh-module-metadata-v2\.cjs)$/iu.test(name))
      || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")
      || !HASH.test(source.sha256) || seen.has(name.toLowerCase())) throw Error("Module metadata source binding has an unsafe or duplicate path");
    seen.add(name.toLowerCase()); const actual = await checked(name);
    if (actual.row.sha256 !== source.sha256) throw Error("MODULE_METADATA_STALE: a bound manifest source changed; refresh and review before building");
    rows.push(actual.row);
  }
  if (!seen.has("scripts/refresh-module-metadata-v2.cjs")) throw Error("Module metadata binding does not cover its generator");
  if (v3 && [...MODULE_METADATA_TOOL_SOURCES_V3, ...MODULE_METADATA_JSON_SOURCES_V3].some(name => !seen.has(name.toLowerCase()))) throw Error("Module metadata v3 binding does not cover all tools/constants/JSON sources");
  return rows.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
