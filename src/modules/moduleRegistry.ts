import { createHash } from "node:crypto";
import { listModulesWithRegistryV2 } from "./moduleQueryV2";
import { describeModuleEntryV2, prepareModuleEntryV2 } from "./moduleInvocationV2";
import { canonicalJson } from "../shared/canonicalJson";
import { moduleCatalog } from "./moduleCatalog";
import {
  EDITKIN_MODULE_INDEX_SCHEMA, EDITKIN_MODULE_INVOCATION_SCHEMA, EDITKIN_MODULE_REGISTRY_SCHEMA, EDITKIN_MODULE_SCHEMA, MODULE_FORMATS, MODULE_KINDS,
  MODULE_STATUSES, type ModuleAdapter, type ModuleFormat, type ModuleKind, type ModuleManifest, type ModuleStatus,
} from "./moduleTypes";

const sha256 = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
const MODULE_ID = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;

interface Entry { manifest: ModuleManifest; manifestSha256: string; adapter: ModuleAdapter }
export interface ModuleRegistry {
  identity: Readonly<{ schema: typeof EDITKIN_MODULE_REGISTRY_SCHEMA; sha256: string; moduleCount: number; variantCount: number }>;
  manifests: readonly ModuleManifest[];
  get(id: string): Entry | undefined;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertManifest(manifest: ModuleManifest, adapter: ModuleAdapter) {
  const fail = (reason: string): never => { throw new Error(`模組 ${manifest.id} 定義錯誤：${reason}`); };
  if (!MODULE_ID.test(manifest.id)) fail("id 必須是 kind.name 小寫");
  if (!(MODULE_KINDS as readonly string[]).includes(manifest.kind) || manifest.id.split(".")[0] !== manifest.kind) fail("kind 與 id 前綴不一致");
  if (!(MODULE_STATUSES as readonly string[]).includes(manifest.status)) fail("status 不合法");
  if (!manifest.formats.length || manifest.formats.some(format => !(MODULE_FORMATS as readonly string[]).includes(format))) fail("formats 不合法");
  if (new Set(manifest.variants.map(variant => variant.id)).size !== manifest.variants.length) fail("variant id 重複");
  if (manifest.variantField && !manifest.variants.length) fail("有 variantField 卻沒有 variants");
  const viaModuleTool = manifest.invoke.tool === "prepare_editkin_module";
  if (manifest.status === "available" && (!adapter.prepare || !viaModuleTool)) fail("available 模組必須由 prepare_editkin_module 編譯");
  if (manifest.status !== "available" && (adapter.prepare || viaModuleTool)) fail("非 available 模組必須指向專用工具");
}

let cached: ModuleRegistry | undefined;
// Manifests are deep-frozen by the registry. Cache their search text once, not every palette query.
// Search cache and query semantics are shared with metadata-only discovery in moduleQueryV2.

/** Built once from the adapter catalog, frozen; duplicate ids or inconsistent manifests fail fast. */
export function editkinModuleRegistry(): ModuleRegistry {
  if (cached) return cached;
  const entries: Entry[] = moduleCatalog().map(adapter => {
    const manifest = deepFreeze({ schema: EDITKIN_MODULE_SCHEMA, ...structuredClone(adapter.manifest) }) as ModuleManifest;
    assertManifest(manifest, adapter);
    return { manifest, manifestSha256: sha256(manifest), adapter };
  });
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    if (byId.has(entry.manifest.id)) throw new Error(`模組 id 重複：${entry.manifest.id}`);
    byId.set(entry.manifest.id, entry);
  }
  const identity = Object.freeze({ schema: EDITKIN_MODULE_REGISTRY_SCHEMA, sha256: sha256(entries.map(entry => [entry.manifest.id, entry.manifestSha256])),
    moduleCount: entries.length, variantCount: entries.reduce((sum, entry) => sum + entry.manifest.variants.length, 0) });
  cached = Object.freeze({ identity, manifests: Object.freeze(entries.map(entry => entry.manifest)), get: (id: string) => byId.get(id) });
  return cached;
}

export interface ModuleQuery { kind?: ModuleKind; status?: ModuleStatus; format?: ModuleFormat; role?: string; query?: string; limit?: number; cursor?: number }

/** Compact index: enough to choose a module and variant without loading schemas. */
export function listEditkinModules(query: ModuleQuery = {}) { return listModulesWithRegistryV2(editkinModuleRegistry(), query); }

/** One module's full manifest plus the JSON Schema of its inputs. */
export function describeEditkinModule(moduleId: string) {
  const registry = editkinModuleRegistry(), entry = registry.get(moduleId);
  if (!entry) throw new Error(`未知模組：${moduleId}（用 list_editkin_modules 查詢）`);
  return describeModuleEntryV2(registry.identity, entry, entry.adapter);
}

export interface ModulePrepareRequest { projectPath: string; moduleId: string; variantId?: string; inputs?: Record<string, unknown> }

/** Read-only: compiles an available module through the same compiler its dedicated tool uses. */
export async function prepareEditkinModule(request: ModulePrepareRequest, context: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  const registry = editkinModuleRegistry(), entry = registry.get(request.moduleId);
  if (!entry) throw new Error(`未知模組：${request.moduleId}（用 list_editkin_modules 查詢）`);
  return prepareModuleEntryV2(registry.identity, entry, entry.adapter, request, context);
}
