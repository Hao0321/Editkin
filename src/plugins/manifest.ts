import * as z from "zod/v4";
import { compileGpuEffectModule, gpuEffectInstructionSpecs, gpuEffectOperationNames, type GpuEffectModule } from "./effectSdk";

export const pluginCapabilityKindSchema = z.enum([
  "effect",
  "transition",
  "generator",
  "analysis",
  "workflow_tool",
  "importer",
  "exporter",
  "asset_pack",
  "knowledge_pack",
  "workflow_skill",
]);

const parameterBase = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
});

export const pluginParameterSchema = z.discriminatedUnion("type", [
  parameterBase.extend({ type: z.literal("number"), default: z.number(), min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional() }),
  parameterBase.extend({ type: z.literal("boolean"), default: z.boolean() }),
  parameterBase.extend({ type: z.literal("string"), default: z.string().max(500), maxLength: z.number().int().positive().max(500).default(160) }),
  parameterBase.extend({ type: z.literal("enum"), default: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/), options: z.array(z.strictObject({ value: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/), label: z.string().min(1).max(80) })).min(1).max(64) }),
  parameterBase.extend({ type: z.literal("color"), default: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/) }),
]).superRefine((parameter, context) => {
  if (parameter.type === "enum" && !parameter.options.some((option) => option.value === parameter.default)) {
    context.addIssue({ code: "custom", path: ["default"], message: "enum default 必須存在於 options" });
  }
  if (parameter.type === "string" && parameter.default.length > parameter.maxLength) {
    context.addIssue({ code: "custom", path: ["default"], message: "string default 不得超過 maxLength" });
  }
});

const commandRuntimeSchema = z.strictObject({
  type: z.literal("editgraph_commands"),
  operations: z.array(z.strictObject({
    command: z.enum([
      "set_clip_creative",
      "set_clip_color",
      "set_clip_layout",
      "set_clip_layer",
      "update_clip_transform",
      "configure_particle_simulation",
      "set_particle_simulation_settings",
    ]),
    template: z.record(z.string(), z.unknown()),
  })).min(1).max(32),
});

const nativeEffectRuntimeSchema = z.strictObject({
  type: z.literal("native_effect"),
  abiVersion: z.union([z.literal(1), z.literal(2)]),
  entrySymbol: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/),
  libraries: z.record(z.string(), z.strictObject({
    path: z.string().min(1).max(240),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })),
  supportedFormats: z.array(z.enum(["rgba8", "rgba16_float", "rgba32_float"])).min(1),
  maxTemporalRadius: z.number().int().nonnegative().max(240).default(0),
  timeoutMs: z.number().int().min(100).max(30_000).default(3_000),
});

const gpuEffectArgumentSchema = z.union([
  z.number().finite().min(-64).max(64),
  z.string().regex(/^\$parameter\.[a-z][a-z0-9_.-]{0,63}$/),
]);

const gpuEffectOperationSchema = z.strictObject({
  op: z.enum(gpuEffectOperationNames),
  args: z.array(gpuEffectArgumentSchema).max(3),
});

const gpuEffectGraphRuntimeSchema = z.strictObject({
  type: z.literal("gpu_effect_graph"),
  abiVersion: z.literal(1),
  supportedFormats: z.array(z.enum(["rgba16_float", "rgba32_float"])).min(1),
  maxTemporalRadius: z.literal(0).default(0),
  operations: z.array(gpuEffectOperationSchema).min(1).max(4),
});

const gpuEffectModuleSchema = z.strictObject({
  schema: z.literal("editkin.gpu-effect-module/v1"),
  nodes: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    input: z.string().regex(/^(?:\$source|[a-z][a-z0-9_.-]{0,63})$/),
    op: z.enum(gpuEffectOperationNames),
    args: z.array(gpuEffectArgumentSchema).max(3),
  })).min(1).max(4),
  output: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
});

const gpuEffectModuleRuntimeSchema = z.strictObject({
  type: z.literal("gpu_effect_module"),
  abiVersion: z.literal(1),
  supportedFormats: z.array(z.enum(["rgba16_float", "rgba32_float"])).min(1),
  maxTemporalRadius: z.literal(0).default(0),
  module: gpuEffectModuleSchema,
});

const packageRuntimeSchema = z.strictObject({
  type: z.enum(["asset_pack", "knowledge_pack"]),
  index: z.string().min(1).max(240),
});

