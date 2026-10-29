import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import { moduleMetadataV2, moduleMetadataConstantsV2 } from "./moduleMetadataV2.generated";
import type { ModuleManifest } from "./moduleTypes";
const { registrySchema: EDITKIN_MODULE_REGISTRY_SCHEMA, moduleSchema: EDITKIN_MODULE_SCHEMA, formats: MODULE_FORMATS, kinds: MODULE_KINDS, statuses: MODULE_STATUSES } = moduleMetadataConstantsV2;

export interface ModuleRegistryIdentityV2 {
  schema: typeof EDITKIN_MODULE_REGISTRY_SCHEMA;
  sha256: string;
  moduleCount: number;
  variantCount: number;
}
export interface ModuleMetadataEntryV2 { manifest: ModuleManifest; manifestSha256: string }
export interface ModuleMetadataRegistryV2 {
  identity: Readonly<ModuleRegistryIdentityV2>;
  manifests: readonly ModuleManifest[];
  get(id: string): ModuleMetadataEntryV2 | undefined;
}
const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Builds metadata only. No schema, adapter, renderer, filesystem project or state store is loaded. */
export function createModuleMetadataRegistryV2(source: typeof moduleMetadataV2): ModuleMetadataRegistryV2 {
  const byId = new Map<string, ModuleMetadataEntryV2>();
  for (const raw of source.manifests) {
    const manifest = deepFreeze(structuredClone(raw));
    if (manifest.schema !== EDITKIN_MODULE_SCHEMA || !/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(manifest.id) || manifest.id.split(".")[0] !== manifest.kind
      || !(MODULE_KINDS as readonly string[]).includes(manifest.kind) || !(MODULE_STATUSES as readonly string[]).includes(manifest.status)
      || !manifest.formats.length || manifest.formats.some(format => !(MODULE_FORMATS as readonly string[]).includes(format))
      || new Set(manifest.variants.map(variant => variant.id)).size !== manifest.variants.length
      || (manifest.variantField && !manifest.variants.length)
      || (manifest.status === "available") !== (manifest.invoke.tool === "prepare_editkin_module")
      || byId.has(manifest.id)) throw Error(`MODULE_METADATA_INVALID:${manifest.id}`);
    byId.set(manifest.id, Object.freeze({ manifest, manifestSha256: sha256(manifest) }));
  }
  const entries = [...byId.values()];
  const identity = Object.freeze({ schema: EDITKIN_MODULE_REGISTRY_SCHEMA,
    sha256: sha256(entries.map(entry => [entry.manifest.id, entry.manifestSha256])), moduleCount: entries.length,
    variantCount: entries.reduce((sum, entry) => sum + entry.manifest.variants.length, 0) });
  if (canonicalJson(identity) !== canonicalJson(source.identity)) throw Error("MODULE_METADATA_IDENTITY_MISMATCH");
  return Object.freeze({ identity, manifests: Object.freeze(entries.map(entry => entry.manifest)), get: (id: string) => byId.get(id) });
}
let cached: ModuleMetadataRegistryV2 | undefined;
export function editkinModuleMetadataRegistryV2(): ModuleMetadataRegistryV2 {
  return cached ??= createModuleMetadataRegistryV2(moduleMetadataV2);
}
