import type { ModuleCall } from "./moduleTypes";
import type { ModulePrepareRequest, ModuleQuery } from "./moduleRegistry";
import { moduleAdapterLoadersV2 } from "./moduleAdapterLoadersV2";
import { createModuleLazyLoaderV2 } from "./moduleLazyLoaderV2";
import { editkinModuleMetadataRegistryV2 } from "./moduleMetadataRuntimeV2";
import { listModulesWithRegistryV2 } from "./moduleQueryV2";

const loadAdapter = createModuleLazyLoaderV2(moduleAdapterLoadersV2);
function entryFor(moduleId: string) {
  const entry = editkinModuleMetadataRegistryV2().get(moduleId);
  if (!entry) throw new Error(`未知模組：${moduleId}（用 list_editkin_modules 查詢）`);
  return entry;
}
/** Same JSON and W54 WeakMap search semantics as V1; discovery never loads adapters or schemas. */
export function listEditkinModulesV2(query: ModuleQuery = {}) {
  return listModulesWithRegistryV2(editkinModuleMetadataRegistryV2(), query);
}
/** Additive short VA discovery. Use describe for exactly one schema after selecting a capability. */
export function listEditkinCapabilitiesV2(query: ModuleQuery = {}) {
  const page = listEditkinModulesV2(query);
  return { schema: "editkin.capability-index/v2" as const, registry: page.registry, total: page.total, returned: page.returned,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    capabilities: page.modules.map(({ id, name, status, invoke, variantCount }) => ({ id, name, status, invoke, variantCount })),
    next: "describe one capability for its manifest and schema; prepare compiles read-only commands; execution requires the existing audited v4 plan tools." };
}
export async function describeEditkinModuleV2(moduleId: string, context: { signal?: AbortSignal } = {}) {
  const entry = entryFor(moduleId);
  context.signal?.throwIfAborted();
  const adapter = entry.manifest.status === "available" ? await loadAdapter(moduleId, context.signal) : {};
  context.signal?.throwIfAborted();
  const { describeModuleEntryV2 } = await import("./moduleInvocationV2");
  context.signal?.throwIfAborted();
  return describeModuleEntryV2(editkinModuleMetadataRegistryV2().identity, entry, adapter);
}
export async function prepareEditkinModuleV2(request: ModulePrepareRequest, context: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal; onProgress?: ModuleCall["onProgress"] } = {}) {
  const entry = entryFor(request.moduleId), { manifest } = entry;
  // Preserve V1 admission ordering and error strings; reject unavailable/foreign variants before import.
  if (manifest.status !== "available") throw new Error(`模組 ${manifest.id} 狀態為 ${manifest.status}，請改用 ${manifest.invoke.tool}`);
  if (manifest.variantField && !request.variantId) throw new Error(`模組 ${manifest.id} 需要 variantId（共 ${manifest.variants.length} 種）`);
  if (request.variantId && !manifest.variants.some(variant => variant.id === request.variantId)) throw new Error(`模組 ${manifest.id} 沒有 variant：${request.variantId}`);
  context.signal?.throwIfAborted();
  const adapter = await loadAdapter(request.moduleId, context.signal);
  const { prepareModuleEntryV2 } = await import("./moduleInvocationV2");
  context.signal?.throwIfAborted();
  return prepareModuleEntryV2(editkinModuleMetadataRegistryV2().identity, entry, adapter, request, context);
}

export type EditkinCapabilityRequestV2 =
  | { operation: "list"; query?: ModuleQuery }
  | { operation: "describe"; moduleId: string }
  | { operation: "prepare"; request: ModulePrepareRequest }
  | { operation: "execute"; moduleId: string };
/** Versioned Editkin-side VA gateway; it never creates a second executor, undo history or state store. */
export async function dispatchEditkinCapabilityV2(request: EditkinCapabilityRequestV2, context: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal; onProgress?: ModuleCall["onProgress"] } = {}) {
  context.signal?.throwIfAborted();
  switch (request.operation) {
    case "list": return listEditkinCapabilitiesV2(request.query);
    case "describe": return describeEditkinModuleV2(request.moduleId, context);
    case "prepare": return prepareEditkinModuleV2(request.request, context);
    case "execute": {
      const { manifest } = entryFor(request.moduleId);
      throw Error(manifest.status === "available" ? "MODULE_EXECUTE_REQUIRES_AUDITED_PLAN:audit_autopilot_plan → apply_autopilot_plan"
        : `模組 ${manifest.id} 狀態為 ${manifest.status}，請改用 ${manifest.invoke.tool}`);
    }
    default: throw Error("MODULE_CAPABILITY_OPERATION_INVALID");
  }
}
