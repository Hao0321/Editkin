import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import type { ModulePrepareRequest } from "./moduleRegistry";
import type { ModuleMetadataEntryV2, ModuleRegistryIdentityV2 } from "./moduleMetadataRuntimeV2";
import { EDITKIN_MODULE_INVOCATION_SCHEMA, EDITKIN_MODULE_SCHEMA, type ModuleCall, type ModuleRuntimeAdapterV2 } from "./moduleTypes";

const sha256 = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");

/** Shared with V1; the schema converter itself is loaded only when a V2 capability is used. */
export function describeModuleEntryV2(identity: Readonly<ModuleRegistryIdentityV2>, entry: ModuleMetadataEntryV2, adapter: ModuleRuntimeAdapterV2) {
  let inputSchema: unknown = null;
  if (adapter.inputSchema) {
    try { inputSchema = z.toJSONSchema(adapter.inputSchema, { unrepresentable: "any", io: "input" }); }
    catch { inputSchema = { description: "schema not representable as JSON Schema; see the legacy tool's input schema" }; }
  }
  const autoFilled = ["projectPath", ...(entry.manifest.variantField ? [entry.manifest.variantField] : [])];
  return { schema: EDITKIN_MODULE_SCHEMA, registry: identity, manifestSha256: entry.manifestSha256, manifest: entry.manifest,
    inputs: { schema: inputSchema, autoFilled, note: "Pass the remaining fields as prepare_editkin_module.inputs; projectPath and the variant field are filled from the request." } };
}

export function validateModulePrepareV2(entry: ModuleMetadataEntryV2, request: ModulePrepareRequest) {
  const { manifest } = entry;
  if (manifest.status !== "available") throw new Error(`模組 ${manifest.id} 狀態為 ${manifest.status}，請改用 ${manifest.invoke.tool}`);
  if (manifest.variantField && !request.variantId) throw new Error(`模組 ${manifest.id} 需要 variantId（共 ${manifest.variants.length} 種）`);
  if (request.variantId && !manifest.variants.some(variant => variant.id === request.variantId)) throw new Error(`模組 ${manifest.id} 沒有 variant：${request.variantId}`);
}

/** Read-only compiler envelope, identical for synchronous catalog callers and async capability callers. */
export async function prepareModuleEntryV2(identity: Readonly<ModuleRegistryIdentityV2>, entry: ModuleMetadataEntryV2, adapter: ModuleRuntimeAdapterV2,
  request: ModulePrepareRequest, context: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal; onProgress?: ModuleCall["onProgress"] } = {}) {
  const { manifest, manifestSha256 } = entry;
  if (manifest.status !== "available" || !adapter.prepare) throw new Error(`模組 ${manifest.id} 狀態為 ${manifest.status}，請改用 ${manifest.invoke.tool}`);
  validateModulePrepareV2(entry, request);
  const inputs = request.inputs ?? {};
  context.signal?.throwIfAborted();
  const result = await adapter.prepare({ projectPath: request.projectPath, variantId: request.variantId, inputs, environment: context.environment ?? process.env, signal: context.signal,
    ...(context.onProgress ? { onProgress: context.onProgress } : {}) });
  const commands = (Array.isArray(result.commands) ? result.commands : result.command ? [result.command] : []) as Array<{ type: string }>;
  const { commands: _commands, command: _command, status, readOnly: _readOnly, next: _next, projectRevision, ...carriers } = result;
  return {
    schema: EDITKIN_MODULE_INVOCATION_SCHEMA, status: typeof status === "string" ? status : "PREPARED", readOnly: true, mutationPerformed: false,
    module: { id: manifest.id, kind: manifest.kind, version: manifest.version, manifestSha256 }, variantId: request.variantId ?? null,
    registrySha256: identity.sha256, inputsSha256: sha256(inputs), projectRevision: projectRevision ?? null,
    commandCount: commands.length, commandTypes: [...new Set(commands.map(command => command.type))], commandsSha256: sha256(commands), commands, carriers,
    legacyTool: manifest.legacy.tools[0],
    next: "Bind commands (and carriers such as planDeclaration or editorialGraphics) into the single v4 plan, then audit_autopilot_plan → apply_autopilot_plan. prepare_editkin_module never mutates the project.",
  };
}