const skillPackRuntimeSchema = z.strictObject({
  type: z.literal("skill_pack"),
  index: z.string().min(1).max(240),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const pluginCapabilitySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  kind: pluginCapabilityKindSchema,
  automation: z.enum(["full", "assisted", "manual"]).default("assisted"),
  semanticRoles: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/)).max(20).default([]),
  formats: z.array(z.enum(["any", "longform", "shorts", "reels", "podcast"])).min(1).default(["any"]),
  requires: z.array(z.string().min(1).max(80)).max(20).default([]),
  avoidWhen: z.array(z.string().min(1).max(160)).max(20).default([]),
  parameters: z.array(pluginParameterSchema).max(64).default([]),
  runtime: z.discriminatedUnion("type", [commandRuntimeSchema, nativeEffectRuntimeSchema, gpuEffectGraphRuntimeSchema, gpuEffectModuleRuntimeSchema, packageRuntimeSchema, skillPackRuntimeSchema]),
}).superRefine((capability, context) => {
  if (capability.runtime.type === "asset_pack" && capability.kind !== "asset_pack") {
    context.addIssue({ code: "custom", path: ["kind"], message: "asset_pack runtime 只能宣告 asset_pack capability" });
  }
  if (capability.runtime.type === "knowledge_pack" && capability.kind !== "knowledge_pack") {
    context.addIssue({ code: "custom", path: ["kind"], message: "knowledge_pack runtime 只能宣告 knowledge_pack capability" });
  }
  if (capability.runtime.type === "skill_pack" && capability.kind !== "workflow_skill") {
    context.addIssue({ code: "custom", path: ["kind"], message: "skill_pack runtime 只能宣告 workflow_skill capability" });
  }
  if (capability.runtime.type === "gpu_effect_graph" || capability.runtime.type === "gpu_effect_module") {
    if (capability.kind !== "effect") context.addIssue({ code: "custom", path: ["kind"], message: `${capability.runtime.type} runtime 只能宣告 effect capability` });
    const parameters = new Set(capability.parameters.map((parameter) => parameter.id));
    const operations = capability.runtime.type === "gpu_effect_graph"
      ? capability.runtime.operations
      : capability.runtime.module.nodes;
    const path = capability.runtime.type === "gpu_effect_graph" ? ["runtime", "operations"] : ["runtime", "module", "nodes"];
    for (const [index, operation] of operations.entries()) {
      const expectedArgs = gpuEffectInstructionSpecs[operation.op].bounds.length;
      if (operation.args.length !== expectedArgs) {
        context.addIssue({ code: "custom", path: [...path, index, "args"], message: `${operation.op} 需要 ${expectedArgs} 個參數` });
      }
      for (const [argumentIndex, argument] of operation.args.entries()) {
        if (typeof argument === "string" && !parameters.has(argument.slice("$parameter.".length))) {
          context.addIssue({ code: "custom", path: [...path, index, "args", argumentIndex], message: `引用不存在的外掛參數 ${argument}` });
        }
      }
    }
    if (capability.runtime.type === "gpu_effect_module") {
      try { compileGpuEffectModule(capability.runtime.module as GpuEffectModule); }
      catch (error) { context.addIssue({ code: "custom", path: ["runtime", "module"], message: error instanceof Error ? error.message : String(error) }); }
    }
  }
});

export const pluginManifestSchema = z.strictObject({
  schema: z.literal("editkin.plugin/v1"),
  id: z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),
  name: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  minimumHostVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  publisher: z.strictObject({ name: z.string().min(1).max(100), url: z.string().url().optional() }),
  license: z.strictObject({ spdx: z.string().min(1).max(80), commercialUse: z.boolean() }),
  permissions: z.array(z.enum(["project.read", "project.write", "media.read", "render.effect", "assets.read", "knowledge.read", "workflow.read"])).max(12).default([]),
  capabilities: z.array(pluginCapabilitySchema).min(1).max(128),
}).superRefine((manifest, context) => {
  const permissions = new Set(manifest.permissions);
  for (const [index, capability] of manifest.capabilities.entries()) {
    const required = capability.runtime.type === "editgraph_commands"
      ? "project.write"
      : capability.runtime.type === "native_effect" || capability.runtime.type === "gpu_effect_graph" || capability.runtime.type === "gpu_effect_module"
        ? "render.effect"
        : capability.runtime.type === "asset_pack"
          ? "assets.read"
          : capability.runtime.type === "skill_pack"
            ? "workflow.read"
            : "knowledge.read";
    if (!permissions.has(required)) {
      context.addIssue({ code: "custom", path: ["capabilities", index, "runtime"], message: `runtime 缺少必要權限 ${required}` });
    }
  }
});

export type PluginParameter = z.infer<typeof pluginParameterSchema>;
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export type PluginParameterValues = Record<string, string | number | boolean>;

export function validatePluginParameters(capability: PluginCapability, input: Record<string, unknown>): PluginParameterValues {
  const definitions = new Map(capability.parameters.map((parameter) => [parameter.id, parameter]));
  for (const key of Object.keys(input)) if (!definitions.has(key)) throw new Error(`外掛參數不存在：${key}`);
  const output: PluginParameterValues = {};
  for (const parameter of capability.parameters) {
    const value = input[parameter.id] ?? parameter.default;
    if (parameter.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${parameter.name} 必須是有限數字`);
      if (parameter.min !== undefined && value < parameter.min) throw new Error(`${parameter.name} 不得小於 ${parameter.min}`);
      if (parameter.max !== undefined && value > parameter.max) throw new Error(`${parameter.name} 不得大於 ${parameter.max}`);
    } else if (parameter.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${parameter.name} 必須是布林值`);
    } else if (parameter.type === "string") {
      if (typeof value !== "string" || value.length > parameter.maxLength) throw new Error(`${parameter.name} 文字太長或格式錯誤`);
    } else if (parameter.type === "enum") {
      if (typeof value !== "string" || !parameter.options.some((option) => option.value === value)) throw new Error(`${parameter.name} 選項無效`);
    } else if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) {
      throw new Error(`${parameter.name} 必須是 #RRGGBB 或 #RRGGBBAA`);
    }
    output[parameter.id] = value as string | number | boolean;
  }
  return output;
}
