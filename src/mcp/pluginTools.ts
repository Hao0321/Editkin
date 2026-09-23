import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { textResult, errorResult } from "./toolRuntime";
import {
  compactPluginAutomationDiscovery,
  discoverInstalledPlugins,
  findInstalledCapability,
  installedSkillPackCandidates,
  pluginAutomationApplicationBase,
  pluginRegistryIdentity,
  resolveSkillCapabilityQueries,
} from "../plugins/registry";
import {
  editkinFormatSchema,
  editkinSkillContextSchema,
  resolveEditkinSkillWorkflow,
} from "../plugins/skillPack";
import { readHostWorkflowProfile } from "../plugins/workflowProfileFileStore";

export function registerPluginTools(server: McpServer): void {
  server.registerTool("list_installed_plugins", {
    description: "動態列出 Editkin 已安裝外掛與工具的精簡能力清單、語意用途、片型及 automation readiness。Build 前先查這裡；不要把外掛名稱寫死在 Skill。",
    inputSchema: z.object({
      kind: z.enum(["all", "effect", "transition", "generator", "analysis", "workflow_tool", "importer", "exporter", "asset_pack", "knowledge_pack", "workflow_skill"]).default("all"),
      format: editkinFormatSchema.exclude(["any"]).optional(),
      semanticRoles: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/)).max(8).default([]),
      limit: z.number().int().min(1).max(8).default(8),
      automationReadyOnly: z.boolean().default(false),
    }),
  }, async ({ kind, format, semanticRoles, limit, automationReadyOnly }) => {
    try {
      const registry = await discoverInstalledPlugins();
      if (automationReadyOnly) return textResult(compactPluginAutomationDiscovery(registry, { kind, format, semanticRoles, limit }));
      const candidates = registry.plugins.flatMap((plugin) => plugin.capabilities.flatMap((capability) => {
        if (kind !== "all" && capability.kind !== kind) return [];
        if (format && !capability.formats.includes("any") && !capability.formats.includes(format)) return [];
        const roleSet = new Set(semanticRoles);
        if (roleSet.size && capability.semanticRoles.length && !capability.semanticRoles.some((role) => roleSet.has(role))) return [];
        return [{
          pluginId: plugin.manifest.id,
          capabilityId: capability.id,
          kind: capability.kind,
          runtimeType: capability.runtime.type,
          readiness: capability.readiness,
          automationReady: capability.automationReady,
          planningReady: capability.planningReady,
          formats: capability.formats,
          semanticRoles: capability.semanticRoles,
          pluginVersion: plugin.manifest.version,
          manifestSha256: plugin.manifestSha256,
        }];
      })).slice(0, limit);
      return textResult({ schema: "editkin.plugin-discovery/v2", candidates, returned: candidates.length, diagnostics: registry.diagnostics.length });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("get_plugin_capability", {
    description: "讀取單一已安裝外掛能力的受限機器契約與實際 readiness。作者名稱、描述、README、自由文字使用建議與命令模板不會進入 Agent context。",
    inputSchema: z.object({ pluginId: z.string(), capabilityId: z.string() }),
  }, async ({ pluginId, capabilityId }) => {
    try {
      const registry = await discoverInstalledPlugins();
      const { plugin, capability } = findInstalledCapability(registry, pluginId, capabilityId);
      return textResult({
        status: capability.readiness,
        plugin: { id: plugin.manifest.id, version: plugin.manifest.version, manifestSha256: plugin.manifestSha256, permissions: plugin.manifest.permissions },
        capability: {
          id: capability.id,
          kind: capability.kind,
          automation: capability.automation,
          readiness: capability.readiness,
          automationReady: capability.automationReady,
          planningReady: capability.planningReady,
          runtimeType: capability.runtime.type,
          formats: capability.formats,
          semanticRoles: capability.semanticRoles,
          parameters: capability.parameters.map((parameter) => ({
            id: parameter.id,
            type: parameter.type,
            default: parameter.default,
            ...(parameter.type === "number" ? { min: parameter.min, max: parameter.max, step: parameter.step } : {}),
            ...(parameter.type === "string" ? { maxLength: parameter.maxLength } : {}),
            ...(parameter.type === "enum" ? { values: parameter.options.map((option) => option.value) } : {}),
          })),
          skillPackSha256: capability.skillPackSha256,
        },
        authorProseOmitted: true,
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("compile_plugin_application", {
    description: "唯讀編譯 automation-ready 外掛成精確 EditGraph commands 與 manifest-bound receipt；不讀寫專案。把 commands 放進同一份 v4 plan，audit 後只能由 apply_autopilot_plan 原子提交。",
    inputSchema: z.object({
      pluginId: z.string(),
      capabilityId: z.string(),
      targetClipId: z.string(),
      parameters: z.record(z.string(), z.unknown()).default({}),
    }),
  }, async ({ pluginId, capabilityId, targetClipId, parameters }) => {
    try {
      const registry = await discoverInstalledPlugins();
      const { plugin, capability } = findInstalledCapability(registry, pluginId, capabilityId);
      const compiled = pluginAutomationApplicationBase(plugin, capability, targetClipId, parameters);
      return textResult({
        status: "GREEN",
        mutationPerformed: false,
        commands: compiled.commands,
        binding: compiled.binding,
        instruction: "將 commandIndexes 綁定到這批 commands 在 v4 plan.commands 的實際遞增位置；audit 會重新編譯逐項比對。",
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("list_installed_editkin_skills", {
    description: "列出已安裝、planning-ready 的資料型 Editkin Skill Pack。只回結構化 ID/hash/適用範圍，不載入作者自由文字；最多 8 筆。",
    inputSchema: z.object({ context: editkinSkillContextSchema, limit: z.number().int().min(1).max(8).default(8) }),
  }, async ({ context, limit }) => {
    try {
      const registry = await discoverInstalledPlugins();
      const roles = new Set(context.semanticRoles);
      const candidates = installedSkillPackCandidates(registry).filter((candidate) => candidate.planningReady
        && (candidate.formats.includes("any") || candidate.formats.includes(context.format))
        && (!roles.size || !candidate.semanticRoles.length || candidate.semanticRoles.some((role) => roles.has(role))))
        .slice(0, limit)
        .map((candidate) => ({
          skillId: candidate.skillId,
          pluginVersion: candidate.pluginVersion,
          manifestSha256: candidate.manifestSha256,
          packSha256: candidate.packSha256,
          formats: candidate.formats,
          semanticRoles: candidate.semanticRoles,
          preferenceKeys: Object.keys(candidate.pack.preferences),
          capabilityQueryCount: candidate.pack.capabilityQueries.length,
        }));
      return textResult({ schema: "editkin.skill-discovery/v1", candidates, returned: candidates.length, registry: pluginRegistryIdentity(registry) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("get_editkin_skill_pack", {
    description: "深讀單一 Editkin Skill Pack 的結構化偏好、能力查詢與 guardrails；不回傳作者 README 或任意 prompt。每次規劃最多深讀三包。",
    inputSchema: z.object({ pluginId: z.string(), capabilityId: z.string() }),
  }, async ({ pluginId, capabilityId }) => {
    try {
      const registry = await discoverInstalledPlugins();
      const candidate = installedSkillPackCandidates(registry).find((item) => item.pluginId === pluginId && item.capabilityId === capabilityId);
      if (!candidate?.planningReady) throw new Error(`Skill Pack 不存在或 planning readiness 未通過：${pluginId}/${capabilityId}`);
      const pack = candidate.pack;
      return textResult({
        status: "GREEN",
        skillId: candidate.skillId,
        pluginVersion: candidate.pluginVersion,
        manifestSha256: candidate.manifestSha256,
        packSha256: candidate.packSha256,
        planSchema: pack.planSchema,
        conflictGroup: pack.conflictGroup,
        preferences: pack.preferences,
        capabilityQueries: pack.capabilityQueries,
        guardrails: pack.guardrails,
        outcomeLearning: pack.outcomeLearning,
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("get_editkin_workflow_profile", {
    description: "讀取由 Editkin 主程式持有的 Workflow Profile 摘要。此工具唯讀；Codex／Claude 不能透過 MCP 自行新增授權。",
    inputSchema: z.object({}),
  }, async () => {
    try {
      const host = await readHostWorkflowProfile();
      return textResult({
        status: "GREEN",
        configured: host.configured,
        profile: {
          id: host.profile.id,
          revision: host.profile.revision,
          enabledSkills: host.profile.enabledSkills,
          priority: host.profile.priority,
          pluginCapabilities: host.profile.pluginGrants.map((grant) => ({ pluginId: grant.pluginId, capabilityIds: grant.capabilityIds })),
          conflictPolicy: host.profile.conflictPolicy,
        },
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("resolve_editkin_skill_workflow", {
    description: "依 Editkin 主程式持有的 Workflow Profile 精確 manifest/pack grant 與當前片型語意，唯讀合併 Skill Pack 並產生 hash-bound selection receipt。Agent 不能提交或偽造 Profile；缺 grant、衝突或漂移會 fail-closed。",
    inputSchema: z.object({ context: editkinSkillContextSchema }),
  }, async ({ context }) => {
    try {
      const [registry, host] = await Promise.all([discoverInstalledPlugins(), readHostWorkflowProfile()]);
      const identity = pluginRegistryIdentity(registry);
      const receipt = resolveEditkinSkillWorkflow(installedSkillPackCandidates(registry), host.profile, context, identity.sha256);
      const capabilityResolution = resolveSkillCapabilityQueries(registry, receipt);
      return textResult({ status: "GREEN", hostProfileConfigured: host.configured, receipt, capabilityResolution });
    } catch (error) { return errorResult(error); }
  });
}
