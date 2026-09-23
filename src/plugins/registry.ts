import { createHash, randomUUID } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { editorCommandSchema } from "../domain/schema";
import type { EditorCommand } from "../domain/commands";
import type { NativeEffectInstance } from "../domain/types";
import { findEffectPreset, findLookPreset, findTransitionPreset } from "../creative/corePack";
import { compareUtf8Bytes } from "../shared/utf8ByteOrder";
import { compileGpuEffectModule, gpuEffectInstructionSpecs } from "./effectSdk";
import { pluginManifestSchema, validatePluginParameters, type PluginCapability, type PluginManifest, type PluginParameterValues } from "./manifest";
import {
  assertEditkinSkillSelectionReceiptIntegrity,
  editkinSkillPackSchema,
  skillPackSha256,
  type EditkinSkillPack,
  type EditkinSkillSelectionReceipt,
  type InstalledSkillPackCandidate,
  type EditkinWorkflowProfile,
} from "./skillPack";
import { pluginAutomationApplicationSchema, type PluginAutomationApplication } from "./automationContract";

export type PluginReadiness = "AUTOMATION_READY" | "RUNTIME_READY" | "MANUAL_ONLY" | "BLOCKED";

export interface InstalledPluginCapability extends PluginCapability {
  readiness: PluginReadiness;
  automationReady: boolean;
  planningReady: boolean;
  readinessDetail: string;
  skillPack?: EditkinSkillPack;
  skillPackSha256?: string;
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  manifestPath: string;
  manifestSha256: string;
  root: string;
  capabilities: InstalledPluginCapability[];
}

