import type { ModuleManifest } from "./moduleTypes";
import { moduleMetadataConstantsV2 } from "./moduleMetadataV2.generated";
const { indexSchema: EDITKIN_MODULE_INDEX_SCHEMA } = moduleMetadataConstantsV2;
import type { ModuleQuery } from "./moduleRegistry";
import type { ModuleMetadataRegistryV2 } from "./moduleMetadataRuntimeV2";
// W54: keyed by the same frozen manifest object; cache lifetime never extends that object.
const moduleSearchDocumentsV1 = new WeakMap<ModuleManifest, string>();
export function listModulesWithRegistryV2(registry: ModuleMetadataRegistryV2, query: ModuleQuery = {}) {
  const term = query.query?.trim().toLocaleLowerCase();
  const variantMatches = (manifest: ModuleManifest) => manifest.variants.filter(variant =>
    (!query.role || variant.roles?.includes(query.role)) && (!query.format || !variant.formats?.length || variant.formats.includes(query.format)));
  const text = (manifest: ModuleManifest) => {
    const found = moduleSearchDocumentsV1.get(manifest);
    if (found !== undefined) return found;
    const document = [manifest.id, manifest.name, manifest.summary, manifest.autopilot.use, ...manifest.roles,
      ...manifest.variants.flatMap(variant => [variant.id, variant.name, variant.use ?? ""])].join(" ").toLocaleLowerCase();
    moduleSearchDocumentsV1.set(manifest, document);
    return document;
  };
  const matches = registry.manifests.filter(manifest => (!query.kind || manifest.kind === query.kind) && (!query.status || manifest.status === query.status)
    && (!query.format || manifest.formats.includes(query.format))
    && (!query.role || manifest.roles.includes(query.role) || manifest.variants.some(variant => variant.roles?.includes(query.role!)))
    && (!term || text(manifest).includes(term)));
  const start = query.cursor ?? 0, limit = query.limit ?? 20, page = matches.slice(start, start + limit);
  return {
    schema: EDITKIN_MODULE_INDEX_SCHEMA, registry: registry.identity, total: matches.length, returned: page.length,
    ...(start + limit < matches.length ? { nextCursor: start + limit } : {}),
    modules: page.map(manifest => {
      const variants = query.role || query.format ? variantMatches(manifest) : manifest.variants;
      return { id: manifest.id, kind: manifest.kind, name: manifest.name, status: manifest.status, summary: manifest.summary, layer: manifest.layer,
        formats: manifest.formats, roles: manifest.roles.slice(0, 12), invoke: manifest.invoke.tool, variantCount: manifest.variants.length,
        variants: variants.slice(0, 12).map(({ id, name, roles, intensity }) => ({ id, name, ...(roles ? { roles } : {}), ...(intensity ? { intensity } : {}) })),
        use: manifest.autopilot.use };
    }),
    next: "list_editkin_modules({moduleId}) shows one module's full manifest and input schema; prepare_editkin_module compiles available modules.",
  };
}
