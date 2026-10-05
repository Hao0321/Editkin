import { createHash } from "node:crypto";
import * as z from "zod/v4";
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
export function listEditkinModules(query: ModuleQuery = {}) {
  const registry = editkinModuleRegistry();
  const term = query.query?.trim().toLocaleLowerCase();
  const variantMatches = (manifest: ModuleManifest) => manifest.variants.filter(variant =>
    (!query.role || variant.roles?.includes(query.role)) && (!query.format || !variant.formats?.length || variant.formats.includes(query.format)));
  const text = (manifest: ModuleManifest) => [manifest.id, manifest.name, manifest.summary, manifest.autopilot.use, ...manifest.roles,
    ...manifest.variants.flatMap(variant => [variant.id, variant.name, variant.use ?? ""])].join(" ").toLocaleLowerCase();
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

/** One module's full manifest plus the JSON Schema of its inputs. */
export function describeEditkinModule(moduleId: string) {
  const registry = editkinModuleRegistry();
  const entry = registry.get(moduleId);
  if (!entry) throw new Error(`未知模組：${moduleId}（用 list_editkin_modules 查詢）`);
  let inputSchema: unknown = null;
  if (entry.adapter.inputSchema) {
    try { inputSchema = z.toJSONSchema(entry.adapter.inputSchema, { unrepresentable: "any", io: "input" }); }
    catch { inputSchema = { description: "schema not representable as JSON Schema; see the legacy tool's input schema" }; }
  }
  const autoFilled = ["projectPath", ...(entry.manifest.variantField ? [entry.manifest.variantField] : [])];
  return { schema: EDITKIN_MODULE_SCHEMA, registry: registry.identity, manifestSha256: entry.manifestSha256, manifest: entry.manifest,
    inputs: { schema: inputSchema, autoFilled, note: "Pass the remaining fields as prepare_editkin_module.inputs; projectPath and the variant field are filled from the request." } };
}

export interface ModulePrepareRequest { projectPath: string; moduleId: string; variantId?: string; inputs?: Record<string, unknown> }

/** Read-only: compiles an available module through the same compiler its dedicated tool uses. */
export async function prepareEditkinModule(request: ModulePrepareRequest, context: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  const registry = editkinModuleRegistry();
  const entry = registry.get(request.moduleId);
  if (!entry) throw new Error(`未知模組：${request.moduleId}（用 list_editkin_modules 查詢）`);
  const { manifest, manifestSha256, adapter } = entry;
  if (manifest.status !== "available" || !adapter.prepare) throw new Error(`模組 ${manifest.id} 狀態為 ${manifest.status}，請改用 ${manifest.invoke.tool}`);
  if (manifest.variantField && !request.variantId) throw new Error(`模組 ${manifest.id} 需要 variantId（共 ${manifest.variants.length} 種）`);
  if (request.variantId && !manifest.variants.some(variant => variant.id === request.variantId)) throw new Error(`模組 ${manifest.id} 沒有 variant：${request.variantId}`);
  const inputs = request.inputs ?? {};
  context.signal?.throwIfAborted();
  const result = await adapter.prepare({ projectPath: request.projectPath, variantId: request.variantId, inputs, environment: context.environment ?? process.env, signal: context.signal });
  const commands = (Array.isArray(result.commands) ? result.commands : result.command ? [result.command] : []) as Array<{ type: string }>;
  const { commands: _commands, command: _command, status, readOnly: _readOnly, next: _next, projectRevision, ...carriers } = result;
  return {
    schema: EDITKIN_MODULE_INVOCATION_SCHEMA, status: typeof status === "string" ? status : "PREPARED", readOnly: true, mutationPerformed: false,
    module: { id: manifest.id, kind: manifest.kind, version: manifest.version, manifestSha256 }, variantId: request.variantId ?? null,
    registrySha256: registry.identity.sha256, inputsSha256: sha256(inputs), projectRevision: projectRevision ?? null,
    commandCount: commands.length, commandTypes: [...new Set(commands.map(command => command.type))], commandsSha256: sha256(commands), commands, carriers,
    legacyTool: manifest.legacy.tools[0],
    next: "Bind commands (and carriers such as planDeclaration or editorialGraphics) into the single v4 plan, then audit_autopilot_plan → apply_autopilot_plan. prepare_editkin_module never mutates the project.",
  };
}