export interface PluginRegistry {
  plugins: InstalledPlugin[];
  diagnostics: Array<{ path: string; status: "BLOCKED"; error: string }>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUtf8Bytes(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function configuredRoots(): string[] {
  const explicit = [process.env.EDITKIN_PLUGIN_ROOTS, process.env.EDITKIN_PLUGIN_ROOT].filter(Boolean).flatMap((value) => value!.split(delimiter));
  return [...new Set((explicit.length ? explicit : [resolve(process.cwd(), "plugins")]).map((root) => resolve(root.trim())).filter(Boolean))];
}

function compareStableVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function manifestCandidates(root: string): Promise<string[]> {
  try {
    const canonicalRoot = await realpath(root);
    const candidates = [resolve(canonicalRoot, "editkin-plugin.json")];
    for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(resolve(canonicalRoot, entry.name, "editkin-plugin.json"));
    }
    const existing: string[] = [];
    for (const candidate of candidates) {
      try { await access(candidate); existing.push(candidate); } catch { /* not a plugin */ }
    }
    return existing;
  } catch { return []; }
}

async function nativeReadiness(pluginRoot: string, capability: PluginCapability): Promise<Pick<InstalledPluginCapability, "readiness" | "automationReady" | "planningReady" | "readinessDetail">> {
  if (capability.runtime.type !== "native_effect") throw new Error("native readiness 僅接受 native effect");
  const platform = `${process.platform}-${process.arch}`;
  if (!capability.runtime.supportedFormats.includes("rgba32_float")) {
    return { readiness: "BLOCKED", automationReady: false, planningReady: false, readinessDetail: "目前 host boundary 需要 rgba32_float" };
  }
  if (capability.runtime.maxTemporalRadius !== 0) {
    return { readiness: "BLOCKED", automationReady: false, planningReady: false, readinessDetail: "temporal radius 尚未提供鄰幀 ABI，已阻擋" };
  }
  const library = capability.runtime.libraries[platform];
  if (!library) return { readiness: "BLOCKED", automationReady: false, planningReady: false, readinessDetail: `不支援目前平台 ${platform}` };
  const path = resolve(pluginRoot, library.path);
  if (!isWithin(pluginRoot, path)) return { readiness: "BLOCKED", automationReady: false, planningReady: false, readinessDetail: "原生程式庫越過外掛目錄" };
  try {
    const canonicalPath = await realpath(path);
    if (!isWithin(pluginRoot, canonicalPath)) throw new Error("原生程式庫 symlink/junction 越過外掛目錄");
    const content = await readFile(canonicalPath);
    if (sha256(content) !== library.sha256) return { readiness: "BLOCKED", automationReady: false, planningReady: false, readinessDetail: "原生程式庫 SHA-256 不符" };
  } catch { return { readiness: "BLOCKED", automationReady: false, planningReady: false, readinessDetail: "找不到原生程式庫" }; }
  return {
    readiness: "RUNTIME_READY",
    automationReady: false,
    planningReady: false,
    readinessDetail: "ABI、檔案完整性與序列輸出 adapter 已驗證；即時預覽尚未同源，因此 Skill 不會自動套用",
  };
}

function gpuEffectGraphReadiness(capability: PluginCapability): Pick<InstalledPluginCapability, "readiness" | "automationReady" | "planningReady" | "readinessDetail"> {
  if (capability.runtime.type !== "gpu_effect_graph" && capability.runtime.type !== "gpu_effect_module") throw new Error("GPU effect readiness 僅接受安全 GPU runtime");
  if (!capability.runtime.supportedFormats.some((format) => format === "rgba16_float" || format === "rgba32_float")) {
    return { readiness: "BLOCKED", automationReady: false, planningReady: false, readinessDetail: "GPU effect graph 需要 rgba16_float 或 rgba32_float" };
  }
  if (capability.automation === "manual") return {
    readiness: "RUNTIME_READY",
    automationReady: false,
    planningReady: false,
    readinessDetail: "安全 shader graph/module 已通過 resident GPU 預覽、畫素 oracle 與正式輸出同源 gate；作者限定人工套用",
  };
  return {
    readiness: "AUTOMATION_READY",
    automationReady: true,
    planningReady: false,
    readinessDetail: "安全 shader graph/module 已通過 resident GPU 預覽、畫素 oracle 與正式輸出同源 gate，可由 Skill 經 EditGraph 套用",
  };
}

async function inspectSkillPack(pluginRoot: string, manifest: PluginManifest, capability: PluginCapability): Promise<InstalledPluginCapability> {
  if (capability.runtime.type !== "skill_pack") throw new Error("Skill Pack readiness 僅接受 skill_pack runtime");
  const indexPath = resolve(pluginRoot, capability.runtime.index);
  if (!isWithin(pluginRoot, indexPath)) return { ...capability, readiness: "BLOCKED", automationReady: false, planningReady: false, readinessDetail: "Skill Pack index 越過外掛目錄" };
  try {
    const canonicalIndexPath = await realpath(indexPath);
    if (!isWithin(pluginRoot, canonicalIndexPath)) throw new Error("Skill Pack index symlink/junction 越過外掛目錄");
    const content = await readFile(canonicalIndexPath);
    if (content.byteLength > 64 * 1024) throw new Error("Skill Pack 超過 64 KiB");
    const actualSha256 = skillPackSha256(content);
    if (actualSha256 !== capability.runtime.sha256) throw new Error("Skill Pack SHA-256 不符");
    const pack = editkinSkillPackSchema.parse(JSON.parse(content.toString("utf8")));
    if (pack.identity.pluginId !== manifest.id || pack.identity.capabilityId !== capability.id || pack.identity.version !== manifest.version) {
      throw new Error("Skill Pack identity 與外掛 manifest 不一致");
    }
    return {
      ...capability,
      readiness: capability.automation === "manual" ? "MANUAL_ONLY" : "RUNTIME_READY",
      automationReady: false,
      planningReady: capability.automation !== "manual",
      readinessDetail: capability.automation === "manual"
        ? "作者限定人工檢視，不會進入 Video Autopilot 規劃"
        : "資料型 Skill Pack 已驗證；只提供規劃偏好，不能直接修改專案",
      skillPack: pack,
      skillPackSha256: actualSha256,
    };
  } catch (error) {
    return {
      ...capability,
      readiness: "BLOCKED",
      automationReady: false,
      planningReady: false,
      readinessDetail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspectCapability(pluginRoot: string, manifest: PluginManifest, capability: PluginCapability): Promise<InstalledPluginCapability> {
  if (capability.runtime.type === "editgraph_commands") return {
    ...capability,
    readiness: capability.automation === "manual" ? "MANUAL_ONLY" : "AUTOMATION_READY",
    automationReady: capability.automation !== "manual",
    planningReady: false,
    readinessDetail: capability.automation === "manual" ? "作者要求人工操作" : "透過 EditGraph 原子命令執行，可 Undo",
  };
  if (capability.runtime.type === "native_effect") return { ...capability, ...await nativeReadiness(pluginRoot, capability) };
  if (capability.runtime.type === "gpu_effect_graph" || capability.runtime.type === "gpu_effect_module") return { ...capability, ...gpuEffectGraphReadiness(capability) };
  if (capability.runtime.type === "skill_pack") return inspectSkillPack(pluginRoot, manifest, capability);
  const indexPath = resolve(pluginRoot, capability.runtime.index);
  const validPath = isWithin(pluginRoot, indexPath);
  try {
    if (!validPath) throw new Error();
    const canonicalIndexPath = await realpath(indexPath);
    if (!isWithin(pluginRoot, canonicalIndexPath)) throw new Error();
    await access(canonicalIndexPath);
  }
  catch { return { ...capability, readiness: "BLOCKED", automationReady: false, planningReady: false, readinessDetail: "套件 index 缺失或越過外掛目錄" }; }
  return { ...capability, readiness: "RUNTIME_READY", automationReady: false, planningReady: false, readinessDetail: "套件可讀；由素材／知識專用流程匯入" };
}

async function readInstalledPlugin(path: string, allowedRoot: string): Promise<InstalledPlugin> {
  const canonicalRoot = await realpath(allowedRoot);
  const canonicalManifest = await realpath(path);
  if (!isWithin(canonicalRoot, canonicalManifest)) throw new Error("外掛 manifest 越過允許的根目錄");
  const source = await readFile(canonicalManifest, "utf8");
  if (Buffer.byteLength(source) > 256 * 1024) throw new Error("外掛 manifest 超過 256 KiB");
  const manifest = pluginManifestSchema.parse(JSON.parse(source));
  const hostVersion = process.env.EDITKIN_HOST_VERSION ?? "0.15.0";
  if (!/^\d+\.\d+\.\d+$/.test(hostVersion)) throw new Error(`主程式版本格式錯誤：${hostVersion}`);
  if (compareStableVersions(hostVersion, manifest.minimumHostVersion) < 0) {
    throw new Error(`外掛需要 Editkin ${manifest.minimumHostVersion} 以上，目前是 ${hostVersion}`);
  }
  if (new Set(manifest.capabilities.map((item) => item.id)).size !== manifest.capabilities.length) throw new Error("外掛 capability id 重複");
  const pluginRoot = dirname(canonicalManifest);
  return {
    manifest,
    manifestPath: canonicalManifest,
    manifestSha256: sha256(source),
    root: pluginRoot,
    capabilities: await Promise.all(manifest.capabilities.map((capability) => inspectCapability(pluginRoot, manifest, capability))),
  };
}

export async function discoverInstalledPlugins(roots: string[] = configuredRoots()): Promise<PluginRegistry> {
  const plugins: InstalledPlugin[] = [];
  const diagnostics: PluginRegistry["diagnostics"] = [];
  const ids = new Set<string>();
  for (const root of roots.map((item) => resolve(item))) {
    for (const path of await manifestCandidates(root)) {
      try {
        const plugin = await readInstalledPlugin(path, root);
        if (ids.has(plugin.manifest.id)) throw new Error(`外掛 id 重複：${plugin.manifest.id}`);
        ids.add(plugin.manifest.id);
        plugins.push(plugin);
      } catch (error) {
        diagnostics.push({ path, status: "BLOCKED", error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  plugins.sort((left, right) => compareUtf8Bytes(left.manifest.id, right.manifest.id));
  return { plugins, diagnostics };
}

/** A path-redacted, deterministic identity for the registry seen by automation. */
export function pluginRegistryIdentity(registry: PluginRegistry) {
  const snapshot = {
    schema: "editkin.plugin-registry-identity/v1",
    plugins: registry.plugins.map((plugin) => ({
      id: plugin.manifest.id,
      version: plugin.manifest.version,
      manifestSha256: plugin.manifestSha256,
      capabilities: plugin.capabilities.map((capability) => ({
        id: capability.id,
        runtimeType: capability.runtime.type,
        readiness: capability.readiness,
        automationReady: capability.automationReady,
        planningReady: capability.planningReady,
        skillPackSha256: capability.skillPackSha256,
      })),
    })),
    diagnostics: registry.diagnostics.map((diagnostic) => ({
      pathSha256: sha256(process.platform === "win32" ? resolve(diagnostic.path).toLowerCase() : resolve(diagnostic.path)),
      status: diagnostic.status,
      error: diagnostic.error,
    })).sort((left, right) => compareUtf8Bytes(left.pathSha256, right.pathSha256)),
  } as const;
  return {
    schema: snapshot.schema,
    sha256: sha256(canonicalJson(snapshot)),
    pluginCount: snapshot.plugins.length,
    diagnosticCount: snapshot.diagnostics.length,
  } as const;
}

export function findInstalledCapability(registry: PluginRegistry, pluginId: string, capabilityId: string): { plugin: InstalledPlugin; capability: InstalledPluginCapability } {
  const plugin = registry.plugins.find((item) => item.manifest.id === pluginId);
  if (!plugin) throw new Error(`找不到已安裝外掛：${pluginId}`);
  const capability = plugin.capabilities.find((item) => item.id === capabilityId);
  if (!capability) throw new Error(`找不到外掛能力：${pluginId}/${capabilityId}`);
  return { plugin, capability };
}

export interface ResolvedNativeEffectBinding {
  plugin: InstalledPlugin;
  capability: InstalledPluginCapability & { runtime: Extract<PluginCapability["runtime"], { type: "native_effect" }> };
  libraryPath: string;
  numericParameters: number[];
}

export function resolveNativeEffectBinding(registry: PluginRegistry, instance: NativeEffectInstance): ResolvedNativeEffectBinding {
  if (instance.runtimeType === "gpu_effect_graph") throw new Error(`GPU effect graph 不能進入 CPU native ABI：${instance.pluginId}/${instance.capabilityId}`);
  const { plugin, capability } = findInstalledCapability(registry, instance.pluginId, instance.capabilityId);
  if (plugin.manifest.version !== instance.pluginVersion || plugin.manifestSha256 !== instance.manifestSha256) {
    throw new Error(`原生效果版本或 manifest identity 已改變：${instance.pluginId}/${instance.capabilityId}`);
  }
  if (capability.runtime.type !== "native_effect" || capability.kind !== "effect" || capability.readiness === "BLOCKED") {
    throw new Error(`外掛能力不是可執行的原生效果：${instance.pluginId}/${instance.capabilityId}`);
  }
  const values = validatePluginParameters(capability, instance.parameters);
  const numericParameters = capability.parameters.map((parameter) => {
    const value = values[parameter.id];
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    throw new Error(`原生 ABI 目前只接受數值或布林參數：${parameter.id}`);
  });
  const platform = `${process.platform}-${process.arch}`;
  const library = capability.runtime.libraries[platform];
  if (!library) throw new Error(`原生效果不支援目前平台 ${platform}`);
  return {
    plugin,
    capability: capability as ResolvedNativeEffectBinding["capability"],
    libraryPath: resolve(plugin.root, library.path),
    numericParameters,
  };
}

export function gpuEffectProgramSha256(
  pluginIdentity: string,
  parameters: Record<string, number>,
  operations: Array<{ opcode: number; args: [number, number, number] }>,
): string {
  const chunks: Buffer[] = [];
  const appendU32 = (value: number) => { const chunk = Buffer.allocUnsafe(4); chunk.writeUInt32LE(value); chunks.push(chunk); };
  const appendString = (value: string) => { const chunk = Buffer.from(value, "utf8"); appendU32(chunk.length); chunks.push(chunk); };
  appendString("editkin.gpu-effect-graph/v1");
  appendString(pluginIdentity);
  const entries = Object.entries(parameters).sort(([left], [right]) => compareUtf8Bytes(left, right));
  appendU32(entries.length);
  for (const [key, value] of entries) {
    appendString(key);
    const chunk = Buffer.allocUnsafe(8); chunk.writeDoubleLE(value); chunks.push(chunk);
  }
  appendU32(operations.length);
  for (const operation of operations) {
    appendU32(operation.opcode);
    for (const argument of operation.args) {
      const chunk = Buffer.allocUnsafe(4); chunk.writeFloatLE(argument); chunks.push(chunk);
    }
  }
  return sha256(Buffer.concat(chunks));
}

export interface ResolvedGpuEffectGraphBinding {
  schema: "editkin.gpu-effect-graph/v1";
  nodeId: string;
  pluginIdentity: string;
  parameters: Record<string, number>;
  programSha256: string;
  operations: Array<{ opcode: number; args: [number, number, number] }>;
}

function numericGpuParameters(capability: InstalledPluginCapability, input: Record<string, unknown>): Record<string, number> {
  const values = validatePluginParameters(capability, input);
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (typeof value === "number") return [key, value];
    if (typeof value === "boolean") return [key, value ? 1 : 0];
    throw new Error(`GPU effect graph 目前只接受數值或布林參數：${key}`);
  }));
}

export function resolveGpuEffectGraphBinding(
  plugin: InstalledPlugin,
  capability: InstalledPluginCapability,
  nodeId: string,
  pluginIdentity: string,
  input: Record<string, unknown>,
): ResolvedGpuEffectGraphBinding {
  if ((capability.runtime.type !== "gpu_effect_graph" && capability.runtime.type !== "gpu_effect_module") || capability.kind !== "effect" || capability.readiness === "BLOCKED") {
    throw new Error(`外掛能力不是可執行的 GPU effect graph：${plugin.manifest.id}/${capability.id}`);
  }
  const parameters = numericGpuParameters(capability, input);
  const authoredOperations = capability.runtime.type === "gpu_effect_graph"
    ? capability.runtime.operations
    : compileGpuEffectModule(capability.runtime.module).map(({ op, args }) => ({ op, args }));
  const operations = authoredOperations.map((operation) => {
    const args = operation.args.map((argument) => typeof argument === "number" ? argument : parameters[argument.slice("$parameter.".length)]);
    const spec = gpuEffectInstructionSpecs[operation.op];
    const bounds = spec.bounds;
    if (args.length !== bounds.length || args.some((value, index) => !Number.isFinite(value) || value < bounds[index][0] || value > bounds[index][1])) {
      throw new Error(`GPU effect operation 參數超出界線：${operation.op}`);
    }
    return { opcode: spec.opcode, args: [args[0] ?? 0, args[1] ?? 0, args[2] ?? 0] as [number, number, number] };
  });
  const programSha256 = gpuEffectProgramSha256(pluginIdentity, parameters, operations);
  return { schema: "editkin.gpu-effect-graph/v1", nodeId, pluginIdentity, parameters, programSha256, operations };
}

export async function resolveGpuEffectGraphBindings(graph: unknown, roots: string[] = configuredRoots()) {
  if (!graph || typeof graph !== "object") throw new Error("GPU effect graph 缺少 Engine Graph");
  const candidate = graph as { schema?: unknown; nodes?: unknown };
  if (candidate.schema !== "editkin.engine-graph/v1" || !Array.isArray(candidate.nodes) || candidate.nodes.length > 256) throw new Error("GPU effect graph Engine Graph 不合法");
  const registry = await discoverInstalledPlugins(roots);
  const bindings: Record<string, ResolvedGpuEffectGraphBinding> = {};
  const identityPattern = /^([a-z][a-z0-9.-]{2,127})\/([a-z][a-z0-9_.-]{0,95})@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)#([a-f0-9]{64})$/;
  for (const raw of candidate.nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as { id?: unknown; kind?: unknown; pluginId?: unknown; parameters?: unknown };
    if (node.kind !== "effect" || typeof node.pluginId !== "string" || node.pluginId.startsWith("editkin.builtin.")) continue;
    if (typeof node.id !== "string" || bindings[node.id]) throw new Error("GPU effect node id 缺失或重複");
    const match = identityPattern.exec(node.pluginId);
    if (!match) throw new Error(`外部 GPU effect identity 不合法：${node.pluginId}`);
    const [, pluginId, capabilityId, version, manifestSha256] = match;
    const { plugin, capability } = findInstalledCapability(registry, pluginId, capabilityId);
    if (plugin.manifest.version !== version || plugin.manifestSha256 !== manifestSha256) throw new Error(`GPU effect 版本或 manifest identity 已改變：${pluginId}/${capabilityId}`);
    if (!node.parameters || typeof node.parameters !== "object" || Array.isArray(node.parameters)) throw new Error(`GPU effect parameters 不合法：${node.id}`);
    bindings[node.id] = resolveGpuEffectGraphBinding(plugin, capability, node.id, node.pluginId, node.parameters as Record<string, unknown>);
  }
  return { schema: "editkin.gpu-effect-bindings/v1" as const, bindings };
}

function resolveTemplate(value: unknown, targetClipId: string, parameters: Record<string, string | number | boolean>, depth = 0): unknown {
  if (depth > 12) throw new Error("外掛命令模板巢狀過深");
  if (value === "$target.clipId") return targetClipId;
  if (typeof value === "string" && value.startsWith("$parameter.")) {
    const id = value.slice("$parameter.".length);
    if (!(id in parameters)) throw new Error(`外掛模板引用不存在的參數：${id}`);
    return parameters[id];
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, targetClipId, parameters, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, targetClipId, parameters, depth + 1)]));
  return value;
}

function validateCreativeReferences(command: EditorCommand): void {
  if (command.type !== "set_clip_creative") return;
  if (command.patch.lookPresetId) findLookPreset(command.patch.lookPresetId);
  for (const id of command.patch.effectPresetIds ?? []) findEffectPreset(id);
  if (command.patch.transitionIn) findTransitionPreset(command.patch.transitionIn.presetId);
  if (command.patch.transitionOut) findTransitionPreset(command.patch.transitionOut.presetId);
}

const PROJECT_SCOPED_PLUGIN_COMMANDS = new Set<EditorCommand["type"]>([
  "configure_particle_simulation",
  "set_particle_simulation_settings",
]);

function pluginCommandScope(command: EditorCommand["type"]): "clip" | "project" {
  return PROJECT_SCOPED_PLUGIN_COMMANDS.has(command) ? "project" : "clip";
}

export function compilePluginCommands(capability: InstalledPluginCapability, targetClipId: string, input: Record<string, unknown>): EditorCommand[] {
  if (!capability.automationReady || capability.readiness !== "AUTOMATION_READY") throw new Error(`外掛能力不可由 Skill 自動執行：${capability.readinessDetail}`);
  if (capability.runtime.type !== "editgraph_commands") throw new Error("此能力不是 EditGraph 工具");
  const parameters = validatePluginParameters(capability, input);
  return capability.runtime.operations.map((operation) => {
    if ("type" in operation.template || "clipId" in operation.template) throw new Error("外掛命令模板不得覆寫 type 或 clipId");
    const scope = pluginCommandScope(operation.command);
    const candidate = resolveTemplate({
      ...operation.template,
      type: operation.command,
      ...(scope === "clip" ? { clipId: targetClipId } : {}),
    }, targetClipId, parameters);
    const command = editorCommandSchema.parse(candidate);
    if (scope === "project" && "clipId" in command) throw new Error(`專案級外掛命令不得包含 clipId：${operation.command}`);
    if (scope === "clip" && (!("clipId" in command) || command.clipId !== targetClipId)) throw new Error(`片段級外掛命令沒有綁定目標片段：${operation.command}`);
    validateCreativeReferences(command);
    return command;
  });
}

/** Human-facing application compiler. Automation continues to use
 * compilePluginCommands and therefore cannot invoke RUNTIME_READY-only effects. */
export function compilePluginApplication(
  plugin: InstalledPlugin,
  capability: InstalledPluginCapability,
  targetClipId: string,
  input: Record<string, unknown>,
): EditorCommand[] {
  if (capability.runtime.type === "editgraph_commands") return compilePluginCommands(capability, targetClipId, input);
  if ((capability.runtime.type !== "native_effect" && capability.runtime.type !== "gpu_effect_graph" && capability.runtime.type !== "gpu_effect_module") || capability.kind !== "effect" || !["RUNTIME_READY", "AUTOMATION_READY"].includes(capability.readiness)) {
    throw new Error(`外掛能力目前不能套用：${capability.readinessDetail}`);
  }
  const parameters = validatePluginParameters(capability, input);
  const runtimeType: NativeEffectInstance["runtimeType"] = capability.runtime.type === "gpu_effect_module" ? "gpu_effect_graph" : capability.runtime.type;
  return compileNativeEffectCommand(plugin, capability, targetClipId, parameters, runtimeType, `native-effect-${randomUUID()}`);
}

function compileNativeEffectCommand(
  plugin: InstalledPlugin,
  capability: InstalledPluginCapability,
  targetClipId: string,
  parameters: PluginParameterValues,
  runtimeType: NativeEffectInstance["runtimeType"],
  instanceId: string,
): EditorCommand[] {
  return [{
    type: "add_native_effect",
    clipId: targetClipId,
    instance: {
      id: instanceId,
      pluginId: plugin.manifest.id,
      capabilityId: capability.id,
      pluginVersion: plugin.manifest.version,
      manifestSha256: plugin.manifestSha256,
      runtimeType,
      enabled: true,
      parameters,
    },
  }];
}

export function compilePluginAutomationApplication(
  plugin: InstalledPlugin,
  capability: InstalledPluginCapability,
  targetClipId: string,
  input: Record<string, unknown>,
  applicationId = "application-single",
): EditorCommand[] {
  if (!capability.automationReady || capability.readiness !== "AUTOMATION_READY") {
    throw new Error(`外掛能力不可由 Skill 自動執行：${capability.readinessDetail}`);
  }
  if (capability.runtime.type === "editgraph_commands") return compilePluginCommands(capability, targetClipId, input);
  if ((capability.runtime.type !== "native_effect" && capability.runtime.type !== "gpu_effect_graph" && capability.runtime.type !== "gpu_effect_module") || capability.kind !== "effect") {
    throw new Error(`外掛能力目前不能自動套用：${capability.readinessDetail}`);
  }
  const parameters = validatePluginParameters(capability, input);
  const runtimeType: NativeEffectInstance["runtimeType"] = capability.runtime.type === "gpu_effect_module" ? "gpu_effect_graph" : capability.runtime.type;
  const identity = {
    pluginId: plugin.manifest.id,
    capabilityId: capability.id,
    pluginVersion: plugin.manifest.version,
    manifestSha256: plugin.manifestSha256,
    targetClipId,
    parameters,
    applicationId,
  };
  return compileNativeEffectCommand(
    plugin,
    capability,
    targetClipId,
    parameters,
    runtimeType,
    `native-effect-auto-${sha256(canonicalJson(identity)).slice(0, 32)}`,
  );
}

export function pluginAutomationApplicationBase(
  plugin: InstalledPlugin,
  capability: InstalledPluginCapability,
  targetClipId: string,
  input: Record<string, unknown>,
) {
  const applicationId = `application-${randomUUID()}`;
  const commands = compilePluginAutomationApplication(plugin, capability, targetClipId, input, applicationId);
  return {
    commands,
    binding: {
      applicationId,
      pluginId: plugin.manifest.id,
      capabilityId: capability.id,
      pluginVersion: plugin.manifest.version,
      manifestSha256: plugin.manifestSha256,
      targetClipId,
      parameters: validatePluginParameters(capability, input),
      commandsSha256: sha256(canonicalJson(commands)),
    },
  };
}

function requiredAutomationPermission(capability: InstalledPluginCapability): EditkinWorkflowProfile["pluginGrants"][number]["permissions"][number] {
  if (capability.runtime.type === "editgraph_commands") return "project.write";
  if (capability.runtime.type === "native_effect" || capability.runtime.type === "gpu_effect_graph" || capability.runtime.type === "gpu_effect_module") return "render.effect";
  throw new Error(`能力不是可執行的自動化 runtime：${capability.runtime.type}`);
}

export function verifyPluginAutomationApplications(
  applicationsInput: PluginAutomationApplication[],
  registry: PluginRegistry,
  commands: EditorCommand[],
  profile: EditkinWorkflowProfile,
  limits: { maxCapabilityDeepReads: number; maxAutomaticActions: number } = { maxCapabilityDeepReads: 3, maxAutomaticActions: 32 },
) {
  const applications = applicationsInput.map((application) => pluginAutomationApplicationSchema.parse(application));
  if (new Set(applications.map((application) => application.applicationId)).size !== applications.length) {
    throw new Error("外掛 applicationId 不可在同一份 plan 重複");
  }
  const uniqueCapabilities = new Set(applications.map((application) => `${application.pluginId}/${application.capabilityId}`));
  if (uniqueCapabilities.size > limits.maxCapabilityDeepReads) {
    throw new Error(`外掛深讀能力數超過 Skill guardrail：${uniqueCapabilities.size}/${limits.maxCapabilityDeepReads}`);
  }
  const automaticActionCount = applications.reduce((total, application) => total + application.commandIndexes.length, 0);
  if (applications.length > limits.maxAutomaticActions || automaticActionCount > limits.maxAutomaticActions) {
    throw new Error(`外掛自動動作超過 Skill guardrail：${Math.max(applications.length, automaticActionCount)}/${limits.maxAutomaticActions}`);
  }
  const occupied = new Set<number>();
  const verified = applications.map((application) => {
    const { plugin, capability } = findInstalledCapability(registry, application.pluginId, application.capabilityId);
    if (plugin.manifest.version !== application.pluginVersion || plugin.manifestSha256 !== application.manifestSha256) {
      throw new Error(`外掛 application identity 已漂移：${application.pluginId}/${application.capabilityId}`);
    }
    const permission = requiredAutomationPermission(capability);
    const grant = profile.pluginGrants.find((item) => item.pluginId === plugin.manifest.id);
    if (!grant || grant.manifestSha256 !== plugin.manifestSha256 || !grant.capabilityIds.includes(capability.id) || !grant.permissions.includes(permission)) {
      throw new Error(`外掛 automation grant 缺失或已漂移：${application.pluginId}/${application.capabilityId}`);
    }
    if (!plugin.manifest.permissions.includes(permission)) throw new Error(`外掛 manifest 未宣告 ${permission}`);
    const compiled = compilePluginAutomationApplication(plugin, capability, application.targetClipId, application.parameters, application.applicationId);
    if (compiled.length !== application.commandIndexes.length) throw new Error("外掛 application command 數量與 plan range 不一致");
    if (sha256(canonicalJson(compiled)) !== application.commandsSha256) throw new Error("外掛 application command receipt 已漂移");
    application.commandIndexes.forEach((commandIndex, index) => {
      if (commandIndex >= commands.length) throw new Error(`外掛 command index 超出 plan：${commandIndex}`);
      if (occupied.has(commandIndex)) throw new Error(`外掛 command index 被重複綁定：${commandIndex}`);
      occupied.add(commandIndex);
      if (canonicalJson(commands[commandIndex]) !== canonicalJson(compiled[index])) {
        throw new Error(`外掛 command 與 host 重新編譯結果不一致：${commandIndex}`);
      }
    });
    return {
      pluginId: plugin.manifest.id,
      capabilityId: capability.id,
      manifestSha256: plugin.manifestSha256,
      commandCount: compiled.length,
      commandsSha256: application.commandsSha256,
    };
  });
  commands.forEach((command, index) => {
    if (command.type === "add_native_effect" && !command.instance.pluginId.startsWith("editkin.builtin.") && !occupied.has(index)) {
      throw new Error(`外部 native/GPU effect 缺少 plugin application provenance：${index}`);
    }
  });
  return { applicationCount: verified.length, commandCount: occupied.size, applications: verified };
}

export function compactPluginRegistry(registry: PluginRegistry) {
  return {
    schema: "editkin.plugin-registry/v1",
    plugins: registry.plugins.map((plugin) => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      publisher: plugin.manifest.publisher.name,
      manifestSha256: plugin.manifestSha256,
      permissions: plugin.manifest.permissions,
      capabilities: plugin.capabilities.map((capability) => ({
        id: capability.id,
        name: capability.name,
        description: capability.description,
        kind: capability.kind,
        automation: capability.automation,
        automationReady: capability.automationReady,
        planningReady: capability.planningReady,
        readiness: capability.readiness,
        readinessDetail: capability.readinessDetail,
        semanticRoles: capability.semanticRoles,
        formats: capability.formats,
        requires: capability.requires,
        avoidWhen: capability.avoidWhen,
        parameters: capability.parameters,
        runtimeType: capability.runtime.type,
        ...(capability.runtime.type === "skill_pack" && capability.skillPackSha256 ? { packSha256: capability.skillPackSha256 } : {}),
        commandScopes: capability.runtime.type === "editgraph_commands"
          ? [...new Set(capability.runtime.operations.map((operation) => pluginCommandScope(operation.command)))]
          : [],
      })),
    })),
    diagnostics: registry.diagnostics,
  };
}

/** Agent-facing discovery intentionally omits parameters, prose usage notes and
 * readiness diagnostics. A planner may deep-read at most the few candidates it
 * actually considers through get_plugin_capability. */
export function compactPluginAutomationDiscovery(registry: PluginRegistry, input: {
  kind?: PluginCapability["kind"] | "all";
  format?: "longform" | "shorts" | "reels" | "podcast";
  semanticRoles?: string[];
  limit?: number;
} = {}) {
  const kind = input.kind ?? "all";
  const roles = new Set(input.semanticRoles ?? []);
  const limit = Math.max(1, Math.min(8, input.limit ?? 8));
  const candidates = registry.plugins.flatMap((plugin) => plugin.capabilities.flatMap((capability) => {
    if (!capability.automationReady || capability.readiness !== "AUTOMATION_READY") return [];
    if (kind !== "all" && capability.kind !== kind) return [];
    if (input.format && !capability.formats.includes("any") && !capability.formats.includes(input.format)) return [];
    if (roles.size && capability.semanticRoles.length && !capability.semanticRoles.some((role) => roles.has(role))) return [];
    return [{
      pluginId: plugin.manifest.id,
      capabilityId: capability.id,
      kind: capability.kind,
      formats: capability.formats,
      semanticRoles: capability.semanticRoles,
    }];
  })).sort((left, right) => compareUtf8Bytes(`${left.pluginId}/${left.capabilityId}`, `${right.pluginId}/${right.capabilityId}`));
  const selected = candidates.slice(0, limit);
  return {
    schema: "editkin.plugin-automation-discovery/v1" as const,
    registrySha256: pluginRegistryIdentity(registry).sha256,
    totalMatches: candidates.length,
    returned: selected.length,
    hasMore: candidates.length > selected.length,
    candidates: selected,
    diagnostics: registry.diagnostics.length,
  };
}

export function installedSkillPackCandidates(registry: PluginRegistry): InstalledSkillPackCandidate[] {
  return registry.plugins.flatMap((plugin) => plugin.capabilities.flatMap((capability) => {
    if (capability.runtime.type !== "skill_pack" || !capability.skillPack || !capability.skillPackSha256) return [];
    return [{
      skillId: `${plugin.manifest.id}/${capability.id}`,
      pluginId: plugin.manifest.id,
      capabilityId: capability.id,
      pluginVersion: plugin.manifest.version,
      manifestSha256: plugin.manifestSha256,
      packSha256: capability.skillPackSha256,
      formats: capability.formats,
      semanticRoles: capability.semanticRoles,
      planningReady: capability.planningReady,
      pack: capability.skillPack,
    }];
  })).sort((left, right) => compareUtf8Bytes(left.skillId, right.skillId));
}

export function resolveSkillCapabilityQueries(registry: PluginRegistry, selection: EditkinSkillSelectionReceipt) {
  selection = assertEditkinSkillSelectionReceiptIntegrity(selection);
  const registrySha256 = pluginRegistryIdentity(registry).sha256;
  if (selection.pluginRegistrySha256 !== registrySha256) {
    throw new Error("Skill capability query 的 plugin registry 已漂移");
  }
  const resolutions = selection.compiled.capabilityQueries.map((query) => {
    const matches = registry.plugins.flatMap((plugin) => plugin.capabilities.flatMap((capability) => {
      if (capability.kind !== query.kind) return [];
      const planningDataPack = (capability.kind === "asset_pack" || capability.kind === "knowledge_pack") && capability.readiness === "RUNTIME_READY";
      if (!planningDataPack && (!capability.automationReady || capability.readiness !== "AUTOMATION_READY")) return [];
      if (!capability.formats.includes("any") && !capability.formats.includes(selection.context.format)) return [];
      if (!capability.semanticRoles.some((role) => query.semanticRoles.includes(role))) return [];
      return [{
        pluginId: plugin.manifest.id,
        capabilityId: capability.id,
        manifestSha256: plugin.manifestSha256,
        runtimeType: capability.runtime.type,
        automationReady: capability.automationReady,
      }];
    })).sort((left, right) => compareUtf8Bytes(`${left.pluginId}/${left.capabilityId}`, `${right.pluginId}/${right.capabilityId}`));
    const candidates = matches.slice(0, query.maxCandidates);
    if (query.required && candidates.length === 0) {
      throw new Error(`Skill required capability query 沒有可用候選：${query.sourceSkillId}/${query.id}`);
    }
    return {
      sourceSkillId: query.sourceSkillId,
      queryId: query.id,
      required: query.required,
      maxCandidates: query.maxCandidates,
      totalMatches: matches.length,
      candidates,
    };
  });
  return {
    schema: "editkin.skill-capability-resolution/v1" as const,
    skillSelectionReceiptSha256: selection.receiptSha256,
    pluginRegistrySha256: registrySha256,
    resolutions,
  };
}
